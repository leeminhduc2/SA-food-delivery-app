import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import pg from 'pg';
import {
  GeocodingProviderError,
  setGeocodingProvider,
  type GeocodingProvider,
} from '../server/integrations/geocoding.js';
import {
  RoutingProviderError,
  setRoutingProvider,
  type RoutingProvider,
} from '../server/integrations/routing.js';
import { shippingQuote } from '../server/domain/delivery.js';
import { MOCK_RESTAURANTS } from '../server/domain/mock-catalog.js';

const schema = 'test_delivery_' + randomUUID().replaceAll('-', '');
const originalUrl =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgres://food:food_local_only@localhost:5433/food_delivery';
const admin = new pg.Pool({ connectionString: originalUrl });
const url = new URL(originalUrl);
url.searchParams.set('options', `-c search_path=${schema}`);
url.searchParams.set('schema', schema);
process.env.DATABASE_URL = url.toString();
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'DeliveryTest123!';
process.env.PAYMENT_MODE = 'simulated';
process.env.PAYMENT_WEBHOOK_SECRET = 'delivery-test-webhook-secret-at-least-32';
process.env.LOG_REQUESTS = 'false';
process.env.GEOCODING_MIN_INTERVAL_MS = '0';
process.env.ROUTING_TIMEOUT_MS = '6000';

const distances: Record<string, number> = {
  '21.0366,105.7899': 100, // mock-restaurant-10
  '21.0357,105.8266': 800, // 05
  '21.0301,105.8527': 1_200, // 01
  '21.0123,105.8551': 2_100, // 02
  '21.0127,105.8297': 3_000, // 03
  '21.0260,105.8006': 5_000, // 04
  '21.0271,105.8566': 8_000, // 06
  '20.9939,105.8128': 10_000, // 07
  '21.0079,105.8250': 15_000, // 08
  '21.0313,105.8394': 16_000, // 09 (unsupported)
};

let routeMode: 'ok' | 'no-route' | 'provider-error' | 'partial-error' | 'invalid' | 'timeout' =
  'ok';
let routingCalls = 0;
const fakeRouting: RoutingProvider = {
  name: 'fake-pedestrian',
  async walkingRoute(from, to) {
    routingCalls++;
    if (routeMode === 'no-route') throw new RoutingProviderError('NO_ROUTE', 'No walking route.');
    if (routeMode === 'provider-error')
      throw new RoutingProviderError('PROVIDER_ERROR', 'Router down.');
    if (
      routeMode === 'partial-error' &&
      to.latitude.toFixed(4) === '21.0301' &&
      to.longitude.toFixed(4) === '105.8527'
    )
      throw new RoutingProviderError('PROVIDER_ERROR', 'Router down for one restaurant.');
    if (routeMode === 'invalid')
      return {
        distanceMeters: Number.NaN,
        durationSeconds: 10,
        routeGeometry: { type: 'LineString', coordinates: [] },
        provider: 'fake',
      };
    if (routeMode === 'timeout') await new Promise((resolve) => setTimeout(resolve, 2_500));
    const destinationKey = `${to.latitude.toFixed(4)},${to.longitude.toFixed(4)}`;
    const distance =
      from.latitude < 20.95
        ? 16_000
        : from.latitude > 21.045
          ? 5_000
          : (distances[destinationKey] ?? 1_000);
    return {
      distanceMeters: distance,
      durationSeconds: Math.round(distance / 1.2),
      routeGeometry: {
        type: 'LineString',
        coordinates: [
          [from.longitude, from.latitude],
          [to.longitude, to.latitude],
        ],
      },
      provider: 'fake-pedestrian',
    };
  },
};

