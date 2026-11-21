import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import {
  testDatabaseUrl,
  testSchemaUrl,
  verifyTestSchema,
  dropTestSchema,
} from './test-database.js';
import type {
  NotificationBus,
  TrackingLocation,
} from '../server/modules/notification/infrastructure/redis-bus.js';
import { logLocationPublishFailure } from '../server/modules/location/application/driver-location-publish-log.js';

const schema = `test_publish_${randomUUID().replaceAll('-', '')}`;
const adminDb = new pg.Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 });
// Redis is never required: a fake bus is injected through the notification
// module's test seam, so these tests run without a Redis server.
delete process.env.REDIS_URL;
process.env.DATABASE_URL = testSchemaUrl(testDatabaseUrl(), schema);
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'PublishTest123!';
process.env.DRIVER_LOCATION_MIN_INTERVAL_SECONDS = '1';
process.env.LOG_REQUESTS = 'false';

let created = false;
let db: typeof import('../server/shared/db.js');
let notification: typeof import('../server/modules/notification/index.js');
let location: typeof import('../server/modules/location/index.js');

let publishMode: 'ok' | 'fail' = 'ok';
const published: TrackingLocation[] = [];
const fakeBus: NotificationBus = {
  async publish() {},
  subscribe() {},
  async publishLocation(message) {
    if (publishMode === 'fail')
      throw new Error('Redis connection lost: redis://app:s3cret@127.0.0.1:6379');
    published.push(message);
    return true;
  },
  async readLocation() {
    return null;
  },
  subscribeLocations() {
    return () => undefined;
  },
  trackingReady() {
    return true;
  },
  health() {
    return { publisher: 'ready', subscriber: 'ready', trackingReady: true };
  },
  async close() {},
};

before(async () => {
  await adminDb.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  db = await import('../server/shared/db.js');
  await verifyTestSchema(schema, db.prisma);
  await (await import('../server/migrate.js')).migrate();
  await (await import('../server/seed/seed.js')).seed();
  (await import('../server/modules/index.js')).registerModules();
  notification = await import('../server/modules/notification/index.js');
  location = await import('../server/modules/location/index.js');
  notification.initNotificationBus(
    () => undefined,
    () => fakeBus,
  );
});

after(async () => {
  await notification?.closeNotificationBus();
  if (db) await db.prisma.$disconnect();
  await dropTestSchema(adminDb, schema, created);
  await adminDb.end();
});

test('publish failures log structured JSON without coordinates and are rate-limited', () => {
  const lines: string[] = [];
  const write = (line: string) => lines.push(line);
  assert.equal(logLocationPublishFailure('driver-log', 'boom', 1_000, write), true);
  assert.equal(logLocationPublishFailure('driver-log', 'boom', 2_000, write), false);
  assert.equal(
    logLocationPublishFailure('driver-log', 'redis://user:pass@redis:6379 down', 31_000, write),
    true,
  );
  assert.equal(lines.length, 2);
  const [first, second] = lines.map((line) => JSON.parse(line));
  assert.deepEqual(
    {
      level: first.level,
      event: first.event,
      eventName: first.eventName,
      driverId: first.driverId,
      suppressed: first.suppressed,
      timestamp: first.timestamp,
    },
    {
      level: 'error',
      event: 'driver.location.publish_failed',
      eventName: 'DriverLocationUpdated',
      driverId: 'driver-log',
      suppressed: 0,
      timestamp: new Date(1_000).toISOString(),
    },
  );
  assert.match(first.reason, /boom/);
  assert.equal(second.suppressed, 1);
  assert.match(second.reason, /redis:\/\/\[redacted\]/);
  assert.doesNotMatch(second.reason, /user:pass@/);
  for (const log of [first, second]) {
    assert.equal('latitude' in log, false);
    assert.equal('longitude' in log, false);
    assert.equal('capturedAt' in log, false);
  }
});

test('a committed location is published to Redis', async () => {
  publishMode = 'ok';
  published.length = 0;
  const result = await location.recordDriverLocation('driver', {
    latitude: 21,
    longitude: 105,
    capturedAt: new Date().toISOString(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.version, 1);
  const row = await db.prisma.driverLocation.findUnique({ where: { driver_id: 'driver' } });
  assert.ok(row);
  assert.equal(row.latitude, 21);
  assert.equal(published.length, 1);
  assert.deepEqual(published[0], {
    driverId: 'driver',
    latitude: 21,
    longitude: 105,
    capturedAt: row.captured_at.toISOString(),
    receivedAt: row.received_at.toISOString(),
    version: 1,
  });
});

test('a failed Redis publish keeps the GPS row and logs without coordinates', async () => {
  publishMode = 'fail';
  const logs: string[] = [];
  const original = console.error;
  console.error = ((...args: unknown[]) => {
    logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  }) as typeof console.error;
  try {
    const result = await location.recordDriverLocation('driver2', {
      latitude: 10.5,
      longitude: 106.5,
      capturedAt: new Date().toISOString(),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(result.version, 1);
    const row = await db.prisma.driverLocation.findUnique({ where: { driver_id: 'driver2' } });
    assert.ok(row, 'the GPS row must be committed even when the Redis publish fails');
    assert.equal(row.latitude, 10.5);
    assert.equal(row.longitude, 106.5);
    const publishLogs = logs.filter((line) => line.includes('driver.location.publish_failed'));
    assert.equal(publishLogs.length, 1);
    const log = JSON.parse(publishLogs[0]);
    assert.equal(log.level, 'error');
    assert.equal(log.event, 'driver.location.publish_failed');
    assert.equal(log.eventName, 'DriverLocationUpdated');
    assert.equal(log.driverId, 'driver2');
    assert.match(log.reason, /Redis connection lost/);
    assert.match(log.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.doesNotMatch(publishLogs[0], /10\.5|106\.5|"latitude"|"longitude"/);
    assert.doesNotMatch(publishLogs[0], /s3cret/);
  } finally {
    console.error = original;
    publishMode = 'ok';
  }
});
