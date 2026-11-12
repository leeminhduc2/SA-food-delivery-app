/**
 * Delivery module public API. Other modules import only from this file.
 * Delivery never imports Ordering: it reads orders through DeliveryOrderGateway
 * and announces progress as DeliveryPickedUp / DeliveryCompleted / DeliveryFailed.
 */
export { deliveryRoutes } from './delivery.routes.js';
export {
  setDeliveryOrderGateway,
  type DeliverableOrder,
  type DeliveryOrderGateway,
} from './delivery.ports.js';
export {
  cancelDelivery,
  createDelivery,
  isDriverAssigned,
  hasActiveTrip,
  busyDriverIds,
  deliveryForOrderLocked,
  deliveryForAssignmentLocked,
} from './application/delivery.service.js';
