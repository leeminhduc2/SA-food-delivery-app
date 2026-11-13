import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';
import pg from 'pg';
import {
  testDatabaseUrl,
  testSchemaUrl,
  verifyTestSchema,
  dropTestSchema,
} from './test-database.js';
import { createLowestEtaStrategy } from '../server/modules/assignment/application/strategies/lowest-eta.strategy.js';
import { createBalancedLoadStrategy } from '../server/modules/assignment/application/strategies/balanced-load.strategy.js';
import type { AssignmentCandidate } from '../server/modules/assignment/domain/assignment-strategy.js';

const schema = `test_strategies_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 });
const target = testSchemaUrl(testDatabaseUrl(), schema);
const pool = new pg.Pool({ connectionString: target, connectionTimeoutMillis: 3000 });
process.env.DATABASE_URL = target;
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'StrategyTest123!';
process.env.LOG_REQUESTS = 'false';
process.env.ASSIGNMENT_AUTOMATION_ENABLED = 'true';
let created = false,
  server: Server,
  base = '';
let db: typeof import('../server/shared/db.js');
let assignment: typeof import('../server/modules/assignment/index.js');
let delivery: typeof import('../server/modules/delivery/index.js');
const cookies: Record<string, string> = {};
const pickup = { latitude: 21, longitude: 105 };
const at = (dLat: number) => ({ latitude: 21 + dLat, longitude: 105 });
const list = (n: number): AssignmentCandidate[] =>
  Array.from({ length: n }, (_, i) => ({ driverId: `c${i + 1}`, location: at((i + 1) * 0.001) }));

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  created = true;
  db = await import('../server/shared/db.js');
  await verifyTestSchema(schema, db.prisma);
  await (await import('../server/migrate.js')).migrate();
  await (await import('../server/seed/seed.js')).seed();
  await db.prisma.restaurant.update({
    where: { id: 'saigon' },
    data: { latitude: 21, longitude: 105 },
  });
  server = (await import('../server/app.js')).createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  assignment = await import('../server/modules/assignment/index.js');
  delivery = await import('../server/modules/delivery/index.js');
});
after(async () => {
  assignment?.useAssignmentStrategy(null);
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  if (db) await db.prisma.$disconnect();
  await pool.end();
  await dropTestSchema(admin, schema, created);
  await admin.end();
});

test('Lowest ETA ranks the five nearest by walking ETA and keeps the tail without ETA', async () => {
  const calls: string[] = [];
  const eta: Record<string, number> = { c1: 900, c2: 300, c3: 300, c4: 120, c5: 600 };
  const strategy = createLowestEtaStrategy(async (from) => {
    const id = `c${Math.round((from.latitude - 21) / 0.001)}`;
    calls.push(id);
    return { durationSeconds: eta[id], distanceMeters: eta[id] * 1.2 };
  });
  const ranked = await strategy.rank({ pickup }, list(7));
  assert.deepEqual(calls.sort(), ['c1', 'c2', 'c3', 'c4', 'c5']);
  // c2/c3 tie on ETA → nearer first; c6/c7 are the tail in Nearest order.
  assert.deepEqual(
    ranked.map((row) => row.driverId),
    ['c4', 'c2', 'c3', 'c5', 'c1', 'c6', 'c7'],
  );
  for (const row of ranked.slice(0, 5)) {
    assert.equal(row.rankingScope, 'TOP5_NEAREST');
    assert.equal(row.criterion.kind, 'WALKING_ETA_SECONDS');
    assert.ok(row.criterion.kind === 'WALKING_ETA_SECONDS' && row.criterion.etaSeconds! > 0);
  }
  for (const row of ranked.slice(5)) {
    assert.equal(row.rankingScope, 'TAIL_NEAREST');
    assert.ok(row.criterion.kind === 'WALKING_ETA_SECONDS' && row.criterion.etaSeconds === null);
    assert.ok(
      row.criterion.kind === 'WALKING_ETA_SECONDS' && row.criterion.routeMode === 'WALKING',
    );
  }
});

test('any top-five routing failure falls back to Nearest deterministically with a reason', async () => {
  const failures: Array<[string, (id: string) => Promise<any>]> = [
    [
      'ROUTE_TIMEOUT',
      async (id) => {
        if (id === 'c3') throw Object.assign(new Error('slow'), { code: 'TIMEOUT' });
        return { durationSeconds: 60, distanceMeters: 1 };
      },
    ],
    [
      'ROUTE_NO_ROUTE',
      async (id) => {
        if (id === 'c5') throw Object.assign(new Error('none'), { code: 'NO_ROUTE' });
        return { durationSeconds: 60, distanceMeters: 1 };
      },
    ],
    ['ROUTE_INVALID', async () => ({ durationSeconds: Number.NaN, distanceMeters: 1 })],
    [
      'ROUTE_ERROR',
      async () => {
        throw new Error('provider down');
      },
    ],
  ];
  for (const [reason, behaviour] of failures) {
    const strategy = createLowestEtaStrategy((from) =>
      behaviour(`c${Math.round((from.latitude - 21) / 0.001)}`),
    );
    const first = await strategy.rank({ pickup }, list(7));
    assert.deepEqual(await strategy.rank({ pickup }, list(7)), first);
    assert.deepEqual(
      first.map((row) => row.driverId),
      ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'],
    );
    for (const row of first) {
      assert.equal(row.fallbackReason, reason);
      assert.equal(row.appliedStrategy, 'NEAREST');
      assert.equal(row.criterion.kind, 'HAVERSINE_METERS');
    }
  }
});

test('Balanced Load prefers fewer pickups, then distance, then ID, and falls back on gaps', async () => {
  const counts = new Map([
    ['c1', 2],
    ['c2', 0],
    ['c3', 1],
    ['c4', 0],
  ]);
  const strategy = createBalancedLoadStrategy(async () => ({ counts, complete: true }));
  const now = new Date('2026-05-01T12:00:00Z');
  const ranked = await strategy.rank({ pickup, now }, list(4));
  assert.deepEqual(
    ranked.map((row) => row.driverId),
    ['c2', 'c4', 'c3', 'c1'],
  );
  assert.deepEqual(
    ranked.map((row) => row.criterion.kind === 'PICKUPS_24H' && row.criterion.pickups),
    [0, 0, 1, 2],
  );
  const gap = createBalancedLoadStrategy(async () => ({ counts, complete: false }));
  const fallback = await gap.rank({ pickup, now }, list(4));
  assert.deepEqual(
    fallback.map((row) => [row.driverId, row.fallbackReason]),
    [
      ['c1', 'LOAD_HISTORY_INCOMPLETE'],
      ['c2', 'LOAD_HISTORY_INCOMPLETE'],
      ['c3', 'LOAD_HISTORY_INCOMPLETE'],
      ['c4', 'LOAD_HISTORY_INCOMPLETE'],
    ],
  );
  const broken = createBalancedLoadStrategy(async () => {
    throw new Error('db down');
  });
  assert.equal((await broken.rank({ pickup, now }, list(2)))[0].fallbackReason, 'LOAD_UNAVAILABLE');
  assert.equal((await strategy.rank({ pickup }, list(2)))[0].fallbackReason, 'CLOCK_UNAVAILABLE');
});

async function loadTrip(driver: string, options: { pickedUpAt?: Date | null; status: string }) {
  const order = randomUUID();
  await db.prisma.order.create({
    data: {
      id: order,
      customer_id: 'customer',
      restaurant_id: 'saigon',
      status: 'DELIVERED',
      subtotal: 1000,
      delivery_fee: 0,
      total: 1000,
      address: 'x',
      idempotency_key: order,
      fingerprint: 'load',
      expires_at: new Date('2099-01-01T00:00:00Z'),
    },
  });
  const id = randomUUID();
  await db.prisma.delivery.create({
    data: {
      id,
      order_id: order,
      driver_id: driver,
      status: options.status,
      picked_up_at: options.pickedUpAt ?? null,
      updated_at: options.pickedUpAt ?? new Date('2026-05-01T11:00:00Z'),
    },
  });
  return { order, id };
}

test('pickup load window is [now-24h, now] and counts each delivery once', async () => {
  for (const id of ['load-a', 'load-b', 'load-c'])
    await pool.query(
      "INSERT INTO users (id,email,name,password_hash,role,active) VALUES ($1,$2,$1,'x','DRIVER',true)",
      [id, `${id}@test.local`],
    );
  const now = new Date('2026-05-01T12:00:00Z');
  const start = new Date(now.getTime() - 24 * 3600000);
  await loadTrip('load-a', { pickedUpAt: start, status: 'DELIVERED' });
  await loadTrip('load-a', { pickedUpAt: now, status: 'FAILED' });
  await loadTrip('load-a', { pickedUpAt: new Date(start.getTime() - 1), status: 'DELIVERED' });
  await loadTrip('load-a', { pickedUpAt: new Date(now.getTime() + 1), status: 'DELIVERED' });
  const twice = await loadTrip('load-b', {
    pickedUpAt: new Date('2026-05-01T10:00:00Z'),
    status: 'DELIVERED',
  });
  for (let i = 0; i < 2; i++)
    await db.prisma.stateHistory.create({
      data: {
        id: randomUUID(),
        order_id: twice.order,
        entity: 'DELIVERY',
        to_state: 'PICKED_UP',
        actor: 'load-b',
      },
    });
  await loadTrip('load-b', { pickedUpAt: null, status: 'CANCELLED' });
  const result = await delivery.pickupLoads(['load-a', 'load-b', 'load-c'], {
    from: start,
    to: now,
  });
  assert.deepEqual(Object.fromEntries(result.counts), { 'load-a': 2, 'load-b': 1 });
  assert.equal(result.complete, true);
  await loadTrip('load-c', { pickedUpAt: null, status: 'DELIVERED' });
  const incomplete = await delivery.pickupLoads(['load-c'], { from: start, to: now });
  assert.equal(incomplete.complete, false);
});

async function login(id: string) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Bep' },
    body: JSON.stringify({ email: `${id}@test.local`, password: process.env.DEMO_PASSWORD }),
  });
  assert.equal(response.status, 200);
  cookies[id] = response.headers.get('set-cookie')!.split(';')[0];
}
async function readyDriver(id: string, dLat: number) {
  const password = (await db.prisma.user.findUniqueOrThrow({ where: { id: 'driver' } }))
    .password_hash;
  await db.prisma.user.create({
    data: {
      id,
      email: `${id}@test.local`,
      name: id,
      role: 'DRIVER',
      active: true,
      password_hash: password,
    },
  });
  const now = (await db.prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`)[0].now;
  await db.prisma.driverLocation.create({
    data: { driver_id: id, ...at(dLat), captured_at: now, received_at: now },
  });
  await db.prisma.driverAvailability.create({
    data: { driver_id: id, online: true, ready: true, heartbeat_at: now },
  });
  await login(id);
}
const accept = (offerId: string, who: string, key: string) =>
  fetch(`${base}/api/driver/offers/${offerId}/accept`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'Bep',
      cookie: cookies[who],
    },
    body: JSON.stringify({ idempotencyKey: key }),
  }).then(async (response) => ({ status: response.status, data: await response.json() }));

