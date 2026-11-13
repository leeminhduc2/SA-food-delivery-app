import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';
import pg from 'pg';
import Redis from 'ioredis';
import {
  testDatabaseUrl,
  testSchemaUrl,
  verifyTestSchema,
  dropTestSchema,
} from './test-database.js';
import { trackingNamespace } from '../server/modules/notification/infrastructure/redis-bus.js';

const redisUrl = process.env.REDIS_URL;
const schema = `test_tracking_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 });
process.env.DATABASE_URL = testSchemaUrl(testDatabaseUrl(), schema);
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'TrackingStreamTest123!';
process.env.ASSIGNMENT_AUTOMATION_ENABLED = 'false';
process.env.LOG_REQUESTS = 'false';
let created = false,
  server: Server,
  base = '';
let db: typeof import('../server/shared/db.js');
let notification: typeof import('../server/modules/notification/index.js');
let streamService: typeof import('../server/modules/location/application/tracking-stream.service.js');
const cookies: Record<string, string> = {};
const streams = new Set<AbortController>();
let redis: Redis;
async function waitFor(condition: () => Promise<boolean> | boolean, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('Timed out waiting for tracking condition');
}
async function request(path: string, actor = 'customer', method = 'GET', body?: unknown) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      cookie: cookies[actor] ?? '',
      'Content-Type': 'application/json',
      'X-Requested-With': 'Bep',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json(), headers: response.headers };
}
async function login(actor: string) {
  const response = await request('/auth/login', '', 'POST', {
    email: `${actor}@bep.local`,
    password: process.env.DEMO_PASSWORD,
  });
  assert.equal(response.status, 200);
  cookies[actor] = response.headers.get('set-cookie')!.split(';')[0];
}
async function fixture(suffix: string, assigned = true) {
  const order = `tracking-order-${suffix}`,
    delivery = `tracking-delivery-${suffix}`;
  await db.prisma.order.create({
    data: {
      id: order,
      customer_id: 'customer',
      restaurant_id: 'saigon',
      status: 'ACCEPTED',
      subtotal: 1000,
      delivery_fee: 0,
      total: 1000,
      address: 'private',
      idempotency_key: order,
      fingerprint: 'test',
      expires_at: new Date('2099-01-01T00:00:00Z'),
    },
  });
  await db.prisma.delivery.create({
    data: {
      id: delivery,
      order_id: order,
      status: assigned ? 'ASSIGNED' : 'UNASSIGNED',
      driver_id: assigned ? 'driver' : null,
    },
  });
  if (assigned)
    await db.prisma.driverAssignment.create({
      data: { id: `tracking-assignment-${suffix}`, delivery_id: delivery, driver_id: 'driver' },
    });
  const now = new Date();
  for (const driver of ['driver', 'driver2'])
    await db.prisma.driverLocation.upsert({
      where: { driver_id: driver },
      create: {
        driver_id: driver,
        latitude: driver === 'driver' ? 21 : 22,
        longitude: 105,
        captured_at: now,
        received_at: now,
      },
      update: {
        latitude: driver === 'driver' ? 21 : 22,
        longitude: 105,
        captured_at: now,
        received_at: now,
        version: { increment: 1 },
      },
    });
  return { order, delivery };
}
async function release(delivery: string) {
  await db.prisma.driverAssignment.updateMany({
    where: { delivery_id: delivery, active: true },
    data: { active: false, end_reason: 'REASSIGNED', ended_at: new Date() },
  });
}
class Frames {
  private buffer = '';
  private readonly decoder = new TextDecoder();
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  constructor(
    readonly response: Response,
    readonly controller: AbortController,
  ) {
    this.reader = response.body!.getReader();
  }
  async next(timeout = 6000): Promise<{ event: string; data: any; raw: string }> {
    const end = Date.now() + timeout;
    for (;;) {
      const at = this.buffer.indexOf('\n\n');
      if (at >= 0) {
        const raw = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 2);
        const event = raw.match(/^event: (.+)$/m)?.[1];
        const data = raw.match(/^data: (.+)$/m)?.[1];
        if (event && data) return { event, data: JSON.parse(data), raw };
        continue;
      }
      const remaining = end - Date.now();
      if (remaining <= 0) throw new Error('Timed out waiting for SSE frame');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const part = await Promise.race([
        this.reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Timed out waiting for SSE')), remaining);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (part.done) throw new Error('Stream ended before frame');
      this.buffer += this.decoder.decode(part.value, { stream: true });
    }
  }
  async close() {
    this.controller.abort();
    await this.reader.cancel().catch(() => undefined);
    streams.delete(this.controller);
  }
}
async function open(order: string, actor = 'customer', lastEventId?: string) {
  const controller = new AbortController();
  streams.add(controller);
  const response = await fetch(`${base}/api/orders/${order}/tracking/stream`, {
    headers: {
      cookie: cookies[actor] ?? '',
      ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
    },
    signal: controller.signal,
  });
  return { response, frames: response.ok ? new Frames(response, controller) : null, controller };
}
async function publish(driverId: string) {
  const row = await db.prisma.driverLocation.findUniqueOrThrow({ where: { driver_id: driverId } });
  const transport = notification.trackingTransport()!;
  return transport.publishLocation(
    {
      driverId,
      latitude: row.latitude,
      longitude: row.longitude,
      capturedAt: row.captured_at.toISOString(),
      receivedAt: row.received_at.toISOString(),
      version: row.version,
    },
    120,
  );
}
before(async () => {
  if (!redisUrl) return;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  db = await import('../server/shared/db.js');
  await verifyTestSchema(schema, db.prisma);
  await (await import('../server/migrate.js')).migrate();
  await (await import('../server/seed/seed.js')).seed();
  const customer = await db.prisma.user.findUniqueOrThrow({ where: { id: 'customer' } });
  await db.prisma.user.create({
    data: {
      id: 'outsider',
      email: 'outsider@bep.local',
      name: 'Outsider',
      role: 'CUSTOMER',
      password_hash: customer.password_hash,
    },
  });
  notification = await import('../server/modules/notification/index.js');
  notification.initNotificationBus(notification.dispatchPush);
  await waitFor(() => Boolean(notification.trackingTransport()?.trackingReady()));
  streamService = await import('../server/modules/location/application/tracking-stream.service.js');
  const { createApp } = await import('../server/app.js');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  for (const actor of [
    'customer',
    'outsider',
    'restaurant',
    'restaurant2',
    'driver',
    'driver2',
    'admin',
  ])
    await login(actor);
  redis = new Redis(redisUrl!, { maxRetriesPerRequest: 1 });
});
after(async () => {
  for (const controller of streams) controller.abort();
  streamService?.closeAllTrackingStreams();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  await notification?.closeNotificationBus();
  if (redis) {
    const ns = trackingNamespace(process.env.DATABASE_URL, redisUrl);
    const keys = await redis.keys(`bep:tracking:${ns}:*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  }
  if (db) await db.prisma.$disconnect();
  await dropTestSchema(admin, schema, created);
  await admin.end();
});

