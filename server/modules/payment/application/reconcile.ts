import { transaction } from '../../../shared/db.js';
import { publish } from '../../../shared/events.js';
import * as audits from '../../../shared/audit.repository.js';
import * as payments from '../infrastructure/payment.repository.js';
import { paymentAdapter, providerCall } from '../infrastructure/payment-provider.js';
import { orderGateway } from '../payment.ports.js';
import { cancelPayment, ensurePayment } from './payment-lifecycle.js';
import { applyPayment } from './webhook.js';

/**
 * Worker step: settles refunds, queries the provider for pending payments and
 * expires payments whose order window has closed. Expiring orders that never
 * reached the provider is Ordering's job (`expireUnpaidOrders`).
 */
export async function reconcilePayments(): Promise<void> {
  const orders = orderGateway();
  const pending = await payments.listPendingReconcile();
  for (const payment of pending) {
    try {
      if (payment.status === 'REFUND_PENDING') {
        const result = await providerCall(paymentAdapter.refund(payment.reference));
        if (result?.status === 'REFUNDED')
          await transaction(async (db) => {
            await orders.lockOrder(db, payment.order_id);
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
      if (payment.status !== 'PENDING') continue;
      const snapshot = await orders.findOrder(payment.order_id);
      if (snapshot && orders.isPaymentWindowClosed(snapshot, new Date()))
        await transaction(async (db) => {
          const order = await orders.lockOrder(db, payment.order_id);
          if (order && orders.isAwaitingPayment(order)) {
            await cancelPayment(db, order.id, 'worker');
            await publish(db, 'PaymentFailed', {
              orderId: order.id,
              actor: 'worker',
              reason: 'Payment window expired',
            });
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
}

/** Back-office view: payments needing a human look or a pending refund. */
export async function listReconciliationQueue(): Promise<any[]> {
  return payments.listReconciliationQueue();
}