let geocodeMode: 'ok' | 'not-found' | 'timeout' = 'ok';
let geocodeCalls = 0;
const fakeGeocoding: GeocodingProvider = {
  name: 'fake-geocoder',
  async search(query) {
    geocodeCalls++;
    if (geocodeMode === 'timeout')
      throw new GeocodingProviderError('TIMEOUT', 'Geocoder timed out.');
    if (geocodeMode === 'not-found' || /unknown|not a place/i.test(query)) return null;
    return {
      address: query,
      formattedAddress: query + ', Hà Nội, Việt Nam',
      latitude: 21.0301,
      longitude: 105.8527,
      provider: 'fake-geocoder',
    };
  },
  async reverse(latitude, longitude) {
    return {
      address: `${latitude}, ${longitude}`,
      formattedAddress: `Số 18 Phố Hàng Bạc, Hoàn Kiếm, Hà Nội (${latitude.toFixed(4)}, ${longitude.toFixed(4)})`,
      latitude,
      longitude,
      provider: 'fake-geocoder',
    };
  },
};

setGeocodingProvider(fakeGeocoding);
setRoutingProvider(fakeRouting);

let server: Server;
let base = '';
let db: any;
let customerCookie = '';
let routing: typeof import('../server/services/routing.service.js');
let addressService: typeof import('../server/services/address.service.js');

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

async function saveAddress(address: string, latitude: number, longitude: number) {
  return request('/users/me/delivery-address', 'PUT', { address, latitude, longitude });
}

async function quote() {
  return request('/checkout/quote', 'POST', {
    items: [{ itemId: 'mock-item-001', quantity: 1, optionIds: [] }],
  });
}

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  db = await import('../server/db.js');
  const { migrate } = await import('../server/migrate.js');
  await migrate();
  const { seed } = await import('../server/seed.js');
  await seed();
  const { seedMockCatalog } = await import('../server/seed-mock.js');
  await seedMockCatalog();
  routing = await import('../server/services/routing.service.js');
  addressService = await import('../server/services/address.service.js');
  const { createApp } = await import('../server/app.js');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Bep' },
    body: JSON.stringify({ email: 'customer@bep.local', password: process.env.DEMO_PASSWORD }),
  });
  assert.equal(response.status, 200, await response.text());
  customerCookie = response.headers.get('set-cookie')!.split(';')[0];
});

after(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  if (db) await db.prisma.$disconnect();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

test('shipping fee boundaries follow the centralized formula', () => {
  const cases: [number, number][] = [
    [1_200, 10_000],
    [2_000, 10_000],
    [2_100, 13_000],
    [3_000, 13_000],
    [5_000, 19_000],
    [8_000, 28_000],
    [10_000, 34_000],
    [15_000, 49_000],
  ];
  for (const [distance, fee] of cases) {
    const result = shippingQuote(distance);
    assert.equal(result.supported, true, String(distance));
    assert.equal(result.shippingFee, fee, String(distance));
  }
  const over = shippingQuote(15_001);
  assert.equal(over.supported, false);
  assert.equal(over.reason, 'OUT_OF_RANGE');
  assert.equal(over.shippingFee, null);
  const negative = shippingQuote(-1);
  assert.equal(negative.supported, false);
  assert.equal(negative.reason, 'INVALID_DISTANCE');
  const invalid = shippingQuote(Number.NaN);
  assert.equal(invalid.supported, false);
  assert.equal(invalid.reason, 'INVALID_DISTANCE');
});

test('catalog shows no fake distance or fee before an address is saved', async () => {
  const list = await request('/restaurants');
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 10);
  for (const restaurant of list.data) {
    assert.equal(restaurant.deliveryInfo.status, 'NO_ADDRESS');
    assert.equal(restaurant.deliveryInfo.supported, false);
    assert.equal(restaurant.deliveryInfo.distanceMeters, null);
    assert.equal(restaurant.deliveryInfo.shippingFee, null);
  }
  const detail = await request('/restaurants/mock-restaurant-01');
  assert.equal(detail.data.deliveryInfo.status, 'NO_ADDRESS');
  assert.equal(detail.data.items.length, 6);
});

