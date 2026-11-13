import { z } from 'zod';
import type { User } from '../../../shared/types.js';
import { AppError, check } from '../../../shared/errors.js';
import { trackingAccessGateway, trackingRouteGateway } from '../tracking.ports.js';
import { authorizedTrackingSnapshot } from './driver-tracking.service.js';
import { RoutingProviderError, liveWalkingRoute } from './routing.service.js';

const query = z.object({ destination: z.enum(['pickup', 'dropoff']) });
export async function driverWalkingNavigation(actor: User, orderId: string, raw: unknown) {
  check(
    actor.role === 'DRIVER',
    403,
    'FORBIDDEN',
    'Only the assigned driver can request navigation.',
  );
  const { destination } = query.parse(raw);
  const context = await trackingRouteGateway()(actor, orderId);
  const current = await authorizedTrackingSnapshot(actor, orderId);
  check(
    current.assignmentId === context.assignmentId &&
      current.driverId === actor.id &&
      current.snapshot.location,
    409,
    'LOCATION_UNAVAILABLE',
    'A current driver location is required for navigation.',
  );
  check(
    !current.snapshot.stale,
    409,
    'STALE_LOCATION',
    'Refresh your location before requesting directions.',
  );
  check(
    current.snapshot.capturedAt,
    409,
    'LOCATION_UNAVAILABLE',
    'A current driver location is required for navigation.',
  );
  const target = context[destination];
  check(target, 409, 'ROUTE_DESTINATION_UNAVAILABLE', 'This destination has no coordinates.');
  let route;
  try {
    route = await liveWalkingRoute(current.snapshot.location, target);
  } catch (error) {
    if (error instanceof RoutingProviderError)
      throw new AppError(
        503,
        'ROUTE_UNAVAILABLE',
        'Walking directions are unavailable. Please try again.',
      );
    throw error;
  }
  const access = await trackingAccessGateway()(actor, orderId);
  check(
    access.assignmentId === context.assignmentId && access.driverId === actor.id && access.driver,
    403,
    'FORBIDDEN',
    'This delivery is no longer assigned to you.',
  );
  return {
    routeMode: 'WALKING' as const,
    destination,
    target,
    sourceCapturedAt: current.snapshot.capturedAt,
    ...route,
  };
}
