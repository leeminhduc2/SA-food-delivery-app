import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyLocationFailure,
  classifyLocationResponse,
  LOCATION_MAX_RETRY_DELAY_MS,
  LOCATION_SEND_INTERVAL_MS,
  nextRetryDelay,
  RequestError,
} from '../src/components/driver-location-errors.js';

test('400 stops the watcher and reports a validation error', () => {
  const decision = classifyLocationResponse(400, 'VALIDATION');
  assert.equal(decision.kind, 'validation');
  assert.equal(decision.stop, true);
  assert.equal(decision.backoff, false);
  assert.match(decision.message, /rejected by the server/i);
});

test('401 stops the watcher and asks the driver to sign in again', () => {
  const decision = classifyLocationResponse(401);
  assert.equal(decision.kind, 'unauthenticated');
  assert.equal(decision.stop, true);
  assert.equal(decision.backoff, false);
  assert.match(decision.message, /sign in again/i);
});

test('403 stops the watcher and explains the account restriction', () => {
  const decision = classifyLocationResponse(403, 'FORBIDDEN');
  assert.equal(decision.kind, 'forbidden');
  assert.equal(decision.stop, true);
  assert.equal(decision.backoff, false);
  assert.match(decision.message, /not allowed/i);
});

test('409 distinguishes out-of-order, stale and unknown conflicts', () => {
  const outOfOrder = classifyLocationResponse(409, 'LOCATION_OUT_OF_ORDER');
  assert.equal(outOfOrder.kind, 'out-of-order');
  assert.equal(outOfOrder.stop, false);
  assert.equal(outOfOrder.backoff, false);
  assert.match(outOfOrder.message, /newer position was already saved/i);

  const stale = classifyLocationResponse(409, 'STALE_LOCATION');
  assert.equal(stale.kind, 'stale');
  assert.equal(stale.stop, false);
  assert.equal(stale.backoff, true);
  assert.match(stale.message, /device clock/i);
  assert.match(stale.message, /device time/i);

  // A 409 without a known business code is not silently treated as stale.
  const unknownCode = classifyLocationResponse(409, 'SOMETHING_ELSE');
  assert.equal(unknownCode.kind, 'conflict');
  assert.equal(unknownCode.stop, true);
  assert.equal(unknownCode.backoff, false);
  assert.match(unknownCode.message, /conflict/i);
  assert.doesNotMatch(unknownCode.message, /newer position/i);

  const noCode = classifyLocationResponse(409);
  assert.equal(noCode.kind, 'conflict');
  assert.equal(noCode.stop, true);
});

test('429 keeps the watcher and the normal cadence', () => {
  const decision = classifyLocationResponse(429, 'LOCATION_RATE_LIMITED');
  assert.equal(decision.kind, 'rate-limited');
  assert.equal(decision.stop, false);
  assert.equal(decision.backoff, false);
  assert.match(decision.message, /rate limited/i);
});

test('5xx, timeouts and network failures back off without stopping', () => {
  for (const status of [408, 500, 502, 503]) {
    const decision = classifyLocationResponse(status);
    assert.equal(decision.kind, 'transient', `status ${status}`);
    assert.equal(decision.stop, false, `status ${status}`);
    assert.equal(decision.backoff, true, `status ${status}`);
  }
  const network = classifyLocationFailure(new TypeError('Failed to fetch'));
  assert.equal(network.kind, 'transient');
  assert.equal(network.stop, false);
  assert.equal(network.backoff, true);
  const unexpected = classifyLocationFailure(new Error('socket hang up'));
  assert.equal(unexpected.kind, 'transient');
  assert.equal(unexpected.backoff, true);
});

test('other 4xx responses stop the watcher', () => {
  for (const status of [404, 405, 422]) {
    const decision = classifyLocationResponse(status);
    assert.equal(decision.kind, 'rejected', `status ${status}`);
    assert.equal(decision.stop, true, `status ${status}`);
    assert.equal(decision.backoff, false, `status ${status}`);
  }
});

test('classification reads the business code, not only the HTTP status', () => {
  const viaRequestError = classifyLocationFailure(
    new RequestError('conflict', 409, 'LOCATION_OUT_OF_ORDER'),
  );
  assert.equal(viaRequestError.kind, 'out-of-order');
  const viaStale = classifyLocationFailure(new RequestError('stale', 409, 'STALE_LOCATION'));
  assert.equal(viaStale.kind, 'stale');
  const viaUnauthorized = classifyLocationFailure(new RequestError('nope', 401));
  assert.equal(viaUnauthorized.kind, 'unauthenticated');
});

test('retry delay doubles from 10 s and caps at 5 minutes', () => {
  assert.equal(LOCATION_SEND_INTERVAL_MS, 10_000);
  assert.equal(LOCATION_MAX_RETRY_DELAY_MS, 300_000);
  assert.equal(nextRetryDelay(LOCATION_SEND_INTERVAL_MS), 20_000);
  assert.equal(nextRetryDelay(20_000), 40_000);
  assert.equal(nextRetryDelay(80_000), 160_000);
  assert.equal(nextRetryDelay(160_000), 300_000);
  assert.equal(nextRetryDelay(300_000), 300_000);
  assert.equal(nextRetryDelay(0), 20_000);
});
