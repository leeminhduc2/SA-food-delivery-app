import type { DeliveryOrderGateway } from '../../delivery/index.js';
import type { PayableOrder, PaymentOrderGateway } from '../../payment/index.js';
import {
  acceptsDriverAssignment,
  acceptsPayment,
  isAwaitingPayment,
  isPaymentWindowClosed,
  isReadyForPickup,
} from '../domain/order-status.js';
import * as orders from '../infrastructure/order.repository.js';

const toPayable = (row: orders.OrderRow | undefined): PayableOrder | undefined =>
  row && { id: row.id, status: row.status, expiresAt: row.expires_at };

/** Ordering's implementation of the port Payment declares. Wired in modules/index.ts. */
export const paymentOrderGateway: PaymentOrderGateway = {
  lockOrder: async (db, orderId) => toPayable(await orders.findById(orderId, db, true)),
  findOrder: async (orderId) => toPayable(await orders.findById(orderId)),
  isAwaitingPayment: (order) => isAwaitingPayment(order.status),
  isPaymentWindowClosed: (order, now) => isPaymentWindowClosed(order.expiresAt, now),
  acceptsPayment: (order, now) => acceptsPayment(order, now),
};

/** Ordering's implementation of the port Delivery declares. Wired in modules/index.ts. */
export const deliveryOrderGateway: DeliveryOrderGateway = {
  lockOrder: async (db, orderId) => {
    const row = await orders.findById(orderId, db, true);
    return row && { id: row.id, status: row.status, customerId: row.customer_id };
  },
  acceptsDriverAssignment: (order) => acceptsDriverAssignment(order.status),
  isReadyForPickup: (order) => isReadyForPickup(order.status),
};
