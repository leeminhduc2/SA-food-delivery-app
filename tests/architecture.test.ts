import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';
import pg from 'pg';
const schema = 'test_' + randomUUID().replaceAll('-', '');
const originalUrl =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgres://food:food_local_only@localhost:55432/food_delivery';
const admin = new pg.Pool({ connectionString: originalUrl });
const url = new URL(originalUrl);
url.searchParams.set('options', `-c search_path=${schema}`);
process.env.DATABASE_URL = url.toString();
process.env.NODE_ENV = 'test';
process.env.LOG_REQUESTS = 'false';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'ArchitectureTest123!';
process.env.PAYMENT_MODE = 'simulated';
process.env.PAYMENT_WEBHOOK_SECRET = 'test-secret-for-signed-callback-validation';
let server: Server, base: string, db: any, payment: any, ops: any;
const cookies: Record<string, string> = {};
async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  actor = 'customer',
  extra: Record<string, string> = {},
) {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'Bep',
      cookie: cookies[actor] || '',
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json(), headers: response.headers };
}
const lines = [{ itemId: 'pho', quantity: 1, optionIds: [] }];
async function checkout(items = lines, key = randomUUID(), actor = 'customer') {
  const q = await request('/checkout/quote', 'POST', { items }, actor);
  assert.equal(q.status, 200, JSON.stringify(q.data));
  return request(
    '/checkout',
    'POST',
    {
      items,
      address: '12 Test Street, District 1',
      expectedTotal: q.data.total,
      idempotencyKey: key,
    },
    actor,
  );
}
async function pay(o: any, status = 'SUCCEEDED', eventId = randomUUID(), changes = {}) {
  const event = {
    eventId,
    reference: o.payment.reference,
    orderId: o.id,
    amount: o.total,
    currency: 'VND',
    status,
    externalTransactionId: 'ext_' + o.payment.reference,
    ...changes,
  };
  const raw = JSON.stringify(event);
  return request('/payments/webhook', 'POST', event, 'customer', {
    'x-payment-signature': payment.signature(raw),
  });
}
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  db = await import('../server/db.js');
  const { migrate } = await import('../server/migrate.js');
  await migrate();
  const { seed } = await import('../server/seed.js');
  await seed();
  payment = await import('../server/modules/payments.js');
  ops = await import('../server/modules/operations.js');
  const { createApp } = await import('../server/app.js');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const address = server.address();
  assert(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  for (const actor of ['customer', 'restaurant', 'restaurant2', 'driver', 'driver2', 'admin']) {
    const r = await request('/auth/login', 'POST', {
      email: actor + '@bep.local',
      password: process.env.DEMO_PASSWORD,
    });
    assert.equal(r.status, 200);
    cookies[actor] = r.headers.get('set-cookie')!.split(';')[0];
  }
});
after(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  if (db) await db.pool.end();
  assert.match(schema, /^test_[a-f0-9]{32}$/);
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
test('authentication, CSRF, registration, profile, role and account suspension', async () => {
  assert.equal((await request('/orders', 'GET', undefined, 'unknown')).status, 401);
  assert.equal((await request('/admin/overview')).status, 403);
  assert.equal(
    (await request('/auth/login', 'POST', { email: 'customer@bep.local', password: 'bad' })).status,
    401,
  );
  assert.equal(
    (
      await request('/auth/me', 'PATCH', { name: 'Wrong' }, 'customer', {
        origin: 'https://attacker.test',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request('/auth/register', 'POST', {
        name: 'Hacker',
        email: 'hacker@example.test',
        password: 'LongPassword123',
        role: 'ADMIN',
      })
    ).status,
    400,
  );
  const registration = await request('/auth/register', 'POST', {
    name: 'Another buyer',
    email: 'new@example.test',
    password: 'LongPassword123',
  });
  assert.equal(registration.status, 201);
  cookies.buyer2 = registration.headers.get('set-cookie')!.split(';')[0];
  assert.equal(
    (await request('/auth/me', 'PATCH', { name: 'New name' }, 'buyer2')).data.name,
    'New name',
  );
  const u = await request('/auth/register', 'POST', {
    name: 'Pending driver',
    email: 'pending@example.test',
    password: 'LongPassword123',
    role: 'DRIVER',
  });
  assert.equal(u.data.pendingApproval, true);
  await request('/admin/users/driver2', 'PATCH', { active: false }, 'admin');
  assert.equal((await request('/orders', 'GET', undefined, 'driver2')).status, 401);
  await request('/admin/users/driver2', 'PATCH', { active: true }, 'admin');
  cookies.driver2 = (
    await request('/auth/login', 'POST', {
      email: 'driver2@bep.local',
      password: process.env.DEMO_PASSWORD,
    })
  ).headers
    .get('set-cookie')!
    .split(';')[0];
});
test('discovery searches dishes; cart enforces single restaurant and optimistic version', async () => {
  const found = await request('/restaurants?q=Ph%E1%BB%9F');
  assert.equal(found.data.length, 1);
  assert.equal(found.data[0].id, 'saigon');
  const r = await request('/cart', 'PUT', { items: lines, version: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.data.version, 1);
  assert.equal((await request('/cart', 'PUT', { items: [], version: 0 })).status, 409);
  assert.equal(
    (
      await request('/cart', 'PUT', {
        items: [...lines, { itemId: 'bowl', quantity: 1, optionIds: [] }],
        version: 1,
      })
    ).data.code,
    'SINGLE_RESTAURANT',
  );
});
test('checkout retry is atomic and payload conflicts are rejected', async () => {
  const key = randomUUID();
  const body = {
    items: lines,
    address: '12 Test Street, District 1',
    expectedTotal: 80000,
    idempotencyKey: key,
    total: 1,
  };
  const responses = await Promise.all(
    Array.from({ length: 5 }, () => request('/checkout', 'POST', body)),
  );
  assert(
    responses.every((r) => r.status === 201),
    JSON.stringify(responses),
  );
  assert.equal(new Set(responses.map((r) => r.data.id)).size, 1);
  assert.equal(responses[0].data.total, 80000);
  assert.equal(
    (await request('/checkout', 'POST', { ...body, address: '99 Different Street' })).data.code,
    'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(
    (await request('/orders/' + responses[0].data.id, 'GET', undefined, 'buyer2')).status,
    403,
  );
});
test('last serving concurrency permits exactly one checkout and never negative stock', async () => {
  await db.pool.query("UPDATE menu_items SET stock=1 WHERE id='banhmi'");
  const body = {
    items: [{ itemId: 'banhmi', quantity: 1, optionIds: [] }],
    address: '12 Test Street, District 1',
    expectedTotal: 50000,
  };
  const responses = await Promise.all([
    request('/checkout', 'POST', { ...body, idempotencyKey: randomUUID() }),
    request('/checkout', 'POST', { ...body, idempotencyKey: randomUUID() }, 'buyer2'),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  assert.equal(responses.find((r) => r.status === 409)!.data.code, 'OUT_OF_STOCK');
  assert.equal(
    (await db.pool.query("SELECT stock FROM menu_items WHERE id='banhmi'")).rows[0].stock,
    0,
  );
});
test('all-or-nothing checkout, price revalidation, unavailable items, and options', async () => {
  const before = (await db.pool.query("SELECT stock FROM menu_items WHERE id='rice'")).rows[0]
    .stock;
  const bad = await request('/checkout', 'POST', {
    items: [
      { itemId: 'rice', quantity: 1, optionIds: [] },
      { itemId: 'rolls', quantity: 1, optionIds: ['invented'] },
    ],
    address: '12 Test Street',
    expectedTotal: 120000,
    idempotencyKey: randomUUID(),
  });
  assert.equal(bad.data.code, 'INVALID_OPTION');
  assert.equal(
    (await db.pool.query("SELECT stock FROM menu_items WHERE id='rice'")).rows[0].stock,
    before,
  );
  const changed = await request('/checkout', 'POST', {
    items: lines,
    address: '12 Test Street',
    expectedTotal: 1,
    idempotencyKey: randomUUID(),
  });
  assert.equal(changed.data.code, 'PRICE_CHANGED');
  const quote = await request('/checkout/quote', 'POST', {
    items: [{ itemId: 'pho', quantity: 2, optionIds: ['extra'] }],
  });
  assert.equal(quote.data.total, 175000);
  await db.pool.query("UPDATE menu_items SET available=false WHERE id='rolls'");
  assert.equal(
    (
      await request('/checkout/quote', 'POST', {
        items: [{ itemId: 'rolls', quantity: 1, optionIds: [] }],
      })
    ).data.code,
    'UNAVAILABLE',
  );
  await db.pool.query("UPDATE menu_items SET available=true WHERE id='rolls'");
});
test('signed callbacks validate amount, currency and identity; duplicate confirmation has one effect', async () => {
  const o = (await checkout()).data;
  assert.equal(
    (await request('/payments/webhook', 'POST', {}, 'customer', { 'x-payment-signature': 'bad' }))
      .status,
    401,
  );
  assert.equal(
    (await pay(o, 'SUCCEEDED', randomUUID(), { amount: o.total + 1 })).data.code,
    'PAYMENT_MISMATCH',
  );
  assert.equal((await pay(o, 'SUCCEEDED', randomUUID(), { currency: 'USD' })).status, 400);
  const eventId = randomUUID();
  assert.equal((await pay(o, 'SUCCEEDED', eventId)).status, 200);
  assert.equal((await pay(o, 'SUCCEEDED', eventId)).data.duplicate, true);
  assert.equal((await pay(o)).data.duplicate, true);
  const saved = await request('/orders/' + o.id);
  assert.equal(saved.data.status, 'CONFIRMED');
  assert.equal(
    saved.data.history.filter((h: any) => h.entity === 'ORDER' && h.to_state === 'CONFIRMED')
      .length,
    1,
  );
  assert.equal((await pay(o, 'FAILED', eventId)).data.code, 'EVENT_CONFLICT');
});
test('restaurant ownership and invalid transitions preserve state and history', async () => {
  const o = (await checkout()).data;
  await pay(o);
  assert.equal((await request('/orders/' + o.id, 'GET', undefined, 'restaurant2')).status, 403);
  assert.equal(
    (await request(`/orders/${o.id}/transition`, 'POST', { status: 'ACCEPTED' }, 'restaurant2'))
      .status,
    403,
  );
  const before = (await request('/orders/' + o.id)).data;
  assert.equal(
    (
      await request(
        `/orders/${o.id}/transition`,
        'POST',
        { status: 'READY_FOR_PICKUP' },
        'restaurant',
      )
    ).status,
    409,
  );
  const after = (await request('/orders/' + o.id)).data;
  assert.equal(after.status, before.status);
  assert.equal(after.history.length, before.history.length);
  assert.equal(
    (await request(`/orders/${o.id}/review`, 'POST', { rating: 5, content: 'Good meal' })).data
      .code,
    'NOT_DELIVERED',
  );
});
test('complete lifecycle: preparation, reassignment, authorized delivery and buyer review', async () => {
  const o = (await checkout()).data;
  await pay(o);
  assert.equal(
    (await request(`/deliveries/${o.delivery.id}/assign`, 'POST', { driverId: 'driver' }, 'admin'))
      .status,
    200,
  );
  assert.equal(
    (
      await request(
        `/deliveries/${o.delivery.id}/transition`,
        'POST',
        { status: 'PICKED_UP' },
        'driver',
      )
    ).data.code,
    'NOT_READY',
  );
  await request(`/deliveries/${o.delivery.id}/assign`, 'POST', { driverId: 'driver2' }, 'admin');
  assert.equal(
    (
      await request(
        `/deliveries/${o.delivery.id}/transition`,
        'POST',
        { status: 'PICKED_UP' },
        'driver',
      )
    ).status,
    403,
  );
  assert.equal((await request('/orders/' + o.id, 'GET', undefined, 'driver')).status, 403);
  for (const status of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'])
    assert.equal(
      (await request(`/orders/${o.id}/transition`, 'POST', { status }, 'restaurant')).status,
      200,
    );
  for (const status of ['PICKED_UP', 'IN_TRANSIT', 'DELIVERED'])
    assert.equal(
      (await request(`/deliveries/${o.delivery.id}/transition`, 'POST', { status }, 'driver2'))
        .status,
      200,
    );
  assert.equal((await request('/orders/' + o.id)).data.status, 'DELIVERED');
  assert.equal(
    (
      await request(
        `/orders/${o.id}/review`,
        'POST',
        { rating: 5, content: 'Lovely food, arrived warm.' },
        'buyer2',
      )
    ).status,
    403,
  );
  const review = await request(`/orders/${o.id}/review`, 'POST', {
    rating: 5,
    content: 'Lovely food, arrived warm.',
  });
  assert.equal(review.status, 201);
  assert.equal(
    (await request(`/orders/${o.id}/review`, 'POST', { rating: 4, content: 'Duplicate' })).status,
    409,
  );
  assert.equal(
    (await request('/admin/reviews/' + review.data.id, 'PATCH', { hidden: true }, 'admin')).status,
    200,
  );
  assert.equal((await request('/restaurants/saigon')).data.reviews.length, 0);
  const report = (await request('/reports', 'GET', undefined, 'restaurant')).data;
  assert.equal(report.delivered, 1);
  assert.equal(Number(report.revenue), o.total);
});
test('failed payment and cancellation restore stock once; late success never reopens an order', async () => {
  const before = (await db.pool.query("SELECT stock FROM menu_items WHERE id='pho'")).rows[0].stock;
  const o = (await checkout()).data;
  assert.equal(
    (await request(`/orders/${o.id}/cancel`, 'POST', { reason: 'Changed plans' })).status,
    200,
  );
  assert.equal(
    (await request(`/orders/${o.id}/cancel`, 'POST', { reason: 'Changed plans' })).status,
    409,
  );
  assert.equal(
    (await db.pool.query("SELECT stock FROM menu_items WHERE id='pho'")).rows[0].stock,
    before,
  );
  await pay(o);
  const saved = (await request('/orders/' + o.id)).data;
  assert.equal(saved.status, 'CANCELLED');
  assert.equal(saved.payment.status, 'REFUND_PENDING');
  assert.equal(saved.payment.reconciliation_required, true);
  const failed = (await checkout()).data;
  await pay(failed, 'FAILED');
  assert.equal((await request('/orders/' + failed.id)).data.status, 'PAYMENT_FAILED');
  assert.equal(
    (await db.pool.query("SELECT stock FROM menu_items WHERE id='pho'")).rows[0].stock,
    before,
  );
});
test('expiration, crash recovery, query reconciliation and simulated refunds', async () => {
  const o = (await checkout()).data;
  await db.pool.query("UPDATE orders SET expires_at=now()-interval '1 minute' WHERE id=$1", [o.id]);
  await payment.reconcilePayments();
  assert.equal((await request('/orders/' + o.id)).data.status, 'PAYMENT_FAILED');
  const pending = (await checkout()).data;
  await db.pool.query('DELETE FROM simulated_transactions WHERE reference=$1', [
    pending.payment.reference,
  ]);
  await db.pool.query('UPDATE payments SET provider_created=false WHERE id=$1', [
    pending.payment.id,
  ]);
  await payment.reconcilePayments();
  assert(
    (
      await db.pool.query('SELECT * FROM simulated_transactions WHERE reference=$1', [
        pending.payment.reference,
      ])
    ).rowCount === 1,
  );
  await db.pool.query("UPDATE simulated_transactions SET status='SUCCEEDED' WHERE reference=$1", [
    pending.payment.reference,
  ]);
  await db.pool.query('UPDATE payments SET next_reconcile_at=now() WHERE order_id=$1', [
    pending.id,
  ]);
  await payment.reconcilePayments();
  assert.equal((await request('/orders/' + pending.id)).data.status, 'CONFIRMED');
  await request(`/orders/${pending.id}/cancel`, 'POST', { reason: 'Please cancel' });
  await db.pool.query('UPDATE payments SET next_reconcile_at=now() WHERE order_id=$1', [
    pending.id,
  ]);
  await payment.reconcilePayments();
  assert.equal((await request('/orders/' + pending.id)).data.payment.status, 'REFUNDED');
});
test('provider timeout keeps a recoverable pending order; outages do not hold stock forever', async () => {
  const original = payment.paymentAdapter.create;
  process.env.PROVIDER_TIMEOUT_MS = '20';
  payment.paymentAdapter.create = async () => new Promise(() => {});
  let o: any;
  try {
    o = (await checkout()).data;
    assert.equal(o.status, 'PENDING_PAYMENT');
    assert.equal(o.payment.provider_created, false);
    await db.pool.query("UPDATE orders SET expires_at=now()-interval '1 second' WHERE id=$1", [
      o.id,
    ]);
    await payment.reconcilePayments();
    assert.equal((await request('/orders/' + o.id)).data.status, 'PAYMENT_FAILED');
  } finally {
    payment.paymentAdapter.create = original;
    delete process.env.PROVIDER_TIMEOUT_MS;
  }
  const next = (await checkout()).data;
  await db.pool.query(
    'UPDATE payments SET provider_created=false,next_reconcile_at=now() WHERE id=$1',
    [next.payment.id],
  );
  await payment.reconcilePayments();
  assert.equal(
    (
      await db.pool.query(
        'SELECT count(*)::int AS total FROM simulated_transactions WHERE reference=$1',
        [next.payment.reference],
      )
    ).rows[0].total,
    1,
  );
});
test('delivery failure requires a reason and stays distinct from successful delivery', async () => {
  const o = (await checkout()).data;
  await pay(o);
  await request(`/deliveries/${o.delivery.id}/assign`, 'POST', { driverId: 'driver' }, 'admin');
  for (const status of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'])
    await request(`/orders/${o.id}/transition`, 'POST', { status }, 'restaurant');
  assert.equal(
    (await request(`/orders/${o.id}/cancel`, 'POST', { reason: 'Too late' })).data.code,
    'CANCELLATION_NOT_ALLOWED',
  );
  await request(
    `/deliveries/${o.delivery.id}/transition`,
    'POST',
    { status: 'PICKED_UP' },
    'driver',
  );
  assert.equal(
    (
      await request(
        `/deliveries/${o.delivery.id}/transition`,
        'POST',
        { status: 'FAILED' },
        'driver',
      )
    ).data.code,
    'REASON_REQUIRED',
  );
  assert.equal(
    (
      await request(
        `/deliveries/${o.delivery.id}/transition`,
        'POST',
        { status: 'FAILED', reason: 'Customer unreachable' },
        'driver',
      )
    ).status,
    200,
  );
  assert.equal((await request('/orders/' + o.id)).data.status, 'DELIVERY_FAILED');
});
test('outbox retry is idempotent, complaints are owned, sensitive actions audited', async () => {
  await ops.deliverNotifications();
  await ops.deliverNotifications();
  const counts = await db.pool.query(
    'SELECT count(*)::int AS total,count(DISTINCT id)::int AS unique FROM notifications',
  );
  assert.equal(counts.rows[0].total, counts.rows[0].unique);
  assert(counts.rows[0].total > 0);
  const o = (await checkout()).data;
  assert.equal(
    (
      await request(
        `/orders/${o.id}/complaints`,
        'POST',
        { content: 'Help with this order please' },
        'buyer2',
      )
    ).status,
    403,
  );
  const c = await request(`/orders/${o.id}/complaints`, 'POST', {
    content: 'Help with this order please',
  });
  assert.equal(c.status, 201);
  assert.equal(
    (
      await request(
        `/admin/complaints/${c.data.id}/resolve`,
        'POST',
        { resolution: 'We contacted the kitchen.' },
        'admin',
      )
    ).status,
    200,
  );
  const audit = await db.pool.query(
    "SELECT * FROM audit_logs WHERE action IN ('COMPLAINT_RESOLVED','INVALID_PAYMENT_SIGNATURE','DRIVER_ASSIGNED')",
  );
  assert(audit.rowCount >= 3);
});
test('restaurant registration approval, menu CRUD and cross-restaurant write protection', async () => {
  const r = await request(
    '/restaurants',
    'POST',
    {
      name: 'New kitchen',
      description: 'Fresh meals',
      address: '20 Test Street, District 2',
      cuisine: 'Vietnamese',
    },
    'restaurant',
  );
  assert.equal(r.status, 201);
  assert.equal((await request('/restaurants/' + r.data.id)).status, 403);
  assert.equal(
    (
      await request(
        `/admin/restaurants/${r.data.id}/approval`,
        'POST',
        { status: 'APPROVED' },
        'restaurant',
      )
    ).status,
    403,
  );
  await request(
    `/admin/restaurants/${r.data.id}/approval`,
    'POST',
    { status: 'APPROVED' },
    'admin',
  );
  const input = {
    name: 'Fresh dish',
    description: 'Test',
    price: 30000,
    stock: 3,
    available: true,
    category: 'Lunch',
    options: [],
  };
  const i = await request(`/restaurants/${r.data.id}/items`, 'POST', input, 'restaurant');
  assert.equal(i.status, 201);
  assert.equal(
    (await request('/items/' + i.data.id, 'PUT', { ...input, price: 35000 }, 'restaurant2')).status,
    403,
  );
  assert.equal(
    (await request('/items/' + i.data.id, 'PUT', { ...input, price: 35000 }, 'restaurant')).status,
    200,
  );
  assert.equal(
    (await request('/items/' + i.data.id, 'DELETE', undefined, 'restaurant')).status,
    200,
  );
  assert.equal(
    (
      await request('/checkout/quote', 'POST', {
        items: [{ itemId: i.data.id, quantity: 1, optionIds: [] }],
      })
    ).data.code,
    'UNAVAILABLE',
  );
});
