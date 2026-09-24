import { Router } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { audit, check, history, linesSchema, member, notify, user, type User } from '../core.js';
import { id, one, pool, transaction, type DB } from '../db.js';
import { priceCart, releaseStock } from './catalog.js';
import { cancelDelivery, createDelivery } from './delivery.js';
import { cancelPayment, createPayment, ensurePayment } from './payments.js';
export const orders = Router();
export async function releaseOrderStock(db: DB, orderId: string) {
  const result = await db.query(
    'UPDATE orders SET stock_released=true WHERE id=$1 AND stock_released=false RETURNING id',
    [orderId],
  );
  if (!result.rowCount) return;
  const items = (
    await db.query(
      'SELECT menu_item_id,quantity FROM order_items WHERE order_id=$1 ORDER BY menu_item_id',
      [orderId],
    )
  ).rows;
  await releaseStock(db, items);
}
export async function accessOrder(db: DB, actor: User, orderId: string, lock = false) {
  const order = await one(db, `SELECT * FROM orders WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [
    orderId,
  ]);
  check(order, 404, 'NOT_FOUND', 'Order not found.');
  if (actor.role === 'CUSTOMER')
    check(order.customer_id === actor.id, 403, 'FORBIDDEN', 'You cannot access this order.');
  else if (actor.role === 'RESTAURANT') await member(db, actor, order.restaurant_id);
  else if (actor.role === 'DRIVER')
    check(
      await one(
        db,
        'SELECT 1 FROM deliveries d JOIN driver_assignments a ON a.delivery_id=d.id WHERE d.order_id=$1 AND a.driver_id=$2 AND a.active=true',
        [orderId, actor.id],
      ),
      403,
      'FORBIDDEN',
      'This delivery is not assigned to you.',
    );
  return order;
}
export async function orderDetail(db: DB, orderId: string) {
  const row = await one(
    db,
    'SELECT o.*,r.name AS restaurant_name FROM orders o JOIN restaurants r ON r.id=o.restaurant_id WHERE o.id=$1',
    [orderId],
  );
  return {
    ...row,
    items: (await db.query('SELECT * FROM order_items WHERE order_id=$1', [orderId])).rows,
    payment: await one(db, 'SELECT * FROM payments WHERE order_id=$1', [orderId]),
    delivery: await one(
      db,
      'SELECT d.*,u.name AS driver_name FROM deliveries d LEFT JOIN users u ON u.id=d.driver_id WHERE d.order_id=$1',
      [orderId],
    ),
    history: (
      await db.query('SELECT * FROM state_history WHERE order_id=$1 ORDER BY sequence', [orderId])
    ).rows,
    review: await one(db, 'SELECT * FROM reviews WHERE order_id=$1', [orderId]),
  };
}
export async function changeOrder(db: DB, order: any, to: string, actor: string, reason = '') {
  await db.query('UPDATE orders SET status=$1 WHERE id=$2', [to, order.id]);
  await history(db, order.id, 'ORDER', order.status, to, actor, reason);
  await notify(db, order.customer_id, 'ORDER_STATUS', { orderId: order.id, status: to });
}
orders.get('/cart', async (req, res) => {
  const actor = user(req, 'CUSTOMER');
  res.json(
    (await one(pool, 'SELECT * FROM carts WHERE customer_id=$1', [actor.id])) || {
      items: [],
      version: 0,
    },
  );
});
orders.put('/cart', async (req, res) => {
  const actor = user(req, 'CUSTOMER');
  const input = z
    .object({
      items: linesSchema.or(z.array(z.never()).length(0)),
      version: z.number().int().min(0),
    })
    .parse(req.body);
  res.json(
    await transaction(async (db) => {
      await db.query('INSERT INTO carts(customer_id) VALUES($1) ON CONFLICT DO NOTHING', [
        actor.id,
      ]);
      const cart = await one(db, 'SELECT * FROM carts WHERE customer_id=$1 FOR UPDATE', [actor.id]);
      check(
        cart.version === input.version,
        409,
        'CART_CONFLICT',
        'Basket changed in another tab. Refresh and try again.',
      );
      if (input.items.length) await priceCart(db, input.items);
      return one(
        db,
        'UPDATE carts SET items=$1,version=version+1 WHERE customer_id=$2 RETURNING *',
        [JSON.stringify(input.items), actor.id],
      );
    }),
  );
});
orders.post('/checkout/quote', async (req, res) => {
  user(req, 'CUSTOMER');
  res.json(await transaction((db) => priceCart(db, req.body.items)));
});
const checkoutSchema = z.object({
  items: linesSchema,
  address: z.string().trim().min(8).max(300),
  note: z.string().trim().max(500).default(''),
  expectedTotal: z.number().int().positive(),
  idempotencyKey: z.string().min(8).max(120),
});
orders.post('/checkout', async (req, res) => {
  const actor = user(req, 'CUSTOMER');
  const input = checkoutSchema.parse(req.body);
  const canonical = {
    address: input.address,
    note: input.note,
    expectedTotal: input.expectedTotal,
    items: input.items
      .map((l) => ({ ...l, optionIds: [...new Set(l.optionIds)].sort() }))
      .sort(
        (a, b) =>
          a.itemId.localeCompare(b.itemId) || a.optionIds.join().localeCompare(b.optionIds.join()),
      ),
  };
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  const orderId = await transaction(async (db) => {
    // Serialize per customer/key before looking up a committed result. Unique constraint remains the final guard.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      actor.id + ':' + input.idempotencyKey,
    ]);
    const old = await one(db, 'SELECT * FROM orders WHERE customer_id=$1 AND idempotency_key=$2', [
      actor.id,
      input.idempotencyKey,
    ]);
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
    const orderId = id();
    const expiry = new Date(Date.now() + Number(process.env.PAYMENT_WINDOW_MINUTES || 15) * 60000);
    await db.query(
      "INSERT INTO orders(id,customer_id,restaurant_id,status,subtotal,delivery_fee,total,address,note,idempotency_key,fingerprint,expires_at) VALUES($1,$2,$3,'PENDING_PAYMENT',$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        orderId,
        actor.id,
        quote.restaurantId,
        quote.subtotal,
        quote.deliveryFee,
        quote.total,
        input.address,
        input.note,
        input.idempotencyKey,
        fingerprint,
        expiry,
      ],
    );
    for (const i of quote.items)
      await db.query(
        'INSERT INTO order_items(id,order_id,menu_item_id,name,price,quantity,options) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [id(), orderId, i.itemId, i.name, i.price, i.quantity, JSON.stringify(i.options)],
      );
    await createPayment(db, orderId, quote.total);
    await createDelivery(db, orderId);
    await history(db, orderId, 'ORDER', null, 'PENDING_PAYMENT', actor.id);
    await notify(db, actor.id, 'ORDER_CREATED', { orderId });
    await db.query("UPDATE carts SET items='[]',version=version+1 WHERE customer_id=$1", [
      actor.id,
    ]);
    return orderId;
  });
  // Provider call is deliberately outside the business transaction; a worker retries the persisted reference.
  try {
    await ensurePayment(orderId);
  } catch {
    /* The pending payment remains recoverable. */
  }
  res.status(201).json(await orderDetail(pool, orderId));
});
orders.get('/orders', async (req, res) => {
  const actor = user(req);
  const rows = (
    await pool.query(
      `SELECT o.id FROM orders o WHERE $1='ADMIN' OR ($1='CUSTOMER' AND o.customer_id=$2) OR ($1='RESTAURANT' AND o.status<>'PENDING_PAYMENT' AND EXISTS(SELECT 1 FROM restaurant_members m WHERE m.restaurant_id=o.restaurant_id AND m.user_id=$2)) OR ($1='DRIVER' AND EXISTS(SELECT 1 FROM deliveries d JOIN driver_assignments a ON a.delivery_id=d.id WHERE d.order_id=o.id AND a.driver_id=$2 AND a.active=true)) ORDER BY o.created_at DESC LIMIT 100`,
      [actor.role, actor.id],
    )
  ).rows;
  res.json(await Promise.all(rows.map((o) => orderDetail(pool, o.id))));
});
orders.get('/orders/:id', async (req, res) => {
  await accessOrder(pool, user(req), String(req.params.id));
  res.json(await orderDetail(pool, String(req.params.id)));
});
orders.post('/orders/:id/transition', async (req, res) => {
  const actor = user(req, 'RESTAURANT');
  const { status } = z
    .object({ status: z.enum(['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']) })
    .parse(req.body);
  await transaction(async (db) => {
    const order = await accessOrder(db, actor, String(req.params.id), true);
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
    await audit(db, actor.id, 'ORDER_TRANSITION', order.id, { from: order.status, to: status });
  });
  res.json(await orderDetail(pool, String(req.params.id)));
});
orders.post('/orders/:id/cancel', async (req, res) => {
  const actor = user(req, 'CUSTOMER', 'RESTAURANT', 'ADMIN');
  const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
  await transaction(async (db) => {
    const o = await accessOrder(db, actor, String(req.params.id), true);
    check(
      ['PENDING_PAYMENT', 'CONFIRMED'].includes(o.status),
      409,
      'CANCELLATION_NOT_ALLOWED',
      'Cancellation is available only before the restaurant accepts. Contact support for later issues.',
    );
    await cancelPayment(db, o.id, actor.id);
    await cancelDelivery(db, o.id, actor.id);
    await releaseOrderStock(db, o.id);
    await changeOrder(db, o, 'CANCELLED', actor.id, reason);
    await audit(db, actor.id, 'ORDER_CANCELLED', o.id, { reason });
  });
  res.json(await orderDetail(pool, String(req.params.id)));
});
