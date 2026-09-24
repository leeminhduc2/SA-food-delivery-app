import { Router } from 'express';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { audit, check, history, user } from '../core.js';
import { id, one, pool, transaction, type DB } from '../db.js';
import { cancelDelivery } from './delivery.js';
import { accessOrder, changeOrder, releaseOrderStock } from './orders.js';
export const payments = Router();
export const simulated = () => process.env.PAYMENT_MODE === 'simulated';
// Adapter boundary: a real provider must implement create/query/refund with the same stable reference.
export const paymentAdapter = {
  async create(reference: string, amount: number) {
    check(simulated(), 503, 'PROVIDER_UNAVAILABLE', 'No payment provider is configured.');
    await pool.query(
      'INSERT INTO simulated_transactions(reference,amount,external_id) VALUES($1,$2,$3) ON CONFLICT(reference) DO NOTHING',
      [reference, amount, 'sim_' + reference],
    );
    return this.query(reference);
  },
  async query(reference: string) {
    return one(pool, 'SELECT * FROM simulated_transactions WHERE reference=$1', [reference]);
  },
  async refund(reference: string) {
    check(simulated(), 503, 'PROVIDER_UNAVAILABLE', 'Refund provider is not configured.');
    await pool.query(
      "UPDATE simulated_transactions SET status='REFUNDED' WHERE reference=$1 AND status='SUCCEEDED'",
      [reference],
    );
    return this.query(reference);
  },
};
export async function createPayment(db: DB, orderId: string, amount: number) {
  await db.query('INSERT INTO payments(id,order_id,reference,amount) VALUES($1,$2,$3,$4)', [
    id(),
    orderId,
    'pay_' + id(),
    amount,
  ]);
  await history(db, orderId, 'PAYMENT', null, 'PENDING', 'system');
}
async function providerCall<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Payment provider timeout')),
          Number(process.env.PROVIDER_TIMEOUT_MS || 3000),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
