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
import { parseTimeRange } from '../server/shared/time-range.js';
import { duration, rate, successRate } from '../server/modules/backoffice/domain/metrics.js';

const schema = `test_reports_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 });
const target = testSchemaUrl(testDatabaseUrl(), schema);
const pool = new pg.Pool({ connectionString: target, connectionTimeoutMillis: 3000 });
process.env.DATABASE_URL = target;
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'ReportMetrics123!';
process.env.LOG_REQUESTS = 'false';
process.env.ASSIGNMENT_AUTOMATION_ENABLED = 'false';
let created = false,
  server: Server,
  base = '';
let db: typeof import('../server/shared/db.js');
const cookies: Record<string, string> = {};
// One Asia/Saigon day: 2026-03-01 00:00 +07:00 to 2026-03-02 00:00 +07:00.
const FROM = '2026-03-01T00:00:00+07:00',
  TO = '2026-03-02T00:00:00+07:00';
const at = (iso: string) => new Date(iso);

async function get(path: string, who: string) {
  const response = await fetch(`${base}/api${path}`, {
    headers: { cookie: cookies[who] ?? '' },
  });
  return { status: response.status, data: await response.json() };
}
async function login(who: string) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Bep' },
    body: JSON.stringify({ email: `${who}@bep.local`, password: process.env.DEMO_PASSWORD }),
  });
  assert.equal(response.status, 200);
  cookies[who] = response.headers.get('set-cookie')!.split(';')[0];
}

async function trip(options: {
  restaurant?: string;
  status?: string;
  deliveryStatus?: string;
  total: number;
  subtotal: number;
  acceptedAt?: string;
  readyAt?: string;
  assignedAt?: string;
  pickedUpAt?: string;
  deliveredAt?: string | null;
  failedAt?: string;
  createdAt?: string;
}) {
  const order = randomUUID(),
    delivery = randomUUID();
  await db.prisma.order.create({
    data: {
      id: order,
      customer_id: 'customer',
      restaurant_id: options.restaurant ?? 'saigon',
      status: options.status ?? 'DELIVERED',
      subtotal: options.subtotal,
      delivery_fee: options.total - options.subtotal,
      total: options.total,
      address: 'private',
      idempotency_key: order,
      fingerprint: 'test',
      expires_at: at('2099-01-01T00:00:00Z'),
      ...(options.createdAt ? { created_at: at(options.createdAt) } : {}),
    },
  });
  await db.prisma.delivery.create({
    data: {
      id: delivery,
      order_id: order,
      driver_id: 'driver',
      status: options.deliveryStatus ?? 'DELIVERED',
      picked_up_at: options.pickedUpAt ? at(options.pickedUpAt) : null,
      delivered_at: options.deliveredAt ? at(options.deliveredAt) : null,
      failed_at: options.failedAt ? at(options.failedAt) : null,
    },
  });
  for (const [state, time] of [
    ['ACCEPTED', options.acceptedAt],
    ['READY_FOR_PICKUP', options.readyAt],
  ] as const)
    if (time)
      await db.prisma.stateHistory.create({
        data: {
          id: randomUUID(),
          order_id: order,
          entity: 'ORDER',
          to_state: state,
          actor: 'restaurant',
          created_at: at(time),
        },
      });
  if (options.assignedAt)
    await db.prisma.driverAssignment.create({
      data: {
        id: randomUUID(),
        delivery_id: delivery,
        driver_id: 'driver',
        active: false,
        end_reason: 'DELIVERED',
        assigned_at: at(options.assignedAt),
      },
    });
  return { order, delivery };
}

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
  for (const who of ['customer', 'restaurant', 'restaurant2', 'driver', 'admin']) await login(who);
  // In range, complete milestones: prep 20 min, wait 5 min, trip 30 min.
  await trip({
    total: 100000,
    subtotal: 85000,
    acceptedAt: '2026-03-01T09:00:00Z',
    assignedAt: '2026-03-01T09:05:00Z',
    readyAt: '2026-03-01T09:20:00Z',
    pickedUpAt: '2026-03-01T09:30:00Z',
    deliveredAt: '2026-03-01T10:00:00Z',
    createdAt: '2026-03-01T08:59:00Z',
  });
  // In range but missing legacy milestones.
  await trip({ total: 70000, subtotal: 60000, deliveredAt: '2026-03-01T12:00:00Z' });
  // One second before local midnight and exactly at `to`: both outside.
  const early = await trip({
    total: 50000,
    subtotal: 40000,
    deliveredAt: '2026-02-28T16:59:59Z',
  });
  await trip({ total: 30000, subtotal: 25000, deliveredAt: '2026-03-01T17:00:00Z' });
  // Exactly at `from`: inside.
  await trip({ total: 20000, subtotal: 15000, deliveredAt: '2026-02-28T17:00:00Z' });
  await trip({
    status: 'DELIVERY_FAILED',
    deliveryStatus: 'FAILED',
    total: 40000,
    subtotal: 30000,
    failedAt: '2026-03-01T11:00:00Z',
  });
  await trip({ total: 99000, subtotal: 90000, deliveredAt: null });
  await trip({
    restaurant: 'pizza',
    total: 999000,
    subtotal: 990000,
    deliveredAt: '2026-03-01T10:00:00Z',
  });
  // Refund confirmed in range for an order delivered before the range.
  const paymentId = randomUUID();
  await db.prisma.payment.create({
    data: {
      id: paymentId,
      order_id: early.order,
      reference: `report-${paymentId}`,
      amount: 50000,
      status: 'REFUNDED',
    },
  });
  await pool.query(
    "INSERT INTO refund_requests (id,order_id,payment_id,source,requested_by,requester_role,reason,amount,status,confirmed_at,complaint_id) VALUES ($1,$2,$3,'COMPLAINT','admin','ADMIN','Spoiled',50000,'SUCCEEDED','2026-03-01T15:00:00Z','c')",
    [randomUUID(), early.order, paymentId],
  );
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

test('pure helpers never produce NaN, Infinity or fake zeros', () => {
  assert.equal(rate(1, 0), null);
  assert.equal(successRate(0, 0), null);
  assert.equal(successRate(2, 1), 0.6667);
  assert.deepEqual(duration(null, 0, 0), {
    averageMinutes: null,
    coverage: { withData: 0, total: 0 },
  });
  assert.deepEqual(duration(1200, 1, 2), {
    averageMinutes: 20,
    coverage: { withData: 1, total: 2 },
  });
  const range = parseTimeRange({ from: FROM, to: TO });
  assert.equal(range.from.toISOString(), '2026-02-28T17:00:00.000Z');
  assert.equal(range.to.toISOString(), '2026-03-01T17:00:00.000Z');
  for (const bad of [
    { from: '2026-03-01T00:00:00' },
    { from: TO, to: FROM },
    { from: FROM, to: FROM },
    { from: 'yesterday' },
    { from: '2020-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' },
  ])
    assert.throws(() => parseTimeRange(bad), /INVALID|time|earlier|long|valid/i);
});

test('restaurant metrics follow their cohort definitions across a local-day boundary', async () => {
  const response = await get(
    `/restaurants/saigon/reports?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`,
    'restaurant',
  );
  assert.equal(response.status, 200);
  const r = response.data;
  assert.equal(r.timezone, 'Asia/Saigon');
  assert.equal(r.from, '2026-02-28T17:00:00.000Z');
  assert.deepEqual(r.delivered, {
    basis: 'Delivery delivered_at in [from,to)',
    count: 3,
    grossDeliveredValue: 190000,
    merchandiseValue: 160000,
    revenue: 190000,
  });
  assert.equal(r.failed.count, 1);
  assert.equal(r.successRate, 0.75);
  // Refund belongs to its confirmation cohort and is not netted against delivered value.
  assert.deepEqual(r.refunded, {
    basis: 'Refund confirmed_at in [from,to); separate cohort from delivered value',
    count: 1,
    amount: 50000,
  });
  assert.equal('net' in r.delivered, false);
  assert.deepEqual(r.durations.prep, { averageMinutes: 20, coverage: { withData: 1, total: 3 } });
  assert.deepEqual(r.durations.assignmentWait, {
    averageMinutes: 5,
    coverage: { withData: 1, total: 3 },
  });
  assert.deepEqual(r.durations.delivery, {
    averageMinutes: 30,
    coverage: { withData: 1, total: 3 },
  });
  assert.equal(r.coverage.deliveredWithoutTimestamp, 1);
  assert.equal(r.placedOrders.byStatus.DELIVERED, 1);
  assert.ok(Array.isArray(r.inventory.lowStock));
  assert.ok(r.definitions.grossDeliveredValue.includes('Not the amount a restaurant receives'));
});

test('empty ranges return nulls and coverage, and legacy revenue keeps its meaning', async () => {
  const empty = await get(
    '/restaurants/saigon/reports?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z',
    'restaurant',
  );
  assert.equal(empty.status, 200);
  assert.equal(empty.data.successRate, null);
  assert.equal(empty.data.durations.delivery.averageMinutes, null);
  assert.deepEqual(empty.data.durations.delivery.coverage, { withData: 0, total: 0 });
  assert.equal(empty.data.delivered.grossDeliveredValue, 0);
  assert.ok(!/NaN|Infinity/.test(JSON.stringify(empty.data)));
  const legacy = await get('/reports', 'restaurant');
  const expected = await pool.query(
    "SELECT sum(o.total)::int AS revenue FROM orders o JOIN restaurant_members m ON m.restaurant_id=o.restaurant_id WHERE m.user_id='restaurant' AND o.status='DELIVERED'",
  );
  assert.equal(legacy.data.revenue, expected.rows[0].revenue);
  assert.match(legacy.data.revenueBasis, /including delivery fees/);
});

test('restaurant scope is enforced and Admin keeps global access', async () => {
  const path = (id: string) =>
    `/restaurants/${id}/reports?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;
  assert.equal((await get(path('pizza'), 'restaurant')).status, 403);
  assert.equal((await get(path('saigon'), 'restaurant2')).status, 403);
  for (const who of ['customer', 'driver'])
    assert.equal((await get(path('saigon'), who)).status, 403);
  const pizza = await get(path('pizza'), 'admin');
  assert.equal(pizza.status, 200);
  assert.equal(pizza.data.delivered.grossDeliveredValue, 999000);
  assert.equal((await get(path('saigon'), 'admin')).data.delivered.count, 3);
  assert.equal(
    (await get('/restaurants/saigon/reports?from=2026-03-01', 'restaurant')).data.code,
    'INVALID_TIME_RANGE',
  );
});
