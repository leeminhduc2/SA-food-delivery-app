/**
 * Payment module public API. Other modules import only from this file.
 * Payment never imports Ordering: it reads orders through PaymentOrderGateway
 * and announces outcomes as PaymentSucceeded / PaymentFailed events.
 */
export { paymentRoutes } from './payment.routes.js';
export { refundRoutes } from './refund.routes.js';
export { processRefunds } from './application/refund.service.js';
export {
  setPaymentOrderGateway,
  setRefundContextGateway,
  type PaymentOrderGateway,
  type PayableOrder,
} from './payment.ports.js';
export { cancelPayment, createPayment, ensurePayment } from './application/payment-lifecycle.js';
export { signature, simulate } from './application/webhook.js';
export { listReconciliationQueue, reconcilePayments } from './application/reconcile.js';
export { paymentAdapter, simulated } from './infrastructure/payment-provider.js';
