import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { id, transaction, type DB } from '../db.js';
import { check } from '../domain/errors.js';
import type { User } from '../domain/types.js';
import * as audits from '../repositories/audit.repository.js';
import * as orders from '../repositories/order.repository.js';
import * as payments from '../repositories/payment.repository.js';
import { cancelDelivery } from './delivery.service.js';
import { accessOrder, changeOrder, releaseOrderStock } from './order.service.js';

export const simulated = () => process.env.PAYMENT_MODE === 'simulated';

// Adapter boundary: a real provider must implement create/query/refund with the same stable reference.
export const paymentAdapter = {
  async create(reference: string, amount: number) {
    check(simulated(), 503, 'PROVIDER_UNAVAILABLE', 'No payment provider is configured.');
    await payments.insertSimulated(reference, amount, 'sim_' + reference);
    return this.query(reference);
  },
  async query(reference: string) {
    return payments.findSimulated(reference);
  },
  async refund(reference: string) {
    check(simulated(), 503, 'PROVIDER_UNAVAILABLE', 'Refund provider is not configured.');
    await payments.refundSimulated(reference);
    return this.query(reference);
  },
};

export async function createPayment(db: DB, orderId: string, amount: number): Promise<void> {
  await payments.insert(orderId, 'pay_' + id(), amount, db);
  await audits.history(orderId, 'PAYMENT', null, 'PENDING', 'system', '', db);
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

export async function ensurePayment(orderId: string): Promise<void> {
  const payment = await payments.findByOrder(orderId);
  if (payment?.status === 'PENDING' && !payment.provider_created) {
    await providerCall(paymentAdapter.create(payment.reference, payment.amount));
    await payments.setProviderCreated(payment.id);
  }
}

export async function cancelPayment(db: DB, orderId: string, actor: string): Promise<void> {
  const payment = await payments.findByOrderForUpdate(orderId, db);
  check(payment, 404, 'NOT_FOUND', 'Payment not found.');
  const next =
    payment.status === 'SUCCEEDED'
      ? 'REFUND_PENDING'
      : payment.status === 'PENDING'
        ? 'EXPIRED'
        : payment.status;
  if (next !== payment.status) {
    await payments.setStatus(payment.id, next, db);
    await audits.history(orderId, 'PAYMENT', payment.status, next, actor, '', db);
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

export async function applyPayment(raw: unknown): Promise<{ duplicate: boolean }> {
  const event = eventSchema.parse(raw);
  const fingerprint = createHash('sha256').update(JSON.stringify(event)).digest('hex');
  return transaction(async (db) => {
    const order = await orders.findById(event.orderId, db, true);
    check(order, 404, 'NOT_FOUND', 'Order not found.');
    const payment = await payments.findByReferenceForUpdate(event.reference, db);
    check(
      payment &&
        payment.order_id === order.id &&
        payment.amount === event.amount &&
        payment.currency === event.currency,
      400,
      'PAYMENT_MISMATCH',
      'Payment details do not match.',
    );
    const old = await payments.findEvent(event.eventId, db);
    if (old) {
      check(
        old.payload_hash === fingerprint,
        409,
        'EVENT_CONFLICT',
        'Event ID already contains different payment details.',
      );
      return { duplicate: true };
    }
    await payments.insertEvent(event.eventId, event.reference, fingerprint, db);
    if (['SUCCEEDED', 'REFUND_PENDING', 'REFUNDED'].includes(payment.status)) {
      check(
        !payment.external_transaction_id ||
          payment.external_transaction_id === event.externalTransactionId,
        409,
        'TRANSACTION_CONFLICT',
        'Payment reference has a different transaction.',
      );
      return { duplicate: true };
    }
    if (event.status === 'SUCCEEDED') {
      const late =
        order.status !== 'PENDING_PAYMENT' || new Date(order.expires_at).getTime() <= Date.now();
      await payments.setSucceeded(
        payment.id,
        late ? 'REFUND_PENDING' : 'SUCCEEDED',
        event.externalTransactionId,
        late,
        db,
      );
      await audits.history(
        order.id,
        'PAYMENT',
        payment.status,
        late ? 'REFUND_PENDING' : 'SUCCEEDED',
        'provider',
        '',
        db,
      );
      if (late) {
        if (order.status === 'PENDING_PAYMENT') {
          await releaseOrderStock(db, order.id);
          await cancelDelivery(db, order.id, 'system');
          await changeOrder(db, order, 'PAYMENT_FAILED', 'system', 'Payment window expired');
        }
        await audits.audit('provider', 'LATE_PAYMENT', payment.id, {}, db);
      } else await changeOrder(db, order, 'CONFIRMED', 'provider');
    } else if (payment.status === 'PENDING') {
      await payments.setFailed(payment.id, event.externalTransactionId, db);
      await audits.history(order.id, 'PAYMENT', 'PENDING', 'FAILED', 'provider', '', db);
      if (order.status === 'PENDING_PAYMENT') {
        await releaseOrderStock(db, order.id);
        await cancelDelivery(db, order.id, 'provider');
        await changeOrder(db, order, 'PAYMENT_FAILED', 'provider');
      }
    }
    return { duplicate: false };
  });
}

export function signature(body: string): string {
  check(
    process.env.PAYMENT_WEBHOOK_SECRET,
    503,
    'CONFIGURATION',
    'Payment webhook secret is not configured.',
  );
  return createHmac('sha256', process.env.PAYMENT_WEBHOOK_SECRET).update(body).digest('hex');
}

/** Verifies the raw bytes, then applies the event. Kept out of the route body. */
export async function handleWebhook(
  raw: string,
  given: string,
  requestId: string,
): Promise<{ duplicate: boolean }> {
  const expected = signature(raw);
  if (
    !/^[a-f0-9]{64}$/.test(given) ||
    !timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'))
  ) {
    await audits.audit('anonymous', 'INVALID_PAYMENT_SIGNATURE', requestId);
    check(false, 401, 'INVALID_SIGNATURE', 'Invalid payment signature.');
  }
  try {
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      check(false, 400, 'INVALID_JSON', 'Invalid JSON callback.');
    }
    return await applyPayment(event);
  } catch (error) {
    await audits.audit('provider', 'PAYMENT_CALLBACK_REJECTED', requestId);
    throw error;
  }
}

export async function simulate(
  actor: User,
  orderId: string,
  raw: unknown,
): Promise<{ duplicate: boolean }> {
  check(simulated(), 404, 'NOT_FOUND', 'Not found.');
  const order = await accessOrder(undefined, actor, orderId);
  check(
    order.status === 'PENDING_PAYMENT',
    409,
    'INVALID_TRANSITION',
    'This order is not awaiting payment.',
  );
  const { status } = z.object({ status: z.enum(['SUCCEEDED', 'FAILED']) }).parse(raw);
  await ensurePayment(order.id);
  const payment = await payments.findByOrder(order.id);
  check(payment, 404, 'NOT_FOUND', 'Payment not found.');
  const external =
    (await payments.setSimulatedStatus(payment.reference, status)) ||
    (await paymentAdapter.query(payment.reference));
  return applyPayment({
    eventId: 'sim_' + payment.reference + '_' + external.status,
    reference: payment.reference,
    orderId: order.id,
    amount: payment.amount,
    currency: payment.currency,
    status: external.status,
    externalTransactionId: external.external_id,
  });
}

export async function reconcilePayments(): Promise<void> {
  const pending = await payments.listPendingReconcile();
  for (const payment of pending) {
    try {
      if (payment.status === 'REFUND_PENDING') {
        const result = await providerCall(paymentAdapter.refund(payment.reference));
        if (result?.status === 'REFUNDED')
          await transaction(async (db) => {
            await orders.lock(payment.order_id, db);
            const current = await payments.findByIdForUpdate(payment.id, db);
            if (current?.status === 'REFUND_PENDING') {
              await payments.setRefunded(payment.id, db);
              await audits.history(
                payment.order_id,
                'PAYMENT',
                'REFUND_PENDING',
                'REFUNDED',
                'worker',
                '',
                db,
              );
            }
          });
        continue;
      }
      if (payment.status === 'PENDING') await ensurePayment(payment.order_id);
      const result = await providerCall(paymentAdapter.query(payment.reference));
      if (result && ['SUCCEEDED', 'FAILED'].includes(result.status)) {
        await applyPayment({
          eventId: 'query_' + payment.reference + '_' + result.status,
          reference: payment.reference,
          orderId: payment.order_id,
          amount: result.amount,
          currency: payment.currency,
          status: result.status,
          externalTransactionId: result.external_id,
        });
        continue;
      }
      if (payment.status === 'PENDING' && new Date(payment.expires_at).getTime() <= Date.now())
        await transaction(async (db) => {
          const order = await orders.lock(payment.order_id, db);
          if (order?.status === 'PENDING_PAYMENT') {
            await cancelPayment(db, order.id, 'worker');
            await releaseOrderStock(db, order.id);
            await cancelDelivery(db, order.id, 'worker');
            await changeOrder(db, order, 'PAYMENT_FAILED', 'worker', 'Payment window expired');
          }
        });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'payment_reconciliation_error',
          paymentId: payment.id,
          message: error instanceof Error ? error.message : 'unknown',
        }),
      );
      await payments.setReconciliationRequired(payment.id);
    } finally {
      await payments.setNextReconcile(payment.id);
    }
  }
  // Expire reservations even when the provider is unreachable; a later success is reconciled to a refund.
  const expired = await orders.listExpiredIds(100);
  for (const entry of expired)
    await transaction(async (db) => {
      const order = await orders.lock(entry.id, db);
      if (order?.status === 'PENDING_PAYMENT') {
        await cancelPayment(db, order.id, 'worker');
        await releaseOrderStock(db, order.id);
        await cancelDelivery(db, order.id, 'worker');
        await changeOrder(db, order, 'PAYMENT_FAILED', 'worker', 'Payment window expired');
      }
    });
}
