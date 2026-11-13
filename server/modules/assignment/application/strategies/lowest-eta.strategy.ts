import {
  byDistance,
  nearestRanking,
  type AssignmentStrategy,
  type RankedDriver,
} from '../../domain/assignment-strategy.js';
import type { RouteEstimator } from '../../strategy.ports.js';

export const LOWEST_ETA_SCOPE = 5;

/**
 * Lowest walking ETA among the five nearest eligible drivers. Routes are
 * requested through the injected estimator before any lock is taken (the
 * worker ranks outside transactions). If any of the five cannot be routed the
 * whole list falls back to Nearest with a reason; an unknown ETA is never 0.
 * Drivers beyond the five keep Nearest order with a null ETA.
 */
export function createLowestEtaStrategy(estimate: RouteEstimator): AssignmentStrategy {
  return {
    name: 'LOWEST_ETA',
    async rank(context, candidates) {
      const ordered = byDistance(context, candidates);
      const top = ordered.slice(0, LOWEST_ETA_SCOPE);
      const tail = ordered.slice(LOWEST_ETA_SCOPE);
      const routes = await Promise.allSettled(
        top.map((entry) => estimate(entry.candidate.location, context.pickup)),
      );
      const failed = routes.find(
        (route) =>
          route.status === 'rejected' ||
          !Number.isFinite(route.value.durationSeconds) ||
          route.value.durationSeconds < 0,
      );
      if (failed)
        return nearestRanking(
          context,
          candidates,
          failed.status === 'rejected'
            ? `ROUTE_${String((failed.reason as { code?: string })?.code ?? 'ERROR')}`
            : 'ROUTE_INVALID',
        );
      const routed = top
        .map((entry, index) => {
          const route = (
            routes[index] as PromiseFulfilledResult<{
              durationSeconds: number;
              distanceMeters: number;
            }>
          ).value;
          return { ...entry, eta: route.durationSeconds, routeDistance: route.distanceMeters };
        })
        .sort(
          (a, b) =>
            a.eta - b.eta ||
            a.distance - b.distance ||
            a.candidate.driverId.localeCompare(b.candidate.driverId),
        );
      const ranked: RankedDriver[] = routed.map((entry, index) => ({
        driverId: entry.candidate.driverId,
        rank: index + 1,
        criterion: {
          kind: 'WALKING_ETA_SECONDS',
          etaSeconds: entry.eta,
          routeDistanceMeters: entry.routeDistance,
          distanceMeters: entry.distance,
          routeMode: 'WALKING',
        },
        appliedStrategy: 'LOWEST_ETA',
        rankingScope: 'TOP5_NEAREST',
        fallbackReason: null,
      }));
      for (const entry of tail)
        ranked.push({
          driverId: entry.candidate.driverId,
          rank: ranked.length + 1,
          criterion: {
            kind: 'WALKING_ETA_SECONDS',
            etaSeconds: null,
            routeDistanceMeters: null,
            distanceMeters: entry.distance,
            routeMode: 'WALKING',
          },
          appliedStrategy: 'LOWEST_ETA',
          rankingScope: 'TAIL_NEAREST',
          fallbackReason: null,
        });
      return ranked;
    },
  };
}
