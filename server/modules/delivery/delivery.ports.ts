import type { DB } from '../../shared/db.js';
import type { User } from '../../shared/types.js';

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

export type DriverOverride = (
  actor: User,
  deliveryId: string,
  raw: unknown,
  correlationId?: string,
) => Promise<{ ok: boolean; assignmentId: string }>;
let driverOverride: DriverOverride | undefined;
export function setDriverOverride(implementation: DriverOverride): void {
  driverOverride = implementation;
}
export function getDriverOverride(): DriverOverride {
  if (!driverOverride) throw new Error('Driver override capability is not configured.');
  return driverOverride;
}