test(
  'tracking snapshots enforce resource scope and redact terminal or unavailable GPS',
  { skip: redisUrl ? false : 'REDIS_URL is required' },
  async () => {
    const f = await fixture('snapshot');
    try {
      for (const actor of ['customer', 'restaurant', 'driver', 'admin']) {
        const response = await request(`/orders/${f.order}/tracking`, actor);
        assert.equal(response.status, 200, actor);
        assert.deepEqual(response.data.location, { latitude: 21, longitude: 105 });
        assert.equal(response.data.driver.id, 'driver');
        assert.equal(response.data.routeMode, 'WALKING');
        assert.equal(response.data.stale, false);
        assert.equal('payment' in response.data, false);
        assert.equal('assignmentId' in response.data, false);
      }
      for (const actor of ['outsider', 'restaurant2', 'driver2'])
        assert.equal((await request(`/orders/${f.order}/tracking`, actor)).status, 403);
      assert.equal((await request(`/orders/${f.order}/tracking`, 'unknown')).status, 401);
      assert.equal((await request('/orders/no-such-order/tracking', 'customer')).status, 404);
      await db.prisma
        .$executeRaw`UPDATE driver_locations SET captured_at = now() - interval '2 minutes', received_at = now() - interval '2 minutes' WHERE driver_id = 'driver'`;
      assert.equal((await request(`/orders/${f.order}/tracking`)).data.stale, true);
      await db.prisma.driverLocation.delete({ where: { driver_id: 'driver' } });
      assert.equal(
        (await request(`/orders/${f.order}/tracking`)).data.reason,
        'LOCATION_UNAVAILABLE',
      );
      await db.prisma.user.update({ where: { id: 'driver' }, data: { active: false } });
      const locked = await request(`/orders/${f.order}/tracking`);
      assert.equal(locked.data.reason, 'DRIVER_UNAVAILABLE');
      assert.equal(locked.data.location, null);
      await db.prisma.user.update({ where: { id: 'driver' }, data: { active: true } });
      await db.prisma.delivery.update({ where: { id: f.delivery }, data: { status: 'DELIVERED' } });
      await db.prisma.driverAssignment.updateMany({
        where: { delivery_id: f.delivery },
        data: { active: false, end_reason: 'DELIVERED', ended_at: new Date() },
      });
      const terminal = await request(`/orders/${f.order}/tracking`);
      assert.equal(terminal.data.reason, 'TERMINAL');
      assert.equal(terminal.data.location, null);
      const finalDriver = await request(`/orders/${f.order}/tracking`, 'driver');
      assert.equal(finalDriver.status, 200);
      assert.equal(finalDriver.data.location, null);
      assert.equal((await request(`/orders/${f.order}/tracking`, 'driver2')).status, 403);
    } finally {
      await db.prisma.user.update({ where: { id: 'driver' }, data: { active: true } });
      await release(f.delivery);
    }
  },
);

