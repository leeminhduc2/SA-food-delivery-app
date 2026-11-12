import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  nearestStrategy,
  haversineMeters,
  type AssignmentCandidate,
  type AssignmentStrategy,
} from '../server/modules/assignment/domain/assignment-strategy.js';
import {
  selectEligibleCandidates,
  type CandidateFact,
} from '../server/modules/assignment/domain/candidate-policy.js';

const pickup = { latitude: 21, longitude: 105 };
const candidates: readonly AssignmentCandidate[] = Object.freeze([
  Object.freeze({ driverId: 'b', location: Object.freeze({ ...pickup }) }),
  Object.freeze({ driverId: 'z', location: Object.freeze({ latitude: 21.01, longitude: 105 }) }),
  Object.freeze({ driverId: 'a', location: Object.freeze({ ...pickup }) }),
]);
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
for (const strategy of [nearestStrategy, fake])
  test(`${strategy.name} preserves candidates and returns a deterministic permutation`, async () => {
    const before = JSON.stringify(candidates);
    const ranked = await strategy.rank({ pickup }, candidates);
    assert.equal(JSON.stringify(candidates), before);
    assert.deepEqual(ranked.map((row) => row.driverId).sort(), ['a', 'b', 'z']);
    assert.deepEqual(
      ranked.map((row) => row.rank),
      [1, 2, 3],
    );
    assert.deepEqual(await strategy.rank({ pickup }, []), []);
    assert.deepEqual(await strategy.rank({ pickup }, candidates), ranked);
  });
test('nearest uses Haversine, stable driver tie and never route price', async () => {
  const ranked = await nearestStrategy.rank({ pickup }, candidates);
  assert.deepEqual(
    ranked.map((row) => row.driverId),
    ['a', 'b', 'z'],
  );
  assert.equal(ranked[0].criterion.distanceMeters, 0);
  assert.ok(ranked[2].criterion.distanceMeters > 1100 && ranked[2].criterion.distanceMeters < 1120);
  assert.equal(ranked[2].criterion.kind, 'HAVERSINE_METERS');
});
test('candidate policy filters stale, inactive, unready, busy, out of radius and attempted drivers', () => {
  const now = new Date('2026-01-01T00:02:00Z');
  const fact: CandidateFact = {
    driverId: 'ok',
    ...pickup,
    capturedAt: now,
    receivedAt: now,
    heartbeatAt: now,
    active: true,
    online: true,
    ready: true,
    busy: false,
    excluded: false,
  };
  const policy = {
    radiusMeters: 5000,
    locationMaxAgeSeconds: 90,
    locationMaxFutureSeconds: 15,
    heartbeatMaxAgeSeconds: 90,
  };
  const tooOld = new Date(now.getTime() - 91000);
  const facts: CandidateFact[] = [
    fact,
    { ...fact, driverId: 'inactive', active: false },
    { ...fact, driverId: 'offline', online: false },
    { ...fact, driverId: 'unready', ready: false },
    { ...fact, driverId: 'busy', busy: true },
    { ...fact, driverId: 'attempted', excluded: true },
    { ...fact, driverId: 'old-capture', capturedAt: tooOld },
    { ...fact, driverId: 'old-receive', receivedAt: tooOld },
    { ...fact, driverId: 'old-heartbeat', heartbeatAt: tooOld },
    { ...fact, driverId: 'future-heartbeat', heartbeatAt: new Date(now.getTime() + 1000) },
    { ...fact, driverId: 'far', latitude: 22 },
    { ...fact, driverId: 'invalid', latitude: NaN },
  ];
  assert.deepEqual(
    selectEligibleCandidates(facts, pickup, now, policy).map((item) => item.driverId),
    ['ok'],
  );
  const edge = { ...fact, driverId: 'edge', latitude: 21.01 };
  assert.equal(
    selectEligibleCandidates([edge], pickup, now, {
      ...policy,
      radiusMeters: haversineMeters(pickup, edge),
    }).length,
    1,
  );
  assert.deepEqual(
    selectEligibleCandidates(facts, { latitude: 91, longitude: 105 }, now, policy),
    [],
  );
});