for (const name of ['NEAREST', 'LOWEST_ETA', 'BALANCED_LOAD'] as const)
  test(`${name} keeps eligibility, atomic accept, one active trip and audit metadata`, async () => {
    const near = `${name.toLowerCase()}-near`,
      far = `${name.toLowerCase()}-far`;
    await readyDriver(near, 0.001);
    await readyDriver(far, 0.003);
    const order = `strategy-order-${name}`,
      deliveryId = `strategy-delivery-${name}`;
    await db.prisma.order.create({
      data: {
        id: order,
        customer_id: 'customer',
        restaurant_id: 'saigon',
        status: 'ACCEPTED',
        subtotal: 50000,
        delivery_fee: 14000,
        total: 64000,
        address: 'Private',
        idempotency_key: order,
        fingerprint: 'strategy',
        expires_at: new Date('2099-01-01T00:00:00Z'),
      },
    });
    await db.prisma.delivery.create({ data: { id: deliveryId, order_id: order } });
    await db.prisma.assignmentSearch.create({
      data: {
        id: `search-${name}`,
        delivery_id: deliveryId,
        deadline_at: new Date(Date.now() + 600000),
      },
    });
    let lockFree = true;
    if (name === 'NEAREST') assignment.useAssignmentStrategy(assignment.nearestStrategy);
    if (name === 'LOWEST_ETA')
      assignment.useAssignmentStrategy(
        assignment.createLowestEtaStrategy(async (from) => {
          // The worker must not hold Order or Driver locks while routing.
          const probe = await pool.connect();
          try {
            await probe.query('BEGIN');
            await probe.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE NOWAIT', [order]);
            await probe.query('SELECT id FROM users WHERE id = ANY($1) FOR UPDATE NOWAIT', [
              [near, far],
            ]);
          } catch {
            lockFree = false;
          } finally {
            await probe.query('ROLLBACK');
            probe.release();
          }
          // The farther driver walks faster here.
          return { durationSeconds: from.latitude > 21.002 ? 120 : 600, distanceMeters: 300 };
        }),
      );
    if (name === 'BALANCED_LOAD') {
      for (let i = 0; i < 2; i++)
        await loadTrip(near, { pickedUpAt: new Date(Date.now() - 3600000), status: 'DELIVERED' });
      assignment.useAssignmentStrategy(
        assignment.createBalancedLoadStrategy((ids, window) => delivery.pickupLoads(ids, window)),
      );
    }
    try {
      assert.equal(await assignment.runAssignmentWorker(true, 1), 1);
    } finally {
      assignment.useAssignmentStrategy(null);
    }
    assert.ok(lockFree, 'routing ran while a row lock was held');
    const winner = name === 'NEAREST' ? near : far;
    const offer = await db.prisma.driverOffer.findFirstOrThrow({
      where: { search_id: `search-${name}` },
    });
    assert.equal(offer.driver_id, winner);
    const attempt = await db.prisma.assignmentAttempt.findFirstOrThrow({
      where: { search_id: `search-${name}`, driver_id: winner },
    });
    const criterion = attempt.criterion as any;
    assert.equal(criterion.strategy, name);
    assert.equal(criterion.fallbackReason, null);
    assert.ok(criterion.distanceMeters > 0);
    if (name === 'LOWEST_ETA') {
      assert.equal(criterion.kind, 'WALKING_ETA_SECONDS');
      assert.equal(criterion.rankingScope, 'TOP5_NEAREST');
      assert.equal(criterion.routeMode, 'WALKING');
    }
    if (name === 'BALANCED_LOAD') assert.equal(criterion.kind, 'PICKUPS_24H');
    assert.equal(
      (await db.prisma.assignmentSearch.findUniqueOrThrow({ where: { id: `search-${name}` } }))
        .strategy,
      name,
    );
    const loser = winner === near ? far : near;
    assert.equal((await accept(offer.id, loser, `foreign-${name}`)).status, 403);
    const [a, b] = await Promise.all([
      accept(offer.id, winner, `accept-${name}`),
      accept(offer.id, winner, `accept-${name}`),
    ]);
    assert.equal(a.status, 200);
    assert.deepEqual(a.data, b.data);
    assert.equal(
      await db.prisma.driverAssignment.count({ where: { driver_id: winner, active: true } }),
      1,
    );
    assert.equal(
      (await db.prisma.order.findUniqueOrThrow({ where: { id: order } })).delivery_fee,
      14000,
    );
    await db.prisma.driverAvailability.updateMany({
      where: { driver_id: { in: [near, far] } },
      data: { online: false, ready: false },
    });
  });