test(
  'unassigned order has no location',
  { skip: redisUrl ? false : 'REDIS_URL is required' },
  async () => {
    const f = await fixture('unassigned', false);
    const response = await request(`/orders/${f.order}/tracking`);
    assert.equal(response.status, 200);
    assert.equal(response.data.reason, 'NO_DRIVER');
    assert.equal(response.data.location, null);
  },
);

test(
  'stream sends only authorized current GPS, ignores replay and revokes on reassignment',
  { skip: redisUrl ? false : 'REDIS_URL is required', timeout: 15000 },
  async () => {
    const f = await fixture('reassign');
    let frames: Frames | null = null;
    try {
      const forbidden = await open(f.order, 'outsider');
      assert.equal(forbidden.response.status, 403);
      forbidden.controller.abort();
      streams.delete(forbidden.controller);
      const opened = await open(f.order, 'customer', 'old-position-id');
      assert.equal(opened.response.status, 200);
      frames = opened.frames!;
      const first = await frames.next();
      assert.equal(first.event, 'location');
      assert.equal(first.data.driver.id, 'driver');
      assert.deepEqual(first.data.location, { latitude: 21, longitude: 105 });
      assert.doesNotMatch(first.raw, /^id:/m);
      const ns = trackingNamespace(process.env.DATABASE_URL, redisUrl);
      await waitFor(
        async () => Number((await redis.pubsub('NUMSUB', `bep:tracking:${ns}`))[1]) >= 1,
      );
      const now = new Date();
      await db.prisma.driverLocation.update({
        where: { driver_id: 'driver' },
        data: { latitude: 21.1, captured_at: now, received_at: now, version: { increment: 1 } },
      });
      await publish('driver');
      const next = await frames.next();
      assert.equal(next.event, 'location');
      assert.equal(next.data.location.latitude, 21.1);
      await db.prisma.$transaction(async (tx) => {
        await tx.driverAssignment.updateMany({
          where: { delivery_id: f.delivery, active: true },
          data: { active: false, end_reason: 'REASSIGNED', ended_at: new Date() },
        });
        await tx.driverAssignment.create({
          data: {
            id: 'tracking-assignment-reassign-new',
            delivery_id: f.delivery,
            driver_id: 'driver2',
          },
        });
        await tx.delivery.update({ where: { id: f.delivery }, data: { driver_id: 'driver2' } });
      });
      const later = new Date(Date.now() + 20);
      await db.prisma.driverLocation.update({
        where: { driver_id: 'driver' },
        data: { latitude: 21.2, captured_at: later, received_at: later, version: { increment: 1 } },
      });
      await publish('driver');
      const revoked = await frames.next();
      assert.equal(revoked.event, 'revoked');
      assert.equal('location' in revoked.data, false);
      await waitFor(() => streamService.trackingStreamCount() === 0);
      assert.equal((await request(`/orders/${f.order}/tracking`, 'driver')).status, 403);
      const current = await request(`/orders/${f.order}/tracking`, 'customer');
      assert.equal(current.data.driver.id, 'driver2');
      assert.equal(current.data.location.latitude, 22);
    } finally {
      await frames?.close();
      await release(f.delivery);
    }
  },
);

