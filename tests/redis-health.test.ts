import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
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
  RedisHealth,
} from '../server/modules/notification/infrastructure/redis-bus.js';
import { redisConnectionStatus } from '../server/modules/notification/infrastructure/redis-bus.js';

const schema = `test_health_${randomUUID().replaceAll('-', '')}`;
const adminDb = new pg.Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 });
// Health must work without Redis configured, and with an injected fake bus.
delete process.env.REDIS_URL;
process.env.DATABASE_URL = testSchemaUrl(testDatabaseUrl(), schema);
process.env.NODE_ENV = 'test';
process.env.LOG_REQUESTS = 'false';

let created = false;
let db: typeof import('../server/shared/db.js');
let notification: typeof import('../server/modules/notification/index.js');
let server: Server | undefined;
let base = '';

let current: RedisHealth = { publisher: 'ready', subscriber: 'ready', trackingReady: true };
const fakeBus: NotificationBus = {
  async publish() {},
  subscribe() {},
  async publishLocation() {
    return true;
  },
  async readLocation() {
    return null;
  },
  subscribeLocations() {
    return () => undefined;
  },
  trackingReady() {
    return current.trackingReady;
  },
  health() {
    return current;
  },
  async close() {},
};

async function fetchHealth(): Promise<{ status: number; body: any }> {
  const response = await fetch(base + '/api/health');
  return { status: response.status, body: await response.json() };
}

before(async () => {
  await adminDb.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  db = await import('../server/shared/db.js');
  await verifyTestSchema(schema, db.prisma);
  notification = await import('../server/modules/notification/index.js');
  // No migrations: the health route only needs `SELECT 1` against this schema.
  const { createApp } = await import('../server/app.js');
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await notification?.closeNotificationBus();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  if (db) await db.prisma.$disconnect();
  await dropTestSchema(adminDb, schema, created);
  await adminDb.end();
});

test('maps ioredis connection states to the three health states', () => {
  assert.equal(redisConnectionStatus('ready'), 'ready');
  for (const status of ['wait', 'connecting', 'connect', 'reconnecting'])
    assert.equal(redisConnectionStatus(status), 'reconnecting');
  assert.equal(redisConnectionStatus('close'), 'disconnected');
  assert.equal(redisConnectionStatus('end'), 'disconnected');
});

test('health reports PostgreSQL ready and redis null when Redis is not configured', async () => {
  const { status, body } = await fetchHealth();
  assert.equal(status, 200);
  assert.deepEqual(body, { status: 'ok', postgres: 'ready', redis: null });
});

test('health reports a ready publisher, subscriber and live tracking', async () => {
  current = { publisher: 'ready', subscriber: 'ready', trackingReady: true };
  notification.initNotificationBus(
    () => undefined,
    () => fakeBus,
  );
  const { status, body } = await fetchHealth();
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.postgres, 'ready');
  assert.deepEqual(body.redis, current);
  assert.doesNotMatch(JSON.stringify(body), /redis:\/\/|password|s3cret/i);
});

test('health is degraded while the publisher is reconnecting', async () => {
  current = { publisher: 'reconnecting', subscriber: 'ready', trackingReady: false };
  const { status, body } = await fetchHealth();
  assert.equal(status, 200);
  assert.equal(body.status, 'degraded');
  assert.equal(body.postgres, 'ready');
  assert.deepEqual(body.redis, {
    publisher: 'reconnecting',
    subscriber: 'ready',
    trackingReady: false,
  });
});

test('health is degraded when the subscriber is disconnected', async () => {
  current = { publisher: 'ready', subscriber: 'disconnected', trackingReady: false };
  const { status, body } = await fetchHealth();
  assert.equal(status, 200);
  assert.equal(body.status, 'degraded');
  assert.deepEqual(body.redis, {
    publisher: 'ready',
    subscriber: 'disconnected',
    trackingReady: false,
  });
});
