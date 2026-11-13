/**
 * Delivery module public API. Other modules import only from this file.
 * Delivery never imports Ordering: it reads orders through DeliveryOrderGateway
 * and announces progress as DeliveryPickedUp / DeliveryCompleted / DeliveryFailed.
 */
export { deliveryRoutes } from './delivery.routes.js';
export { createOtpChallenge } from './application/delivery-proof.service.js';
export { cleanupStagedUploads } from './application/photo-proof.service.js';
export { purgeExpiredProofPhotos } from './application/proof-retention.service.js';
export { createLocalProofStorage } from './infrastructure/proof-storage.js';
export { deliveryConfig } from './config.js';
export { incidentForOrder } from './application/incident.service.js';
export {
  registerDeliveryHandlers,
  backfillEarningEstimates,
} from './application/driver-report.service.js';
export {
  setDeliveryOrderGateway,
  type DeliverableOrder,
  type DeliveryOrderGateway,
  setDriverOverride,
  setProofStorage,
  setProofHoldGateway,
  type ProofStorage,
} from './delivery.ports.js';
export {
  cancelDelivery,
  createDelivery,
  isDriverAssigned,
  driverParticipated,
  hasActiveTrip,
  activeDeliveryForDriver,
  unassignedDeliveriesForBootstrap,
  activeAssignmentsForBootstrap,
  revokeUnavailableDriver,
  recordOperationalIncident,
  busyDriverIds,
  deliveryForOrderLocked,
  trackingDeliveryForOrder,
  deliveryForAssignmentLocked,
  deliveryForAssignment,
  hasOperationalIncident,
  applyAdminDriverOverride,
  confirmOfferAssignment,
} from './application/delivery.service.js';