test('address validation, geocoding failures and coordinate bounds', async () => {
  const invalidCoordinates = await request('/users/me/delivery-address', 'PUT', {
    address: '18 Phố Hàng Bạc, Hoàn Kiếm, Hà Nội',
    latitude: 999,
    longitude: 105.85,
  });
  assert.equal(invalidCoordinates.status, 400);
  assert.equal(invalidCoordinates.data.code, 'VALIDATION');

  geocodeMode = 'not-found';
  const missing = await request('/users/me/delivery-address', 'PUT', {
    address: 'This place is unknown 12345',
  });
  assert.equal(missing.status, 422);
  assert.equal(missing.data.code, 'ADDRESS_NOT_FOUND');

  geocodeMode = 'timeout';
  const timedOut = await request('/users/me/delivery-address', 'PUT', {
    address: 'A different address that times out',
  });
  assert.equal(timedOut.status, 502);
  assert.equal(timedOut.data.code, 'GEOCODING_TIMEOUT');
  geocodeMode = 'ok';

  const saved = await saveAddress('18 Phố Hàng Bạc, Hoàn Kiếm, Hà Nội', 21.03, 105.85);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.latitude, 21.03);
  assert.equal(saved.data.longitude, 105.85);
  assert.equal(saved.data.isDefault, true);
  const fetched = await request('/users/me/delivery-address');
  assert.equal(fetched.status, 200);
  assert.equal(fetched.data.address, '18 Phố Hàng Bạc, Hoàn Kiếm, Hà Nội');
});

test('catalog uses pedestrian distance, sorts nearest first and keeps the menu intact', async () => {
  geocodeCalls = 0;
  const list = await request('/restaurants');
  assert.equal(list.status, 200);
  const ids = list.data.map((row: any) => row.id);
  assert.deepEqual(ids, [
    'mock-restaurant-10',
    'mock-restaurant-05',
    'mock-restaurant-01',
    'mock-restaurant-02',
    'mock-restaurant-03',
    'mock-restaurant-04',
    'mock-restaurant-06',
    'mock-restaurant-07',
    'mock-restaurant-08',
    'mock-restaurant-09',
  ]);
  const byId = new Map(list.data.map((row: any) => [row.id, row]));
  const first = byId.get('mock-restaurant-10') as any;
  assert.equal(first.deliveryInfo.supported, true);
  assert.equal(first.deliveryInfo.distanceMeters, 100);
  assert.equal(first.deliveryInfo.shippingFee, 10_000);
  const far = byId.get('mock-restaurant-09') as any;
  assert.equal(far.deliveryInfo.status, 'UNSUPPORTED');
  assert.equal(far.deliveryInfo.reason, 'OUT_OF_RANGE');
  assert.equal(far.deliveryInfo.shippingFee, null);

  const detail = await request('/restaurants/mock-restaurant-01');
  assert.equal(detail.status, 200);
  assert.equal(detail.data.deliveryInfo.distanceMeters, 1_200);
  assert.equal(detail.data.deliveryInfo.shippingFee, 10_000);
  assert.ok(detail.data.deliveryInfo.routeGeometry.coordinates.length >= 2);
  assert.equal(detail.data.items.length, 6);
  assert.ok(detail.data.items.some((row: any) => row.name === 'Phở bò tái'));

  const quote = await request('/restaurants/mock-restaurant-01/shipping-quote');
  assert.equal(quote.status, 200);
  assert.equal(quote.data.shippingFee, 10_000);

  const nearby = await request('/restaurants/nearby');
  assert.equal(nearby.status, 200);
  assert.deepEqual(
    nearby.data.map((row: any) => row.id),
    ids,
  );
  const callsBeforeCacheHit = routingCalls;
  await request('/restaurants/nearby');
  assert.equal(
    routingCalls,
    callsBeforeCacheHit,
    'repeated catalog loads must use the route cache',
  );
  assert.equal(geocodeCalls, 0, 'stored restaurant coordinates must not be re-geocoded');
});

