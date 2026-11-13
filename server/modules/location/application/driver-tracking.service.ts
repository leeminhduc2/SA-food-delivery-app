import { dbNow } from '../../../shared/db.js';
import type { User } from '../../../shared/types.js';
import { locationDependencies } from '../driver-location.ports.js';
import { trackingAccessGateway, type TrackingAccess } from '../tracking.ports.js';
import { locationFresh, trackingLocationSnapshot } from './driver-location.service.js';

export type TrackingSnapshot = {
  orderId: string;
  deliveryId: string | null;
  status: string;
  driver: { id: string; name: string } | null;
  location: { latitude: number; longitude: number } | null;
  routeMode: 'WALKING';
  capturedAt: string | null;
  stale: boolean;
  reason: string | null;
};
export type AuthorizedTracking = {
  snapshot: TrackingSnapshot;
  assignmentId: string | null;
  driverId: string | null;
};
const terminal = (status: string) => ['DELIVERED', 'FAILED', 'CANCELLED'].includes(status);
export function terminalTracking(status: string): boolean {
  return terminal(status);
}
function empty(access: TrackingAccess, reason: string): AuthorizedTracking {
  return {
    assignmentId: access.assignmentId,
    driverId: access.driverId,
    snapshot: {
      orderId: access.orderId,
      deliveryId: access.deliveryId,
      status: access.status,
      driver: terminal(access.status) ? null : access.driver,
      location: null,
      routeMode: 'WALKING',
      capturedAt: null,
      stale: true,
      reason,
    },
  };
}
/** Authorize before and after reading GPS so a reassignment cannot return the old driver's data. */
export async function authorizedTrackingSnapshot(
  actor: User,
  orderId: string,
  signal?: AbortSignal,
): Promise<AuthorizedTracking> {
  const access = await trackingAccessGateway()(actor, orderId, signal);
  signal?.throwIfAborted();
  if (terminal(access.status)) return empty(access, 'TERMINAL');
  if (!access.driverId || !access.assignmentId) return empty(access, 'NO_DRIVER');
  if (!access.driver) return empty(access, 'DRIVER_UNAVAILABLE');
  const [location, now] = await Promise.all([
    trackingLocationSnapshot(access.driverId, signal),
    dbNow(),
  ]);
  signal?.throwIfAborted();
  const current = await trackingAccessGateway()(actor, orderId, signal);
  signal?.throwIfAborted();
  if (
    current.assignmentId !== access.assignmentId ||
    current.driverId !== access.driverId ||
    !current.driver ||
    terminal(current.status)
  )
    return empty(current, terminal(current.status) ? 'TERMINAL' : 'ASSIGNMENT_CHANGED');
  if (!location) return empty(current, 'LOCATION_UNAVAILABLE');
  const policy = locationDependencies().policy;
  const fresh = locationFresh(location, now, policy.maxAgeSeconds, policy.maxFutureSeconds);
  return {
    assignmentId: current.assignmentId,
    driverId: current.driverId,
    snapshot: {
      orderId,
      deliveryId: current.deliveryId,
      status: current.status,
      driver: current.driver,
      location: { latitude: location.latitude, longitude: location.longitude },
      routeMode: 'WALKING',
      capturedAt: location.captured_at.toISOString(),
      stale: !fresh,
      reason: fresh ? null : 'STALE_LOCATION',
    },
  };
}
