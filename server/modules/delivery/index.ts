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
  setDriverOverride,
} from './delivery.ports.js';
export {
  cancelDelivery,
  createDelivery,
  isDriverAssigned,
  hasActiveTrip,
  activeDeliveryForDriver,
  unassignedDeliveriesForBootstrap,
  activeAssignmentsForBootstrap,
  revokeUnavailableDriver,
  recordOperationalIncident,
  busyDriverIds,
  deliveryForOrderLocked,
  deliveryForAssignmentLocked,
  deliveryForAssignment,
  applyAdminDriverOverride,
  confirmOfferAssignment,
} from './application/delivery.service.js';
