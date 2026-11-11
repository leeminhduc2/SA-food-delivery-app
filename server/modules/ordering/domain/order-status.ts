/**
 * Order lifecycle rules. Pure functions: no database, no HTTP.
 * Other modules never hard-code order statuses; they ask Ordering through
 * the gateways in application/order-gateways.ts.
 */
export type OrderStatus =
  | 'PENDING_PAYMENT'
  | 'CONFIRMED'
  | 'ACCEPTED'
  | 'PREPARING'
  | 'READY_FOR_PICKUP'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'DELIVERY_FAILED'
  | 'CANCELLED'
  | 'PAYMENT_FAILED';

/** The only moves a restaurant may make, one step at a time. */
const RESTAURANT_STEPS: Record<string, string> = {
  CONFIRMED: 'ACCEPTED',
  ACCEPTED: 'PREPARING',
  PREPARING: 'READY_FOR_PICKUP',
};

export function canRestaurantTransition(from: string, to: string): boolean {
  return RESTAURANT_STEPS[from] === to;
}

/** Customers may cancel only before the restaurant accepts. */
export function canCustomerCancel(status: string): boolean {
  return status === 'PENDING_PAYMENT' || status === 'CONFIRMED';
}

export function isAwaitingPayment(status: string): boolean {
  return status === 'PENDING_PAYMENT';
}

export function isPaymentWindowClosed(expiresAt: Date | string, now: Date): boolean {
  return new Date(expiresAt).getTime() <= now.getTime();
}

/** A successful payment confirms the order only inside the payment window. */
export function acceptsPayment(
  order: { status: string; expiresAt: Date | string },
  now: Date,
): boolean {
  return isAwaitingPayment(order.status) && !isPaymentWindowClosed(order.expiresAt, now);
}

/** A driver can be (re)assigned from confirmation until pickup. */
export function acceptsDriverAssignment(status: string): boolean {
  return ['CONFIRMED', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(status);
}

export function isReadyForPickup(status: string): boolean {
  return status === 'READY_FOR_PICKUP';
}
