import { dbNow, prisma, type DB } from '../../../shared/db.js';
import { candidateSources, type CandidateSources } from '../candidate.ports.js';
import { assignmentConfig, type AssignmentConfig } from '../config.js';
import { selectEligibleCandidates } from '../domain/candidate-policy.js';
import type { AssignmentCandidate, Point } from '../domain/assignment-strategy.js';
import {
  candidateAvailability,
  excludedCandidateIds,
} from '../infrastructure/assignment.repository.js';

export async function findEligibleCandidates(
  searchId: string,
  pickup: Point,
  db: DB = prisma,
  ports: CandidateSources = candidateSources(),
  config: AssignmentConfig = assignmentConfig,
): Promise<AssignmentCandidate[]> {
  const [locations, now] = await Promise.all([ports.locations(db), dbNow(db)]);
  const ids = locations.map((location) => location.driverId);
  if (!ids.length) return [];
  const [active, busy, availability, excluded] = await Promise.all([
    ports.activeDrivers(ids, db),
    ports.busyDrivers(ids, db),
    candidateAvailability(ids, db),
    excludedCandidateIds(searchId, ids, db),
  ]);
  const activeSet = new Set(active),
    busySet = new Set(busy),
    excludedSet = new Set(excluded);
  const states = new Map(availability.map((row) => [row.driverId, row]));
  return selectEligibleCandidates(
    locations.map((location) => {
      const state = states.get(location.driverId);
      return {
        ...location,
        active: activeSet.has(location.driverId),
        busy: busySet.has(location.driverId),
        excluded: excludedSet.has(location.driverId),
        online: state?.online ?? false,
        ready: state?.ready ?? false,
        heartbeatAt: state?.heartbeatAt ?? null,
      };
    }),
    pickup,
    now,
    {
      radiusMeters: config.ASSIGNMENT_RADIUS_METERS,
      locationMaxAgeSeconds: config.DRIVER_LOCATION_MAX_AGE_SECONDS,
      locationMaxFutureSeconds: config.DRIVER_LOCATION_MAX_FUTURE_SECONDS,
      heartbeatMaxAgeSeconds: config.DRIVER_HEARTBEAT_MAX_AGE_SECONDS,
    },
  );
}