test('one restaurant routing failure does not break the rest of the catalog', async () => {
  routeMode = 'partial-error';
  routing.clearRoutingCache();
  const list = await request('/restaurants');
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 10);
  const broken = list.data.find((row: any) => row.id === 'mock-restaurant-01') as any;
  assert.equal(broken.deliveryInfo.status, 'UNAVAILABLE');
  assert.equal(broken.deliveryInfo.reason, 'ROUTE_PROVIDER_ERROR');
  assert.equal(broken.deliveryInfo.shippingFee, null);
  const healthy = list.data.find((row: any) => row.id === 'mock-restaurant-10') as any;
  assert.equal(healthy.deliveryInfo.status, 'AVAILABLE');
  assert.equal(healthy.deliveryInfo.distanceMeters, 100);
  routeMode = 'ok';
  routing.clearRoutingCache();
});

test('checkout recomputes the fee, snapshots delivery data and preserves old orders', async () => {
  const before = await quote();
  assert.equal(before.status, 200, JSON.stringify(before.data));
  assert.equal(before.data.subtotal, 55_000);
  assert.equal(before.data.deliveryFee, 10_000);
  assert.equal(before.data.total, 65_000);
  assert.equal(before.data.deliveryInfo.supported, true);

  const firstKey = 'delivery-order-' + randomUUID();
  const first = await request('/checkout', 'POST', {
    items: [{ itemId: 'mock-item-001', quantity: 1, optionIds: [] }],
    // A client-supplied address is ignored while a saved address exists.
    address: 'Somewhere else entirely, District 1',
    // Nor is a client-supplied shipping fee trusted; this is not part of the
    // checkout contract and must not affect the authoritative total.
    shippingFee: 1,
    note: '',
    expectedTotal: 65_000,
    idempotencyKey: firstKey,
  });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.delivery_fee, 10_000);
  assert.equal(first.data.total, 65_000);
  assert.equal(first.data.payment?.amount, 65_000);
  assert.equal(first.data.walking_distance_meters, 1_200);
  assert.equal(first.data.delivery_latitude, 21.03);
  assert.equal(first.data.address, '18 Phố Hàng Bạc, Hoàn Kiếm, Hà Nội');

  const replay = await request('/checkout', 'POST', {
    items: [{ itemId: 'mock-item-001', quantity: 1, optionIds: [] }],
    address: 'Somewhere else entirely, District 1',
    note: '',
    expectedTotal: 65_000,
    idempotencyKey: firstKey,
  });
  assert.equal(replay.status, 201);
  assert.equal(replay.data.id, first.data.id);

  const changed = await saveAddress('50 Phố Huế, Hai Bà Trưng, Hà Nội', 21.05, 105.86);
  assert.equal(changed.status, 200);
  const afterAddress = await quote();
  assert.equal(afterAddress.data.deliveryFee, 19_000);
  assert.equal(afterAddress.data.total, 74_000);

  const second = await request('/checkout', 'POST', {
    items: [{ itemId: 'mock-item-001', quantity: 1, optionIds: [] }],
    expectedTotal: 74_000,
    idempotencyKey: 'delivery-order-' + randomUUID(),
  });
  assert.equal(second.status, 201, JSON.stringify(second.data));
  assert.equal(second.data.delivery_fee, 19_000);
  assert.equal(second.data.total, 74_000);
  assert.equal(second.data.payment?.amount, 74_000);
  assert.equal(second.data.walking_distance_meters, 5_000);

  const oldOrder = await request('/orders/' + first.data.id);
  assert.equal(oldOrder.status, 200);
  assert.equal(oldOrder.data.delivery_fee, 10_000);
  assert.equal(oldOrder.data.walking_distance_meters, 1_200);
  assert.equal(oldOrder.data.address, '18 Phố Hàng Bạc, Hoàn Kiếm, Hà Nội');
});

