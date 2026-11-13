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

const schema = `test_reject_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 });
process.env.DATABASE_URL = testSchemaUrl(testDatabaseUrl(), schema);
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'RejectionTest123!';
process.env.ASSIGNMENT_AUTOMATION_ENABLED = 'false';
process.env.LOG_REQUESTS = 'false';
let created = false,
  server: Server,
  base = '';
let db: typeof import('../server/shared/db.js');
const cookies: Record<string, string> = {};
async function request(path: string, actor: string, body: unknown) {
  const response = await fetch(`${base}/api${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'Bep',
      cookie: cookies[actor] ?? '',
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
async function fixture(suffix: string, status = 'CONFIRMED') {
  const order = `reject-order-${suffix}`;
  await db.prisma.menuItem.update({ where: { id: 'pho' }, data: { stock: { decrement: 1 } } });
  await db.prisma.order.create({
    data: {
      id: order,
      customer_id: 'customer',
      restaurant_id: 'saigon',
      status,
      subtotal: 65000,
      delivery_fee: 0,
      total: 65000,
      address: 'private',
      idempotency_key: order,
      fingerprint: 'test',
      expires_at: new Date('2099-01-01T00:00:00Z'),
    },
  });
  await db.prisma.orderItem.create({
    data: {
      id: `line-${suffix}`,
      order_id: order,
      menu_item_id: 'pho',
      name: 'Snapshot',
      price: 65000,
      quantity: 1,
      options: [],
    },
  });
  await db.prisma.payment.create({
    data: {
      id: `payment-${suffix}`,
      order_id: order,
      reference: `payment-ref-${suffix}`,
      amount: 65000,
      status: 'SUCCEEDED',
    },
  });
  await db.prisma.delivery.create({
    data: { id: `delivery-${suffix}`, order_id: order, status: 'UNASSIGNED' },
  });
  return order;
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
  for (const name of ['customer', 'restaurant', 'restaurant2', 'driver', 'admin']) {
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

test('paid confirmed order rejection compensates once and sends recipient-scoped notifications', async () => {
  const before = (await db.prisma.menuItem.findUniqueOrThrow({ where: { id: 'pho' } })).stock;
  const order = await fixture('paid');
  const body = { reason: 'Kitchen cannot prepare this dish', idempotencyKey: 'reject-paid-key' };
  assert.equal((await request(`/orders/${order}/reject`, 'restaurant2', body)).status, 403);
  for (const who of ['customer', 'driver', 'admin'])
    assert.equal((await request(`/orders/${order}/reject`, who, body)).status, 403);
  assert.equal(
    (await request(`/orders/${order}/reject`, 'restaurant', { ...body, reason: '' })).status,
    400,
  );
  const [first, replay] = await Promise.all([
    request(`/orders/${order}/reject`, 'restaurant', body),
    request(`/orders/${order}/reject`, 'restaurant', body),
  ]);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(replay.status, 200);
  assert.equal(first.data.status, 'CANCELLED');
  assert.equal(replay.data.status, 'CANCELLED');
  assert.equal(
    (await db.prisma.payment.findUniqueOrThrow({ where: { order_id: order } })).status,
    'REFUND_PENDING',
  );
  assert.equal(
    (await db.prisma.delivery.findUniqueOrThrow({ where: { order_id: order } })).status,
    'CANCELLED',
  );
  assert.equal(
    (await db.prisma.menuItem.findUniqueOrThrow({ where: { id: 'pho' } })).stock,
    before,
  );
  assert.equal(
    await db.prisma.auditLog.count({
      where: { action: 'RESTAURANT_REJECTED', resource_id: order },
    }),
    1,
  );
  assert.equal(
    await db.prisma.stateHistory.count({
      where: { order_id: order, entity: 'ORDER', to_state: 'CANCELLED' },
    }),
    1,
  );
  assert.equal(
    await db.prisma.outbox.count({
      where: {
        type: 'ORDER_REJECTED',
        user_id: 'customer',
        payload: { path: ['orderId'], equals: order },
      },
    }),
    1,
  );
  assert.equal(
    await db.prisma.outbox.count({
      where: {
        type: 'RESTAURANT_ORDER_REJECTED',
        user_id: 'restaurant',
        payload: { path: ['orderId'], equals: order },
      },
    }),
    1,
  );
  assert.equal(
    (
      await request(`/orders/${order}/reject`, 'restaurant', {
        ...body,
        reason: 'Different reason',
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`/orders/${order}/reject`, 'restaurant', {
        ...body,
        idempotencyKey: 'reject-other-key',
      })
    ).status,
    409,
  );
});

test('acceptance makes rejection unavailable and legacy cancellation remains unchanged', async () => {
  const order = await fixture('accepted', 'ACCEPTED');
  const result = await request(`/orders/${order}/reject`, 'restaurant', {
    reason: 'Too late',
    idempotencyKey: 'reject-late-key',
  });
  assert.equal(result.status, 409);
  assert.equal(
    (await db.prisma.order.findUniqueOrThrow({ where: { id: order } })).status,
    'ACCEPTED',
  );
  assert.equal(
    (await request(`/orders/${order}/cancel`, 'restaurant', { reason: 'Too late' })).status,
    409,
  );
});

test('acceptance racing rejection has one winner and no double compensation', async () => {
  const before = (await db.prisma.menuItem.findUniqueOrThrow({ where: { id: 'pho' } })).stock;
  const order = await fixture('race');
  const [accepted, rejected] = await Promise.all([
    request(`/orders/${order}/transition`, 'restaurant', { status: 'ACCEPTED' }),
    request(`/orders/${order}/reject`, 'restaurant', {
      reason: 'Kitchen unavailable',
      idempotencyKey: 'reject-race-key',
    }),
  ]);
  assert.deepEqual([accepted.status, rejected.status].sort(), [200, 409]);
  const current = await db.prisma.order.findUniqueOrThrow({ where: { id: order } });
  const stock = (await db.prisma.menuItem.findUniqueOrThrow({ where: { id: 'pho' } })).stock;
  if (current.status === 'CANCELLED') {
    assert.equal(stock, before);
    assert.equal(
      (await db.prisma.payment.findUniqueOrThrow({ where: { order_id: order } })).status,
      'REFUND_PENDING',
    );
  } else {
    assert.equal(current.status, 'ACCEPTED');
    assert.equal(stock, before - 1);
    assert.equal(
      (await db.prisma.payment.findUniqueOrThrow({ where: { order_id: order } })).status,
      'SUCCEEDED',
    );
  }
});
