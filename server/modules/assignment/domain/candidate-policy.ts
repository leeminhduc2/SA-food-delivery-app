import { haversineMeters, type AssignmentCandidate, type Point } from './assignment-strategy.js';
import { isEligibleForAssignment } from './eligibility.js';
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
export function selectEligibleCandidates(
  facts: readonly CandidateFact[],
  pickup: Point,
  now: Date,
  policy: CandidatePolicy,
): AssignmentCandidate[] {
  if (
    !Number.isFinite(pickup.latitude) ||
    !Number.isFinite(pickup.longitude) ||
    Math.abs(pickup.latitude) > 90 ||
    Math.abs(pickup.longitude) > 180
  )
    return [];
  const timestamp = now.getTime();
  return facts
    .filter((fact) => {
      const capturedAge = timestamp - fact.capturedAt.getTime();
      const receivedAge = timestamp - fact.receivedAt.getTime();
      const heartbeatAge = fact.heartbeatAt ? timestamp - fact.heartbeatAt.getTime() : Infinity;
      if (
        ![fact.latitude, fact.longitude, capturedAge, receivedAge, heartbeatAge].every(
          Number.isFinite,
        )
      )
        return false;
      if (Math.abs(fact.latitude) > 90 || Math.abs(fact.longitude) > 180 || fact.excluded)
        return false;
      const heartbeatFresh =
        heartbeatAge >= 0 && heartbeatAge <= policy.heartbeatMaxAgeSeconds * 1000;
      const locationFresh =
        capturedAge >= -policy.locationMaxFutureSeconds * 1000 &&
        capturedAge <= policy.locationMaxAgeSeconds * 1000 &&
        receivedAge >= 0 &&
        receivedAge <= policy.locationMaxAgeSeconds * 1000;
      return (
        isEligibleForAssignment({
          active: fact.active,
          online: fact.online,
          ready: fact.ready,
          busy: fact.busy,
          heartbeatFresh,
          locationFresh,
        }) && haversineMeters(pickup, fact) <= policy.radiusMeters
      );
    })
    .map((fact) => ({
      driverId: fact.driverId,
      location: { latitude: fact.latitude, longitude: fact.longitude },
    }));
}