test('unsupported and unavailable routes fail checkout explicitly', async () => {
  const unsupported = await saveAddress('Xa xôi, ngoại thành Hà Nội', 20.9, 105.7);
  assert.equal(unsupported.status, 200);
  const unsupportedQuote = await quote();
  assert.equal(unsupportedQuote.status, 200);
  assert.equal(unsupportedQuote.data.deliveryInfo.status, 'UNSUPPORTED');
  assert.equal(unsupportedQuote.data.deliveryFee, 0);
  const blocked = await request('/checkout', 'POST', {
    items: [{ itemId: 'mock-item-001', quantity: 1, optionIds: [] }],
    expectedTotal: 55_000,
    idempotencyKey: 'delivery-order-' + randomUUID(),
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, 'DELIVERY_UNSUPPORTED');

  await saveAddress('18 Phố Hàng Bạc, Hoàn Kiếm, Hà Nội', 21.03, 105.85);
  routing.clearRoutingCache();
  routeMode = 'provider-error';
  const providerQuote = await quote();
  assert.equal(providerQuote.data.deliveryInfo.status, 'UNAVAILABLE');
  assert.equal(providerQuote.data.deliveryFee, 0);
  const providerBlocked = await request('/checkout', 'POST', {
    items: [{ itemId: 'mock-item-001', quantity: 1, optionIds: [] }],
    expectedTotal: 55_000,
    idempotencyKey: 'delivery-order-' + randomUUID(),
  });
  assert.equal(providerBlocked.status, 409);
  assert.equal(providerBlocked.data.code, 'DELIVERY_ROUTE_UNAVAILABLE');

  routeMode = 'no-route';
  routing.clearRoutingCache();
  const noRoute = await quote();
  assert.equal(noRoute.data.deliveryInfo.status, 'UNSUPPORTED');
  assert.equal(noRoute.data.deliveryInfo.reason, 'NO_WALKING_ROUTE');
  routeMode = 'ok';
  routing.clearRoutingCache();
});

test('routing service isolates invalid responses, timeouts, no-route and bad coordinates', async () => {
  const from = { latitude: 21.03, longitude: 105.85 };
  const to = { latitude: 21.04, longitude: 105.86 };

  routeMode = 'invalid';
  routing.clearRoutingCache();
  await assert.rejects(
    routing.walkingRoute(from, { latitude: 21.041, longitude: 105.861 }),
    (error: any) => error.code === 'INVALID_RESPONSE',
  );

  routeMode = 'no-route';
  routing.clearRoutingCache();
  await assert.rejects(
    routing.walkingRoute(from, { latitude: 21.042, longitude: 105.862 }),
    (error: any) => error.code === 'NO_ROUTE',
  );

  routeMode = 'provider-error';
  routing.clearRoutingCache();
  await assert.rejects(
    routing.walkingRoute(from, { latitude: 21.043, longitude: 105.863 }),
    (error: any) => error.code === 'PROVIDER_ERROR',
  );

  routeMode = 'timeout';
  process.env.ROUTING_TIMEOUT_MS = '1000';
  routing.clearRoutingCache();
  await assert.rejects(
    routing.walkingRoute(from, { latitude: 21.044, longitude: 105.864 }),
    (error: any) => error.code === 'TIMEOUT',
  );
  process.env.ROUTING_TIMEOUT_MS = '6000';

  routeMode = 'ok';
  routing.clearRoutingCache();
  await assert.rejects(
    routing.walkingRoute({ latitude: 999, longitude: 105.85 }, to),
    (error: any) => error.code === 'INVALID_COORDINATES',
  );
});

test('a customer without an address still sees the catalog and gets a clear checkout error', async () => {
  const registration = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Bep' },
    body: JSON.stringify({
      name: 'No Address',
      email: `no-address-${randomUUID()}@example.test`,
      password: 'LongPassword123',
    }),
  });
  assert.equal(registration.status, 201);
  const cookie = registration.headers.get('set-cookie')!.split(';')[0];
  const list = await request('/restaurants', 'GET', undefined, cookie);
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 10);
  assert.equal(list.data[0].deliveryInfo.status, 'NO_ADDRESS');
  const checkout = await request(
    '/checkout',
    'POST',
    {
      items: [{ itemId: 'mock-item-001', quantity: 1, optionIds: [] }],
      expectedTotal: 65_000,
      idempotencyKey: 'no-address-' + randomUUID(),
    },
    cookie,
  );
  assert.equal(checkout.status, 400);
  assert.equal(checkout.data.code, 'ADDRESS_REQUIRED');
});

