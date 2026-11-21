import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import {
  MAX_TRACKED_DRIVERS,
  PUBLISH_LOG_INTERVAL_MS,
  logLocationPublishFailure,
  publishFailureLogSize,
  resetPublishFailureLog,
} from '../server/modules/location/application/driver-location-publish-log.js';

function capture() {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

beforeEach(() => resetPublishFailureLog());

test('never tracks more than the limit across thousands of drivers', () => {
  const { write } = capture();
  for (let index = 0; index < 2_500; index += 1) {
    logLocationPublishFailure(`driver-${index}`, 'boom', 1_000, write);
    assert.ok(publishFailureLogSize() <= MAX_TRACKED_DRIVERS);
  }
  assert.equal(publishFailureLogSize(), MAX_TRACKED_DRIVERS);
});

test('evicts the oldest tracked driver when a new driver arrives at capacity', () => {
  const { lines, write } = capture();
  for (let index = 0; index < MAX_TRACKED_DRIVERS; index += 1)
    assert.equal(logLocationPublishFailure(`driver-${index}`, 'boom', 1_000, write), true);
  assert.equal(logLocationPublishFailure('driver-new', 'boom', 1_000, write), true);
  assert.equal(publishFailureLogSize(), MAX_TRACKED_DRIVERS);

  // driver-0 was the oldest tracked entry, so it is no longer rate-limited.
  lines.length = 0;
  assert.equal(logLocationPublishFailure('driver-0', 'boom', 1_000, write), true);
  assert.equal(lines.length, 1);
  assert.equal(publishFailureLogSize(), MAX_TRACKED_DRIVERS);

  // A newer entry is still tracked and therefore suppressed.
  lines.length = 0;
  assert.equal(
    logLocationPublishFailure(`driver-${MAX_TRACKED_DRIVERS - 1}`, 'boom', 1_000, write),
    false,
  );
  assert.equal(lines.length, 0);
});

test('forgets rate-limit-expired entries before evicting active ones', () => {
  const { write } = capture();
  for (let index = 0; index < MAX_TRACKED_DRIVERS; index += 1)
    logLocationPublishFailure(`filler-${index}`, 'boom', 1_000, write);
  assert.equal(publishFailureLogSize(), MAX_TRACKED_DRIVERS);
  assert.equal(
    logLocationPublishFailure('late-driver', 'boom', 1_000 + PUBLISH_LOG_INTERVAL_MS, write),
    true,
  );
  assert.equal(publishFailureLogSize(), 1);
});

test('keeps rate limiting and suppressed counts after an eviction', () => {
  const { lines, write } = capture();
  const now = 9_000_000;
  for (let index = 0; index < MAX_TRACKED_DRIVERS - 1; index += 1)
    logLocationPublishFailure(`filler-${index}`, 'boom', now, write);
  assert.equal(logLocationPublishFailure('keeper', 'boom', now, write), true);
  assert.equal(logLocationPublishFailure('keeper', 'boom', now + 1, write), false);
  assert.equal(logLocationPublishFailure('keeper', 'boom', now + 2, write), false);

  // This evicts filler-0; "keeper" was tracked later, so it survives.
  assert.equal(logLocationPublishFailure('newest', 'boom', now, write), true);
  assert.equal(publishFailureLogSize(), MAX_TRACKED_DRIVERS);

  lines.length = 0;
  assert.equal(logLocationPublishFailure('keeper', 'boom', now + 3, write), false);
  assert.equal(lines.length, 0);
  assert.equal(
    logLocationPublishFailure('keeper', 'boom', now + PUBLISH_LOG_INTERVAL_MS, write),
    true,
  );
  assert.equal(JSON.parse(lines[0]).suppressed, 3);
});

test('redacts redis:// URLs including credentials and query parameters', () => {
  const { lines, write } = capture();
  logLocationPublishFailure(
    'driver-redis',
    'connect failed: redis://app:s3cret@redis.internal:6380/0?password=abc&ssl=true after retry',
    1,
    write,
  );
  const log = JSON.parse(lines[0]);
  assert.equal(log.reason, 'connect failed: redis://[redacted] after retry');
  assert.doesNotMatch(lines[0], /app:|s3cret|redis\.internal|password=abc|ssl=true/);
  assert.equal('latitude' in log, false);
  assert.equal('longitude' in log, false);
});

test('redacts rediss:// URLs in any letter case', () => {
  for (const [index, value] of [
    'TLS error rediss://admin:topsecret@secure.redis.example:6380?password=q',
    'TLS error ReDiSs://admin:topsecret@secure.redis.example:6380?password=q',
  ].entries()) {
    const { lines, write } = capture();
    logLocationPublishFailure(`driver-tls-${index}`, value, 1, write);
    const log = JSON.parse(lines[0]);
    assert.match(log.reason, /redis:\/\/\[redacted\]$/);
    assert.doesNotMatch(log.reason, /admin:|topsecret|secure\.redis\.example|password=q/);
  }
});

test('redacts every Redis URL in the same reason', () => {
  const { lines, write } = capture();
  logLocationPublishFailure(
    'driver-multi',
    'REDIS://u:p@one.example:6379 and rediss://x:y@two.example:6380/?token=zzz',
    1,
    write,
  );
  assert.equal((lines[0].match(/redis:\/\/\[redacted\]/g) ?? []).length, 2);
  assert.doesNotMatch(lines[0], /u:p@|x:y@|one\.example|two\.example|token=zzz/);
});

test('bounds the reason length without leaking URL credentials', () => {
  const { lines, write } = capture();
  const reason = `redis://user:pass@host.example:6379/?password=secret ${'x'.repeat(400)}`;
  logLocationPublishFailure('driver-long', reason, 1, write);
  const log = JSON.parse(lines[0]);
  assert.ok(log.reason.length <= 300);
  assert.doesNotMatch(log.reason, /user:pass|host\.example|password=secret/);
});
