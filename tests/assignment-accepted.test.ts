import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { after, before, test } from 'node:test';
import pg from 'pg';
import {
  testDatabaseUrl,
  testSchemaUrl,
  verifyTestSchema,
  dropTestSchema,
} from './test-database.js';
import type { User } from '../server/shared/types.js';

const schema = `test_accept_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 });
process.env.DATABASE_URL = testSchemaUrl(testDatabaseUrl(), schema);
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'AssignmentTest123!';
process.env.ASSIGNMENT_AUTOMATION_ENABLED = 'true';
let created = false;
let db: typeof import('../server/shared/db.js');
let lifecycle: typeof import('../server/modules/ordering/application/order-lifecycle.js');
let assignment: typeof import('../server/modules/assignment/index.js');
let actor: User;
async function createOrder(name: string) {
  await db.prisma.order.create({
    data: {
      id: `order-${name}`,
      customer_id: 'customer',
      restaurant_id: 'saigon',
      status: 'CONFIRMED',
      subtotal: 1000,
      delivery_fee: 10000,
      total: 11000,
      address: 'Private customer address',
      note: 'Private customer note',
      idempotency_key: `key-${name}`,
      fingerprint: 'test',
      expires_at: new Date('2099-01-01T00:00:00Z'),
    },
  });
  await db.prisma.delivery.create({ data: { id: `delivery-${name}`, order_id: `order-${name}` } });
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
  const now = (await db.prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`)[0].now;
  for (const driver of ['driver', 'driver2']) {
    await db.prisma.driverLocation.create({
      data: { driver_id: driver, latitude: 21, longitude: 105, captured_at: now, received_at: now },
    });
    await db.prisma.driverAvailability.create({
      data: { driver_id: driver, online: true, ready: true, heartbeat_at: now },
    });
  }
  actor = (await db.prisma.user.findUniqueOrThrow({ where: { id: 'restaurant' } })) as User;
  (await import('../server/modules/index.js')).registerModules();
  lifecycle = await import('../server/modules/ordering/application/order-lifecycle.js');
  assignment = await import('../server/modules/assignment/index.js');
});
after(async () => {
  if (db) await db.prisma.$disconnect();
  await dropTestSchema(admin, schema, created);
  await admin.end();
});

test('Accepted and durable search commit together, duplicate events do not duplicate offers', async () => {
  await createOrder('rollback');
  await db.prisma.$executeRawUnsafe(
    `CREATE FUNCTION reject_search() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.delivery_id = 'delivery-rollback' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$`,
  );
  await db.prisma.$executeRawUnsafe(
    'CREATE TRIGGER reject_search BEFORE INSERT ON assignment_searches FOR EACH ROW EXECUTE FUNCTION reject_search()',
  );
  try {
    await assert.rejects(lifecycle.transition(actor, 'order-rollback', { status: 'ACCEPTED' }));
  } finally {
    await db.prisma.$executeRawUnsafe('DROP TRIGGER reject_search ON assignment_searches');
    await db.prisma.$executeRawUnsafe('DROP FUNCTION reject_search()');
  }
  assert.equal(
    (await db.prisma.order.findUniqueOrThrow({ where: { id: 'order-rollback' } })).status,
    'CONFIRMED',
  );
  assert.equal(
    await db.prisma.assignmentSearch.count({ where: { delivery_id: 'delivery-rollback' } }),
    0,
  );
  assert.equal(
    await db.prisma.stateHistory.count({
      where: { order_id: 'order-rollback', to_state: 'ACCEPTED' },
    }),
    0,
  );
  await createOrder('accepted');
  await lifecycle.transition(actor, 'order-accepted', { status: 'ACCEPTED' });
  const search = await db.prisma.assignmentSearch.findUniqueOrThrow({
    where: { delivery_id_generation: { delivery_id: 'delivery-accepted', generation: 1 } },
  });
  const { publish } = await import('../server/shared/events.js');
  await db.prisma.$transaction((tx) =>
    publish(tx, 'OrderAccepted', {
      orderId: 'order-accepted',
      deliveryId: 'delivery-accepted',
      actor: 'restaurant',
    }),
  );
  assert.equal(
    await db.prisma.assignmentSearch.count({ where: { delivery_id: 'delivery-accepted' } }),
    1,
  );
  // Start a separate Node process: the search must survive without this process's memory.
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'tests/helpers/run-assignment-worker.ts'],
    { env: process.env, stdio: 'ignore' },
  );
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  assert.equal(exitCode, 0);
  assert.equal(
    (await db.prisma.assignmentSearch.findUniqueOrThrow({ where: { id: search.id } })).status,
    'OFFERED',
  );
  const offer = await db.prisma.driverOffer.findFirstOrThrow({ where: { search_id: search.id } });
  assert.equal(offer.driver_id, 'driver');
  const events = await db.prisma.outbox.findMany({ where: { type: 'DRIVER_OFFER' } });
  assert.equal(events.length, 1);
  assert.equal(events[0].user_id, 'driver');
  const payload = JSON.stringify(events[0].payload);
  assert.ok(payload.includes('Bếp Nhà Sài Gòn'));
  assert.doesNotMatch(payload, /Private customer address|Private customer note/);
  assert.equal(await assignment.runAssignmentWorker(true, 1), 0);
  assert.equal(await db.prisma.driverOffer.count({ where: { search_id: search.id } }), 1);
});

