import { id, type DB } from '../../../shared/db.js';
import { check } from '../../../shared/errors.js';
import * as audits from '../../../shared/audit.repository.js';
import * as payments from '../infrastructure/payment.repository.js';
import { paymentAdapter, providerCall } from '../infrastructure/payment-provider.js';
import { attachRefundOperation } from './refund.service.js';

/** Commands Ordering issues to Payment. Each runs inside the caller's transaction. */
export async function createPayment(db: DB, orderId: string, amount: number): Promise<void> {
  await payments.insert(orderId, 'pay_' + id(), amount, db);
  await audits.history(orderId, 'PAYMENT', null, 'PENDING', 'system', '', db);
}

export async function ensurePayment(orderId: string): Promise<void> {
  const payment = await payments.findByOrder(orderId);
  if (payment?.status === 'PENDING' && !payment.provider_created) {
    await providerCall(() => paymentAdapter.create(payment.reference, payment.amount));
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
    if (next === 'REFUND_PENDING') await attachRefundOperation(db, payment, 'CANCELLATION', actor);
  }
}