test('default address service stores a single default and exposes it only to its owner', async () => {
  const saved = await saveAddress('18 Phố Hàng Bạc, Hoàn Kiếm, Hà Nội', 21.0301, 105.8527);
  assert.equal(saved.status, 200);
  const rows = await db.prisma.address.findMany({ where: { user_id: 'customer' } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].is_default, true);
  const internal = await addressService.defaultAddressFor('customer');
  assert(internal);
  assert.equal(internal.latitude, 21.0301);
  const anonymous = await request('/users/me/delivery-address', 'GET', undefined, '');
  assert.equal(anonymous.status, 401);
});

test('restaurant coordinate failures do not overwrite the original address', async () => {
  const original = MOCK_RESTAURANTS[0];
  await db.prisma.restaurant.update({
    where: { id: original.id },
    data: { latitude: null, longitude: null, address: original.address },
  });
  geocodeMode = 'not-found';
  const quote = await request('/restaurants/mock-restaurant-01/shipping-quote');
  assert.equal(quote.status, 200);
  assert.equal(quote.data.status, 'UNAVAILABLE');
  assert.equal(quote.data.reason, 'RESTAURANT_LOCATION_UNKNOWN');
  const row = await db.prisma.restaurant.findUnique({ where: { id: original.id } });
  assert.equal(row.address, original.address);
  assert.equal(row.latitude, null);
  geocodeMode = 'ok';
  await db.prisma.restaurant.update({
    where: { id: original.id },
    data: { latitude: original.latitude, longitude: original.longitude },
  });
});

test('changing a restaurant address invalidates old coordinates and resolves once', async () => {
  const repository = await import('../server/repositories/restaurant.repository.js');
  const original = MOCK_RESTAURANTS[1];
  const current = await repository.findById(original.id);
  assert(current);
  const newAddress = '99 Phố Mới, Hai Bà Trưng, Hà Nội';
  await repository.update(original.id, {
    name: current.name,
    description: current.description,
    address: newAddress,
    cuisine: current.cuisine,
    image: current.image,
  });
  const changed = await repository.findById(original.id);
  assert.equal(changed?.address, newAddress);
  assert.equal(changed?.latitude, null);
  assert.equal(changed?.longitude, null);
  assert.equal(changed?.geocoded_address, null);

  await saveAddress('18 Phố Hàng Bạc, Hoàn Kiếm, Hà Nội', 21.03, 105.85);
  routing.clearRoutingCache();
  geocodeCalls = 0;
  const quoted = await request('/restaurants/mock-restaurant-02/shipping-quote');
  assert.equal(quoted.status, 200, JSON.stringify(quoted.data));
  assert.equal(quoted.data.supported, true);
  assert.ok(geocodeCalls >= 1, 'a missing restaurant location should be geocoded once');
  const resolved = await repository.findById(original.id);
  assert.equal(resolved?.address, newAddress);
  assert.equal(resolved?.latitude, 21.0301);
  assert.equal(resolved?.longitude, 105.8527);

  await repository.update(original.id, {
    name: current.name,
    description: current.description,
    address: original.address,
    cuisine: current.cuisine,
    image: current.image,
  });
  await repository.setCoordinates(
    original.id,
    original.address,
    original.latitude,
    original.longitude,
  );
  const restored = await repository.findById(original.id);
  assert.equal(restored?.address, original.address);
  assert.equal(restored?.latitude, original.latitude);
});
