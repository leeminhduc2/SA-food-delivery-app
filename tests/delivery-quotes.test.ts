import {
  testDatabaseUrl,
  testSchemaUrl,
  verifyTestSchema,
  dropTestSchema,
} from './test-database.js';
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';
import pg from 'pg';
import {
  setGeocodingProvider,
  type GeocodingProvider,
} from '../server/modules/location/infrastructure/geocoding.client.js';
import {
  RoutingProviderError,
  setRoutingProvider,
  type RoutingProvider,
} from '../server/modules/location/infrastructure/routing.client.js';
import { MOCK_RESTAURANTS } from '../server/seed/data/mock-catalog.js';

/**
 * Persisted delivery quotes are the contract between an address, a restaurant
 * and a price. These tests prove a saved address prefetches one snapshot per
 * visible restaurant, valid snapshots are reused without routing, and stale or
 * failed quotes are recomputed instead of trusted.
 */
const schema = 'test_quotes_' + randomUUID().replaceAll('-', '');
const originalUrl = testDatabaseUrl();
const admin = new pg.Pool({ connectionString: originalUrl, connectionTimeoutMillis: 3000 });
process.env.DATABASE_URL = testSchemaUrl(originalUrl, schema);
let schemaCreated = false;
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'QuoteTest123!';
process.env.PAYMENT_MODE = 'simulated';
process.env.PAYMENT_WEBHOOK_SECRET = 'delivery-quote-test-webhook-secret-32';
process.env.LOG_REQUESTS = 'false';
process.env.GEOCODING_MIN_INTERVAL_MS = '0';

let routeMode: 'ok' | 'provider-error' | 'no-route' = 'ok';
let routingCalls = 0;
const fakeRouting: RoutingProvider = {
  name: 'quotes-fake-router',
  async walkingRoute(from, to) {
    routingCalls++;
    if (routeMode === 'provider-error')
      throw new RoutingProviderError('PROVIDER_ERROR', 'Router down.');
    if (routeMode === 'no-route') throw new RoutingProviderError('NO_ROUTE', 'No walking route.');
    const distanceMeters = from.latitude < 20.95 ? 16_000 : from.latitude > 21.045 ? 5_000 : 1_200;
    return {
      distanceMeters,
      durationSeconds: Math.round(distanceMeters / 1.2),
      routeGeometry: {
        type: 'LineString',
        coordinates: [
          [from.longitude, from.latitude],
          [to.longitude, to.latitude],
        ],
      },
      provider: 'quotes-fake-router',
    };
  },
};
const fakeGeocoding: GeocodingProvider = {
  name: 'quotes-fake-geocoder',
  async search(query) {
    return {
      address: query,
      formattedAddress: query + ', Hà Nội, Việt Nam',
      latitude: 21.0301,
      longitude: 105.8527,
      provider: 'quotes-fake-geocoder',
    };
  },
  async reverse(latitude, longitude) {
    return {
      address: `${latitude}, ${longitude}`,
      formattedAddress: `Saved address (${latitude.toFixed(4)}, ${longitude.toFixed(4)})`,
      latitude,
      longitude,
      provider: 'quotes-fake-geocoder',
    };
  },
};
setGeocodingProvider(fakeGeocoding);
setRoutingProvider(fakeRouting);

const firstRestaurant = MOCK_RESTAURANTS[0];
let server: Server;
let base = '';
let db: any;
let routing: typeof import('../server/modules/location/application/routing.service.js');
let customerCookie = '';

async function request(path: string, method = 'GET', body?: unknown, cookie = customerCookie) {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'Bep',
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : undefined };
}

const itemLines = [{ itemId: 'mock-item-001', quantity: 1, optionIds: [] }];

async function saveAddress(address: string, latitude: number, longitude: number) {
  return request('/users/me/delivery-address', 'PUT', { address, latitude, longitude });
}

async function quote() {
  return request('/checkout/quote', 'POST', { items: itemLines });
}

async function currentAddressId(): Promise<string> {
  const row = await db.prisma.address.findFirst({
    where: { user_id: 'customer', is_default: true },
  });
  assert.ok(row, 'expected a saved default address');
  return row.id;
}