test(
  'stream revokes expired sessions within five seconds without a Redis push',
  { skip: redisUrl ? false : 'REDIS_URL is required', timeout: 12000 },
  async () => {
    const f = await fixture('session');
    let frames: Frames | null = null;
    try {
      const opened = await open(f.order);
      frames = opened.frames!;
      assert.equal((await frames.next()).event, 'location');
      const tokenHash = createHash('sha256')
        .update(cookies.customer.slice('session='.length))
        .digest('hex');
      await db.prisma.session.update({
        where: { token_hash: tokenHash },
        data: { expires_at: new Date(Date.now() - 1000) },
      });
      const started = Date.now();
      const revoked = await frames.next(5000);
      assert.equal(revoked.event, 'revoked');
      assert.ok(Date.now() - started < 5000);
      await waitFor(() => streamService.trackingStreamCount() === 0);
      await login('customer');
    } finally {
      await frames?.close();
      await release(f.delivery);
    }
  },
);

test(
  'stream ends for locked drivers and terminal delivery without leaking location',
  { skip: redisUrl ? false : 'REDIS_URL is required', timeout: 15000 },
  async () => {
    const f = await fixture('terminal');
    let first: Frames | null = null,
      second: Frames | null = null;
    try {
      first = (await open(f.order)).frames!;
      assert.equal((await first.next()).event, 'location');
      await db.prisma.user.update({ where: { id: 'driver' }, data: { active: false } });
      const locked = await first.next(5000);
      assert.equal(locked.event, 'revoked');
      await db.prisma.user.update({ where: { id: 'driver' }, data: { active: true } });
      second = (await open(f.order)).frames!;
      assert.equal((await second.next()).event, 'location');
      await db.prisma.$transaction(async (tx) => {
        await tx.delivery.update({ where: { id: f.delivery }, data: { status: 'DELIVERED' } });
        await tx.driverAssignment.updateMany({
          where: { delivery_id: f.delivery },
          data: { active: false, end_reason: 'DELIVERED', ended_at: new Date() },
        });
        await tx.order.update({ where: { id: f.order }, data: { status: 'DELIVERED' } });
      });
      const terminal = await second.next(5000);
      assert.equal(terminal.event, 'tracking_status');
      assert.equal(terminal.data.reason, 'TERMINAL');
      assert.equal((await request(`/orders/${f.order}/tracking`)).data.location, null);
      await waitFor(() => streamService.trackingStreamCount() === 0);
    } finally {
      await first?.close();
      await second?.close();
      await db.prisma.user.update({ where: { id: 'driver' }, data: { active: true } });
      await release(f.delivery);
    }
  },
);

test(
  'stream enforces per-user limits and removes disconnected clients',
  { skip: redisUrl ? false : 'REDIS_URL is required', timeout: 12000 },
  async () => {
    const f = await fixture('limits');
    const opened: Frames[] = [];
    try {
      for (let i = 0; i < 5; i++) {
        const stream = await open(f.order);
        assert.equal(stream.response.status, 200);
        opened.push(stream.frames!);
      }
      const sixth = await open(f.order);
      assert.equal(sixth.response.status, 429);
      sixth.controller.abort();
      streams.delete(sixth.controller);
      assert.equal(streamService.trackingStreamCount(), 5);
      await Promise.all(opened.map((frame) => frame.close()));
      await waitFor(() => streamService.trackingStreamCount() === 0);
    } finally {
      await Promise.all(opened.map((frame) => frame.close()));
      await release(f.delivery);
    }
  },
);

