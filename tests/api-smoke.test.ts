import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';
import pg from 'pg';

/**
 * Runtime API smoke tests.
 *
 * These tests boot the real Express app against a real PostgreSQL schema and
 * exercise the important endpoints over HTTP: health, auth/session, discovery,
 * menu, cart, checkout, payment, delivery, and admin/operations. They assert
 * status codes and response structure, not just that a route exists.
 */

const schema = 'test_smoke_' + randomUUID().replaceAll('-', '');
const originalUrl =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgres://food:food_local_only@localhost:5433/food_delivery';
const adminPool = new pg.Pool({ connectionString: originalUrl });
const url = new URL(originalUrl);
url.searchParams.set('options', `-c search_path=${schema}`);
// Prisma reads `schema`; libpq-based pg pools read `options`.
url.searchParams.set('schema', schema);
process.env.DATABASE_URL = url.toString();
const schemaPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
process.env.NODE_ENV = 'test';
process.env.LOG_REQUESTS = 'false';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'SmokeTest123!';
process.env.PAYMENT_MODE = 'simulated';
process.env.PAYMENT_WEBHOOK_SECRET = 'smoke-test-webhook-secret-at-least-32-chars';

let server: Server;
let base = '';
let db: any;
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
  const text = await response.text();
  return {
    status: response.status,
    data: text ? JSON.parse(text) : undefined,
    headers: response.headers,
  };
}

const lines = [{ itemId: 'pho', quantity: 1, optionIds: [] }];

before(async () => {
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  db = await import('../server/db.js');
  const { migrate } = await import('../server/migrate.js');
  await migrate();
  const { seed } = await import('../server/seed.js');
  await seed();
  const { createApp } = await import('../server/app.js');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  for (const actor of ['customer', 'restaurant', 'driver', 'driver2', 'admin']) {
    const login = await request('/auth/login', 'POST', {
      email: actor + '@bep.local',
      password: process.env.DEMO_PASSWORD,
    });
    assert.equal(login.status, 200, JSON.stringify(login.data));
    cookies[actor] = login.headers.get('set-cookie')!.split(';')[0];
  }
});

after(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  if (db) await db.prisma.$disconnect();
  await schemaPool.end();
  assert.match(schema, /^test_smoke_[a-f0-9]{32}$/);
  await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
  await adminPool.end();
});