async function quoteRows() {
  return db.prisma.deliveryQuote.findMany({
    where: { address_id: await currentAddressId() },
  });
}

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  db = await import('../server/shared/db.js');
  await verifyTestSchema(schema, db.prisma);
  const { migrate } = await import('../server/migrate.js');
  await migrate();
  const { seed } = await import('../server/seed/seed.js');
  await seed();
  const { seedMockCatalog } = await import('../server/seed/seed-mock.js');
  await seedMockCatalog();
  routing = await import('../server/modules/location/application/routing.service.js');
  const { createApp } = await import('../server/app.js');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Bep' },
    body: JSON.stringify({ email: 'customer@bep.local', password: process.env.DEMO_PASSWORD }),
  });
  assert.equal(login.status, 200, await login.text());
  customerCookie = login.headers.get('set-cookie')!.split(';')[0];
});

after(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  if (db) await db.prisma.$disconnect();
  await dropTestSchema(admin, schema, schemaCreated);
  await admin.end();
});

test('saving an address persists one snapshot for every visible restaurant', async () => {
  routingCalls = 0;
  const saved = await saveAddress('18 Phố Hàng Bạc, Hoàn Kiếm, Hà Nội', 21.03, 105.85);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.ok(routingCalls > 0, 'the address save must prefetch quotes');

  const rows = await quoteRows();
  assert.equal(rows.length, 10, 'one quote per visible restaurant');
  const row = rows.find((candidate: any) => candidate.restaurant_id === firstRestaurant.id);
  assert.ok(row, 'missing quote for the first restaurant');
  assert.equal(row.status, 'AVAILABLE');
  assert.equal(row.distance_meters, 1_200);
  assert.equal(row.duration_seconds, 1_000);
  assert.equal(row.shipping_fee, 10_000);
  assert.equal(row.currency, 'VND');
  assert.equal(row.address_latitude, 21.03);
  assert.equal(row.address_longitude, 105.85);
  assert.equal(row.restaurant_latitude, firstRestaurant.latitude);
  assert.equal(row.restaurant_longitude, firstRestaurant.longitude);
  assert.match(row.pricing_key, /^v1:/);
  assert.ok(row.route_geometry, 'stored geometry is needed for route previews');
  assert.ok(new Date(row.expires_at).getTime() > Date.now());
});

test('catalog, detail, shipping quote and checkout reuse stored quotes without routing', async () => {
  routing.clearRoutingCache();
  routingCalls = 0;

  const list = await request('/restaurants');
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 10);
  const detail = await request('/restaurants/' + firstRestaurant.id);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.deliveryInfo.distanceMeters, 1_200);
  const shipping = await request('/restaurants/' + firstRestaurant.id + '/shipping-quote');
  assert.equal(shipping.status, 200);
  assert.equal(routingCalls, 0, 'valid quotes must survive an empty route cache');

  const preview = await quote();
  assert.equal(preview.status, 200);
  assert.equal(preview.data.deliveryFee, 10_000);
  assert.equal(preview.data.total, 65_000);
  const checkout = await request('/checkout', 'POST', {
    items: itemLines,
    address: 'Ignored client address',
    shippingFee: 1,
    expectedTotal: preview.data.total,
    idempotencyKey: 'quote-order-' + randomUUID(),
  });
  assert.equal(checkout.status, 201, JSON.stringify(checkout.data));
  assert.equal(checkout.data.delivery_fee, 10_000);
  assert.equal(checkout.data.walking_distance_meters, 1_200);
  assert.equal(checkout.data.delivery_latitude, 21.03);
  assert.equal(checkout.data.address, '18 Phố Hàng Bạc, Hoàn Kiếm, Hà Nội');
  assert.equal(routingCalls, 0, 'checkout must reuse the stored snapshot');
});