test(
  'live tracking enforces every role and closes when restaurant membership is revoked',
  { skip: redisUrl ? false : 'REDIS_URL is required', timeout: 12000 },
  async () => {
    const f = await fixture('roles');
    const opened: Frames[] = [];
    try {
      for (const role of ['customer', 'restaurant', 'driver', 'admin']) {
        const stream = await open(f.order, role);
        assert.equal(stream.response.status, 200, role);
        opened.push(stream.frames!);
        const first = await stream.frames!.next();
        assert.equal(first.event, 'location');
        assert.equal(first.data.driver.id, 'driver');
      }
      for (const role of ['outsider', 'restaurant2', 'driver2']) {
        const stream = await open(f.order, role);
        assert.equal(stream.response.status, 403, role);
        stream.controller.abort();
        streams.delete(stream.controller);
      }
      await db.prisma.restaurantMember.delete({
        where: { user_id_restaurant_id: { user_id: 'restaurant', restaurant_id: 'saigon' } },
      });
      const start = Date.now();
      const revoked = await opened[1].next(5000);
      assert.equal(revoked.event, 'revoked');
      assert.ok(Date.now() - start < 5000);
    } finally {
      await db.prisma.restaurantMember.upsert({
        where: { user_id_restaurant_id: { user_id: 'restaurant', restaurant_id: 'saigon' } },
        create: { user_id: 'restaurant', restaurant_id: 'saigon' },
        update: {},
      });
      await Promise.all(opened.map((frame) => frame.close()));
      await waitFor(() => streamService.trackingStreamCount() === 0);
      await release(f.delivery);
    }
  },
);

test(
  'snapshot stays available and stream reports 503 without Redis transport',
  { skip: redisUrl ? false : 'REDIS_URL is required', timeout: 12000 },
  async () => {
    const f = await fixture('transport-down');
    try {
      await notification.closeNotificationBus();
      const snapshot = await request(`/orders/${f.order}/tracking`);
      assert.equal(snapshot.status, 200);
      assert.equal(snapshot.data.location.latitude, 21);
      const stream = await open(f.order);
      assert.equal(stream.response.status, 503);
      stream.controller.abort();
      streams.delete(stream.controller);
      notification.initNotificationBus(notification.dispatchPush);
      await waitFor(() => Boolean(notification.trackingTransport()?.trackingReady()));
    } finally {
      await release(f.delivery);
    }
  },
);

test(
  'a client disconnect during initial authorization does not leak a stream',
  { skip: redisUrl ? false : 'REDIS_URL is required' },
  async () => {
    const { setTrackingAccessGateway } = await import('../server/modules/location/index.js');
    const { trackingAccessGateway } = await import('../server/modules/ordering/index.js');
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    setTrackingAccessGateway(async () => {
      await barrier;
      return {
        orderId: 'slow',
        deliveryId: null,
        status: 'UNASSIGNED',
        driverId: null,
        assignmentId: null,
        driver: null,
      };
    });
    const response = { destroyed: false, writableEnded: false } as any;
    const request = { headers: { cookie: cookies.customer } } as any;
    try {
      const opening = streamService.openTrackingStream(
        request,
        response,
        {
          id: 'customer',
          name: 'Customer',
          email: 'customer@bep.local',
          role: 'CUSTOMER',
          active: true,
        },
        'slow',
      );
      response.destroyed = true;
      release();
      await opening;
      assert.equal(streamService.trackingStreamCount(), 0);
    } finally {
      setTrackingAccessGateway(trackingAccessGateway);
    }
  },
);

test(
  'every GPS push rechecks the viewing account before writing coordinates',
  { skip: redisUrl ? false : 'REDIS_URL is required', timeout: 12000 },
  async () => {
    const f = await fixture('push-auth');
    let frames: Frames | null = null;
    try {
      frames = (await open(f.order)).frames!;
      assert.equal((await frames.next()).event, 'location');
      const ns = trackingNamespace(process.env.DATABASE_URL, redisUrl);
      await waitFor(
        async () => Number((await redis.pubsub('NUMSUB', `bep:tracking:${ns}`))[1]) >= 1,
      );
      await db.prisma.user.update({ where: { id: 'customer' }, data: { active: false } });
      const now = new Date();
      await db.prisma.driverLocation.update({
        where: { driver_id: 'driver' },
        data: { latitude: 21.3, captured_at: now, received_at: now, version: { increment: 1 } },
      });
      await publish('driver');
      const revoked = await frames.next(2000);
      assert.equal(revoked.event, 'revoked');
      assert.equal('location' in revoked.data, false);
    } finally {
      await frames?.close();
      await db.prisma.user.update({ where: { id: 'customer' }, data: { active: true } });
      await release(f.delivery);
    }
  },
);

