import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAssignmentConfig } from '../server/modules/assignment/config.js';
import { locationFresh } from '../server/modules/location/index.js';
import { isEligibleForAssignment } from '../server/modules/assignment/domain/eligibility.js';

test('assignment configuration validates defaults, modes and strategy', () => {
  const defaults = parseAssignmentConfig({});
  assert.equal(defaults.ASSIGNMENT_AUTOMATION_ENABLED, true);
  assert.equal(defaults.DRIVER_LOCATION_MAX_AGE_SECONDS, 90);
  assert.equal(
    parseAssignmentConfig({ ASSIGNMENT_AUTOMATION_ENABLED: 'true' }).ASSIGNMENT_AUTOMATION_ENABLED,
    true,
  );
  assert.equal(
    parseAssignmentConfig({ ASSIGNMENT_AUTOMATION_ENABLED: 'false' }).ASSIGNMENT_AUTOMATION_ENABLED,
    false,
  );
  assert.throws(() => parseAssignmentConfig({ ASSIGNMENT_AUTOMATION_ENABLED: 'yes' }));
  assert.throws(() => parseAssignmentConfig({ ASSIGNMENT_STRATEGY: 'OTHER' }));
  assert.throws(() => parseAssignmentConfig({ DRIVER_LOCATION_MAX_AGE_SECONDS: '0' }));
});
test('GPS freshness checks capture and receive times deterministically', () => {
  const now = new Date('2026-01-01T00:02:00.000Z');
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
  assert.equal(locationFresh({ captured_at: ago(89), received_at: ago(5) }, now, 90, 15), true);
  assert.equal(locationFresh({ captured_at: ago(91), received_at: ago(5) }, now, 90, 15), false);
  assert.equal(locationFresh({ captured_at: ago(5), received_at: ago(91) }, now, 90, 15), false);
  assert.equal(locationFresh({ captured_at: ago(-16), received_at: ago(0) }, now, 90, 15), false);
});

test('eligibility requires active, ready, fresh and unoccupied driver', () => {
  const eligible = {
    active: true,
    online: true,
    ready: true,
    heartbeatFresh: true,
    locationFresh: true,
    busy: false,
  };
  assert.equal(isEligibleForAssignment(eligible), true);
  for (const key of ['active', 'online', 'ready', 'heartbeatFresh', 'locationFresh'] as const)
    assert.equal(isEligibleForAssignment({ ...eligible, [key]: false }), false);
  assert.equal(isEligibleForAssignment({ ...eligible, busy: true }), false);
});
