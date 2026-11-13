import type { DB } from '../../shared/db.js';
import type { Point } from './domain/assignment-strategy.js';
export type AssignmentOrderContext = {
  orderId: string;
  pickup: (Point & { name: string; address: string }) | null;
  deliveryFee: number;
};
export interface AssignmentOrderGateway {
  context(deliveryId: string, db: DB): Promise<AssignmentOrderContext | null>;
  lockOrder(orderId: string, db: DB): Promise<{ id: string; status: string } | undefined>;
  notifyAssigned(orderId: string, assignmentId: string, db: DB): Promise<void>;
  notifyRevoked(orderId: string, workId: string, db: DB): Promise<void>;
}
let gateway: AssignmentOrderGateway | undefined;
export function setAssignmentOrderGateway(value: AssignmentOrderGateway): void {
  gateway = value;
}
export function assignmentOrderGateway(): AssignmentOrderGateway {
  if (!gateway) throw new Error('Assignment order gateway not configured');
  return gateway;
}
