import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, connect, type Socket } from 'node:net';
import { after, before, test } from 'node:test';
import Redis from 'ioredis';
import pg from 'pg';
import {
  testDatabaseUrl,
  testSchemaUrl,
  verifyTestSchema,
  dropTestSchema,
} from './test-database.js';
import {
  trackingNamespace,
  type TrackingLocation,
} from '../server/modules/notification/infrastructure/redis-bus.js';

const redisUrl = process.env.REDIS_URL;
const schema = `test_tracking_${randomUUID().replaceAll('-', '')}`;
const targetUrl = testSchemaUrl(testDatabaseUrl(), schema);
const adminDb = new pg.Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 });
process.env.DATABASE_URL = targetUrl;
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'TrackingTest123!';
process.env.DRIVER_LOCATION_MIN_INTERVAL_SECONDS = '1';
let created = false;
let db: typeof import('../server/shared/db.js');

async function waitFor(condition: () => Promise<boolean> | boolean, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('Timed out waiting for Redis recovery');
}
before(async () => {
  if (!redisUrl) return;
  await adminDb.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  db = await import('../server/shared/db.js');
  await verifyTestSchema(schema, db.prisma);
  await (await import('../server/migrate.js')).migrate();
  await (await import('../server/seed/seed.js')).seed();
  (await import('../server/modules/index.js')).registerModules();
});
after(async () => {
  if (db) await db.prisma.$disconnect();
  await dropTestSchema(adminDb, schema, created);
  await adminDb.end();
});

