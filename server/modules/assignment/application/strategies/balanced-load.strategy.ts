import {
  byDistance,
  nearestRanking,
  type AssignmentStrategy,
} from '../../domain/assignment-strategy.js';
import type { PickupLoadReader } from '../../strategy.ports.js';

export const LOAD_WINDOW_MS = 24 * 3600 * 1000;

/**
 * Fewest pickups in the closed window [now-24h, now], then Haversine, then
 * driver ID. Uses completed work, not active trips (always 0 for an eligible
 * driver). If the history is incomplete or unreadable, falls back to Nearest
 * with a reason instead of treating unknown as 0.
 */
export function createBalancedLoadStrategy(readLoads: PickupLoadReader): AssignmentStrategy {
  return {
    name: 'BALANCED_LOAD',
    async rank(context, candidates) {
      if (!candidates.length) return [];
      if (!context.now) return nearestRanking(context, candidates, 'CLOCK_UNAVAILABLE');
      const window = { from: new Date(context.now.getTime() - LOAD_WINDOW_MS), to: context.now };
      let loads: Awaited<ReturnType<PickupLoadReader>>;
      try {
        loads = await readLoads(
          candidates.map((candidate) => candidate.driverId),
          window,
        );
      } catch {
        return nearestRanking(context, candidates, 'LOAD_UNAVAILABLE');
      }
      if (!loads.complete) return nearestRanking(context, candidates, 'LOAD_HISTORY_INCOMPLETE');
      return byDistance(context, candidates)
        .map((entry) => ({ ...entry, pickups: loads.counts.get(entry.candidate.driverId) ?? 0 }))
        .sort(
          (a, b) =>
            a.pickups - b.pickups ||
            a.distance - b.distance ||
            a.candidate.driverId.localeCompare(b.candidate.driverId),
        )
        .map((entry, index) => ({
          driverId: entry.candidate.driverId,
          rank: index + 1,
          criterion: {
            kind: 'PICKUPS_24H' as const,
            pickups: entry.pickups,
            distanceMeters: entry.distance,
          },
          appliedStrategy: 'BALANCED_LOAD',
          rankingScope: 'ALL' as const,
          fallbackReason: null,
        }));
    },
  };
}