test(
  'stream fails closed if session revalidation stalls',
  { skip: redisUrl ? false : 'REDIS_URL is required', timeout: 12000 },
  async () => {
    const f = await fixture('validation-timeout');
    let frames: Frames | null = null;
    const blocker = await admin.connect();
    try {
      frames = (await open(f.order)).frames!;
      assert.equal((await frames.next()).event, 'location');
      await blocker.query(`SET search_path TO "${schema}"`);
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE');
      const started = Date.now();
      const revoked = await frames.next(5000);
      assert.equal(revoked.event, 'revoked');
      assert.ok(Date.now() - started < 5000);
      await blocker.query('ROLLBACK');
      await waitFor(() => streamService.trackingStreamCount() === 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      await frames?.close();
      await release(f.delivery);
    }
  },
);

test(
  'disconnect cancels queued validation while the session store is blocked',
  { skip: redisUrl ? false : 'REDIS_URL is required', timeout: 12000 },
  async () => {
    const f = await fixture('disconnect-blocked');
    let frames: Frames | null = null;
    const blocker = await admin.connect();
    try {
      frames = (await open(f.order)).frames!;
      assert.equal((await frames.next()).event, 'location');
      const ns = trackingNamespace(process.env.DATABASE_URL, redisUrl);
      await waitFor(
        async () => Number((await redis.pubsub('NUMSUB', `bep:tracking:${ns}`))[1]) >= 1,
      );
      await blocker.query(`SET search_path TO "${schema}"`);
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE');
      const now = new Date();
      await db.prisma.driverLocation.update({
        where: { driver_id: 'driver' },
        data: { latitude: 21.4, captured_at: now, received_at: now, version: { increment: 1 } },
      });
      await publish('driver');
      await waitFor(
        async () =>
          (
            await admin.query(
              "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%sessions%' AND pid <> pg_backend_pid() LIMIT 1",
            )
          ).rowCount! > 0,
        2000,
      );
      const started = Date.now();
      await frames.close();
      await waitFor(() => streamService.trackingStreamCount() === 0, 1000);
      assert.ok(Date.now() - started < 1000);
      await blocker.query('ROLLBACK');
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      await frames?.close();
      await release(f.delivery);
    }
  },
);

test(
  'an open stream reports transport loss and resumes after the Redis bus is replaced',
  { skip: redisUrl ? false : 'REDIS_URL is required', timeout: 15000 },
  async () => {
    const f = await fixture('bus-restart');
    let frames: Frames | null = null;
    try {
      frames = (await open(f.order)).frames!;
      assert.equal((await frames.next()).event, 'location');
      await notification.closeNotificationBus();
      const disconnected = await frames.next(5000);
      assert.equal(disconnected.event, 'tracking_status');
      assert.equal(disconnected.data.connected, false);
      notification.initNotificationBus(notification.dispatchPush);
      await waitFor(() => Boolean(notification.trackingTransport()?.trackingReady()));
      const reconnected = await frames.next(5000);
      assert.equal(reconnected.event, 'tracking_status');
      assert.equal(reconnected.data.connected, true);
      const ns = trackingNamespace(process.env.DATABASE_URL, redisUrl);
      await waitFor(
        async () => Number((await redis.pubsub('NUMSUB', `bep:tracking:${ns}`))[1]) >= 1,
      );
      const now = new Date();
      await db.prisma.driverLocation.update({
        where: { driver_id: 'driver' },
        data: { latitude: 21.5, captured_at: now, received_at: now, version: { increment: 1 } },
      });
      await publish('driver');
      const updated = await frames.next(3000);
      assert.equal(updated.event, 'location');
      assert.equal(updated.data.location.latitude, 21.5);
    } finally {
      await frames?.close();
      await release(f.delivery);
    }
  },
);

test(
  'heartbeat recovers the latest DB location when a Redis push is lost',
  { skip: redisUrl ? false : 'REDIS_URL is required', timeout: 10000 },
  async () => {
    const f = await fixture('lost-push');
    let frames: Frames | null = null;
    try {
      frames = (await open(f.order)).frames!;
      assert.equal((await frames.next()).event, 'location');
      const now = new Date();
      await db.prisma.driverLocation.update({
        where: { driver_id: 'driver' },
        data: { latitude: 21.6, captured_at: now, received_at: now, version: { increment: 1 } },
      });
      const recovered = await frames.next(5000);
      assert.equal(recovered.event, 'location');
      assert.equal(recovered.data.location.latitude, 21.6);
    } finally {
      await frames?.close();
      await release(f.delivery);
    }
  },
);
