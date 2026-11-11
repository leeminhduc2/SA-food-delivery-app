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
  setRoutingProvider,
  type RoutingProvider,
} from '../server/modules/location/infrastructure/routing.client.js';

/**
 * End-to-end catalog management semantics: partial restaurant updates,
 * accepting-orders and public visibility, item visibility/archive, soft
 * archive, ownership, and audit records. No rows are deleted.
 */
const schema = 'test_crud_' + randomUUID().replaceAll('-', '');
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
process.env.DEMO_PASSWORD = 'CrudTest123!';
process.env.PAYMENT_MODE = 'simulated';
process.env.PAYMENT_WEBHOOK_SECRET = 'catalog-crud-test-webhook-secret-32';
process.env.LOG_REQUESTS = 'false';
process.env.GEOCODING_MIN_INTERVAL_MS = '0';

const fakeGeocoding: GeocodingProvider = {
  name: 'crud-fake-geocoder',
  async search(query) {
    return {
      address: query,
      formattedAddress: query + ', Hà Nội, Việt Nam',
      latitude: 21.03,
      longitude: 105.85,
      provider: 'crud-fake-geocoder',
    };
  },
  async reverse(latitude, longitude) {
    return {
      address: `${latitude}, ${longitude}`,
      formattedAddress: `Saved address (${latitude.toFixed(4)}, ${longitude.toFixed(4)})`,
      latitude,
      longitude,
      provider: 'crud-fake-geocoder',
    };
  },
};
const fakeRouting: RoutingProvider = {
  name: 'crud-fake-router',
  async walkingRoute(from, to) {
    return {
      distanceMeters: 1_200,
      durationSeconds: 1_000,
      routeGeometry: {
        type: 'LineString',
        coordinates: [
          [from.longitude, from.latitude],
          [to.longitude, to.latitude],
        ],
      },
      provider: 'crud-fake-router',
    };
  },
};
setGeocodingProvider(fakeGeocoding);
setRoutingProvider(fakeRouting);

const restaurantId = 'mock-restaurant-01';
const itemLines = [{ itemId: 'mock-item-001', quantity: 1, optionIds: [] }];
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
    headers: response.headers,
    data: text ? JSON.parse(text) : undefined,
  };
}

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  db = await import('../server/shared/db.js');
  const { migrate } = await import('../server/migrate.js');
  await migrate();
  const { seed } = await import('../server/seed/seed.js');
  await seed();
  const { seedMockCatalog } = await import('../server/seed/seed-mock.js');
  await seedMockCatalog();
  const { createApp } = await import('../server/app.js');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  for (const actor of ['customer', 'restaurant', 'restaurant2', 'admin']) {
    const login = await request('/auth/login', 'POST', {
      email: actor + '@bep.local',
      password: process.env.DEMO_PASSWORD,
    });
    assert.equal(login.status, 200, JSON.stringify(login.data));
    cookies[actor] = login.headers.get('set-cookie')!.split(';')[0];
  }
  const saved = await request(
    '/users/me/delivery-address',
    'PUT',
    { address: '18 Phố Hàng Bạc, Hoàn Kiếm, Hà Nội', latitude: 21.03, longitude: 105.85 },
    'customer',
  );
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
});

after(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  if (db) await db.prisma.$disconnect();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

test('pausing orders keeps the kitchen public but blocks quote and checkout', async () => {
  const paused = await request(
    '/restaurants/' + restaurantId,
    'PATCH',
    { accepting_orders: false },
    'restaurant',
  );
  assert.equal(paused.status, 200, JSON.stringify(paused.data));
  assert.equal(paused.data.accepting_orders, false);
  assert.equal(paused.data.name, 'Bếp Phố Hà Thành', 'partial update must keep other fields');

  const list = await request('/restaurants');
  assert.equal(list.status, 200);
  const row = list.data.find((candidate: any) => candidate.id === restaurantId);
  assert.ok(row, 'paused kitchens remain visible');
  assert.equal(row.accepting_orders, false);

  const preview = await request('/checkout/quote', 'POST', { items: itemLines });
  assert.equal(preview.status, 409);
  assert.equal(preview.data.code, 'UNAVAILABLE');
  const checkout = await request('/checkout', 'POST', {
    items: itemLines,
    expectedTotal: 65_000,
    idempotencyKey: 'paused-' + randomUUID(),
  });
  assert.equal(checkout.status, 409);
  assert.equal(checkout.data.code, 'UNAVAILABLE');

  const resumed = await request(
    '/restaurants/' + restaurantId,
    'PATCH',
    { accepting_orders: true },
    'restaurant',
  );
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.accepting_orders, true);
  const after = await request('/checkout/quote', 'POST', { items: itemLines });
  assert.equal(after.status, 200);
});

