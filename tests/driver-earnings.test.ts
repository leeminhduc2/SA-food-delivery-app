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

const schema = `test_earnings_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 });
const target = testSchemaUrl(testDatabaseUrl(), schema);
const pool = new pg.Pool({ connectionString: target, connectionTimeoutMillis: 3000 });
process.env.DATABASE_URL = target;
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'DriverEarnings123!';
process.env.LOG_REQUESTS = 'false';
process.env.ASSIGNMENT_AUTOMATION_ENABLED = 'false';
let created = false,
  server: Server,
  base = '';
let db: typeof import('../server/shared/db.js');
const cookies: Record<string, string> = {};

async function request(path: string, who: string, body?: unknown, method = 'POST') {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'Bep',
      cookie: cookies[who] ?? '',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
}
const get = (path: string, who: string) => request(path, who, undefined, 'GET');
async function login(who: string) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Bep' },
    body: JSON.stringify({ email: `${who}@bep.local`, password: process.env.DEMO_PASSWORD }),
  });
  assert.equal(response.status, 200);
  cookies[who] = response.headers.get('set-cookie')!.split(';')[0];
}

/** In-transit trip for `driver`; driver2 held it first and was reassigned away. */
async function trip(suffix: string, fee = 18000) {
  const order = `earning-order-${suffix}`,
    delivery = `earning-delivery-${suffix}`;
  await db.prisma.order.create({
    data: {
      id: order,
      customer_id: 'customer',
      restaurant_id: 'saigon',
      status: 'OUT_FOR_DELIVERY',
      subtotal: 100000,
      delivery_fee: fee,
      total: 100000 + fee,
      address: 'Private customer address 42',
      idempotency_key: order,
      fingerprint: 'test',
      expires_at: new Date('2099-01-01T00:00:00Z'),
    },
  });
  await db.prisma.delivery.create({
    data: {
      id: delivery,
      order_id: order,
      driver_id: 'driver',
      status: 'IN_TRANSIT',
      picked_up_at: new Date(Date.now() - 20 * 60000),
    },
  });
  await db.prisma.driverAssignment.createMany({
    data: [
      {
        id: `${delivery}-old`,
        delivery_id: delivery,
        driver_id: 'driver2',
        active: false,
        end_reason: 'REASSIGNED',
      },
      { id: `${delivery}-final`, delivery_id: delivery, driver_id: 'driver', active: true },
    ],
  });
  return { order, delivery };
}
const estimates = async (delivery: string) =>
  (
    await pool.query(
      'SELECT driver_id, amount, source, basis FROM driver_earning_estimates WHERE delivery_id=$1',
      [delivery],
    )
  ).rows;
const finish = (delivery: string, status = 'DELIVERED') =>
  request(`/deliveries/${delivery}/transition`, 'driver', {
    status,
    ...(status === 'FAILED' ? { reason: 'Customer unreachable' } : {}),
  });

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  created = true;
  db = await import('../server/shared/db.js');
  await verifyTestSchema(schema, db.prisma);
  await (await import('../server/migrate.js')).migrate();
  await (await import('../server/seed/seed.js')).seed();
  server = (await import('../server/app.js')).createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  for (const who of ['customer', 'driver', 'driver2', 'admin']) await login(who);
});
after(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  if (db) await db.prisma.$disconnect();
  await pool.end();
  await dropTestSchema(admin, schema, created);
  await admin.end();
});

test('a delivered trip gets exactly one estimate; failed trips and repeated events get none', async () => {
  const f = await trip('once', 18000);
  assert.equal((await finish(f.delivery)).status, 200);
  assert.deepEqual(await estimates(f.delivery), [
    {
      driver_id: 'driver',
      amount: 18000,
      source: 'DELIVERY_COMPLETED',
      basis: 'SIMULATED_ESTIMATE',
    },
  ]);
  const { publish } = await import('../server/shared/events.js');
  await db.transaction((tx) =>
    publish(tx, 'DeliveryCompleted', { orderId: f.order, actor: 'driver' }),
  );
  await finish(f.delivery);
  assert.equal((await estimates(f.delivery)).length, 1);
  const failed = await trip('failed');
  assert.equal((await finish(failed.delivery, 'FAILED')).status, 200);
  assert.deepEqual(await estimates(failed.delivery), []);
  const cancelled = await trip('cancelled');
  await pool.query("UPDATE deliveries SET status='CANCELLED' WHERE id=$1", [cancelled.delivery]);
  await pool.query(
    "UPDATE driver_assignments SET active=false, end_reason='CANCELLED' WHERE delivery_id=$1",
    [cancelled.delivery],
  );
  await db.transaction((tx) =>
    publish(tx, 'DeliveryCompleted', { orderId: cancelled.order, actor: 'system' }),
  );
  assert.deepEqual(await estimates(cancelled.delivery), []);
});

test('fee changes and customer refunds never change an estimate; labels say it is not a payout', async () => {
  const f = await trip('snapshot', 22000);
  await finish(f.delivery);
  await pool.query('UPDATE orders SET delivery_fee=99999, total=subtotal+99999 WHERE id=$1', [
    f.order,
  ]);
  const paymentId = randomUUID();
  await pool.query(
    "INSERT INTO payments (id,order_id,reference,amount,status) VALUES ($1,$2,$3,122000,'REFUNDED')",
    [paymentId, f.order, `pay-${paymentId}`],
  );
  await pool.query(
    "INSERT INTO refund_requests (id,order_id,payment_id,source,complaint_id,requested_by,requester_role,reason,amount,status,confirmed_at) VALUES ($1,$2,$3,'COMPLAINT','c','admin','ADMIN','Late',122000,'SUCCEEDED',clock_timestamp())",
    [randomUUID(), f.order, paymentId],
  );
  assert.equal((await estimates(f.delivery))[0].amount, 22000);
  const report = (await get('/driver/reports', 'driver')).data;
  assert.equal(report.estimatedEarnings.basis, 'SIMULATED_ESTIMATE');
  assert.match(report.estimatedEarnings.label, /Not a payout/);
  assert.ok(report.estimatedEarnings.amount >= 22000);
  assert.equal(
    report.successRate,
    Math.round((report.delivered / (report.delivered + report.failed)) * 10000) / 10000,
  );
  assert.equal(report.durationCoverage.total, report.delivered);
  const list = (await get('/driver/earnings?limit=1', 'driver')).data;
  assert.equal(list.items.length, 1);
  assert.match(list.label, /Not a payout/);
  assert.ok(list.nextCursor);
  const next = (await get(`/driver/earnings?limit=1&cursor=${list.nextCursor}`, 'driver')).data;
  assert.notEqual(next.items[0]?.deliveryId, list.items[0].deliveryId);
  assert.equal((await get('/driver/earnings?cursor=broken', 'driver')).status, 400);
  for (const who of ['customer', 'admin'])
    assert.equal((await get('/driver/reports', who)).status, 403);
});

test('a reassigned-away driver sees no earnings or drop-off data for the final trip', async () => {
  const f = await trip('privacy', 15000);
  await finish(f.delivery);
  const earnings = (await get('/driver/earnings', 'driver2')).data;
  assert.equal(
    earnings.items.some((item: any) => item.deliveryId === f.delivery),
    false,
  );
  const report = (await get('/driver/reports', 'driver2')).data;
  assert.equal(report.delivered, 0);
  assert.equal(report.estimatedEarnings.amount, 0);
  const history = (await get('/driver/deliveries/history?limit=100', 'driver2')).data;
  const entry = history.items.find((item: any) => item.deliveryId === f.delivery);
  assert.equal(entry.finalDriver, false);
  assert.ok(!JSON.stringify(history).includes('Private customer address'));
  assert.equal((await get(`/orders/${f.order}`, 'driver2')).status, 403);
});

test('backfill creates estimates only for determinable legacy trips and is idempotent', async () => {
  const legacy = async (suffix: string, options: { deliveredAt: boolean; final: boolean }) => {
    const order = `legacy-earning-${suffix}`,
      delivery = `legacy-delivery-${suffix}`;
    await db.prisma.order.create({
      data: {
        id: order,
        customer_id: 'customer',
        restaurant_id: 'saigon',
        status: 'DELIVERED',
        subtotal: 50000,
        delivery_fee: 12000,
        total: 62000,
        address: 'x',
        idempotency_key: order,
        fingerprint: 'legacy',
        expires_at: new Date('2099-01-01T00:00:00Z'),
      },
    });
    await db.prisma.delivery.create({
      data: {
        id: delivery,
        order_id: order,
        driver_id: 'driver',
        status: 'DELIVERED',
        delivered_at: options.deliveredAt ? new Date('2026-01-05T03:00:00Z') : null,
      },
    });
    if (options.final)
      await db.prisma.driverAssignment.create({
        data: {
          id: `${delivery}-a`,
          delivery_id: delivery,
          driver_id: 'driver',
          active: false,
          end_reason: 'MIGRATION_TERMINAL',
        },
      });
    return delivery;
  };
  const good = await legacy('good', { deliveredAt: true, final: true });
  const noTime = await legacy('no-time', { deliveredAt: false, final: true });
  const noDriver = await legacy('no-driver', { deliveredAt: true, final: false });
  const { backfillEarningEstimates } = await import('../server/modules/delivery/index.js');
  const first = await backfillEarningEstimates({ batch: 2 });
  assert.equal(first.created, 1);
  assert.ok(first.missingDeliveredAt >= 1);
  assert.ok(first.missingFinalDriver >= 1);
  const second = await backfillEarningEstimates();
  assert.equal(second.created, 0);
  assert.equal(second.missingDeliveredAt, first.missingDeliveredAt);
  assert.deepEqual(await estimates(good), [
    { driver_id: 'driver', amount: 12000, source: 'BACKFILL', basis: 'SIMULATED_ESTIMATE' },
  ]);
  assert.deepEqual(await estimates(noTime), []);
  assert.deepEqual(await estimates(noDriver), []);
});
