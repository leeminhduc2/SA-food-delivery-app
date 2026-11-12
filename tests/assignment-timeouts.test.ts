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
import { decideNoCandidate } from '../server/modules/assignment/domain/search-policy.js';
import type { User } from '../server/shared/types.js';

const schema = `test_timeout_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 });
process.env.DATABASE_URL = testSchemaUrl(testDatabaseUrl(), schema);
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'TimeoutTest123!';
process.env.ASSIGNMENT_AUTOMATION_ENABLED = 'true';
let created = false;
let db: typeof import('../server/shared/db.js');
let assignment: typeof import('../server/modules/assignment/index.js');
let repo: typeof import('../server/modules/assignment/infrastructure/assignment.repository.js');
async function searchFor(suffix: string) {
  await db.prisma.order.create({
    data: {
      id: `order-${suffix}`,
      customer_id: 'customer',
      restaurant_id: 'saigon',
      status: 'ACCEPTED',
      subtotal: 1000,
      delivery_fee: 10000,
      total: 11000,
      address: 'test',
      idempotency_key: `key-${suffix}`,
      fingerprint: 'test',
      expires_at: new Date('2099-01-01T00:00:00Z'),
    },
  });
  await db.prisma.delivery.create({
    data: { id: `delivery-${suffix}`, order_id: `order-${suffix}` },
  });
  return db.prisma.$transaction((tx) => repo.createInitialSearch(`delivery-${suffix}`, 600, tx));
}
async function expireSearch(searchId: string) {
  await db.prisma
    .$executeRaw`UPDATE assignment_searches SET next_run_at = clock_timestamp() - interval '1 second' WHERE id = ${searchId}`;
}
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
  (await import('../server/modules/index.js')).registerModules();
  assignment = await import('../server/modules/assignment/index.js');
  repo = await import('../server/modules/assignment/infrastructure/assignment.repository.js');
});
after(async () => {
  if (db) await db.prisma.$disconnect();
  await dropTestSchema(admin, schema, created);
  await admin.end();
});

test('no candidate follows 30/60-second rounds and emits one exhaustion alert', async () => {
  const search = await searchFor('empty');
  assert.equal(await assignment.runAssignmentWorker(true, 1), 1);
  let row = await db.prisma.assignmentSearch.findUniqueOrThrow({ where: { id: search.id } });
  assert.equal(row.status, 'WAITING');
  assert.equal(row.round, 2);
  let delta = (
    await db.prisma.$queryRaw<
      Array<{ seconds: number }>
    >`SELECT extract(epoch FROM (next_run_at - clock_timestamp()))::float8 AS seconds FROM assignment_searches WHERE id=${search.id}`
  )[0].seconds;
  assert.ok(delta > 28 && delta <= 30);
  assert.equal(await assignment.runAssignmentWorker(true, 1), 0);
  await expireSearch(search.id);
  assert.equal(await assignment.runAssignmentWorker(true, 1), 1);
  row = await db.prisma.assignmentSearch.findUniqueOrThrow({ where: { id: search.id } });
  assert.equal(row.status, 'WAITING');
  assert.equal(row.round, 3);
  delta = (
    await db.prisma.$queryRaw<
      Array<{ seconds: number }>
    >`SELECT extract(epoch FROM (next_run_at - clock_timestamp()))::float8 AS seconds FROM assignment_searches WHERE id=${search.id}`
  )[0].seconds;
  assert.ok(delta > 58 && delta <= 60);
  await expireSearch(search.id);
  assert.equal(await assignment.runAssignmentWorker(true, 1), 1);
  assert.equal(
    (await db.prisma.assignmentSearch.findUniqueOrThrow({ where: { id: search.id } })).status,
    'EXHAUSTED',
  );
  assert.equal(
    await db.prisma.outbox.count({ where: { user_id: 'admin', type: 'ASSIGNMENT_EXHAUSTED' } }),
    1,
  );
  assert.equal(await assignment.runAssignmentWorker(true, 5), 0);
  assert.equal(
    await db.prisma.outbox.count({ where: { user_id: 'admin', type: 'ASSIGNMENT_EXHAUSTED' } }),
    1,
  );
});

test('reject and expiry rotate to new candidates without repeated offers', async () => {
  await db.prisma.user.create({
    data: {
      id: 'driver3',
      email: 'driver3@test',
      name: 'Driver 3',
      role: 'DRIVER',
      password_hash: 'test',
    },
  });
  const time = (await db.prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`)[0].now;
  for (const driver of ['driver', 'driver2', 'driver3']) {
    await db.prisma.driverLocation.create({
      data: {
        driver_id: driver,
        latitude: 21,
        longitude: 105,
        captured_at: time,
        received_at: time,
      },
    });
    await db.prisma.driverAvailability.create({
      data: { driver_id: driver, online: true, ready: true, heartbeat_at: time },
    });
  }
  const search = await searchFor('rotation');
  assert.equal(await assignment.runAssignmentWorker(true, 1), 1);
  const first = await db.prisma.driverOffer.findFirstOrThrow({
    where: { search_id: search.id, status: 'OFFERED' },
  });
  assert.equal(first.driver_id, 'driver');
  const actor = (await db.prisma.user.findUniqueOrThrow({ where: { id: 'driver' } })) as User;
  await (
    await import('../server/modules/assignment/application/offer-response.service.js')
  ).respondToOffer(
    actor,
    first.id,
    { idempotencyKey: 'rotation-reject-key', reason: 'Cannot deliver' },
    'REJECTED',
  );
  assert.equal(await assignment.runAssignmentWorker(true, 1), 1);
  const second = await db.prisma.driverOffer.findFirstOrThrow({
    where: { search_id: search.id, status: 'OFFERED' },
  });
  assert.equal(second.driver_id, 'driver2');
  await db.prisma
    .$executeRaw`UPDATE driver_offers SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${second.id}`;
  await expireSearch(search.id);
  assert.equal(await assignment.runAssignmentWorker(true, 1), 1);
  assert.equal(
    (await db.prisma.driverOffer.findUniqueOrThrow({ where: { id: second.id } })).status,
    'EXPIRED',
  );
  assert.equal(
    (
      await db.prisma.assignmentAttempt.findFirstOrThrow({
        where: { search_id: search.id, driver_id: 'driver2' },
      })
    ).outcome,
    'EXPIRED',
  );
  assert.equal(await assignment.runAssignmentWorker(true, 1), 1);
  const third = await db.prisma.driverOffer.findFirstOrThrow({
    where: { search_id: search.id, status: 'OFFERED' },
  });
  assert.equal(third.driver_id, 'driver3');
  assert.equal(await db.prisma.driverOffer.count({ where: { search_id: search.id } }), 3);
  assert.equal(await assignment.runAssignmentWorker(true, 1), 0);
});