test('hiding a kitchen removes it from public discovery but not from its manager', async () => {
  const hidden = await request(
    '/restaurants/' + restaurantId,
    'PATCH',
    { catalog_visible: false },
    'restaurant',
  );
  assert.equal(hidden.status, 200, JSON.stringify(hidden.data));
  assert.equal(hidden.data.catalog_visible, false);

  const publicList = await request('/restaurants');
  assert.equal(
    publicList.data.some((candidate: any) => candidate.id === restaurantId),
    false,
  );
  const publicDetail = await request('/restaurants/' + restaurantId);
  assert.equal(publicDetail.status, 404);
  assert.equal(publicDetail.data.code, 'NOT_FOUND');

  const ownerDetail = await request('/restaurants/' + restaurantId, 'GET', undefined, 'restaurant');
  assert.equal(ownerDetail.status, 200);
  assert.equal(ownerDetail.data.catalog_visible, false);
  const adminDetail = await request('/restaurants/' + restaurantId, 'GET', undefined, 'admin');
  assert.equal(adminDetail.status, 200);

  const restored = await request(
    '/restaurants/' + restaurantId,
    'PATCH',
    { catalog_visible: true },
    'restaurant',
  );
  assert.equal(restored.status, 200);
  assert.equal((await request('/restaurants/' + restaurantId)).status, 200);
});

