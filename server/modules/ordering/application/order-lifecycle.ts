import { transaction, type DB } from '../../../shared/db.js';
import { check } from '../../../shared/errors.js';
import type { User } from '../../../shared/types.js';
import * as audits from '../../../shared/audit.repository.js';
import { releaseStock } from '../../catalog/index.js';
import { cancelDelivery, deliveryForOrderLocked } from '../../delivery/index.js';
import { publish } from '../../../shared/events.js';
import { notify } from '../../notification/index.js';
import { cancelPayment, simulate, simulated } from '../../payment/index.js';
import {
  canCustomerCancel,
  canRestaurantTransition,
  isAwaitingPayment,
} from '../domain/order-status.js';
import * as orders from '../infrastructure/order.repository.js';
import { cancelSchema, transitionSchema } from '../ordering.schemas.js';
import { accessOrder, orderDetail } from './order-queries.js';

export async function changeOrder(
  db: DB,
  order: { id: string; status: string; customer_id: string },
  to: string,
  actor: string,
  reason = '',
): Promise<void> {
  await orders.setStatus(order.id, to, db);
  await audits.history(order.id, 'ORDER', order.status, to, actor, reason, db);
  await notify(db, order.customer_id, 'ORDER_STATUS', { orderId: order.id, status: to });
}

export async function releaseOrderStock(db: DB, orderId: string): Promise<void> {
  if (!(await orders.markStockReleased(orderId, db))) return;
  const items = await orders.itemsForStockRelease(orderId, db);
  await releaseStock(db, items);
}

/**
 * The single path an unpaid order takes to PAYMENT_FAILED: give the stock
 * back, cancel the open delivery, then record the new status.
 */
export async function failUnpaidOrder(
  db: DB,
  order: orders.OrderRow,
  actor: string,
  reason = '',
): Promise<void> {
  await releaseOrderStock(db, order.id);
  await cancelDelivery(db, order.id, actor);
  await changeOrder(db, order, 'PAYMENT_FAILED', actor, reason);
}

export async function transition(actor: User, orderId: string, raw: unknown): Promise<any> {
  const { status } = transitionSchema.parse(raw);
  await transaction(async (db) => {
    const order = await accessOrder(db, actor, orderId, true);
    check(
      canRestaurantTransition(order.status, status),
      409,
      'INVALID_TRANSITION',
      'This order cannot move to that state.',
    );
    await changeOrder(db, order, status, actor.id);
    await audits.audit(
      actor.id,
      'ORDER_TRANSITION',
      order.id,
      { from: order.status, to: status },
      db,
    );
    if (status === 'ACCEPTED') {
      const delivery = await deliveryForOrderLocked(order.id, db);
      if (delivery && delivery.status === 'UNASSIGNED' && !delivery.driver_id)
        await publish(db, 'OrderAccepted', {
          orderId: order.id,
          deliveryId: delivery.id,
          actor: actor.id,
        });
    }
  });
  return orderDetail(orderId);
}

export async function cancel(actor: User, orderId: string, raw: unknown): Promise<any> {
  const { reason } = cancelSchema.parse(raw);
  await transaction(async (db) => {
    const order = await accessOrder(db, actor, orderId, true);
    check(
      canCustomerCancel(order.status),
      409,
      'CANCELLATION_NOT_ALLOWED',
      'Cancellation is available only before the restaurant accepts. Contact support for later issues.',
    );
    await cancelPayment(db, order.id, actor.id);
    await cancelDelivery(db, order.id, actor.id);
    await releaseOrderStock(db, order.id);
    await changeOrder(db, order, 'CANCELLED', actor.id, reason);
    await audits.audit(actor.id, 'ORDER_CANCELLED', order.id, { reason }, db);
  });
  return orderDetail(orderId);
}

/** Demo mode: the customer settles their own pending order with a simulated outcome. */
export async function simulatePayment(
  actor: User,
  orderId: string,
  raw: unknown,
): Promise<{ duplicate: boolean }> {
  check(simulated(), 404, 'NOT_FOUND', 'Not found.');
  const order = await accessOrder(undefined, actor, orderId);
  check(
    isAwaitingPayment(order.status),
    409,
    'INVALID_TRANSITION',
    'This order is not awaiting payment.',
  );
  return simulate(order.id, raw);
}
