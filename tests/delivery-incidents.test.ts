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

const schema = `test_incident_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 });
const target = testSchemaUrl(testDatabaseUrl(), schema);
const pool = new pg.Pool({ connectionString: target, connectionTimeoutMillis: 3000 });
process.env.DATABASE_URL = target;
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'IncidentFlows123!';
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
async function login(who: string, email = `${who}@bep.local`) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Bep' },
    body: JSON.stringify({ email, password: process.env.DEMO_PASSWORD }),
  });
  assert.equal(response.status, 200);
  cookies[who] = response.headers.get('set-cookie')!.split(';')[0];
}

async function trip(suffix: string, status = 'IN_TRANSIT') {
  const order = `incident-order-${suffix}`,
    delivery = `incident-delivery-${suffix}`,
    driver = `incident-driver-${suffix}`;
  const password = (await db.prisma.user.findUniqueOrThrow({ where: { id: 'driver' } }))
    .password_hash;
  await db.prisma.user.create({
    data: {
      id: driver,
      email: `${driver}@test.local`,
      name: driver,
      role: 'DRIVER',
      active: true,
      password_hash: password,
    },
  });
  await login(driver, `${driver}@test.local`);
  await db.prisma.order.create({
    data: {
      id: order,
      customer_id: 'customer',
      restaurant_id: 'saigon',
      status: status === 'ASSIGNED' ? 'READY_FOR_PICKUP' : 'OUT_FOR_DELIVERY',
      subtotal: 50000,
      delivery_fee: 15000,
      total: 65000,
      address: 'private',
      idempotency_key: order,
      fingerprint: 'test',
      expires_at: new Date('2099-01-01T00:00:00Z'),
    },
  });
  await db.prisma.payment.create({
    data: {
      id: randomUUID(),
      order_id: order,
      reference: `pay-${suffix}`,
      amount: 65000,
      status: 'SUCCEEDED',
    },
  });
  await db.prisma.delivery.create({
    data: { id: delivery, order_id: order, driver_id: driver, status },
  });
  await db.prisma.driverAssignment.create({
    data: { id: `${delivery}-a`, delivery_id: delivery, driver_id: driver, active: true },
  });
  return { order, delivery, driver };
}
const stockSnapshot = async () =>
  (
    await pool.query(
      'SELECT (SELECT count(*)::int FROM stock_movements) AS movements, (SELECT coalesce(sum(stock),0)::int FROM menu_items) AS stock',
    )
  ).rows[0];

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
  for (const who of ['customer', 'driver', 'driver2', 'admin', 'restaurant']) await login(who);
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

test('a failed delivery opens one incident and one alert even when the event repeats', async () => {
  const f = await trip('duplicate');
  const failed = await request(`/deliveries/${f.delivery}/transition`, f.driver, {
    status: 'FAILED',
    reason: 'Customer building closed',
  });
  assert.equal(failed.status, 200);
  const { publish } = await import('../server/shared/events.js');
  const { transaction } = db;
  await transaction((tx) =>
    publish(tx, 'DeliveryFailed', { orderId: f.order, actor: f.driver, reason: 'repeat' }),
  );
  const repo = await import('../server/modules/delivery/infrastructure/delivery.repository.js');
  assert.equal(
    await transaction((tx) => repo.insertFailureIncident(f.delivery, f.order, 'repeat', tx)),
    null,
  );
  const incidents = await pool.query(
    'SELECT id, status, actor_id, reason FROM delivery_incidents WHERE delivery_id=$1',
    [f.delivery],
  );
  assert.equal(incidents.rows.length, 1);
  assert.deepEqual(
    { ...incidents.rows[0], id: undefined },
    { id: undefined, status: 'OPEN', actor_id: f.driver, reason: 'Customer building closed' },
  );
  const alerts = await pool.query(
    "SELECT count(*)::int AS n FROM outbox WHERE user_id='admin' AND type='DELIVERY_FAILED' AND payload->>'orderId'=$1",
    [f.order],
  );
  assert.equal(alerts.rows[0].n, 1);
  const history = await pool.query(
    "SELECT actor, reason FROM state_history WHERE order_id=$1 AND entity='DELIVERY' AND to_state='FAILED'",
    [f.order],
  );
  assert.deepEqual(history.rows, [{ actor: f.driver, reason: 'Customer building closed' }]);
  const opened = await pool.query(
    'SELECT action, actor_id FROM delivery_incident_history WHERE incident_id=$1',
    [incidents.rows[0].id],
  );
  assert.deepEqual(opened.rows, [{ action: 'OPENED', actor_id: f.driver }]);
  assert.equal(
    (await pool.query('SELECT status FROM orders WHERE id=$1', [f.order])).rows[0].status,
    'DELIVERY_FAILED',
  );
});

test('a driver locked after pickup keeps the trip until Admin fails it, then capacity is released', async () => {
  const f = await trip('locked');
  await db.prisma.driverAvailability.create({
    data: { driver_id: f.driver, online: true, ready: true, heartbeat_at: new Date() },
  });
  const before = await stockSnapshot();
  assert.equal(
    (
      await request(
        `/admin/users/${f.driver}`,
        'admin',
        { active: false, reason: 'Safety report' },
        'PATCH',
      )
    ).status,
    200,
  );
  const { runOperationalInvalidation } = await import('../server/modules/assignment/index.js');
  await runOperationalInvalidation(50, true);
  const operational = await pool.query(
    "SELECT id FROM delivery_incidents WHERE delivery_id=$1 AND type='DRIVER_UNAVAILABLE' AND status='OPEN'",
    [f.delivery],
  );
  assert.equal(operational.rows.length, 1);
  assert.equal(
    (await pool.query('SELECT active FROM driver_assignments WHERE delivery_id=$1', [f.delivery]))
      .rows[0].active,
    true,
  );
  const reassign = await request(`/admin/deliveries/${f.delivery}/reassign`, 'admin', {
    driverId: 'driver2',
    reason: 'Driver locked',
    exceptionCode: 'DRIVER_UNAVAILABLE',
    idempotencyKey: 'locked-reassign-key',
  });
  assert.equal(reassign.status, 409);
  assert.equal(
    (
      await request(`/deliveries/${f.delivery}/transition`, f.driver, {
        status: 'DELIVERED',
      })
    ).status,
    401,
  );
  for (const who of ['customer', 'driver', 'restaurant'])
    assert.equal(
      (
        await request(`/admin/deliveries/${f.delivery}/fail`, who, {
          reason: 'x',
          idempotencyKey: 'role-check-key',
        })
      ).status,
      403,
    );
  const body = { reason: 'Driver account locked after pickup', idempotencyKey: 'admin-fail-key' };
  const [first, replay] = await Promise.all([
    request(`/admin/deliveries/${f.delivery}/fail`, 'admin', body),
    request(`/admin/deliveries/${f.delivery}/fail`, 'admin', body),
  ]);
  assert.equal(first.status, 200);
  assert.deepEqual(first.data, replay.data);
  assert.equal(
    (
      await request(`/admin/deliveries/${f.delivery}/fail`, 'admin', {
        reason: 'Different reason',
        idempotencyKey: 'admin-fail-key',
      })
    ).data.code,
    'IDEMPOTENCY_CONFLICT',
  );
  const after = (
    await pool.query(
      'SELECT d.status, d.failed_at IS NOT NULL AS failed_at, a.active, a.end_reason, o.status AS order_status FROM deliveries d JOIN driver_assignments a ON a.delivery_id=d.id JOIN orders o ON o.id=d.order_id WHERE d.id=$1',
      [f.delivery],
    )
  ).rows[0];
  assert.deepEqual(after, {
    status: 'FAILED',
    failed_at: true,
    active: false,
    end_reason: 'FAILED',
    order_status: 'DELIVERY_FAILED',
  });
  const incidents = await pool.query(
    'SELECT type, status, resolution, actor_id FROM delivery_incidents WHERE delivery_id=$1 ORDER BY type',
    [f.delivery],
  );
  assert.deepEqual(incidents.rows, [
    { type: 'DELIVERY_FAILED', status: 'OPEN', resolution: null, actor_id: 'admin' },
    { type: 'DRIVER_UNAVAILABLE', status: 'RESOLVED', resolution: 'NO_ACTION', actor_id: 'system' },
  ]);
  const history = await pool.query(
    "SELECT actor, reason FROM state_history WHERE order_id=$1 AND entity='DELIVERY' AND to_state='FAILED'",
    [f.order],
  );
  assert.deepEqual(history.rows, [
    { actor: 'admin', reason: 'Driver account locked after pickup' },
  ]);
  assert.deepEqual(await stockSnapshot(), before);
  assert.equal(
    (await pool.query('SELECT status FROM payments WHERE order_id=$1', [f.order])).rows[0].status,
    'SUCCEEDED',
  );
});

test('Admin fail needs an operational incident and a delivery in progress', async () => {
  const noIncident = await trip('no-incident');
  assert.equal(
    (
      await request(`/admin/deliveries/${noIncident.delivery}/fail`, 'admin', {
        reason: 'No incident yet',
        idempotencyKey: 'no-incident-key',
      })
    ).data.code,
    'INCIDENT_REQUIRED',
  );
  const assigned = await trip('assigned', 'ASSIGNED');
  await pool.query(
    "INSERT INTO delivery_incidents (id,delivery_id,order_id,type,reason) VALUES ($1,$2,$3,'DRIVER_UNAVAILABLE','offline')",
    [randomUUID(), assigned.delivery, assigned.order],
  );
  assert.equal(
    (
      await request(`/admin/deliveries/${assigned.delivery}/fail`, 'admin', {
        reason: 'Before pickup',
        idempotencyKey: 'assigned-fail-key',
      })
    ).data.code,
    'INVALID_TRANSITION',
  );
});

test('resolving an incident never refunds, restocks or resolves complaints', async () => {
  const f = await trip('resolve');
  await request(`/deliveries/${f.delivery}/transition`, f.driver, {
    status: 'FAILED',
    reason: 'Bike accident, food damaged',
  });
  const complaint = (
    await request(`/orders/${f.order}/complaints`, 'customer', {
      content: 'My order never arrived and I was charged.',
    })
  ).data.id;
  const before = await stockSnapshot();
  const list = await request('/admin/incidents?status=OPEN&limit=100', 'admin', undefined, 'GET');
  const incident = list.data.items.find((item: any) => item.deliveryId === f.delivery);
  assert.equal(incident.type, 'DELIVERY_FAILED');
  assert.equal(incident.deliveryStatus, 'FAILED');
  assert.equal((await request('/admin/incidents', 'customer', undefined, 'GET')).status, 403);
  const body = {
    resolution: 'REFUND_REQUESTED',
    reason: 'Food damaged after pickup; customer should be refunded.',
    evidence: [complaint],
    idempotencyKey: 'resolve-incident-key',
  };
  const resolved = await request(`/admin/incidents/${incident.id}/resolve`, 'admin', body);
  assert.deepEqual(resolved.data, {
    incidentId: incident.id,
    status: 'RESOLVED',
    resolution: 'REFUND_REQUESTED',
  });
  assert.deepEqual(
    (await request(`/admin/incidents/${incident.id}/resolve`, 'admin', body)).data,
    resolved.data,
  );
  assert.equal(
    (
      await request(`/admin/incidents/${incident.id}/resolve`, 'admin', {
        ...body,
        idempotencyKey: 'resolve-again-key',
      })
    ).data.code,
    'INCIDENT_NOT_OPEN',
  );
  const row = (
    await pool.query(
      'SELECT resolution, resolution_reason, resolved_by, evidence FROM delivery_incidents WHERE id=$1',
      [incident.id],
    )
  ).rows[0];
  assert.equal(row.resolved_by, 'admin');
  assert.deepEqual(row.evidence, [complaint]);
  assert.equal(
    (await pool.query('SELECT status FROM payments WHERE order_id=$1', [f.order])).rows[0].status,
    'SUCCEEDED',
  );
  assert.equal(
    (await pool.query('SELECT status FROM complaints WHERE id=$1', [complaint])).rows[0].status,
    'OPEN',
  );
  assert.deepEqual(await stockSnapshot(), before);
  const page1 = await request('/admin/incidents?limit=1', 'admin', undefined, 'GET');
  assert.equal(page1.data.items.length, 1);
  assert.ok(page1.data.nextCursor);
  const page2 = await request(
    `/admin/incidents?limit=1&cursor=${page1.data.nextCursor}`,
    'admin',
    undefined,
    'GET',
  );
  assert.notEqual(page2.data.items[0].id, page1.data.items[0].id);
  assert.equal(
    (await request('/admin/incidents?cursor=not-valid', 'admin', undefined, 'GET')).status,
    400,
  );
});
