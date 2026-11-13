import type { DB } from '../../shared/db.js';
import type { User } from '../../shared/types.js';

/** What Delivery needs to know about an order. Owned by Delivery, implemented by Ordering. */
export type DeliverableOrder = { id: string; status: string; customerId: string };

export interface DeliveryOrderGateway {
  /** Locks the order row before any delivery row, matching Ordering's cancel flow. */
  lockOrder(db: DB, orderId: string): Promise<DeliverableOrder | undefined>;
  acceptsDriverAssignment(order: DeliverableOrder): boolean;
  isReadyForPickup(order: DeliverableOrder): boolean;
  /** Throws 403/404 unless the actor may read this order (owner, member, assigned driver, admin). */
  authorizeViewer(actor: User, orderId: string): Promise<void>;
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

/** Private bytes for photo proofs. Keys come from newKey(), never from request input. */
export interface ProofStorage {
  newKey(): string;
  put(key: string, bytes: Buffer): Promise<void>;
  /** null when the bytes are missing; never substitutes placeholder content. */
  read(key: string): Promise<Buffer | null>;
  /** Idempotent: removing a missing key succeeds. */
  remove(key: string): Promise<void>;
}
let storage: ProofStorage | undefined;
export function setProofStorage(implementation: ProofStorage): void {
  storage = implementation;
}
export function proofStorage(): ProofStorage {
  if (!storage) throw new Error('Proof storage is not configured.');
  return storage;
}

/** Legal hold source owned by Support. Delivery never reads complaints directly. */
export type ProofHoldGateway = { hasOpenComplaint(orderId: string): Promise<boolean> };
let holds: ProofHoldGateway | undefined;
export function setProofHoldGateway(implementation: ProofHoldGateway): void {
  holds = implementation;
}
export function proofHolds(): ProofHoldGateway {
  if (!holds) throw new Error('Proof hold gateway is not configured.');
  return holds;
}