test('changing the address replaces the quote snapshots and the fee', async () => {
  routingCalls = 0;
  const saved = await saveAddress('50 Phố Huế, Hai Bà Trưng, Hà Nội', 21.05, 105.86);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.ok(routingCalls > 0);
  const rows = await quoteRows();
  assert.equal(rows.length, 10, 'the same address row keeps one quote per restaurant');
  const row = rows.find((candidate: any) => candidate.restaurant_id === firstRestaurant.id);
  assert.equal(row.address_latitude, 21.05);
  assert.equal(row.distance_meters, 5_000);
  assert.equal(row.shipping_fee, 19_000);
  const preview = await quote();
  assert.equal(preview.data.deliveryFee, 19_000);
  assert.equal(preview.data.total, 74_000);
});

test('moving a restaurant invalidates and recomputes its quote', async () => {
  const ownerLogin = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Bep' },
    body: JSON.stringify({ email: 'restaurant@bep.local', password: process.env.DEMO_PASSWORD }),
  });
  assert.equal(ownerLogin.status, 200);
  const ownerCookieHeader = ownerLogin.headers.get('set-cookie')!.split(';')[0];

  const moved = await request(
    '/restaurants/' + firstRestaurant.id,
    'PATCH',
    { latitude: 21.04, longitude: 105.86 },
    ownerCookieHeader,
  );
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  const rows = await quoteRows();
  assert.equal(
    rows.filter((candidate: any) => candidate.restaurant_id === firstRestaurant.id).length,
    0,
    'a coordinate change must delete the old snapshot',
  );

  routing.clearRoutingCache();
  routingCalls = 0;
  const preview = await quote();
  assert.equal(preview.status, 200);
  assert.equal(preview.data.deliveryInfo.distanceMeters, 5_000);
  assert.equal(routingCalls, 1);
  const again = await quote();
  assert.equal(again.status, 200);
  assert.equal(routingCalls, 1, 'the recomputed quote is reused');

  await request(
    '/restaurants/' + firstRestaurant.id,
    'PATCH',
    { latitude: firstRestaurant.latitude, longitude: firstRestaurant.longitude },
    ownerCookieHeader,
  );
});

test('an expired quote is recomputed and its expiry is refreshed', async () => {
  await quote(); // ensure a fresh row exists after the coordinate restore
  const addressId = await currentAddressId();
  const old = await db.prisma.deliveryQuote.findUnique({
    where: {
      address_id_restaurant_id: {
        address_id: addressId,
        restaurant_id: firstRestaurant.id,
      },
    },
  });
  assert.ok(old);
  const past = new Date(Date.now() - 60_000);
  await db.prisma.deliveryQuote.update({
    where: { id: old.id },
    data: { expires_at: past },
  });
  routing.clearRoutingCache();
  routingCalls = 0;
  const preview = await quote();
  assert.equal(preview.status, 200);
  assert.equal(routingCalls, 1, 'an expired snapshot must be recomputed');
  const rows = await quoteRows();
  const refreshed = rows.find((candidate: any) => candidate.restaurant_id === firstRestaurant.id);
  assert.ok(new Date(refreshed.expires_at).getTime() > past.getTime());
  assert.ok(new Date(refreshed.expires_at).getTime() > Date.now());
});

test('transient provider failures are not stored and recovery is immediate', async () => {
  await db.prisma.deliveryQuote.deleteMany();
  routeMode = 'provider-error';
  routing.clearRoutingCache();
  const failed = await quote();
  assert.equal(failed.status, 200);
  assert.equal(failed.data.deliveryInfo.status, 'UNAVAILABLE');
  assert.equal(failed.data.deliveryInfo.reason, 'ROUTE_PROVIDER_ERROR');
  assert.equal(failed.data.deliveryFee, 0);
  assert.equal((await quoteRows()).length, 0, 'transient failures must not be cached as quotes');

  routeMode = 'ok';
  routing.clearRoutingCache();
  const recovered = await quote();
  assert.equal(recovered.status, 200);
  assert.equal(recovered.data.deliveryInfo.status, 'AVAILABLE');
  const rows = await quoteRows();
  assert.equal(
    rows.filter((candidate: any) => candidate.restaurant_id === firstRestaurant.id).length,
    1,
  );
});

