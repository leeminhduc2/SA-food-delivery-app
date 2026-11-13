import type { TrackingAccessGateway, TrackingRouteGateway } from '../../location/index.js';
import { prisma } from '../../../shared/db.js';
import { assignmentContext } from '../infrastructure/assignment-order.projection.js';
import { trackingDeliveryForOrder } from '../../delivery/index.js';
import { activeDriverDisplay } from '../../identity/index.js';
import { check } from '../../../shared/errors.js';
import { accessOrder } from './order-queries.js';

export const trackingAccessGateway: TrackingAccessGateway = async (actor, orderId, signal) => {
  await accessOrder(undefined, actor, orderId, false, signal);
  signal?.throwIfAborted();
  const delivery = await trackingDeliveryForOrder(orderId);
  signal?.throwIfAborted();
  const active = delivery && ['ASSIGNED', 'PICKED_UP', 'IN_TRANSIT'].includes(delivery.status);
  const assignment = active ? delivery.assignments[0] : undefined;
  const driverId =
    assignment && assignment.driver_id === delivery?.driver_id ? assignment.driver_id : null;
  if (actor.role === 'DRIVER' && active)
    check(driverId === actor.id, 403, 'FORBIDDEN', 'This delivery is not assigned to you.');
  const driver = driverId ? await activeDriverDisplay(driverId) : null;
  signal?.throwIfAborted();
  return {
    orderId,
    deliveryId: delivery?.id ?? null,
    status: delivery?.status ?? 'UNASSIGNED',
    driverId,
    assignmentId: driverId ? assignment!.id : null,
    driver,
  };
};

export const trackingRouteGateway: TrackingRouteGateway = async (actor, orderId) => {
  check(
    actor.role === 'DRIVER',
    403,
    'FORBIDDEN',
    'Only the assigned driver can request navigation.',
  );
  const order = await accessOrder(undefined, actor, orderId);
  const tracking = await trackingAccessGateway(actor, orderId);
  check(
    tracking.driverId === actor.id &&
      tracking.assignmentId &&
      tracking.driver &&
      tracking.deliveryId,
    403,
    'FORBIDDEN',
    'This delivery is not assigned to you.',
  );
  const pickupContext = (await assignmentContext(tracking.deliveryId, prisma))?.pickup;
  const pickup = pickupContext
    ? {
        name: pickupContext.name,
        latitude: pickupContext.latitude,
        longitude: pickupContext.longitude,
      }
    : null;
  const dropoff =
    order.delivery_latitude === null || order.delivery_longitude === null
      ? null
      : {
          latitude: order.delivery_latitude,
          longitude: order.delivery_longitude,
          name: 'Drop-off',
        };
  return { assignmentId: tracking.assignmentId, pickup, dropoff };
};