export async function ensurePayment(orderId: string) {
  const p = await one(pool, 'SELECT * FROM payments WHERE order_id=$1', [orderId]);
  if (p?.status === 'PENDING' && !p.provider_created) {
    await providerCall(paymentAdapter.create(p.reference, p.amount));
    await pool.query('UPDATE payments SET provider_created=true WHERE id=$1', [p.id]);
  }
}
export async function cancelPayment(db: DB, orderId: string, actor: string) {
  const p = await one(db, 'SELECT * FROM payments WHERE order_id=$1 FOR UPDATE', [orderId]);
  const next =
    p.status === 'SUCCEEDED' ? 'REFUND_PENDING' : p.status === 'PENDING' ? 'EXPIRED' : p.status;
  if (next !== p.status) {
    await db.query('UPDATE payments SET status=$1 WHERE id=$2', [next, p.id]);
    await history(db, orderId, 'PAYMENT', p.status, next, actor);
  }
}
export const eventSchema = z.object({
  eventId: z.string().min(1).max(150),
  reference: z.string().min(1).max(150),
  orderId: z.string().min(1),
  amount: z.number().int().positive(),
  currency: z.literal('VND'),
  status: z.enum(['SUCCEEDED', 'FAILED']),
  externalTransactionId: z.string().min(1).max(150),
});
export async function applyPayment(raw: unknown) {
  const e = eventSchema.parse(raw);
  const fingerprint = createHash('sha256').update(JSON.stringify(e)).digest('hex');
  return transaction(async (db) => {
    const o = await one(db, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [e.orderId]);
    check(o, 404, 'NOT_FOUND', 'Order not found.');
    const p = await one(db, 'SELECT * FROM payments WHERE reference=$1 FOR UPDATE', [e.reference]);
    check(
      p && p.order_id === o.id && p.amount === e.amount && p.currency === e.currency,
      400,
      'PAYMENT_MISMATCH',
      'Payment details do not match.',
    );
    const old = await one(db, 'SELECT * FROM payment_events WHERE event_id=$1', [e.eventId]);
    if (old) {
      check(
        old.payload_hash === fingerprint,
        409,
        'EVENT_CONFLICT',
        'Event ID already contains different payment details.',
      );
      return { duplicate: true };
    }
    await db.query('INSERT INTO payment_events(event_id,reference,payload_hash) VALUES($1,$2,$3)', [
      e.eventId,
      e.reference,
      fingerprint,
    ]);
    if (['SUCCEEDED', 'REFUND_PENDING', 'REFUNDED'].includes(p.status)) {
      check(
        !p.external_transaction_id || p.external_transaction_id === e.externalTransactionId,
        409,
        'TRANSACTION_CONFLICT',
        'Payment reference has a different transaction.',
      );
      return { duplicate: true };
    }
    if (e.status === 'SUCCEEDED') {
      const late = o.status !== 'PENDING_PAYMENT' || new Date(o.expires_at).getTime() <= Date.now();
      await db.query(
        'UPDATE payments SET status=$1,external_transaction_id=$2,reconciliation_required=$3 WHERE id=$4',
        [late ? 'REFUND_PENDING' : 'SUCCEEDED', e.externalTransactionId, late, p.id],
      );
      await history(
        db,
        o.id,
        'PAYMENT',
        p.status,
        late ? 'REFUND_PENDING' : 'SUCCEEDED',
        'provider',
      );
      if (late) {
        if (o.status === 'PENDING_PAYMENT') {
          await releaseOrderStock(db, o.id);
          await cancelDelivery(db, o.id, 'system');
          await changeOrder(db, o, 'PAYMENT_FAILED', 'system', 'Payment window expired');
        }
        await audit(db, 'provider', 'LATE_PAYMENT', p.id);
      } else await changeOrder(db, o, 'CONFIRMED', 'provider');
    } else if (p.status === 'PENDING') {
      await db.query("UPDATE payments SET status='FAILED',external_transaction_id=$1 WHERE id=$2", [
        e.externalTransactionId,
        p.id,
      ]);
      await history(db, o.id, 'PAYMENT', 'PENDING', 'FAILED', 'provider');
      if (o.status === 'PENDING_PAYMENT') {
        await releaseOrderStock(db, o.id);
        await cancelDelivery(db, o.id, 'provider');
        await changeOrder(db, o, 'PAYMENT_FAILED', 'provider');
      }
    }
    return { duplicate: false };
  });
}
export function signature(body: string) {
  check(
    process.env.PAYMENT_WEBHOOK_SECRET,
    503,
    'CONFIGURATION',
    'Payment webhook secret is not configured.',
  );
  return createHmac('sha256', process.env.PAYMENT_WEBHOOK_SECRET).update(body).digest('hex');
}
// Raw body is required; mounted before express.json in app.ts.
payments.post('/webhook', async (req, res) => {
  check(Buffer.isBuffer(req.body), 400, 'INVALID_BODY', 'Expected a JSON payment callback.');
  const raw = (req.body as Buffer).toString('utf8');
  const given = String(req.headers['x-payment-signature'] || '');
  const expected = signature(raw);
  if (
    !/^[a-f0-9]{64}$/.test(given) ||
    !timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'))
  ) {
    await audit(pool, 'anonymous', 'INVALID_PAYMENT_SIGNATURE', req.requestId);
    check(false, 401, 'INVALID_SIGNATURE', 'Invalid payment signature.');
  }
  try {
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      check(false, 400, 'INVALID_JSON', 'Invalid JSON callback.');
    }
    res.json(await applyPayment(event));
  } catch (e) {
    await audit(pool, 'provider', 'PAYMENT_CALLBACK_REJECTED', req.requestId);
    throw e;
  }
});
export const paymentActions = Router();
paymentActions.post('/orders/:id/simulate-payment', async (req, res) => {
  check(simulated(), 404, 'NOT_FOUND', 'Not found.');
  const actor = user(req, 'CUSTOMER');
  const o = await accessOrder(pool, actor, String(req.params.id));
  check(
    o.status === 'PENDING_PAYMENT',
    409,
    'INVALID_TRANSITION',
    'This order is not awaiting payment.',
  );
  const { status } = z.object({ status: z.enum(['SUCCEEDED', 'FAILED']) }).parse(req.body);
  await ensurePayment(o.id);
  const p = await one(pool, 'SELECT * FROM payments WHERE order_id=$1', [o.id]);
  const external =
    (await one(
      pool,
      "UPDATE simulated_transactions SET status=$1 WHERE reference=$2 AND status='PENDING' RETURNING *",
      [status, p.reference],
    )) || (await paymentAdapter.query(p.reference));
  res.json(
    await applyPayment({
      eventId: 'sim_' + p.reference + '_' + external.status,
      reference: p.reference,
      orderId: o.id,
      amount: p.amount,
      currency: p.currency,
      status: external.status,
      externalTransactionId: external.external_id,
    }),
  );
});
export async function reconcilePayments() {
  const pending = (
    await pool.query(
      "SELECT p.*,o.expires_at,o.status AS order_status FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.next_reconcile_at<=now() AND (p.status IN ('PENDING','REFUND_PENDING') OR (p.status='EXPIRED' AND o.created_at>now()-interval '7 days')) ORDER BY p.next_reconcile_at,p.created_at LIMIT 100",
    )
  ).rows;
  for (const p of pending) {
    try {
      if (p.status === 'REFUND_PENDING') {
        const result = await providerCall(paymentAdapter.refund(p.reference));
        if (result?.status === 'REFUNDED')
          await transaction(async (db) => {
            await db.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [p.order_id]);
            const current = await one(db, 'SELECT * FROM payments WHERE id=$1 FOR UPDATE', [p.id]);
            if (current.status === 'REFUND_PENDING') {
              await db.query(
                "UPDATE payments SET status='REFUNDED',reconciliation_required=false WHERE id=$1",
                [p.id],
              );
              await history(db, p.order_id, 'PAYMENT', 'REFUND_PENDING', 'REFUNDED', 'worker');
            }
          });
        continue;
      }
      if (p.status === 'PENDING') await ensurePayment(p.order_id);
      const result = await providerCall(paymentAdapter.query(p.reference));
      if (result && ['SUCCEEDED', 'FAILED'].includes(result.status)) {
        await applyPayment({
          eventId: 'query_' + p.reference + '_' + result.status,
          reference: p.reference,
          orderId: p.order_id,
          amount: result.amount,
          currency: p.currency,
          status: result.status,
          externalTransactionId: result.external_id,
        });
        continue;
      }
      if (p.status === 'PENDING' && new Date(p.expires_at).getTime() <= Date.now())
        await transaction(async (db) => {
          const o = await one(db, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [p.order_id]);
          if (o.status === 'PENDING_PAYMENT') {
            await cancelPayment(db, o.id, 'worker');
            await releaseOrderStock(db, o.id);
            await cancelDelivery(db, o.id, 'worker');
            await changeOrder(db, o, 'PAYMENT_FAILED', 'worker', 'Payment window expired');
          }
        });
    } catch (e) {
      console.error(
        JSON.stringify({
          event: 'payment_reconciliation_error',
          paymentId: p.id,
          message: e instanceof Error ? e.message : 'unknown',
        }),
      );
      await pool.query('UPDATE payments SET reconciliation_required=true WHERE id=$1', [p.id]);
    } finally {
      await pool.query(
        "UPDATE payments SET next_reconcile_at=now()+interval '3 seconds' WHERE id=$1",
        [p.id],
      );
    }
  }
  // Expire reservations even when the provider is unreachable; a later success is reconciled to a refund.
  const expired = (
    await pool.query(
      "SELECT id FROM orders WHERE status='PENDING_PAYMENT' AND expires_at<=now() LIMIT 100",
    )
  ).rows;
  for (const entry of expired)
    await transaction(async (db) => {
      const o = await one(db, 'SELECT * FROM orders WHERE id=$1 FOR UPDATE', [entry.id]);
      if (o.status === 'PENDING_PAYMENT') {
        await cancelPayment(db, o.id, 'worker');
        await releaseOrderStock(db, o.id);
        await cancelDelivery(db, o.id, 'worker');
        await changeOrder(db, o, 'PAYMENT_FAILED', 'worker', 'Payment window expired');
      }
    });
}
