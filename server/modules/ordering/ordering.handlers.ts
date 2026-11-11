import type { DB } from '../../shared/db.js';
import { subscribe } from '../../shared/events.js';
import { changeOrder, failUnpaidOrder } from './application/order-lifecycle.js';
import { isAwaitingPayment } from './domain/order-status.js';
import * as orders from './infrastructure/order.repository.js';

/** The order row, locked for the rest of the publisher's transaction. */
const locked = (db: DB, orderId: string) => orders.findById(orderId, db, true);

/**
 * Ordering's reactions to what Payment and Delivery report. Each handler runs
 * inside the publisher's transaction, so the order changes atomically with it.
 */
export function registerOrderingHandlers(): void {
  subscribe('PaymentSucceeded', async (db, event) => {
    const order = await locked(db, event.orderId);
    if (order && isAwaitingPayment(order.status))
      await changeOrder(db, order, 'CONFIRMED', event.actor);
  });

  subscribe('PaymentFailed', async (db, event) => {
    const order = await locked(db, event.orderId);
    if (order && isAwaitingPayment(order.status))
      await failUnpaidOrder(db, order, event.actor, event.reason);
  });

  subscribe('DeliveryPickedUp', async (db, event) => {
    const order = await locked(db, event.orderId);
    if (order) await changeOrder(db, order, 'OUT_FOR_DELIVERY', event.actor);
  });

  subscribe('DeliveryCompleted', async (db, event) => {
    const order = await locked(db, event.orderId);
    if (order) await changeOrder(db, order, 'DELIVERED', event.actor);
  });

  subscribe('DeliveryFailed', async (db, event) => {
    const order = await locked(db, event.orderId);
    if (order) await changeOrder(db, order, 'DELIVERY_FAILED', event.actor, event.reason);
  });
}
