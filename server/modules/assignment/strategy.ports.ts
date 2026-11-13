import type { Point } from './domain/assignment-strategy.js';

/** Walking route estimate (Location). Rejects on timeout, no route or provider failure. */
export type RouteEstimator = (
  from: Point,
  to: Point,
) => Promise<{ durationSeconds: number; distanceMeters: number }>;

/**
 * Pickups per driver in a closed window (Delivery). `complete` is false when
 * legacy rows without a pickup time could fall in the window, so counts are
 * not trustworthy as observed values.
 */
export type PickupLoadReader = (
  driverIds: readonly string[],
  window: Readonly<{ from: Date; to: Date }>,
) => Promise<{ counts: ReadonlyMap<string, number>; complete: boolean }>;

export type StrategyDependencies = {
  routeEstimator?: RouteEstimator;
  pickupLoads?: PickupLoadReader;
};
let dependencies: StrategyDependencies = {};
export function setStrategyDependencies(value: StrategyDependencies): void {
  dependencies = { ...dependencies, ...value };
}
export function strategyDependencies(): StrategyDependencies {
  return dependencies;
}
