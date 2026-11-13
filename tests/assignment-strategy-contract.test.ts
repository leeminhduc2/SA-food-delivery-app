import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  nearestStrategy,
  type AssignmentCandidate,
  type AssignmentStrategy,
  type RankedDriver,
} from '../server/modules/assignment/domain/assignment-strategy.js';
import { createLowestEtaStrategy } from '../server/modules/assignment/application/strategies/lowest-eta.strategy.js';
import { createBalancedLoadStrategy } from '../server/modules/assignment/application/strategies/balanced-load.strategy.js';
import { createStrategy } from '../server/modules/assignment/application/strategies/registry.js';
import { parseAssignmentConfig } from '../server/modules/assignment/config.js';

const pickup = Object.freeze({ latitude: 21.03, longitude: 105.85 });
const now = new Date('2026-05-01T12:00:00Z');
const point = (dLat: number) => Object.freeze({ latitude: 21.03 + dLat, longitude: 105.85 });
const candidates: readonly AssignmentCandidate[] = Object.freeze(
  ['d7', 'd2', 'd5', 'd1', 'd3', 'd6', 'd4', 'tie-b', 'tie-a'].map((driverId, index) =>
    Object.freeze({
      driverId,
      location: point(driverId.startsWith('tie') ? 0.004 : (index + 1) * 0.001),
    }),
  ),
);
const sideEffects: string[] = [];
const etaStrategy = createLowestEtaStrategy(async (from) => {
  sideEffects.push('route');
  // Deterministic fake: farther drivers are faster here so ETA order differs.
  return { durationSeconds: Math.round(10000 - from.latitude * 100), distanceMeters: 100 };
});
const loadStrategy = createBalancedLoadStrategy(async (ids) => {
  sideEffects.push('loads');
  return { counts: new Map(ids.map((id) => [id, id.length % 3])), complete: true };
});
const fake: AssignmentStrategy = {
  name: 'FAKE',
  async rank(_context, list) {
    return [...list]
      .sort((a, b) => a.driverId.localeCompare(b.driverId))
      .map((item, index) => ({
        driverId: item.driverId,
        rank: index + 1,
        criterion: { kind: 'HAVERSINE_METERS', distanceMeters: 0 },
      }));
  },
};

/** Returns every contract violation; an empty list means the strategy complies. */
function contractViolations(
  input: readonly AssignmentCandidate[],
  ranked: readonly RankedDriver[],
): string[] {
  const problems: string[] = [];
  const ids = ranked.map((row) => row.driverId);
  if (new Set(ids).size !== ids.length) problems.push('duplicate driver');
  const expected = input.map((row) => row.driverId).sort();
  if (JSON.stringify([...ids].sort()) !== JSON.stringify(expected))
    problems.push('not a permutation of the input');
  if (ranked.some((row, index) => row.rank !== index + 1)) problems.push('ranks not 1..n');
  for (const row of ranked) {
    const kind = row.criterion.kind;
    if (!['HAVERSINE_METERS', 'WALKING_ETA_SECONDS', 'PICKUPS_24H'].includes(kind))
      problems.push(`unknown criterion ${kind}`);
    if (
      kind === 'WALKING_ETA_SECONDS' &&
      row.criterion.etaSeconds === 0 &&
      row.rankingScope !== 'TOP5_NEAREST'
    )
      problems.push('ETA 0 for an unrouted driver');
    if (
      row.fallbackReason !== undefined &&
      row.fallbackReason !== null &&
      typeof row.fallbackReason !== 'string'
    )
      problems.push('untyped fallback');
  }
  return problems;
}

for (const strategy of [nearestStrategy, etaStrategy, loadStrategy, fake])
  test(`${strategy.name} satisfies the ranking contract`, async () => {
    const snapshot = JSON.stringify(candidates);
    sideEffects.length = 0;
    const ranked = await strategy.rank({ pickup, now }, candidates);
    assert.deepEqual(contractViolations(candidates, ranked), []);
    assert.equal(JSON.stringify(candidates), snapshot, 'input must not change');
    // Same input, clock and provider results give the same ranking, regardless of input order.
    const reversed = Object.freeze([...candidates].reverse());
    assert.deepEqual(await strategy.rank({ pickup, now }, reversed), ranked);
    assert.deepEqual(await strategy.rank({ pickup, now }, candidates), ranked);
    assert.deepEqual(await strategy.rank({ pickup, now }, []), []);
    // Only reads happen: at most five routes per ranking and no writes.
    assert.ok(sideEffects.every((effect) => effect === 'route' || effect === 'loads'));
    assert.ok(sideEffects.filter((effect) => effect === 'route').length <= 5 * 3);
    // Equal on every ranking key (same spot, same load) → ordered by driver ID.
    if (strategy === nearestStrategy || strategy === loadStrategy) {
      const ids = ranked.map((row) => row.driverId);
      assert.ok(ids.indexOf('tie-a') < ids.indexOf('tie-b'));
    }
  });

test('the contract checker detects dropped, added and duplicated drivers', () => {
  const good = candidates.map((row, index) => ({
    driverId: row.driverId,
    rank: index + 1,
    criterion: { kind: 'HAVERSINE_METERS' as const, distanceMeters: 1 },
  }));
  assert.deepEqual(contractViolations(candidates, good), []);
  assert.ok(
    contractViolations(candidates, good.slice(1)).includes('not a permutation of the input'),
  );
  assert.ok(
    contractViolations(candidates, [...good, { ...good[0], rank: good.length + 1 }]).includes(
      'duplicate driver',
    ),
  );
  assert.ok(
    contractViolations(candidates, [
      ...good.slice(0, -1),
      { ...good[0], driverId: 'stranger' },
    ]).includes('not a permutation of the input'),
  );
  assert.ok(
    contractViolations(
      candidates,
      good.map((row) => ({ ...row, rank: 1 })),
    ).includes('ranks not 1..n'),
  );
});

test('configuration selects strategies by name; Nearest stays the default; unknown fails', () => {
  assert.equal(parseAssignmentConfig({}).ASSIGNMENT_STRATEGY, 'NEAREST');
  for (const name of ['NEAREST', 'LOWEST_ETA', 'BALANCED_LOAD'])
    assert.equal(parseAssignmentConfig({ ASSIGNMENT_STRATEGY: name }).ASSIGNMENT_STRATEGY, name);
  for (const bad of ['nearest', 'FASTEST', ''])
    assert.throws(() => parseAssignmentConfig({ ASSIGNMENT_STRATEGY: bad }));
  const deps = {
    routeEstimator: async () => ({ durationSeconds: 1, distanceMeters: 1 }),
    pickupLoads: async () => ({ counts: new Map(), complete: true }),
  };
  assert.equal(createStrategy('NEAREST', deps), nearestStrategy);
  assert.equal(createStrategy('LOWEST_ETA', deps).name, 'LOWEST_ETA');
  assert.equal(createStrategy('BALANCED_LOAD', deps).name, 'BALANCED_LOAD');
  assert.throws(() => createStrategy('UNKNOWN', deps), /Unknown assignment strategy/);
  assert.throws(() => createStrategy('LOWEST_ETA', {}), /route estimator/);
  assert.throws(() => createStrategy('BALANCED_LOAD', {}), /pickup load reader/);
});
