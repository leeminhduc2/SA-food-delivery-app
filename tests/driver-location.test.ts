import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateLocationTime } from '../server/modules/location/domain/driver-location-policy.js';
const policy = {
  maxAgeSeconds: 90,
  maxFutureSeconds: 15,
  minIntervalSeconds: 5,
  retentionSeconds: 900,
};
test('location timing enforces age, order and rate with an injected clock', () => {
  const now = new Date('2026-01-01T12:00:00.000Z');
  const at = (seconds: number) => new Date(now.getTime() + seconds * 1000);
  assert.equal(validateLocationTime(at(-91), now, null, policy), 'STALE_LOCATION');
  assert.equal(validateLocationTime(at(16), now, null, policy), 'STALE_LOCATION');
  assert.equal(
    validateLocationTime(at(-5), now, { captured_at: at(-5), received_at: at(-6) }, policy),
    'LOCATION_OUT_OF_ORDER',
  );
  assert.equal(
    validateLocationTime(at(0), now, { captured_at: at(-3), received_at: at(-4) }, policy),
    'LOCATION_RATE_LIMITED',
  );
  assert.equal(
    validateLocationTime(at(0), now, { captured_at: at(-6), received_at: at(-5) }, policy),
    null,
  );
});
