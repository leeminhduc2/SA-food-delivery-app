export type Point = Readonly<{ latitude: number; longitude: number }>;
export type AssignmentCandidate = Readonly<{ driverId: string; location: Point }>;
export type RankedDriver = Readonly<{
  driverId: string;
  rank: number;
  criterion: { kind: 'HAVERSINE_METERS'; distanceMeters: number };
}>;
export type RankingContext = Readonly<{ pickup: Point }>;
export interface AssignmentStrategy {
  readonly name: string;
  rank(
    context: RankingContext,
    candidates: readonly AssignmentCandidate[],
  ): Promise<readonly RankedDriver[]>;
}

export function haversineMeters(a: Point, b: Point): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitude = radians(b.latitude - a.latitude);
  const longitude = radians(b.longitude - a.longitude);
  const arc =
    Math.sin(latitude / 2) ** 2 +
    Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(longitude / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, arc))));
}
export const nearestStrategy: AssignmentStrategy = {
  name: 'NEAREST',
  async rank(context, candidates) {
    return candidates
      .map((candidate) => ({
        driverId: candidate.driverId,
        distance: haversineMeters(context.pickup, candidate.location),
      }))
      .sort((a, b) => a.distance - b.distance || a.driverId.localeCompare(b.driverId))
      .map((entry, index) => ({
        driverId: entry.driverId,
        rank: index + 1,
        criterion: { kind: 'HAVERSINE_METERS' as const, distanceMeters: entry.distance },
      }));
  },
};
