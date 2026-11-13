import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, connect, type Socket } from 'node:net';
import { test } from 'node:test';
import Redis from 'ioredis';
import {
  createRedisBus,
  trackingNamespace,
  type TrackingLocation,
} from '../server/modules/notification/infrastructure/redis-bus.js';

const url = process.env.REDIS_URL;
async function waitFor(condition: () => Promise<boolean> | boolean, timeout = 4000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for Redis condition');
}

test(
  'tracking topics and keys are isolated, version ordered, ephemeral, and separate from notifications',
  { skip: url ? false : 'REDIS_URL is required', timeout: 12000 },
  async () => {
    const ns = `test_${randomUUID().replaceAll('-', '')}`;
    const otherNs = `test_${randomUUID().replaceAll('-', '')}`;
    const a = createRedisBus(url!, undefined, ns);
    const b = createRedisBus(url!, undefined, ns);
    const other = createRedisBus(url!, undefined, otherNs);
    const admin = new Redis(url!, { maxRetriesPerRequest: 1 });
    try {
      const received: TrackingLocation[] = [];
      const foreign: TrackingLocation[] = [];
      const notifications: unknown[] = [];
      const foreignNotifications: unknown[] = [];
      const unsubscribe = b.subscribeLocations((message) => received.push(message));
      b.subscribe((message) => notifications.push(message));
      other.subscribeLocations((message) => foreign.push(message));
      other.subscribe((message) => foreignNotifications.push(message));
      await waitFor(() => a.trackingReady() && b.trackingReady() && other.trackingReady());
      await waitFor(
        async () => Number((await admin.pubsub('NUMSUB', `bep:tracking:${ns}`))[1]) >= 1,
      );
      await waitFor(
        async () => Number((await admin.pubsub('NUMSUB', `notifications:${ns}`))[1]) >= 1,
      );
      const now = new Date();
      const message: TrackingLocation = {
        driverId: 'driver-one',
        latitude: 21,
        longitude: 105,
        capturedAt: now.toISOString(),
        receivedAt: now.toISOString(),
        version: 2,
      };
      assert.equal(await a.publishLocation(message, 1), true);
      await waitFor(() => received.length === 1);
      assert.deepEqual(received, [message]);
      assert.deepEqual(foreign, []);
      assert.deepEqual(notifications, []);
      assert.deepEqual(await b.readLocation('driver-one'), message);
      assert.equal(await other.readLocation('driver-one'), null);
      assert.equal(await a.publishLocation({ ...message, version: 1, latitude: 20 }, 1), false);
      assert.deepEqual(await b.readLocation('driver-one'), message);
      await waitFor(async () => (await b.readLocation('driver-one')) === null, 3000);
      const push = {
        id: randomUUID(),
        userId: 'recipient',
        type: 'ORDER_STATUS',
        payload: { orderId: 'one' },
        created_at: now.toISOString(),
      };
      await a.publish(push);
      await waitFor(() => notifications.length === 1);
      assert.deepEqual(notifications, [push]);
      assert.equal(received.length, 1);
      unsubscribe();
      const later = new Date(now.getTime() + 1000).toISOString();
      assert.equal(
        await a.publishLocation(
          { ...message, capturedAt: later, receivedAt: later, version: 3 },
          1,
        ),
        true,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(received.length, 1);
      assert.deepEqual(foreignNotifications, []);
    } finally {
      await Promise.all([a.close(), b.close(), other.close()]);
      const keys = await admin.keys(`bep:tracking:${ns}:*`);
      if (keys.length) await admin.del(...keys);
      const otherKeys = await admin.keys(`bep:tracking:${otherNs}:*`);
      if (otherKeys.length) await admin.del(...otherKeys);
      admin.disconnect();
    }
  },
);

test('tracking namespace separates DB schemas without exposing credentials', () => {
  const first = trackingNamespace(
    'postgresql://alice:secret@localhost:5432/app?schema=one',
    'redis://localhost:6379/0',
  );
  const same = trackingNamespace(
    'postgresql://bob:other@localhost:5432/app?schema=one',
    'redis://localhost:6379/0',
  );
  const second = trackingNamespace(
    'postgresql://alice:secret@localhost:5432/app?schema=two',
    'redis://localhost:6379/0',
  );
  assert.equal(first, same);
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /alice|secret/);
});

test(
  'a subscription created while Redis is down reconnects without another subscribe call',
  { skip: url ? false : 'REDIS_URL is required', timeout: 12000 },
  async () => {
    const upstreamUrl = new URL(url!);
    const sockets = new Set<Socket>();
    let online = false;
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
    const target = new URL(url!);
    target.hostname = '127.0.0.1';
    target.port = String(address.port);
    const namespace = `test_${randomUUID().replaceAll('-', '')}`;
    const bus = createRedisBus(target.toString(), `test:notifications:${randomUUID()}`, namespace);
    const redis = new Redis(url!, { maxRetriesPerRequest: 1 });
    try {
      const received: TrackingLocation[] = [];
      bus.subscribeLocations((message) => received.push(message));
      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.equal(bus.trackingReady(), false);
      online = true;
      await waitFor(() => bus.trackingReady(), 6000);
      await waitFor(
        async () => Number((await redis.pubsub('NUMSUB', `bep:tracking:${namespace}`))[1]) >= 1,
      );
      const now = new Date().toISOString();
      const message = {
        driverId: 'driver',
        latitude: 21,
        longitude: 105,
        capturedAt: now,
        receivedAt: now,
        version: 1,
      };
      assert.equal(await bus.publishLocation(message, 10), true);
      await waitFor(() => received.length === 1);
      assert.deepEqual(received, [message]);
    } finally {
      await bus.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      const keys = await redis.keys(`bep:tracking:${namespace}:*`);
      if (keys.length) await redis.del(...keys);
      redis.disconnect();
    }
  },
);
