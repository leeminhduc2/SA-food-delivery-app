import { Router } from 'express';
import { z } from 'zod';
import { audit, check, history, user } from '../core.js';
import { id, one, transaction, type DB } from '../db.js';
import { changeOrder } from './orders.js';
export const delivery = Router();
export async function createDelivery(db: DB, orderId: string) {
  await db.query('INSERT INTO deliveries(id,order_id) VALUES($1,$2)', [id(), orderId]);
  await history(db, orderId, 'DELIVERY', null, 'UNASSIGNED', 'system');
}
export async function cancelDelivery(db: DB, orderId: string, actor: string) {
  const d = await one(db, 'SELECT * FROM deliveries WHERE order_id=$1 FOR UPDATE', [orderId]);
  if (d && ['UNASSIGNED', 'ASSIGNED'].includes(d.status)) {
    await db.query("UPDATE deliveries SET status='CANCELLED',updated_at=now() WHERE id=$1", [d.id]);
    await db.query('UPDATE driver_assignments SET active=false WHERE delivery_id=$1', [d.id]);
    await history(db, orderId, 'DELIVERY', d.status, 'CANCELLED', actor);
  }
}
delivery.post('/deliveries/:id/assign', async (req, res) => {
  const actor = user(req, 'ADMIN');
  const { driverId } = z.object({ driverId: z.string().min(1) }).parse(req.body);
  await transaction(async (db) => {
    const found = await one(db, 'SELECT order_id FROM deliveries WHERE id=$1', [req.params.id]);
    check(found, 404, 'NOT_FOUND', 'Delivery not found.');
    const o = await one(db, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [found.order_id]);
    const d = await one(db, 'SELECT * FROM deliveries WHERE id=$1 FOR UPDATE', [req.params.id]);
    check(
      ['CONFIRMED', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(o.status) &&
        ['UNASSIGNED', 'ASSIGNED'].includes(d.status),
      409,
      'INVALID_TRANSITION',
      'This delivery cannot be assigned.',
    );
    check(
      await one(db, "SELECT 1 FROM users WHERE id=$1 AND role='DRIVER' AND active=true", [
        driverId,
      ]),
      400,
      'INVALID_DRIVER',
      'Choose an active driver.',
    );
    await db.query('UPDATE driver_assignments SET active=false WHERE delivery_id=$1', [d.id]);
    await db.query('INSERT INTO driver_assignments(id,delivery_id,driver_id) VALUES($1,$2,$3)', [
      id(),
      d.id,
      driverId,
    ]);
    await db.query(
      "UPDATE deliveries SET driver_id=$1,status='ASSIGNED',updated_at=now() WHERE id=$2",
      [driverId, d.id],
    );
    await history(db, o.id, 'DELIVERY', d.status, 'ASSIGNED', actor.id);
    await audit(db, actor.id, 'DRIVER_ASSIGNED', d.id, { driverId });
  });
  res.json({ ok: true });
});
delivery.post('/deliveries/:id/transition', async (req, res) => {
  const actor = user(req, 'DRIVER');
  const input = z
    .object({
      status: z.enum(['PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED']),
      reason: z.string().max(300).default(''),
    })
    .parse(req.body);
  await transaction(async (db) => {
    const found = await one(db, 'SELECT order_id FROM deliveries WHERE id=$1', [req.params.id]);
    check(found, 404, 'NOT_FOUND', 'Delivery not found.');
    const o = await one(db, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [found.order_id]);
    const d = await one(db, 'SELECT * FROM deliveries WHERE id=$1 FOR UPDATE', [req.params.id]);
    check(
      d.driver_id === actor.id &&
        (await one(
          db,
          'SELECT 1 FROM driver_assignments WHERE delivery_id=$1 AND driver_id=$2 AND active=true',
          [d.id, actor.id],
        )),
      403,
      'FORBIDDEN',
      'This delivery is not assigned to you.',
    );
    const transitions: Record<string, string[]> = {
      ASSIGNED: ['PICKED_UP'],
      PICKED_UP: ['IN_TRANSIT', 'FAILED'],
      IN_TRANSIT: ['DELIVERED', 'FAILED'],
    };
    check(
      transitions[d.status]?.includes(input.status),
      409,
      'INVALID_TRANSITION',
      'Invalid delivery transition.',
    );
    if (input.status === 'PICKED_UP')
      check(
        o.status === 'READY_FOR_PICKUP',
        409,
        'NOT_READY',
        'The restaurant has not marked the food ready.',
      );
    if (input.status === 'FAILED')
      check(
        input.reason.trim().length >= 3,
        400,
        'REASON_REQUIRED',
        'Please describe why delivery failed.',
      );
    await db.query('UPDATE deliveries SET status=$1,updated_at=now() WHERE id=$2', [
      input.status,
      d.id,
    ]);
    await history(db, o.id, 'DELIVERY', d.status, input.status, actor.id, input.reason);
    if (input.status === 'PICKED_UP') await changeOrder(db, o, 'OUT_FOR_DELIVERY', actor.id);
    if (input.status === 'DELIVERED') await changeOrder(db, o, 'DELIVERED', actor.id);
    if (input.status === 'FAILED') {
      await changeOrder(db, o, 'DELIVERY_FAILED', actor.id, input.reason);
      await audit(db, actor.id, 'DELIVERY_FAILED', d.id, { reason: input.reason });
    }
  });
  res.json({ ok: true });
});
