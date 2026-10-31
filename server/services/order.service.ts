import { createHash } from 'node:crypto';
import { z } from 'zod';
import { id, transaction, type DB } from '../db.js';
import { check } from '../domain/errors.js';
import { linesSchema } from '../domain/schemas.js';
import type { User } from '../domain/types.js';
import * as audits from '../repositories/audit.repository.js';
import * as carts from '../repositories/cart.repository.js';
import * as orders from '../repositories/order.repository.js';
import { assertMember, priceCart, releaseStock } from './catalog.service.js';
import { cancelDelivery, createDelivery } from './delivery.service.js';
import { notify } from './notification.service.js';
import { cancelPayment, createPayment, ensurePayment } from './payment.service.js';

const checkoutSchema = z.object({
  items: linesSchema,
  address: z.string().trim().min(8).max(300),
  note: z.string().trim().max(500).default(''),
  expectedTotal: z.number().int().positive(),
  idempotencyKey: z.string().min(8).max(120),
});

const transitionSchema = z.object({
  status: z.enum(['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']),
});

const cancelSchema = z.object({ reason: z.string().trim().min(3).max(300) });

export async function accessOrder(
  db: DB | undefined,
  actor: User,
  orderId: string,
  lock = false,
): Promise<orders.OrderRow> {
  const order = await orders.findById(orderId, db, lock);
  check(order, 404, 'NOT_FOUND', 'Order not found.');
  if (actor.role === 'CUSTOMER')
    check(order.customer_id === actor.id, 403, 'FORBIDDEN', 'You cannot access this order.');
  else if (actor.role === 'RESTAURANT') await assertMember(db, actor, order.restaurant_id);
  else if (actor.role === 'DRIVER')
    check(
      await orders.isDriverAssigned(orderId, actor.id, db),
      403,
      'FORBIDDEN',
      'This delivery is not assigned to you.',
    );
  return order;
}

export async function orderDetail(orderId: string, db?: DB): Promise<any> {
  const row = await orders.detailRow(orderId, db);
  return {
    ...row,
    items: await orders.detailItems(orderId, db),
    payment: await orders.detailPayment(orderId, db),
    delivery: await orders.detailDelivery(orderId, db),
    history: await orders.detailHistory(orderId, db),
    review: await orders.detailReview(orderId, db),
  };
}

export async function changeOrder(
  db: DB,
  order: any,
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

export async function list(actor: User): Promise<any[]> {
  const rows = await orders.listVisibleIds(actor.role, actor.id);
  return Promise.all(rows.map((order) => orderDetail(order.id)));
}

export async function detail(actor: User, orderId: string): Promise<any> {
  await accessOrder(undefined, actor, orderId);
  return orderDetail(orderId);
}

export async function quote(actor: User, items: unknown): Promise<any> {
  return transaction((db) => priceCart(db, items));
}

export async function checkout(actor: User, raw: unknown): Promise<any> {
  const input = checkoutSchema.parse(raw);
  const canonical = {
    address: input.address,
    note: input.note,
    expectedTotal: input.expectedTotal,
    items: input.items
      .map((line) => ({ ...line, optionIds: [...new Set(line.optionIds)].sort() }))
      .sort(
        (a, b) =>
          a.itemId.localeCompare(b.itemId) || a.optionIds.join().localeCompare(b.optionIds.join()),
      ),
  };
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  const orderId = await transaction(async (db) => {
    // Serialize per customer/key before looking up a committed result. Unique constraint remains the final guard.
    await orders.advisoryCheckoutLock(actor.id + ':' + input.idempotencyKey, db);
    const old = await orders.findByCustomerAndKey(actor.id, input.idempotencyKey, db);
    if (old) {
      check(
        old.fingerprint === fingerprint,
        409,
        'IDEMPOTENCY_CONFLICT',
        'This checkout key was already used with different details.',
      );
      return old.id;
    }
    const quote = await priceCart(db, input.items, true);
    check(
      quote.total === input.expectedTotal,
      409,
      'PRICE_CHANGED',
      'Prices changed. Review a fresh quote before ordering.',
    );
    const newOrderId = id();
    const expiry = new Date(Date.now() + Number(process.env.PAYMENT_WINDOW_MINUTES || 15) * 60000);
    await orders.insert(
      {
        id: newOrderId,
        customerId: actor.id,
        restaurantId: quote.restaurantId,
        subtotal: quote.subtotal,
        deliveryFee: quote.deliveryFee,
        total: quote.total,
        address: input.address,
        note: input.note,
        idempotencyKey: input.idempotencyKey,
        fingerprint,
        expiresAt: expiry,
      },
      db,
    );
    for (const item of quote.items)
      await orders.insertItem(
        {
          orderId: newOrderId,
          itemId: item.itemId,
          name: item.name,
          price: item.price,
          quantity: item.quantity,
          options: item.options,
        },
        id(),
        db,
      );
    await createPayment(db, newOrderId, quote.total);
    await createDelivery(db, newOrderId);
    await audits.history(newOrderId, 'ORDER', null, 'PENDING_PAYMENT', actor.id, '', db);
    await notify(db, actor.id, 'ORDER_CREATED', { orderId: newOrderId });
    await carts.clear(actor.id, db);
    return newOrderId;
  });
  // Provider call is deliberately outside the business transaction; a worker retries the persisted reference.
  try {
    await ensurePayment(orderId);
  } catch {
    /* The pending payment remains recoverable. */
  }
  return orderDetail(orderId);
}

export async function transition(actor: User, orderId: string, raw: unknown): Promise<any> {
  const { status } = transitionSchema.parse(raw);
  await transaction(async (db) => {
    const order = await accessOrder(db, actor, orderId, true);
    const allowed: Record<string, string> = {
      CONFIRMED: 'ACCEPTED',
      ACCEPTED: 'PREPARING',
      PREPARING: 'READY_FOR_PICKUP',
    };
    check(
      allowed[order.status] === status,
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
  });
  return orderDetail(orderId);
}

export async function cancel(actor: User, orderId: string, raw: unknown): Promise<any> {
  const { reason } = cancelSchema.parse(raw);
  await transaction(async (db) => {
    const order = await accessOrder(db, actor, orderId, true);
    check(
      ['PENDING_PAYMENT', 'CONFIRMED'].includes(order.status),
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