test(
  'ranking holds no order lock and a stale lease cannot publish an offer',
  { timeout: 10000 },
  async () => {
    await createOrder('stale');
    await lifecycle.transition(actor, 'order-stale', { status: 'ACCEPTED' });
    const search = await db.prisma.assignmentSearch.findUniqueOrThrow({
      where: { delivery_id_generation: { delivery_id: 'delivery-stale', generation: 1 } },
    });
    const strategy = assignment.nearestStrategy;
    const original = strategy.rank;
    let started!: () => void;
    let resume!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pause = new Promise<void>((resolve) => {
      resume = resolve;
    });
    strategy.rank = async (context, list) => {
      started();
      await pause;
      return original(context, list);
    };
    try {
      const work = assignment.runAssignmentWorker(true, 1);
      await ready;
      await db.prisma.order.update({
        where: { id: 'order-stale' },
        data: { note: 'changed while ranking' },
      });
      await db.prisma
        .$executeRaw`UPDATE assignment_searches SET lease_until = clock_timestamp() - interval '1 second', version = version + 1 WHERE id = ${search.id}`;
      resume();
      await work;
      assert.equal(await db.prisma.driverOffer.count({ where: { search_id: search.id } }), 0);
    } finally {
      resume();
      strategy.rank = original;
    }
    assert.equal(await assignment.runAssignmentWorker(true, 1), 1);
    assert.equal(
      await db.prisma.driverOffer.count({ where: { search_id: search.id, driver_id: 'driver2' } }),
      1,
    );
  },
);

test(
  'candidate changing readiness during ranking cannot receive an offer',
  { timeout: 10000 },
  async () => {
    await db.prisma.user.create({
      data: {
        id: 'driver-race',
        email: 'driver-race@test',
        name: 'Race driver',
        password_hash: 'test',
        role: 'DRIVER',
        active: true,
      },
    });
    const now = (await db.prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`)[0].now;
    await db.prisma.driverLocation.create({
      data: {
        driver_id: 'driver-race',
        latitude: 21,
        longitude: 105,
        captured_at: now,
        received_at: now,
      },
    });
    await db.prisma.driverAvailability.create({
      data: { driver_id: 'driver-race', online: true, ready: true, heartbeat_at: now },
    });
    await createOrder('eligibility-race');
    await lifecycle.transition(actor, 'order-eligibility-race', { status: 'ACCEPTED' });
    const search = await db.prisma.assignmentSearch.findUniqueOrThrow({
      where: {
        delivery_id_generation: { delivery_id: 'delivery-eligibility-race', generation: 1 },
      },
    });
    const strategy = assignment.nearestStrategy;
    const original = strategy.rank;
    let started!: () => void;
    let resume!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pause = new Promise<void>((resolve) => {
      resume = resolve;
    });
    strategy.rank = async (context, list) => {
      started();
      await pause;
      return original(context, list);
    };
    try {
      const work = assignment.runAssignmentWorker(true, 1);
      await ready;
      await (
        await import('../server/modules/assignment/application/availability.service.js')
      ).updateAvailability('driver-race', { ready: false });
      resume();
      await work;
      assert.equal(await db.prisma.driverOffer.count({ where: { search_id: search.id } }), 0);
      const attempt = await db.prisma.assignmentAttempt.findFirstOrThrow({
        where: { search_id: search.id, driver_id: 'driver-race' },
      });
      assert.equal(attempt.outcome, 'INELIGIBLE');
      assert.equal(attempt.reason, 'REVALIDATION_FAILED');
    } finally {
      resume();
      strategy.rank = original;
    }
  },
);
