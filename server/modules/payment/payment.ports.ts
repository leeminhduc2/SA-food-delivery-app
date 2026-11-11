import type { DB } from '../../shared/db.js';

/** What Payment needs to know about an order. Owned by Payment, implemented by Ordering. */
export type PayableOrder = { id: string; status: string; expiresAt: Date | string };

export interface PaymentOrderGateway {
  /**
   * Locks the order row for the rest of `db`'s transaction. Callers lock the
   * order before any payment row, matching Ordering's cancel flow, so the two
   * never wait on each other in opposite order.
   */
  lockOrder(db: DB, orderId: string): Promise<PayableOrder | undefined>;
  findOrder(orderId: string): Promise<PayableOrder | undefined>;
  isAwaitingPayment(order: PayableOrder): boolean;
  isPaymentWindowClosed(order: PayableOrder, now: Date): boolean;
  acceptsPayment(order: PayableOrder, now: Date): boolean;
}

let gateway: PaymentOrderGateway | undefined;

export function setPaymentOrderGateway(implementation: PaymentOrderGateway): void {
  gateway = implementation;
}

export function orderGateway(): PaymentOrderGateway {
  if (!gateway) throw new Error('Payment module is not wired. Call registerModules() first.');
  return gateway;
}
