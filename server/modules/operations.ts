import { Router } from 'express';
import { z } from 'zod';
import { audit, check, notify, user } from '../core.js';
import { id, one, pool, transaction } from '../db.js';
import { accessOrder } from './orders.js';
export const operations = Router();
operations.post('/orders/:id/review', async (req, res) => {
  const actor = user(req, 'CUSTOMER');
  const input = z
    .object({ rating: z.number().int().min(1).max(5), content: z.string().trim().min(3).max(1000) })
    .parse(req.body);
  res.status(201).json(
    await transaction(async (db) => {
      const o = await accessOrder(db, actor, String(req.params.id), true);
      check(
        o.status === 'DELIVERED',
        409,
        'NOT_DELIVERED',
        'Only delivered orders can be reviewed.',
      );
      return one(
        db,
        'INSERT INTO reviews(id,order_id,customer_id,restaurant_id,rating,content) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
        [id(), o.id, actor.id, o.restaurant_id, input.rating, input.content],
      );
    }),
  );
});
operations.post('/orders/:id/complaints', async (req, res) => {
  const actor = user(req, 'CUSTOMER');
  const { content } = z.object({ content: z.string().trim().min(10).max(2000) }).parse(req.body);
  await accessOrder(pool, actor, String(req.params.id));
  res
    .status(201)
    .json(
      await one(
        pool,
        'INSERT INTO complaints(id,order_id,customer_id,content) VALUES($1,$2,$3,$4) RETURNING *',
        [id(), req.params.id, actor.id, content],
      ),
    );
});
operations.get('/complaints', async (req, res) => {
  const actor = user(req, 'CUSTOMER', 'ADMIN');
  res.json(
    (
      await pool.query(
        "SELECT * FROM complaints WHERE $1='ADMIN' OR customer_id=$2 ORDER BY created_at DESC LIMIT 100",
        [actor.role, actor.id],
      )
    ).rows,
  );
});
operations.get('/notifications', async (req, res) => {
  const actor = user(req);
  res.json(
    (
      await pool.query(
        'SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',
        [actor.id],
      )
    ).rows,
  );
});
operations.post('/notifications/read', async (req, res) => {
  const actor = user(req);
  await pool.query('UPDATE notifications SET read=true WHERE user_id=$1', [actor.id]);
  res.json({ ok: true });
});
operations.get('/reports', async (req, res) => {
  const actor = user(req, 'ADMIN', 'RESTAURANT');
  const filter =
    "($1='ADMIN' OR EXISTS(SELECT 1 FROM restaurant_members m WHERE m.restaurant_id=o.restaurant_id AND m.user_id=$2))";
  const summary = await one(
    pool,
    `SELECT count(*)::int AS orders,count(*) FILTER(WHERE status='DELIVERED')::int AS delivered,count(*) FILTER(WHERE status='DELIVERY_FAILED')::int AS delivery_failed,COALESCE(sum(total) FILTER(WHERE status='DELIVERED'),0)::bigint AS revenue,count(*) FILTER(WHERE status='PENDING_PAYMENT')::int AS pending FROM orders o WHERE ${filter}`,
    [actor.role, actor.id],
  );
  const daily = (
    await pool.query(
      `SELECT to_char(created_at,'YYYY-MM-DD') AS day,count(*)::int AS orders,COALESCE(sum(total) FILTER(WHERE status='DELIVERED'),0)::bigint AS revenue FROM orders o WHERE ${filter} GROUP BY 1 ORDER BY 1 DESC LIMIT 14`,
      [actor.role, actor.id],
    )
  ).rows;
  res.json({
    ...summary,
    daily,
    revenueBasis:
      'Gross order value including delivery fees, delivered orders only; grouped by order creation date (database UTC).',
  });
});
operations.get('/admin/overview', async (req, res) => {
  user(req, 'ADMIN');
  res.json({
    restaurants: (await pool.query('SELECT * FROM restaurants ORDER BY created_at DESC')).rows,
    users: (await pool.query('SELECT id,name,email,role,active FROM users ORDER BY name')).rows,
    audit: (await pool.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100')).rows,
    reviews: (await pool.query('SELECT * FROM reviews ORDER BY created_at DESC LIMIT 100')).rows,
    reconciliation: (
      await pool.query(
        "SELECT * FROM payments WHERE reconciliation_required OR status='REFUND_PENDING'",
      )
    ).rows,
    outbox: await one(
      pool,
      'SELECT count(*)::int AS pending,count(*) FILTER(WHERE attempts>=5)::int AS failed FROM outbox WHERE processed_at IS NULL',
    ),
  });
});
operations.post('/admin/restaurants/:id/approval', async (req, res) => {
  const actor = user(req, 'ADMIN');
  const { status } = z.object({ status: z.enum(['APPROVED', 'REJECTED']) }).parse(req.body);
  await transaction(async (db) => {
    const r = await one(
      db,
      "UPDATE restaurants SET status=$1,approved_at=CASE WHEN $1='APPROVED' THEN now() ELSE NULL END WHERE id=$2 RETURNING id",
      [status, req.params.id],
    );
    check(r, 404, 'NOT_FOUND', 'Restaurant not found.');
    await audit(db, actor.id, 'RESTAURANT_' + status, r.id);
  });
  res.json({ ok: true });
});
operations.patch('/admin/users/:id', async (req, res) => {
  const actor = user(req, 'ADMIN');
  const { active } = z.object({ active: z.boolean() }).parse(req.body);
  check(req.params.id !== actor.id, 409, 'SELF_CHANGE', 'You cannot disable your own account.');
  await transaction(async (db) => {
    const target = await one(db, 'UPDATE users SET active=$1 WHERE id=$2 RETURNING id', [
      active,
      req.params.id,
    ]);
    check(target, 404, 'NOT_FOUND', 'Account not found.');
    if (!active) await db.query('DELETE FROM sessions WHERE user_id=$1', [target.id]);
    await audit(db, actor.id, 'ACCOUNT_STATUS', target.id, { active });
  });
  res.json({ ok: true });
});
operations.post('/admin/complaints/:id/resolve', async (req, res) => {
  const actor = user(req, 'ADMIN');
  const { resolution } = z
    .object({ resolution: z.string().trim().min(3).max(1000) })
    .parse(req.body);
  await transaction(async (db) => {
    const c = await one(
      db,
      "UPDATE complaints SET status='RESOLVED',resolution=$1 WHERE id=$2 AND status='OPEN' RETURNING *",
      [resolution, req.params.id],
    );
    check(c, 409, 'INVALID_COMPLAINT', 'Complaint not found or already resolved.');
    await audit(db, actor.id, 'COMPLAINT_RESOLVED', c.id);
    await notify(db, c.customer_id, 'COMPLAINT_RESOLVED', { orderId: c.order_id, resolution });
  });
  res.json({ ok: true });
});
operations.patch('/admin/reviews/:id', async (req, res) => {
  const actor = user(req, 'ADMIN');
  const { hidden } = z.object({ hidden: z.boolean() }).parse(req.body);
  await transaction(async (db) => {
    const r = await one(db, 'UPDATE reviews SET hidden=$1 WHERE id=$2 RETURNING id', [
      hidden,
      req.params.id,
    ]);
    check(r, 404, 'NOT_FOUND', 'Review not found.');
    await audit(db, actor.id, 'REVIEW_MODERATED', r.id, { hidden });
  });
  res.json({ ok: true });
});
export async function deliverNotifications() {
  return transaction(async (db) => {
    const events = (
      await db.query(
        'SELECT * FROM outbox WHERE processed_at IS NULL AND attempts<5 AND available_at<=now() ORDER BY available_at LIMIT 50 FOR UPDATE SKIP LOCKED',
      )
    ).rows;
    for (const e of events) {
      await db.query('SAVEPOINT notification_attempt');
      try {
        await db.query(
          'INSERT INTO notifications(id,user_id,type,payload) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING',
          [e.id, e.user_id, e.type, e.payload],
        );
        await db.query('UPDATE outbox SET processed_at=now(),attempts=attempts+1 WHERE id=$1', [
          e.id,
        ]);
      } catch {
        await db.query('ROLLBACK TO SAVEPOINT notification_attempt');
        await db.query(
          "UPDATE outbox SET attempts=attempts+1,last_error='Notification delivery failed',available_at=now()+interval '30 seconds' WHERE id=$1",
          [e.id],
        );
      }
      await db.query('RELEASE SAVEPOINT notification_attempt');
    }
    return events.length;
  });
}