test('item visibility, partial updates, categories and archive behave publicly and for managers', async () => {
  const created = await request(
    '/restaurants/' + restaurantId + '/items',
    'POST',
    {
      name: 'Chef special noodles',
      description: 'A test-only dish',
      price: 42_000,
      stock: 4,
      available: true,
      category: 'Chef specials',
      options: [],
    },
    'restaurant',
  );
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const itemId = created.data.id;
  assert.equal(created.data.visible, true, 'new dishes are visible by default');

  const publicItem = await request('/items/' + itemId);
  assert.equal(publicItem.status, 200);
  assert.equal(publicItem.data.category, 'Chef specials');
  const publicMenu = await request('/restaurants/' + restaurantId + '/items');
  assert.ok(publicMenu.data.some((candidate: any) => candidate.id === itemId));

  const repriced = await request('/items/' + itemId, 'PATCH', { price: 43_000 }, 'restaurant');
  assert.equal(repriced.status, 200, JSON.stringify(repriced.data));
  assert.equal(repriced.data.price, 43_000);
  assert.equal(repriced.data.name, 'Chef special noodles');
  assert.equal(repriced.data.available, true);
  assert.equal(repriced.data.visible, true);

  const hiddenItem = await request('/items/' + itemId, 'PATCH', { visible: false }, 'restaurant');
  assert.equal(hiddenItem.status, 200);
  assert.equal(hiddenItem.data.visible, false);
  assert.equal((await request('/items/' + itemId)).status, 404);
  const menuAfterHide = await request('/restaurants/' + restaurantId + '/items');
  assert.equal(
    menuAfterHide.data.some((candidate: any) => candidate.id === itemId),
    false,
  );
  const ownerItem = await request('/items/' + itemId, 'GET', undefined, 'restaurant');
  assert.equal(ownerItem.status, 200);
  assert.equal(ownerItem.data.visible, false);
  const blocked = await request('/checkout/quote', 'POST', {
    items: [{ itemId, quantity: 1, optionIds: [] }],
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, 'UNAVAILABLE');

  const visibleAgain = await request('/items/' + itemId, 'PATCH', { visible: true }, 'restaurant');
  assert.equal(visibleAgain.status, 200);

  const recategorised = await request(
    '/items/' + itemId,
    'PATCH',
    { category: 'Late night' },
    'restaurant',
  );
  assert.equal(recategorised.status, 200);
  assert.equal(recategorised.data.category, 'Late night');
  const menuRow = await db.prisma.menu.findUnique({
    where: { restaurant_id_name: { restaurant_id: restaurantId, name: 'Late night' } },
  });
  assert.ok(menuRow, 'the category must be created for the same restaurant');
  assert.equal(recategorised.data.menu_id, menuRow.id);

  assert.equal(
    (await request('/items/' + itemId, 'PATCH', { price: 45_000 }, 'restaurant2')).status,
    403,
  );
  assert.equal((await request('/items/' + itemId, 'DELETE', undefined, 'restaurant2')).status, 403);

  const archived = await request('/items/' + itemId, 'DELETE', undefined, 'restaurant');
  assert.equal(archived.status, 200);
  const archivedRow = await db.prisma.menuItem.findUnique({ where: { id: itemId } });
  assert.ok(archivedRow, 'archive must keep the row');
  assert.equal(archivedRow.visible, false);
  assert.equal(archivedRow.available, false);
  assert.equal((await request('/items/' + itemId)).status, 404);
  const ownerArchived = await request('/items/' + itemId, 'GET', undefined, 'restaurant');
  assert.equal(ownerArchived.status, 200);
});

test('ownership, admin creation and soft restaurant archive are enforced and audited', async () => {
  assert.equal(
    (
      await request(
        '/restaurants/' + restaurantId,
        'PATCH',
        { description: 'cross-tenant write' },
        'restaurant2',
      )
    ).status,
    403,
  );
  assert.equal(
    (await request('/restaurants/' + restaurantId, 'DELETE', undefined, 'restaurant2')).status,
    403,
  );

  const created = await request(
    '/restaurants',
    'POST',
    {
      name: 'Admin Kitchen',
      description: 'Created by an administrator',
      address: '20 Test Street, District 2',
      cuisine: 'Vietnamese',
    },
    'admin',
  );
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const newId = created.data.id;
  const membership = await db.prisma.restaurantMember.count({
    where: { restaurant_id: newId },
  });
  assert.equal(membership, 0, 'admin-created kitchens must not gain an admin owner');

  const approved = await request(
    '/admin/restaurants/' + newId + '/approval',
    'POST',
    { status: 'APPROVED' },
    'admin',
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal((await request('/restaurants/' + newId)).status, 200);

  const archived = await request('/restaurants/' + newId, 'DELETE', undefined, 'admin');
  assert.equal(archived.status, 200);
  const row = await db.prisma.restaurant.findUnique({ where: { id: newId } });
  assert.ok(row, 'restaurant archive must keep the row');
  assert.equal(row.catalog_visible, false);
  assert.equal(row.accepting_orders, false);
  assert.equal((await request('/restaurants/' + newId)).status, 404);

  const auditActions = await db.prisma.auditLog.findMany({
    where: {
      action: {
        in: [
          'RESTAURANT_UPDATED',
          'ITEM_CREATED',
          'ITEM_UPDATED',
          'ITEM_ARCHIVED',
          'RESTAURANT_ARCHIVED',
        ],
      },
    },
    select: { action: true },
  });
  const actions = new Set(auditActions.map((entry: any) => entry.action));
  for (const expected of [
    'RESTAURANT_UPDATED',
    'ITEM_CREATED',
    'ITEM_UPDATED',
    'ITEM_ARCHIVED',
    'RESTAURANT_ARCHIVED',
  ])
    assert.ok(actions.has(expected), `missing audit action ${expected}`);
});

test('archiving a kitchen keeps existing orders and their snapshot', async () => {
  const preview = await request('/checkout/quote', 'POST', { items: itemLines });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  const checkout = await request('/checkout', 'POST', {
    items: itemLines,
    expectedTotal: preview.data.total,
    idempotencyKey: 'archive-order-' + randomUUID(),
  });
  assert.equal(checkout.status, 201, JSON.stringify(checkout.data));

  const archived = await request('/restaurants/' + restaurantId, 'DELETE', undefined, 'restaurant');
  assert.equal(archived.status, 200);
  const row = await db.prisma.restaurant.findUnique({ where: { id: restaurantId } });
  assert.ok(row, 'the restaurant row must survive archive');
  assert.equal(row.catalog_visible, false);
  assert.equal(row.accepting_orders, false);
  assert.equal((await request('/restaurants/' + restaurantId)).status, 404);

  const order = await request('/orders/' + checkout.data.id);
  assert.equal(order.status, 200);
  assert.equal(order.data.restaurant_id, restaurantId);
  assert.equal(order.data.delivery_fee, 10_000);
  assert.equal(order.data.walking_distance_meters, 1_200);
  assert.equal(await db.prisma.deliveryQuote.count({ where: { restaurant_id: restaurantId } }), 0);
});
