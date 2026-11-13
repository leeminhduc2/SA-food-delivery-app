import { nearestStrategy, type AssignmentStrategy } from '../../domain/assignment-strategy.js';
import { assignmentConfig } from '../../config.js';
import { strategyDependencies, type StrategyDependencies } from '../../strategy.ports.js';
import { createBalancedLoadStrategy } from './balanced-load.strategy.js';
import { createLowestEtaStrategy } from './lowest-eta.strategy.js';

/**
 * Composition by configuration. Adding a strategy means adding a factory here;
 * routes, controllers and the search state machine stay unchanged.
 */
const factories: Record<string, (deps: StrategyDependencies) => AssignmentStrategy> = {
  NEAREST: () => nearestStrategy,
  LOWEST_ETA: (deps) => {
    if (!deps.routeEstimator) throw new Error('LOWEST_ETA requires a route estimator.');
    return createLowestEtaStrategy(deps.routeEstimator);
  },
  BALANCED_LOAD: (deps) => {
    if (!deps.pickupLoads) throw new Error('BALANCED_LOAD requires a pickup load reader.');
    return createBalancedLoadStrategy(deps.pickupLoads);
  },
};

export function createStrategy(name: string, deps: StrategyDependencies): AssignmentStrategy {
  const factory = factories[name];
  if (!factory) throw new Error(`Unknown assignment strategy: ${name}`);
  return factory(deps);
}

let override: AssignmentStrategy | undefined;
let cached: AssignmentStrategy | undefined;

/** The configured strategy, built once its ports are wired. */
export function activeStrategy(): AssignmentStrategy {
  if (override) return override;
  cached ??= createStrategy(assignmentConfig.ASSIGNMENT_STRATEGY, strategyDependencies());
  return cached;
}

/** Test seam and runtime switch; null restores the configured strategy. */
export function useAssignmentStrategy(strategy: AssignmentStrategy | null): void {
  override = strategy ?? undefined;
}
