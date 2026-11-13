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

const schema = `test_recovery_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 });
const target = testSchemaUrl(testDatabaseUrl(), schema);
const pool = new pg.Pool({ connectionString: target, connectionTimeoutMillis: 3000 });
process.env.DATABASE_URL = target;
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'Recovery123!';
process.env.PAYMENT_MODE = 'simulated';
process.env.ASSIGNMENT_AUTOMATION_ENABLED = 'true';
let created = false;
let db: typeof import('../server/shared/db.js');

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  created = true;
  db = await import('../server/shared/db.js');
  await verifyTestSchema(schema, db.prisma);
  await (await import('../server/migrate.js')).migrate();
  await (await import('../server/seed/seed.js')).seed();
  (await import('../server/modules/index.js')).registerModules();
  await db.prisma.restaurant.update({
    where: { id: 'saigon' },
    data: { latitude: 21, longitude: 105 },
  });
  const now = (await db.prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`)[0].now;
  await db.prisma.driverLocation.create({
    data: { driver_id: 'driver', latitude: 21, longitude: 105, captured_at: now, received_at: now },
  });
  await db.prisma.driverAvailability.create({
    data: { driver_id: 'driver', online: true, ready: true, heartbeat_at: now },
  });
});
after(async () => {
  if (db) await db.prisma.$disconnect();
  await pool.end();
  await dropTestSchema(admin, schema, created);
  await admin.end();
});

async function acceptedOrder(suffix: string) {
  const order = `recovery-order-${suffix}`,
    delivery = `recovery-delivery-${suffix}`;
  await db.prisma.order.create({
    data: {
      id: order,
      customer_id: 'customer',
      restaurant_id: 'saigon',
      status: 'ACCEPTED',
      subtotal: 1000,
      delivery_fee: 5000,
      total: 6000,
      address: 'x',
      idempotency_key: order,
      fingerprint: 'recovery',
      expires_at: new Date('2099-01-01T00:00:00Z'),
    },
  });
  await db.prisma.delivery.create({ data: { id: delivery, order_id: order } });
  return { order, delivery };
}

test('a search claimed by a crashed worker is resumed by another after the lease expires', async () => {
  const f = await acceptedOrder('lease');
  const repository =
    await import('../server/modules/assignment/infrastructure/assignment.repository.js');
  const search = await db.transaction((tx) => repository.createInitialSearch(f.delivery, 600, tx));
  const claim = await repository.claimDue('crashed-worker', 30);
  assert.equal(claim?.id, search.id);
  const { runAssignmentWorker } = await import('../server/modules/assignment/index.js');
  // The dead worker still holds the lease: nothing happens and nothing duplicates.
  assert.equal(await runAssignmentWorker(true, 5), 0);
  assert.equal(await db.prisma.driverOffer.count({ where: { search_id: search.id } }), 0);
  await pool.query(
    "UPDATE assignment_searches SET lease_until = clock_timestamp() - interval '1 second' WHERE id=$1",
    [search.id],
  );
  assert.equal(await runAssignmentWorker(true, 5), 1);
  const offers = await db.prisma.driverOffer.findMany({ where: { search_id: search.id } });
  assert.equal(offers.length, 1);
  assert.equal(offers[0].driver_id, 'driver');
  // A second recovery pass does not create another offer.
  assert.equal(await runAssignmentWorker(true, 5), 0);
  assert.equal(await db.prisma.driverOffer.count({ where: { search_id: search.id } }), 1);
});

test('a background cycle with one failing stage still runs the remaining stages and records the error', async () => {
  const { runIsolatedStages } = await import('../server/jobs.js');
  const { stageStatuses } = await import('../server/shared/job-status.js');
  const order: string[] = [];
  const failed = await runIsolatedStages([
    { name: 'recovery-a', run: async () => void order.push('a') },
    {
      name: 'recovery-b',
      run: async () => {
        throw new Error('stage crashed');
      },
    },
    { name: 'recovery-c', run: async () => void order.push('c') },
  ]);
  assert.deepEqual(order, ['a', 'c']);
  assert.deepEqual(failed, ['recovery-b']);
  const status = stageStatuses().find((stage) => stage.name === 'recovery-b');
  assert.equal(status?.lastError, 'stage crashed');
  const healthy = stageStatuses().find((stage) => stage.name === 'recovery-c');
  assert.ok(healthy?.lastSuccessAt);
});
