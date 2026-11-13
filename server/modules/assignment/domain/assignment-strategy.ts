export type Point = Readonly<{ latitude: number; longitude: number }>;
export type AssignmentCandidate = Readonly<{ driverId: string; location: Point }>;
export const strategyNames = ['NEAREST', 'LOWEST_ETA', 'BALANCED_LOAD'] as const;
export type StrategyName = (typeof strategyNames)[number];

/** Typed ranking evidence recorded on the attempt. ETA is null when not routed, never 0. */
export type RankingCriterion =
  | Readonly<{ kind: 'HAVERSINE_METERS'; distanceMeters: number }>
  | Readonly<{
      kind: 'WALKING_ETA_SECONDS';
      etaSeconds: number | null;
      routeDistanceMeters: number | null;
      distanceMeters: number;
      routeMode: 'WALKING';
    }>
  | Readonly<{ kind: 'PICKUPS_24H'; pickups: number; distanceMeters: number }>;

export type RankingScope = 'ALL' | 'TOP5_NEAREST' | 'TAIL_NEAREST';
export type RankedDriver = Readonly<{
  driverId: string;
  rank: number;
  criterion: RankingCriterion;
  /** Strategy whose ordering produced this row (NEAREST after a fallback). */
  appliedStrategy?: StrategyName | string;
  rankingScope?: RankingScope;
  fallbackReason?: string | null;
}>;
/** `now` is the database clock; strategies never read the wall clock themselves. */
export type RankingContext = Readonly<{ pickup: Point; now?: Date }>;

/**
 * Ranks eligible candidates. Must return a permutation of the input IDs (no
 * additions, removals or duplicates), never mutate the input, never assign or
 * write, and break ties by driver ID. The worker revalidates eligibility.
 */
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

/** Candidates with their Haversine distance, nearest first, ties by driver ID. */
export function byDistance(context: RankingContext, candidates: readonly AssignmentCandidate[]) {
  return candidates
    .map((candidate) => ({
      candidate,
      distance: haversineMeters(context.pickup, candidate.location),
    }))
    .sort(
      (a, b) => a.distance - b.distance || a.candidate.driverId.localeCompare(b.candidate.driverId),
    );
}

/** Nearest ordering with an optional fallback label, shared by every strategy. */
export function nearestRanking(
  context: RankingContext,
  candidates: readonly AssignmentCandidate[],
  fallbackReason: string | null = null,
): RankedDriver[] {
  return byDistance(context, candidates).map((entry, index) => ({
    driverId: entry.candidate.driverId,
    rank: index + 1,
    criterion: { kind: 'HAVERSINE_METERS' as const, distanceMeters: entry.distance },
    appliedStrategy: 'NEAREST',
    rankingScope: 'ALL' as const,
    fallbackReason,
  }));
}

export const nearestStrategy: AssignmentStrategy = {
  name: 'NEAREST',
  async rank(context, candidates) {
    return nearestRanking(context, candidates);
  },
};