test('NO_WALKING_ROUTE is never stored while OUT_OF_RANGE is', async () => {
  await db.prisma.deliveryQuote.deleteMany();
  routeMode = 'no-route';
  routing.clearRoutingCache();
  const noRoute = await quote();
  assert.equal(noRoute.status, 200);
  assert.equal(noRoute.data.deliveryInfo.status, 'UNSUPPORTED');
  assert.equal(noRoute.data.deliveryInfo.reason, 'NO_WALKING_ROUTE');
  assert.equal((await quoteRows()).length, 0);

  routeMode = 'ok';
  const far = await saveAddress('Xa xôi, ngoại thành Hà Nội', 20.9, 105.7);
  assert.equal(far.status, 200);
  const preview = await quote();
  assert.equal(preview.status, 200);
  assert.equal(preview.data.deliveryInfo.reason, 'OUT_OF_RANGE');
  assert.equal(preview.data.deliveryFee, 0);
  const rows = await quoteRows();
  assert.equal(rows.length, 10);
  assert.ok(
    rows.every((row: any) => row.status === 'UNSUPPORTED' && row.reason === 'OUT_OF_RANGE'),
  );
});

test('a hidden restaurant is excluded from prefetch', async () => {
  const ownerLogin = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Bep' },
    body: JSON.stringify({ email: 'restaurant@bep.local', password: process.env.DEMO_PASSWORD }),
  });
  const ownerCookie = ownerLogin.headers.get('set-cookie')!.split(';')[0];
  await db.prisma.deliveryQuote.deleteMany();
  const hidden = await request(
    '/restaurants/' + firstRestaurant.id,
    'PATCH',
    { catalog_visible: false },
    ownerCookie,
  );
  assert.equal(hidden.status, 200, JSON.stringify(hidden.data));

  const saved = await saveAddress('18 Phố Hàng Bạc, Hoàn Kiếm, Hà Nội', 21.03, 105.85);
  assert.equal(saved.status, 200);
  const rows = await quoteRows();
  assert.equal(rows.length, 9);
  assert.equal(
    rows.some((row: any) => row.restaurant_id === firstRestaurant.id),
    false,
    'hidden restaurants must not receive prefetched quotes',
  );
  await request(
    '/restaurants/' + firstRestaurant.id,
    'PATCH',
    { catalog_visible: true },
    ownerCookie,
  );
});

test('checkout requires a saved address and never trusts a client fee', async () => {
  const registration = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Bep' },
    body: JSON.stringify({
      name: 'No Quote Address',
      email: `no-quote-${randomUUID()}@example.test`,
      password: 'LongPassword123',
    }),
  });
  assert.equal(registration.status, 201);
  const noAddressCookie = registration.headers.get('set-cookie')!.split(';')[0];
  const noAddress = await request(
    '/checkout',
    'POST',
    { items: itemLines, expectedTotal: 65_000, idempotencyKey: 'no-quote-' + randomUUID() },
    noAddressCookie,
  );
  assert.equal(noAddress.status, 400);
  assert.equal(noAddress.data.code, 'ADDRESS_REQUIRED');

  // Return the customer to a routable address for the fee checks.
  await saveAddress('18 Phố Hàng Bạc, Hoàn Kiếm, Hà Nội', 21.03, 105.85);
  const preview = await quote();
  assert.equal(preview.status, 200);
  assert.equal(preview.data.deliveryFee, 10_000);

  const changed = await request('/checkout', 'POST', {
    items: itemLines,
    shippingFee: 1,
    expectedTotal: preview.data.total + 1,
    idempotencyKey: 'bad-total-' + randomUUID(),
  });
  assert.equal(changed.status, 409);
  assert.equal(changed.data.code, 'PRICE_CHANGED');

  const accepted = await request('/checkout', 'POST', {
    items: itemLines,
    shippingFee: 1,
    address: 'A different client address',
    expectedTotal: preview.data.total,
    idempotencyKey: 'good-total-' + randomUUID(),
  });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.data));
  assert.equal(accepted.data.delivery_fee, 10_000);
  assert.equal(accepted.data.total, preview.data.total);
  assert.equal(accepted.data.address, '18 Phố Hàng Bạc, Hoàn Kiếm, Hà Nội');
});