test(
  'committed GPS survives Redis outage, reconnect, stale cache and deletion',
  { skip: redisUrl ? false : 'REDIS_URL is required', timeout: 20000 },
  async () => {
    const upstreamUrl = new URL(redisUrl!);
    const sockets = new Set<Socket>();
    let online = true;
    const proxy = createServer((client) => {
      if (!online) {
        client.destroy();
        return;
      }
      const upstream = connect(Number(upstreamUrl.port || 6379), upstreamUrl.hostname);
      sockets.add(client);
      sockets.add(upstream);
      for (const socket of [client, upstream]) {
        socket.on('error', () => undefined);
        socket.on('close', () => sockets.delete(socket));
      }
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(0, '127.0.0.1', resolve);
    });
    const address = proxy.address();
    assert(address && typeof address !== 'string');
    const proxyUrl = new URL(redisUrl!);
    proxyUrl.hostname = '127.0.0.1';
    proxyUrl.port = String(address.port);
    process.env.REDIS_URL = proxyUrl.toString();
    const notification = await import('../server/modules/notification/index.js');
    const location = await import('../server/modules/location/index.js');
    const redis = new Redis(redisUrl!, { maxRetriesPerRequest: 1 });
    const namespace = trackingNamespace(targetUrl, proxyUrl.toString());
    try {
      notification.initNotificationBus(() => undefined);
      const transport = notification.trackingTransport();
      assert(transport);
      const pushed: TrackingLocation[] = [];
      transport.subscribeLocations((message) => pushed.push(message));
      await waitFor(() => transport.trackingReady());
      await waitFor(
        async () => Number((await redis.pubsub('NUMSUB', `bep:tracking:${namespace}`))[1]) >= 1,
      );
      await db.prisma.$executeRawUnsafe(
        `CREATE FUNCTION reject_tracking_work() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.driver_id = 'driver2' THEN RAISE EXCEPTION 'forced rollback'; END IF; RETURN NEW; END $$`,
      );
      await db.prisma.$executeRawUnsafe(
        'CREATE TRIGGER reject_tracking_work BEFORE INSERT ON driver_operational_changes FOR EACH ROW EXECUTE FUNCTION reject_tracking_work()',
      );
      try {
        await assert.rejects(
          location.recordDriverLocation('driver2', {
            latitude: 21,
            longitude: 105,
            capturedAt: new Date().toISOString(),
          }),
        );
        assert.equal(
          await db.prisma.driverLocation.findUnique({ where: { driver_id: 'driver2' } }),
          null,
        );
        assert.equal(await transport.readLocation('driver2'), null);
      } finally {
        await db.prisma.$executeRawUnsafe(
          'DROP TRIGGER reject_tracking_work ON driver_operational_changes',
        );
        await db.prisma.$executeRawUnsafe('DROP FUNCTION reject_tracking_work()');
      }
      online = false;
      for (const socket of sockets) socket.destroy();
      await waitFor(() => !transport.trackingReady());
      const outboxBefore = await db.prisma.outbox.count();
      const first = await location.recordDriverLocation('driver', {
        latitude: 21,
        longitude: 105,
        capturedAt: new Date().toISOString(),
      });
      assert.equal(first.version, 1);
      const started = Date.now();
      const fallback = await location.trackingLocationSnapshot('driver');
      assert.ok(Date.now() - started < 1000);
      assert.equal(fallback?.latitude, 21);
      assert.equal(await db.prisma.outbox.count(), outboxBefore);
      online = true;
      await waitFor(() => transport.trackingReady());
      await waitFor(
        async () => Number((await redis.pubsub('NUMSUB', `bep:tracking:${namespace}`))[1]) >= 1,
      );
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const next = await location.recordDriverLocation('driver', {
        latitude: 21.01,
        longitude: 105,
        capturedAt: new Date().toISOString(),
      });
      assert.equal(next.version, 2);
      await waitFor(async () => (await transport.readLocation('driver'))?.version === 2);
      await waitFor(() => pushed.some((message) => message.version === 2));
      const current = await location.trackingLocationSnapshot('driver');
      assert.equal(current?.latitude, 21.01);
      assert.equal(current?.version, 2);
      const newer = new Date(Date.now() + 1000).toISOString();
      await transport.publishLocation(
        {
          driverId: 'driver',
          latitude: 22,
          longitude: 106,
          capturedAt: newer,
          receivedAt: newer,
          version: 100,
        },
        120,
      );
      const fenced = await location.trackingLocationSnapshot('driver');
      assert.equal(fenced?.latitude, 21.01);
      assert.equal(fenced?.version, 2);
      await db.prisma.driverLocation.delete({ where: { driver_id: 'driver' } });
      assert.equal(await location.trackingLocationSnapshot('driver'), null);
      const recreatedAt = new Date();
      await db.prisma.driverLocation.create({
        data: {
          driver_id: 'driver',
          latitude: 20,
          longitude: 104,
          captured_at: recreatedAt,
          received_at: recreatedAt,
        },
      });
      const recreated = await location.trackingLocationSnapshot('driver');
      assert.equal(recreated?.version, 1);
      assert.equal(recreated?.latitude, 20);
      assert.equal(await db.prisma.outbox.count(), outboxBefore);
      const { replaySince } =
        await import('../server/modules/notification/notification.service.js');
      await db.prisma.$transaction((tx) => notification.notify(tx, 'customer', 'TEST_FIRST', {}));
      await notification.deliverNotifications();
      const firstNotification = await db.prisma.notification.findFirstOrThrow({
        where: { user_id: 'customer', type: 'TEST_FIRST' },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await db.prisma.$transaction((tx) => notification.notify(tx, 'customer', 'TEST_SECOND', {}));
      await db.prisma.$transaction((tx) => notification.notify(tx, 'driver2', 'TEST_PRIVATE', {}));
      await notification.deliverNotifications();
      const replayed = await replaySince('customer', firstNotification.id);
      assert.ok(replayed?.some((item) => item.type === 'TEST_SECOND'));
      assert.ok(!replayed?.some((item) => item.type === 'TEST_PRIVATE'));
    } finally {
      await notification.closeNotificationBus();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      const keys = await redis.keys(`bep:tracking:${namespace}:*`);
      if (keys.length) await redis.del(...keys);
      redis.disconnect();
    }
  },
);
