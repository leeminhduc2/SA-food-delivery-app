import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { transaction } from '../../../shared/db.js';
import { check } from '../../../shared/errors.js';
import { publish } from '../../../shared/events.js';
import * as audits from '../../../shared/audit.repository.js';
import * as payments from '../infrastructure/payment.repository.js';
import { paymentAdapter } from '../infrastructure/payment-provider.js';
import { orderGateway } from '../payment.ports.js';
import { ensurePayment } from './payment-lifecycle.js';

export const eventSchema = z.object({
  eventId: z.string().min(1).max(150),
  reference: z.string().min(1).max(150),
  orderId: z.string().min(1),
  amount: z.number().int().positive(),
  currency: z.literal('VND'),
  status: z.enum(['SUCCEEDED', 'FAILED']),
  externalTransactionId: z.string().min(1).max(150),
});

/**
 * Records a provider outcome. Payment decides only about the payment row;
 * what happens to the order is Ordering's reaction to the published event.
 */
export async function applyPayment(raw: unknown): Promise<{ duplicate: boolean }> {
  const event = eventSchema.parse(raw);
  const fingerprint = createHash('sha256').update(JSON.stringify(event)).digest('hex');
  const orders = orderGateway();
  return transaction(async (db) => {
    const order = await orders.lockOrder(db, event.orderId);
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
      const late = !orders.acceptsPayment(order, new Date());
      const next = late ? 'REFUND_PENDING' : 'SUCCEEDED';
      await payments.setSucceeded(payment.id, next, event.externalTransactionId, late, db);
      await audits.history(order.id, 'PAYMENT', payment.status, next, 'provider', '', db);
      if (late) {
        await publish(db, 'PaymentFailed', {
          orderId: order.id,
          actor: 'system',
          reason: 'Payment window expired',
        });
        await audits.audit('provider', 'LATE_PAYMENT', payment.id, {}, db);
      } else await publish(db, 'PaymentSucceeded', { orderId: order.id, actor: 'provider' });
    } else if (payment.status === 'PENDING') {
      await payments.setFailed(payment.id, event.externalTransactionId, db);
      await audits.history(order.id, 'PAYMENT', 'PENDING', 'FAILED', 'provider', '', db);
      await publish(db, 'PaymentFailed', { orderId: order.id, actor: 'provider' });
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

/**
 * Simulated provider outcome for demo mode. The caller (Ordering) has already
 * checked that the actor may pay for this order and that it awaits payment.
 */
export async function simulate(orderId: string, raw: unknown): Promise<{ duplicate: boolean }> {
  const { status } = z.object({ status: z.enum(['SUCCEEDED', 'FAILED']) }).parse(raw);
  await ensurePayment(orderId);
  const payment = await payments.findByOrder(orderId);
  check(payment, 404, 'NOT_FOUND', 'Payment not found.');
  const external =
    (await payments.setSimulatedStatus(payment.reference, status)) ||
    (await paymentAdapter.query(payment.reference));
  return applyPayment({
    eventId: 'sim_' + payment.reference + '_' + external.status,
    reference: payment.reference,
    orderId,
    amount: payment.amount,
    currency: payment.currency,
    status: external.status,
    externalTransactionId: external.external_id,
  });
}
