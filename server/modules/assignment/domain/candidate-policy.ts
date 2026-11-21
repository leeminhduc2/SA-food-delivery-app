import { haversineMeters, type AssignmentCandidate, type Point } from './assignment-strategy.js';
import { eligibilityFailure } from './eligibility.js';
export type CandidateFact = Readonly<{
  driverId: string;
  latitude: number;
  longitude: number;
  capturedAt: Date;
  receivedAt: Date;
  active: boolean;
  online: boolean;
  ready: boolean;
  heartbeatAt: Date | null;
  busy: boolean;
  excluded: boolean;
}>;
export type CandidatePolicy = Readonly<{
  radiusMeters: number;
  locationMaxAgeSeconds: number;
  locationMaxFutureSeconds: number;
  heartbeatMaxAgeSeconds: number;
}>;
/**
 * Why a driver cannot receive this offer. `LOCATION_MISSING` is decided by the
 * caller because a driver without a location row has no CandidateFact.
 */
export type CandidateExclusionReason =
  | 'LOCATION_MISSING'
  | 'INVALID_LOCATION'
  | 'ACCOUNT_INACTIVE'
  | 'DRIVER_OFFLINE'
  | 'DRIVER_NOT_READY'
  | 'HEARTBEAT_STALE'
  | 'LOCATION_STALE'
  | 'DRIVER_BUSY'
  | 'ALREADY_TRIED'
  | 'OUT_OF_RANGE';

export function validPickup(pickup: Point): boolean {
  return (
    Number.isFinite(pickup.latitude) &&
    Number.isFinite(pickup.longitude) &&
    Math.abs(pickup.latitude) <= 90 &&
    Math.abs(pickup.longitude) <= 180
  );
}

/**
 * Same predicate as `isEligibleForAssignment`, plus radius and attempt
 * exclusion, but returns the first blocking reason for operator diagnostics.
 * `null` means the driver is eligible.
 */
export function candidateExclusionReason(
  fact: CandidateFact,
  pickup: Point,
  now: Date,
  policy: CandidatePolicy,
): CandidateExclusionReason | null {
  const timestamp = now.getTime();
  const capturedAge = timestamp - fact.capturedAt.getTime();
  const receivedAge = timestamp - fact.receivedAt.getTime();
  if (
    ![fact.latitude, fact.longitude, capturedAge, receivedAge].every(Number.isFinite) ||
    Math.abs(fact.latitude) > 90 ||
    Math.abs(fact.longitude) > 180
  )
    return 'INVALID_LOCATION';
  // A missing heartbeat row is stale, not an invalid coordinate.
  const heartbeatAge = fact.heartbeatAt ? timestamp - fact.heartbeatAt.getTime() : null;
  const heartbeatFresh =
    heartbeatAge !== null &&
    Number.isFinite(heartbeatAge) &&
    heartbeatAge >= 0 &&
    heartbeatAge <= policy.heartbeatMaxAgeSeconds * 1000;
  const locationFresh =
    capturedAge >= -policy.locationMaxFutureSeconds * 1000 &&
    capturedAge <= policy.locationMaxAgeSeconds * 1000 &&
    receivedAge >= 0 &&
    receivedAge <= policy.locationMaxAgeSeconds * 1000;
  const failure = eligibilityFailure({
    active: fact.active,
    online: fact.online,
    ready: fact.ready,
    busy: fact.busy,
    heartbeatFresh,
    locationFresh,
  });
  if (failure) return failure;
  if (fact.excluded) return 'ALREADY_TRIED';
  if (!validPickup(pickup) || haversineMeters(pickup, fact) > policy.radiusMeters)
    return 'OUT_OF_RANGE';
  return null;
}

export function selectEligibleCandidates(
  facts: readonly CandidateFact[],
  pickup: Point,
  now: Date,
  policy: CandidatePolicy,
): AssignmentCandidate[] {
  if (!validPickup(pickup)) return [];
  return facts
    .filter((fact) => candidateExclusionReason(fact, pickup, now, policy) === null)
    .map((fact) => ({
      driverId: fact.driverId,
      location: { latitude: fact.latitude, longitude: fact.longitude },
    }));
}
