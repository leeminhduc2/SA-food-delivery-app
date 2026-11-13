export { assignmentRoutes } from './assignment.routes.js';
export { parseAssignmentConfig, assignmentConfig } from './config.js';
export { retainDriverLocation } from './application/location-retention.service.js';
export { isEligibleForAssignment } from './domain/eligibility.js';
export { getAvailability } from './application/availability.service.js';
export { setCandidateSources, type CandidateSources } from './candidate.ports.js';
export { findEligibleCandidates } from './application/candidates.service.js';
export {
  nearestStrategy,
  type AssignmentStrategy,
  type AssignmentCandidate,
  type RankedDriver,
  type Point,
} from './domain/assignment-strategy.js';
export { setAssignmentOrderGateway, type AssignmentOrderGateway } from './assignment.ports.js';
export { registerAssignmentHandlers, runAssignmentWorker } from './application/search.service.js';
export { runOperationalInvalidation } from './application/operational-invalidation.service.js';
export { overrideDriver } from './application/admin-override.service.js';
export { bootstrapAssignmentSearches } from './application/bootstrap.service.js';