test('deadline and offer limits exhaust deterministically', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const limits = { maxRounds: 3, maxOffers: 10 };
  assert.deepEqual(
    decideNoCandidate({ round: 1, offersCreated: 0, deadlineAt: now }, now, limits),
    { kind: 'EXHAUSTED', reason: 'DEADLINE' },
  );
  assert.deepEqual(
    decideNoCandidate(
      { round: 1, offersCreated: 10, deadlineAt: new Date(now.getTime() + 1) },
      now,
      limits,
    ),
    { kind: 'EXHAUSTED', reason: 'OFFER_LIMIT' },
  );
});

test('database deadline and offer cap stop searches and alert once', async () => {
  const capped = await searchFor('cap');
  await db.prisma.assignmentSearch.update({
    where: { id: capped.id },
    data: { offers_created: 10 },
  });
  assert.equal(await assignment.runAssignmentWorker(true, 1), 1);
  assert.equal(
    (await db.prisma.assignmentSearch.findUniqueOrThrow({ where: { id: capped.id } })).status,
    'EXHAUSTED',
  );
  const deadline = await searchFor('deadline');
  await db.prisma
    .$executeRaw`UPDATE assignment_searches SET deadline_at = clock_timestamp() - interval '1 second' WHERE id = ${deadline.id}`;
  assert.equal(await assignment.runAssignmentWorker(true, 1), 1);
  assert.equal(
    (await db.prisma.assignmentSearch.findUniqueOrThrow({ where: { id: deadline.id } })).status,
    'EXHAUSTED',
  );
  const alerts = await db.prisma.outbox.findMany({
    where: { type: 'ASSIGNMENT_EXHAUSTED', user_id: 'admin' },
  });
  assert.equal(
    alerts.filter((row) => (row.payload as { searchId?: string }).searchId === capped.id).length,
    1,
  );
  assert.equal(
    alerts.filter((row) => (row.payload as { searchId?: string }).searchId === deadline.id).length,
    1,
  );
});

test('one failed background stage does not starve the other stages', async () => {
  const called: string[] = [];
  const failed = await (
    await import('../server/jobs.js')
  ).runIsolatedStages([
    {
      name: 'payment',
      async run() {
        called.push('payment');
        throw new Error('test');
      },
    },
    {
      name: 'assignment',
      async run() {
        called.push('assignment');
      },
    },
    {
      name: 'notification',
      async run() {
        called.push('notification');
      },
    },
  ]);
  assert.deepEqual(failed, ['payment']);
  assert.deepEqual(called, ['payment', 'assignment', 'notification']);
});
