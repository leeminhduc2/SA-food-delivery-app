import type { User } from '../../shared/types.js';

export type TrackingAccess = {
  orderId: string;
  deliveryId: string | null;
  status: string;
  driverId: string | null;
  assignmentId: string | null;
  driver: { id: string; name: string } | null;
};
export type TrackingAccessGateway = (
  actor: User,
  orderId: string,
  signal?: AbortSignal,
) => Promise<TrackingAccess>;
let gateway: TrackingAccessGateway | undefined;
export function setTrackingAccessGateway(value: TrackingAccessGateway): void {
  gateway = value;
}
export function trackingAccessGateway(): TrackingAccessGateway {
  if (!gateway) throw new Error('Tracking access gateway not configured');
  return gateway;
}
