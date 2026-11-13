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

const schema = `test_monitoring_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 });
process.env.DATABASE_URL = testSchemaUrl(testDatabaseUrl(), schema);
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'MonitoringTest123!';
process.env.ASSIGNMENT_AUTOMATION_ENABLED = 'false';
process.env.LOG_REQUESTS = 'false';
let created = false,
  server: Server,
  base = '';
let db: typeof import('../server/shared/db.js');
const cookies: Record<string, string> = {};
async function get(path: string, who = 'admin') {
  const res = await fetch(`${base}/api${path}`, { headers: { cookie: cookies[who] ?? '' } });
  return { status: res.status, data: await res.json() };
}
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  created = true;
  db = await import('../server/shared/db.js');
  await verifyTestSchema(schema, db.prisma);
  await (await import('../server/migrate.js')).migrate();
  await (await import('../server/seed/seed.js')).seed();
  for (const suffix of ['a', 'b', 'c', 'd']) {
    await db.prisma.order.create({
      data: {
        id: `monitor-order-${suffix}`,
        customer_id: 'customer',
        restaurant_id: 'saigon',
        status: suffix === 'd' ? 'CONFIRMED' : 'ACCEPTED',
        subtotal: 100,
        delivery_fee: 0,
        total: 100,
        address: 'private-address-secret',
        note: 'private-note-secret',
        idempotency_key: `monitor-${suffix}`,
        fingerprint: 'private-fingerprint',
        expires_at: new Date('2099-01-01T00:00:00Z'),
      },
    });
    await db.prisma.delivery.create({
      data: {
        id: `monitor-delivery-${suffix}`,
        order_id: `monitor-order-${suffix}`,
        status: 'ASSIGNED',
        driver_id: 'driver',
      },
    });
    await db.prisma.assignmentSearch.create({
      data: {
        id: `monitor-search-${suffix}`,
        delivery_id: `monitor-delivery-${suffix}`,
        status: 'EXHAUSTED',
        deadline_at: new Date('2099-01-01T00:00:00Z'),
      },
    });
    await db.prisma.assignmentAttempt.create({
      data: {
        id: `monitor-attempt-${suffix}`,
        search_id: `monitor-search-${suffix}`,
        driver_id: 'driver2',
        round: 1,
        outcome: 'REJECTED',
        reason: 'BUSY',
      },
    });
    // Include distinct microseconds within the same JS millisecond, plus a timestamp tie.
    const fraction = suffix === 'd' ? '123457' : '123456';
    await db.prisma
      .$executeRaw`UPDATE orders SET created_at = ${`2026-01-01T00:00:00.${fraction}Z`}::timestamptz WHERE id = ${`monitor-order-${suffix}`}`;
    await db.prisma
      .$executeRaw`UPDATE assignment_searches SET created_at = ${`2026-01-01T00:00:00.${fraction}Z`}::timestamptz WHERE id = ${`monitor-search-${suffix}`}`;
  }
  server = (await import('../server/app.js')).createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  for (const name of ['admin', 'customer', 'restaurant', 'driver']) {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Bep' },
      body: JSON.stringify({ email: `${name}@bep.local`, password: process.env.DEMO_PASSWORD }),
    });
    assert.equal(response.status, 200);
    cookies[name] = response.headers.get('set-cookie')!.split(';')[0];
  }
});
after(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  if (db) await db.prisma.$disconnect();
  await dropTestSchema(admin, schema, created);
  await admin.end();
});

test('monitoring pages preserve timestamp microseconds and ties with combined filters', async () => {
  for (const kind of ['orders', 'deliveries', 'assignments']) {
    const status =
      kind === 'orders' ? 'ACCEPTED' : kind === 'deliveries' ? 'ASSIGNED' : 'EXHAUSTED';
    const driver = kind === 'assignments' ? 'driver2' : 'driver';
    const params = new URLSearchParams({
      limit: '1',
      status,
      driverId: driver,
      restaurantId: 'saigon',
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-02T00:00:00Z',
    });
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      if (cursor) params.set('cursor', cursor);
      const page = await get(`/admin/${kind}?${params}`);
      assert.equal(page.status, 200);
      ids.push(...page.data.items.map((row: any) => row.searchId ?? row.id));
      assert.doesNotMatch(
        JSON.stringify(page.data),
        /private-address|private-note|fingerprint|password|otp|payment|photo/i,
      );
      cursor = page.data.nextCursor;
    } while (cursor);
    const suffixes = kind === 'orders' ? ['c', 'b', 'a'] : ['d', 'c', 'b', 'a'];
    const prefix = kind === 'orders' ? 'order' : kind === 'deliveries' ? 'delivery' : 'search';
    assert.deepEqual(
      ids,
      suffixes.map((suffix) => `monitor-${prefix}-${suffix}`),
    );
  }
});

test('monitoring validates filters and keeps role isolation and legacy orders', async () => {
  for (const kind of ['orders', 'deliveries', 'assignments']) {
    for (const who of ['customer', 'restaurant', 'driver'])
      assert.equal((await get(`/admin/${kind}`, who)).status, 403);
    for (const query of [
      'limit=101',
      'limit=0',
      'status=unknown',
      'from=2026-02-30T00:00:00Z',
      'from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z',
      'cursor=invalid',
      'unknown=x',
    ])
      assert.equal((await get(`/admin/${kind}?${query}`)).status, 400, `${kind}: ${query}`);
  }
  for (const who of ['customer', 'restaurant', 'driver', 'admin']) {
    const response = await get('/orders', who);
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.data));
  }
  assert.equal((await get('/admin/orders', '')).status, 401);
});
