import type { DB } from '../../shared/db.js';
import type { User } from '../../shared/types.js';

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

/**
 * Facts refund eligibility needs from other modules, wired at the composition
 * root so Payment never imports Ordering, Delivery or Support.
 */
export interface RefundContextGateway {
  /** Throws 403/404 unless the actor may access the order. */
  orderForRefund(
    actor: User,
    orderId: string,
  ): Promise<{ id: string; status: string; customerId: string }>;
  failureIncident(orderId: string, incidentId?: string): Promise<{ id: string } | undefined>;
  complaint(orderId: string, complaintId: string): Promise<{ id: string } | undefined>;
}
let refundContext: RefundContextGateway | undefined;
export function setRefundContextGateway(implementation: RefundContextGateway): void {
  refundContext = implementation;
}
export function refundContextGateway(): RefundContextGateway {
  if (!refundContext) throw new Error('Refund context is not wired. Call registerModules() first.');
  return refundContext;
}

let gateway: PaymentOrderGateway | undefined;

export function setPaymentOrderGateway(implementation: PaymentOrderGateway): void {
  gateway = implementation;
}

export function orderGateway(): PaymentOrderGateway {
  if (!gateway) throw new Error('Payment module is not wired. Call registerModules() first.');
  return gateway;
}
