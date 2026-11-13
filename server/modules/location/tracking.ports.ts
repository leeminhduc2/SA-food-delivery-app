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
export type TrackingRouteGateway = (
  actor: User,
  orderId: string,
) => Promise<{
  assignmentId: string;
  pickup: { latitude: number; longitude: number; name: string } | null;
  dropoff: { latitude: number; longitude: number; name: string } | null;
}>;
let gateway: TrackingAccessGateway | undefined;
let routeGateway: TrackingRouteGateway | undefined;
export function setTrackingAccessGateway(value: TrackingAccessGateway): void {
  gateway = value;
}
export function trackingAccessGateway(): TrackingAccessGateway {
  if (!gateway) throw new Error('Tracking access gateway not configured');
  return gateway;
}
export function setTrackingRouteGateway(value: TrackingRouteGateway): void {
  routeGateway = value;
}
export function trackingRouteGateway(): TrackingRouteGateway {
  if (!routeGateway) throw new Error('Tracking route gateway not configured');
  return routeGateway;
}