test('smoke: health and API docs respond', async () => {
  const health = await fetch(base + '/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.match(health.headers.get('x-request-id') || '', /^[0-9a-f-]{36}$/);

  const docs = await fetch(base + '/api/docs/');
  assert.equal(docs.status, 200);
  assert.match(docs.headers.get('content-type') || '', /text\/html/);

  const spec = await fetch(base + '/api/docs/openapi.yaml');
  assert.equal(spec.status, 200);
  const specText = await spec.text();
  assert.match(specText, /^openapi: 3\.1\.0/m);
  assert.match(specText, /\/api\/health:/);
});

test('smoke: authentication, session cookie, CSRF and logout', async () => {
  const login = await request('/auth/login', 'POST', {
    email: 'customer@bep.local',
    password: process.env.DEMO_PASSWORD,
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie') || '';
  assert.match(setCookie, /^session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.equal(login.data.id, 'customer');
  assert.equal(login.data.role, 'CUSTOMER');
  assert.equal(login.data.password_hash, undefined);

  const me = await request('/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.id, 'customer');
  assert.equal(me.data.role, 'CUSTOMER');

  assert.equal((await request('/auth/me', 'GET', undefined, 'anonymous')).data, null);

  const badLogin = await request('/auth/login', 'POST', {
    email: 'customer@bep.local',
    password: 'definitely-not-the-password',
  });
  assert.equal(badLogin.status, 401);
  assert.equal(badLogin.data.code, 'INVALID_LOGIN');
  assert.equal(typeof badLogin.data.message, 'string');
  assert.equal(typeof badLogin.data.requestId, 'string');

  const csrf = await request(
    '/auth/login',
    'POST',
    { email: 'customer@bep.local', password: process.env.DEMO_PASSWORD },
    'anonymous',
    { 'x-requested-with': 'NotBep' },
  );
  assert.equal(csrf.status, 403);
  assert.equal(csrf.data.code, 'CSRF');

  const logout = await request('/auth/logout', 'POST');
  assert.equal(logout.status, 200);
  assert.deepEqual(logout.data, { ok: true });
  assert.equal((await request('/auth/me')).data, null);

  const relogin = await request('/auth/login', 'POST', {
    email: 'customer@bep.local',
    password: process.env.DEMO_PASSWORD,
  });
  assert.equal(relogin.status, 200);
  cookies.customer = relogin.headers.get('set-cookie')!.split(';')[0];
});

test('smoke: restaurant discovery and menu structure', async () => {
  const list = await request('/restaurants');
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('cache-control'), 'no-store');
  assert.equal(list.data.length, 3);
  assert.deepEqual(list.data.map((restaurant: any) => restaurant.id).sort(), [
    'green',
    'pizza',
    'saigon',
  ]);
  for (const restaurant of list.data) {
    assert.equal(typeof restaurant.id, 'string');
    assert.equal(typeof restaurant.name, 'string');
    assert.equal(typeof restaurant.cuisine, 'string');
    assert.equal(typeof restaurant.delivery_fee, 'number');
    assert.equal(typeof restaurant.eta_minutes, 'number');
    assert.ok(restaurant.status === 'APPROVED');
    assert.ok('rating' in restaurant);
    assert.equal(typeof restaurant.review_count, 'number');
  }

  const search = await request('/restaurants?q=' + encodeURIComponent('Phở'));
  assert.equal(search.status, 200);
  assert.equal(search.data.length, 1);
  assert.equal(search.data[0].id, 'saigon');

  const sorted = await request('/restaurants?sort=fee');
  assert.equal(sorted.status, 200);
  const fees = sorted.data.map((restaurant: any) => restaurant.delivery_fee);
  assert.deepEqual(
    fees,
    [...fees].sort((a: number, b: number) => a - b),
  );

  const detail = await request('/restaurants/saigon');
  assert.equal(detail.status, 200);
  assert.equal(detail.data.id, 'saigon');
  assert.ok(Array.isArray(detail.data.items));
  assert.ok(detail.data.items.length >= 4);
  assert.ok(Array.isArray(detail.data.reviews));
  const pho = detail.data.items.find((item: any) => item.id === 'pho');
  assert(pho);
  assert.equal(pho.name, 'Phở bò đặc biệt');
  assert.equal(pho.price, 65000);
  assert.equal(typeof pho.available, 'boolean');
  assert.equal(typeof pho.stock, 'number');
  assert.ok(Array.isArray(pho.options));

  const missing = await request('/restaurants/does-not-exist');
  assert.equal(missing.status, 404);
  assert.equal(missing.data.code, 'NOT_FOUND');
  assert.equal(typeof missing.data.message, 'string');
});

test('smoke: cart persists, removes an item and rejects stale versions', async () => {
  const initial = await request('/cart');
  assert.equal(initial.status, 200);
  assert.ok(Array.isArray(initial.data.items));
  assert.ok('version' in initial.data);

  const put = await request('/cart', 'PUT', {
    items: [{ itemId: 'pho', quantity: 2, optionIds: [] }],
    version: initial.data.version,
  });
  assert.equal(put.status, 200);
  assert.equal(put.data.version, initial.data.version + 1);
  assert.equal(put.data.items.length, 1);
  assert.equal(put.data.items[0].itemId, 'pho');
  assert.equal(put.data.items[0].quantity, 2);

  const persisted = await request('/cart');
  assert.equal(persisted.status, 200);
  assert.equal(persisted.data.version, put.data.version);
  assert.equal(persisted.data.items.length, 1);

  const stale = await request('/cart', 'PUT', {
    items: [{ itemId: 'pho', quantity: 1, optionIds: [] }],
    version: initial.data.version,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'CART_CONFLICT');

  const removed = await request('/cart/items/pho', 'DELETE');
  assert.equal(removed.status, 200);
  assert.equal(removed.data.items.length, 0);
  assert.equal(removed.data.version, put.data.version + 1);

  const removeAgain = await request('/cart/items/pho', 'DELETE');
  assert.equal(removeAgain.status, 404);
  assert.equal(removeAgain.data.code, 'CART_ITEM_NOT_FOUND');

  const wrongRole = await request('/cart', 'PUT', { items: lines, version: 0 }, 'restaurant');
  assert.equal(wrongRole.status, 403);
  assert.equal(wrongRole.data.code, 'FORBIDDEN');
});

test('smoke: checkout, payment, delivery and review lifecycle', async () => {
  const quote = await request('/checkout/quote', 'POST', { items: lines });
  assert.equal(quote.status, 200);
  assert.equal(quote.data.restaurantId, 'saigon');
  assert.equal(quote.data.items.length, 1);
  assert.equal(quote.data.items[0].itemId, 'pho');
  assert.equal(quote.data.items[0].price, 65000);
  assert.equal(quote.data.subtotal, 65000);
  assert.equal(typeof quote.data.deliveryFee, 'number');
  assert.equal(quote.data.total, quote.data.subtotal + quote.data.deliveryFee);

  const quoteAsRestaurant = await request(
    '/checkout/quote',
    'POST',
    { items: lines },
    'restaurant',
  );
  assert.equal(quoteAsRestaurant.status, 403);

  const idempotencyKey = 'smoke-order-' + randomUUID();
  const checkoutBody = {
    items: lines,
    address: '12 Smoke Test Street, District 1',
    note: 'Smoke test order',
    expectedTotal: quote.data.total,
    idempotencyKey,
  };
  const order = await request('/checkout', 'POST', checkoutBody);
  assert.equal(order.status, 201);
  assert.equal(typeof order.data.id, 'string');
  assert.equal(order.data.status, 'PENDING_PAYMENT');
  assert.equal(order.data.total, quote.data.total);
  assert.equal(order.data.items.length, 1);
  assert.equal(order.data.payment.status, 'PENDING');
  assert.equal(order.data.payment.amount, quote.data.total);
  assert.equal(order.data.payment.currency, 'VND');
  assert.equal(typeof order.data.payment.reference, 'string');
  assert.equal(order.data.delivery.status, 'UNASSIGNED');
  assert.ok(Array.isArray(order.data.history));
  assert.equal(order.data.history.at(-1).to_state, 'PENDING_PAYMENT');

  const replay = await request('/checkout', 'POST', checkoutBody);
  assert.equal(replay.status, 201);
  assert.equal(replay.data.id, order.data.id);

  const list = await request('/orders');
  assert.equal(list.status, 200);
  assert.ok(list.data.some((candidate: any) => candidate.id === order.data.id));

  const detail = await request(`/orders/${order.data.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.id, order.data.id);

  const paid = await request(`/orders/${order.data.id}/simulate-payment`, 'POST', {
    status: 'SUCCEEDED',
  });
  assert.equal(paid.status, 200);
  assert.equal(paid.data.duplicate, false);

  const confirmed = await request(`/orders/${order.data.id}`);
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.status, 'CONFIRMED');
  assert.equal(confirmed.data.payment.status, 'SUCCEEDED');

  const payAgain = await request(`/orders/${order.data.id}/simulate-payment`, 'POST', {
    status: 'SUCCEEDED',
  });
  assert.equal(payAgain.status, 409);
  assert.equal(payAgain.data.code, 'INVALID_TRANSITION');

  const deliveryId = confirmed.data.delivery.id;
  const assign = await request(
    `/deliveries/${deliveryId}/assign`,
    'POST',
    { driverId: 'driver' },
    'admin',
  );
  assert.equal(assign.status, 200);
  assert.deepEqual(assign.data, { ok: true });

  const asDriver = await request(`/orders/${order.data.id}`, 'GET', undefined, 'driver');
  assert.equal(asDriver.status, 200);
  assert.equal(asDriver.data.delivery.driver_id, 'driver');

  const tooEarly = await request(
    `/deliveries/${deliveryId}/transition`,
    'POST',
    { status: 'PICKED_UP' },
    'driver',
  );
  assert.equal(tooEarly.status, 409);
  assert.equal(tooEarly.data.code, 'NOT_READY');

  for (const status of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']) {
    const moved = await request(
      `/orders/${order.data.id}/transition`,
      'POST',
      { status },
      'restaurant',
    );
    assert.equal(moved.status, 200, JSON.stringify(moved.data));
    assert.equal(moved.data.status, status);
  }

  const wrongDriver = await request(
    `/deliveries/${deliveryId}/transition`,
    'POST',
    { status: 'PICKED_UP' },
    'driver2',
  );
  assert.equal(wrongDriver.status, 403);
  assert.equal(wrongDriver.data.code, 'FORBIDDEN');

  const pickedUp = await request(
    `/deliveries/${deliveryId}/transition`,
    'POST',
    { status: 'PICKED_UP' },
    'driver',
  );
  assert.equal(pickedUp.status, 200);
  assert.deepEqual(pickedUp.data, { ok: true });

  const inTransit = await request(
    `/deliveries/${deliveryId}/transition`,
    'POST',
    { status: 'IN_TRANSIT' },
    'driver',
  );
  assert.equal(inTransit.status, 200);

  const delivered = await request(
    `/deliveries/${deliveryId}/transition`,
    'POST',
    { status: 'DELIVERED' },
    'driver',
  );
  assert.equal(delivered.status, 200);

  const final = await request(`/orders/${order.data.id}`);
  assert.equal(final.status, 200);
  assert.equal(final.data.status, 'DELIVERED');
  assert.equal(final.data.delivery.status, 'DELIVERED');
  assert.equal(final.data.delivery.driver_id, 'driver');

  const review = await request(`/orders/${order.data.id}/review`, 'POST', {
    rating: 5,
    content: 'Smoke test: food arrived hot and on time.',
  });
  assert.equal(review.status, 201);
  assert.equal(review.data.rating, 5);
  assert.equal(typeof review.data.id, 'string');
});

test('smoke: admin overview, reports, notifications and metrics', async () => {
  const forbidden = await request('/admin/overview');
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.data.code, 'FORBIDDEN');

  const overview = await request('/admin/overview', 'GET', undefined, 'admin');
  assert.equal(overview.status, 200);
  assert.equal(overview.data.restaurants.length, 3);
  assert.equal(overview.data.users.length, 6);
  assert.ok(Array.isArray(overview.data.audit));
  assert.ok(Array.isArray(overview.data.reviews));
  assert.ok(overview.data.reviews.length >= 1);
  assert.ok(Array.isArray(overview.data.reconciliation));
  assert.equal(typeof overview.data.outbox.pending, 'number');
  assert.equal(typeof overview.data.outbox.failed, 'number');

  const report = await request('/reports', 'GET', undefined, 'admin');
  assert.equal(report.status, 200);
  assert.equal(typeof report.data.orders, 'number');
  assert.equal(typeof report.data.delivered, 'number');
  assert.ok(report.data.delivered >= 1);
  assert.ok(report.data.revenue >= 65000);
  assert.equal(typeof report.data.delivery_failed, 'number');
  assert.equal(typeof report.data.pending, 'number');
  assert.ok(Array.isArray(report.data.daily));
  assert.equal(typeof report.data.revenueBasis, 'string');

  const complaints = await request('/complaints', 'GET', undefined, 'admin');
  assert.equal(complaints.status, 200);
  assert.ok(Array.isArray(complaints.data));

  const { deliverNotifications } = await import('../server/services/notification.service.js');
  await deliverNotifications();
  const inbox = await request('/notifications');
  assert.equal(inbox.status, 200);
  assert.ok(Array.isArray(inbox.data));
  assert.ok(inbox.data.length >= 1);
  for (const notification of inbox.data) {
    assert.equal(typeof notification.id, 'string');
    assert.equal(typeof notification.type, 'string');
    assert.ok('read' in notification);
    assert.ok('payload' in notification);
  }

  const read = await request('/notifications/read', 'POST');
  assert.equal(read.status, 200);
  assert.deepEqual(read.data, { ok: true });

  const metrics = await request('/metrics', 'GET', undefined, 'admin');
  assert.equal(metrics.status, 200);
  assert.equal(typeof metrics.data.requests, 'number');
  assert.equal(typeof metrics.data.serverErrors, 'number');
  assert.equal(typeof metrics.data.p95Ms, 'number');
  assert.equal(typeof metrics.data.p99Ms, 'number');

  const metricsForbidden = await request('/metrics');
  assert.equal(metricsForbidden.status, 403);
});

test('smoke: error contract for unknown routes, auth, validation and malformed JSON', async () => {
  const unknown = await request('/does-not-exist');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.data.code, 'NOT_FOUND');
  assert.equal(typeof unknown.data.message, 'string');
  assert.equal(typeof unknown.data.requestId, 'string');

  const unauthenticated = await request('/orders', 'GET', undefined, 'anonymous');
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.data.code, 'UNAUTHENTICATED');

  const invalid = await request('/auth/login', 'POST', {});
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.code, 'VALIDATION');
  assert.equal(typeof invalid.data.message, 'string');

  const malformed = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Bep' },
    body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).code, 'INVALID_JSON');

  const noCsrf = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'customer@bep.local', password: process.env.DEMO_PASSWORD }),
  });
  assert.equal(noCsrf.status, 403);
  assert.equal((await noCsrf.json()).code, 'CSRF');
});
