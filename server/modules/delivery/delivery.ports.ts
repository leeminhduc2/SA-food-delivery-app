import type { DB } from '../../shared/db.js';

/** What Delivery needs to know about an order. Owned by Delivery, implemented by Ordering. */
export type DeliverableOrder = { id: string; status: string };

export interface DeliveryOrderGateway {
  /** Locks the order row before any delivery row, matching Ordering's cancel flow. */
  lockOrder(db: DB, orderId: string): Promise<DeliverableOrder | undefined>;
  acceptsDriverAssignment(order: DeliverableOrder): boolean;
  isReadyForPickup(order: DeliverableOrder): boolean;
}

let gateway: DeliveryOrderGateway | undefined;

export function setDeliveryOrderGateway(implementation: DeliveryOrderGateway): void {
  gateway = implementation;
}

export function orderGateway(): DeliveryOrderGateway {
  if (!gateway) throw new Error('Delivery module is not wired. Call registerModules() first.');
  return gateway;
}
