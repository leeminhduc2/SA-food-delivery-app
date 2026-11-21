import { dbNow, prisma, type DB } from '../../../shared/db.js';
import {
  candidateSources,
  type CandidateLocation,
  type CandidateSources,
} from '../candidate.ports.js';
import { assignmentConfig, type AssignmentConfig } from '../config.js';
import {
  candidateExclusionReason,
  selectEligibleCandidates,
  validPickup,
  type CandidateExclusionReason,
  type CandidateFact,
  type CandidatePolicy,
} from '../domain/candidate-policy.js';
import {
  haversineMeters,
  type AssignmentCandidate,
  type Point,
} from '../domain/assignment-strategy.js';
import {
  candidateAvailability,
  excludedCandidateIds,
} from '../infrastructure/assignment.repository.js';

type AvailabilityState = { online: boolean; ready: boolean; heartbeatAt: Date | null };
type CandidateEvidence = {
  active: Set<string>;
  busy: Set<string>;
  excluded: Set<string>;
  states: Map<string, AvailabilityState>;
};

function policyOf(config: AssignmentConfig): CandidatePolicy {
  return {
    radiusMeters: config.ASSIGNMENT_RADIUS_METERS,
    locationMaxAgeSeconds: config.DRIVER_LOCATION_MAX_AGE_SECONDS,
    locationMaxFutureSeconds: config.DRIVER_LOCATION_MAX_FUTURE_SECONDS,
    heartbeatMaxAgeSeconds: config.DRIVER_HEARTBEAT_MAX_AGE_SECONDS,
  };
}

/** Loads the non-location facts once so eligibility is never duplicated. */
async function candidateEvidence(
  searchId: string,
  ids: readonly string[],
  db: DB,
  ports: CandidateSources,
): Promise<CandidateEvidence> {
  const [active, busy, availability, excluded] = await Promise.all([
    ports.activeDrivers(ids, db),
    ports.busyDrivers(ids, db),
    candidateAvailability(ids, db),
    excludedCandidateIds(searchId, ids, db),
  ]);
  return {
    active: new Set(active),
    busy: new Set(busy),
    excluded: new Set(excluded),
    states: new Map(
      availability.map((row) => [
        row.driverId,
        { online: row.online, ready: row.ready, heartbeatAt: row.heartbeatAt },
      ]),
    ),
  };
}

function candidateFact(location: CandidateLocation, evidence: CandidateEvidence): CandidateFact {
  const state = evidence.states.get(location.driverId);
  return {
    ...location,
    active: evidence.active.has(location.driverId),
    busy: evidence.busy.has(location.driverId),
    excluded: evidence.excluded.has(location.driverId),
    online: state?.online ?? false,
    ready: state?.ready ?? false,
    heartbeatAt: state?.heartbeatAt ?? null,
  };
}

export type CandidateDiagnostic = {
  driverId: string;
  eligible: boolean;
  reason: CandidateExclusionReason | null;
  distanceMeters: number | null;
};
export type CandidateDiagnostics = {
  pickup: Point;
  considered: number;
  eligible: number;
  reasons: Partial<Record<CandidateExclusionReason, number>>;
  drivers: CandidateDiagnostic[];
};

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
  const evidence = await candidateEvidence(searchId, ids, db, ports);
  return selectEligibleCandidates(
    locations.map((location) => candidateFact(location, evidence)),
    pickup,
    now,
    policyOf(config),
  );
}

/**
 * Read-only explanation of why each driver is or is not a candidate. It uses
 * the same policy function as assignment selection, so diagnostics cannot
 * drift from the eligibility rules.
 */
export async function explainCandidates(
  searchId: string,
  pickup: Point,
  db: DB = prisma,
  ports: CandidateSources = candidateSources(),
  config: AssignmentConfig = assignmentConfig,
): Promise<CandidateDiagnostics> {
  const [locations, allDrivers, now] = await Promise.all([
    ports.locations(db),
    ports.allDrivers(db),
    dbNow(db),
  ]);
  const byDriver = new Map(locations.map((location) => [location.driverId, location]));
  // Active drivers without a position are the LOCATION_MISSING case. Inactive
  // drivers without a position can never be assigned, so they are omitted.
  const ids = [...new Set([...byDriver.keys(), ...allDrivers])];
  const evidence = await candidateEvidence(searchId, ids, db, ports);
  const policy = policyOf(config);
  const drivers: CandidateDiagnostic[] = [];
  for (const driverId of ids) {
    const location = byDriver.get(driverId);
    const active = evidence.active.has(driverId);
    if (!location) {
      if (!active) continue;
      drivers.push({ driverId, eligible: false, reason: 'LOCATION_MISSING', distanceMeters: null });
      continue;
    }
    const fact = candidateFact(location, evidence);
    const reason = candidateExclusionReason(fact, pickup, now, policy);
    const distanceMeters =
      validPickup(pickup) &&
      Number.isFinite(location.latitude) &&
      Number.isFinite(location.longitude) &&
      Math.abs(location.latitude) <= 90 &&
      Math.abs(location.longitude) <= 180
        ? Math.round(haversineMeters(pickup, location))
        : null;
    drivers.push({ driverId, eligible: reason === null, reason, distanceMeters });
  }
  const reasons: Partial<Record<CandidateExclusionReason, number>> = {};
  for (const driver of drivers)
    if (driver.reason) reasons[driver.reason] = (reasons[driver.reason] ?? 0) + 1;
  drivers.sort((a, b) =>
    a.eligible === b.eligible ? a.driverId.localeCompare(b.driverId) : a.eligible ? -1 : 1,
  );
  return {
    pickup,
    considered: drivers.length,
    eligible: drivers.filter((driver) => driver.eligible).length,
    reasons,
    drivers,
  };
}
