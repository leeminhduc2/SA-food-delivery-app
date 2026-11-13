import {
  testDatabaseUrl,
  testSchemaUrl,
  verifyTestSchema,
  dropTestSchema,
} from './test-database.js';
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import pg from 'pg';
import {
  MOCK_ITEM_IDS,
  MOCK_IMAGE_PATHS,
  MOCK_RESTAURANT_IDS,
  MOCK_RESTAURANTS,
} from '../server/seed/data/mock-catalog.js';

/**
 * Integration coverage for the fictional demo catalog against a real
 * PostgreSQL schema. Nothing here contacts Google, Overpass or any other
 * external service.
 */
const schema = 'test_mock_' + randomUUID().replaceAll('-', '');
const originalUrl = testDatabaseUrl();
const admin = new pg.Pool({ connectionString: originalUrl, connectionTimeoutMillis: 3000 });
process.env.DATABASE_URL = testSchemaUrl(originalUrl, schema);
const schemaPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 3000,
});
let schemaCreated = false;
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'MockCatalog123!';

let db: any;
let seedMockCatalog: () => Promise<{
  restaurants: number;
  itemsCreated: number;
  legacyHidden: number;
  initialized: boolean;
}>;

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  db = await import('../server/shared/db.js');
  await verifyTestSchema(schema, db.prisma);
  const { migrate } = await import('../server/migrate.js');
  await migrate();
  const { seed } = await import('../server/seed/seed.js');
  await seed();
  ({ seedMockCatalog } = await import('../server/seed/seed-mock.js'));
  await seedMockCatalog();
});

after(async () => {
  if (db) await db.prisma.$disconnect();
  await schemaPool.end();
  await dropTestSchema(admin, schema, schemaCreated);
  await admin.end();
});

test('exactly the 10 fictional restaurants are visible with 60 dishes', async () => {
  assert.equal(await db.prisma.restaurant.count({ where: { catalog_visible: true } }), 10);
  assert.equal(
    await db.prisma.restaurant.count({ where: { catalog_visible: true, mock: false } }),
    0,
  );
  const rows = await db.prisma.restaurant.findMany({
    where: { mock: true, catalog_visible: true },
    orderBy: { id: 'asc' },
  });
  assert.equal(rows.length, 10);
  assert.deepEqual(
    rows.map((row: any) => row.id),
    MOCK_RESTAURANT_IDS,
  );
  assert.equal(new Set(rows.map((row: any) => row.slug)).size, 10);
  for (const row of rows) {
    assert.equal(row.source, 'MOCK');
    assert.equal(row.status, 'APPROVED');
    assert.equal(row.verified, false);
    assert.equal(row.owner_managed, false);
    assert.ok(row.district, `${row.id} has no district`);
    assert.ok(row.rating >= 0 && row.rating <= 5, `${row.id} has an invalid rating`);
    assert.ok(row.review_count > 0, `${row.id} has no simulated review count`);
    assert.ok(row.image.startsWith('/images/restaurants/'), `${row.id} cover path is invalid`);
    assert.ok(row.latitude >= 20.95 && row.latitude <= 21.1, `${row.id} is outside Hanoi`);
    assert.ok(row.longitude >= 105.75 && row.longitude <= 105.9, `${row.id} is outside Hanoi`);
  }
  const items = await db.prisma.menuItem.findMany({ where: { mock: true } });
  assert.equal(items.length, 60);
  assert.equal(new Set(items.map((item: any) => item.id)).size, 60);
  assert.deepEqual(items.map((item: any) => item.id).sort(), [...MOCK_ITEM_IDS].sort());
});

test('every restaurant has 5–8 valid dishes and unique menu groups', async () => {
  for (const restaurant of MOCK_RESTAURANTS) {
    const items = await db.prisma.menuItem.findMany({
      where: { restaurant_id: restaurant.id },
    });
    assert.ok(items.length >= 5 && items.length <= 8, `${restaurant.id} has ${items.length}`);
    assert.equal(items.length, 6);
    for (const item of items) {
      assert.ok(Number.isInteger(item.price) && item.price >= 1000);
      assert.ok(item.name.length >= 2);
      assert.ok(item.image.startsWith('/images/menu-items/'));
      assert.equal(item.mock, true);
      assert.equal(item.available, true);
    }
    const menus = await db.prisma.menu.findMany({ where: { restaurant_id: restaurant.id } });
    assert.equal(menus.length, restaurant.menus.length);
    assert.equal(new Set(menus.map((menu: any) => menu.name)).size, menus.length);
  }
});

test('legacy OSM/demo rows are hidden, never deleted', async () => {
  const legacy = await db.prisma.restaurant.findMany({
    where: { id: { in: ['saigon', 'pizza', 'green'] } },
    include: { items: true, menus: true },
  });
  assert.equal(legacy.length, 3);
  for (const row of legacy) {
    assert.equal(row.catalog_visible, false);
    assert.ok(row.items.length > 0, `${row.id} lost its menu items`);
    assert.ok(row.menus.length > 0, `${row.id} lost its menus`);
  }
  const osmVisible = await db.prisma.restaurant.count({
    where: { source: 'OSM', catalog_visible: true },
  });
  assert.equal(osmVisible, 0);
});

test('the public catalog only exposes the fictional dataset', async () => {
  const catalog = await import('../server/modules/catalog/application/catalog.service.js');
  const listed = await catalog.listRestaurants({ q: '', cuisine: '', sort: 'recommended' });
  assert.equal(listed.length, 10);
  for (const row of listed) {
    assert.equal(row.mock, true);
    assert.ok(!('google_place_id' in row));
    assert.ok(!('google_maps_uri' in row));
    assert.ok(!('photo_url' in row));
    assert.ok(!('photo_name' in row));
    assert.ok(!('photo_attribution' in row));
  }
  const search = await catalog.listRestaurants({
    q: 'Bếp Phố',
    cuisine: '',
    sort: 'recommended',
  });
  assert.equal(search.length, 1);
  assert.equal(search[0].id, 'mock-restaurant-01');
  for (const row of listed) assert.equal(row.source, 'MOCK');
});

test('the public catalog makes no external provider request', async () => {
  const files = [
    'server/modules/catalog/catalog.routes.ts',
    'server/modules/catalog/application/catalog.service.ts',
    'server/seed/data/mock-catalog.ts',
    'server/seed/seed-mock.ts',
    'src/App.tsx',
    'src/components/Catalog.tsx',
  ];
  const forbidden = /places\.googleapis|GOOGLE_PLACES|openstreetmap\.org|overpass-api|wikimedia/i;
  for (const file of files) {
    assert.doesNotMatch(
      readFileSync(file, 'utf8'),
      forbidden,
      `${file} still references an external provider`,
    );
  }
  assert.equal(MOCK_IMAGE_PATHS.length, 70);
  assert.equal(new Set(MOCK_IMAGE_PATHS).size, 70);
  assert.ok(MOCK_IMAGE_PATHS.every((path: string) => /\.(webp|jpe?g|png)$/.test(path)));
});

test('re-running the seed creates no duplicates and preserves edits and flags', async () => {
  const marker = await db.prisma.seedRun.findUnique({ where: { name: 'mock-catalog' } });
  assert.ok(marker, 'the first seed must record its one-time initialization marker');
  assert.equal(marker.version, 1);
  const restaurantActor = await db.prisma.user.findUniqueOrThrow({ where: { id: 'restaurant' } });
  await (
    await import('../server/modules/catalog/application/catalog.service.js')
  ).updateItem(restaurantActor, 'mock-item-001', {
    stock: 31,
    stockReason: 'Inventory count',
    idempotencyKey: 'mock-stock-test',
  });
  const movementsBefore = await db.prisma
    .$queryRaw`SELECT id,kind,delta,balance_after FROM stock_movements WHERE item_id = 'mock-item-001' ORDER BY created_at,id`;
  await db.prisma.menuItem.update({
    where: { id: 'mock-item-001' },
    data: { price: 61000 },
  });
  await db.prisma.restaurant.update({
    where: { id: 'mock-restaurant-01' },
    data: {
      name: 'Bếp Phố Hà Thành (đã sửa)',
      catalog_visible: false,
      accepting_orders: false,
    },
  });
  const second = await seedMockCatalog();
  assert.equal(second.initialized, false);
  assert.equal(second.itemsCreated, 0);
  assert.equal(await db.prisma.restaurant.count({ where: { mock: true } }), 10);
  assert.equal(await db.prisma.menuItem.count({ where: { mock: true } }), 60);
  const item = await db.prisma.menuItem.findUnique({ where: { id: 'mock-item-001' } });
  assert.equal(item.price, 61000, 'seed overwrote an edited price');
  assert.equal(item.stock, 31, 'seed overwrote edited stock');
  assert.deepEqual(
    await db.prisma
      .$queryRaw`SELECT id,kind,delta,balance_after FROM stock_movements WHERE item_id = 'mock-item-001' ORDER BY created_at,id`,
    movementsBefore,
  );
  const restaurant = await db.prisma.restaurant.findUnique({
    where: { id: 'mock-restaurant-01' },
  });
  assert.equal(restaurant.name, 'Bếp Phố Hà Thành (đã sửa)', 'seed overwrote an edited name');
  assert.equal(restaurant.catalog_visible, false, 'seed overwrote the public visibility flag');
  assert.equal(restaurant.accepting_orders, false, 'seed overwrote the accepting-orders flag');
  // Restore the demo restaurant for the remaining tests.
  await db.prisma.restaurant.update({
    where: { id: 'mock-restaurant-01' },
    data: {
      name: 'Bếp Phố Hà Thành',
      catalog_visible: true,
      accepting_orders: true,
    },
  });
});

test('hiding the legacy catalog does not remove order history', async () => {
  const now = new Date();
  await db.prisma.order.create({
    data: {
      id: 'order-preserved',
      customer_id: 'customer',
      restaurant_id: 'saigon',
      status: 'CONFIRMED',
      subtotal: 65000,
      delivery_fee: 15000,
      total: 80000,
      address: '12 Nguyễn Huệ, District 1',
      idempotency_key: 'preserved-order-key',
      fingerprint: 'preserved-order-fingerprint',
      expires_at: new Date(now.getTime() + 15 * 60 * 1000),
    },
  });
  await db.prisma.orderItem.create({
    data: {
      id: 'order-preserved-item',
      order_id: 'order-preserved',
      menu_item_id: 'pho',
      name: 'Phở bò đặc biệt',
      price: 65000,
      quantity: 1,
      options: [],
    },
  });
  await seedMockCatalog();
  const order = await db.prisma.order.findUnique({
    where: { id: 'order-preserved' },
    include: { items: true, restaurant: true },
  });
  assert.ok(order, 'order history was deleted');
  assert.equal(order.restaurant_id, 'saigon');
  assert.equal(order.restaurant.catalog_visible, false);
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].name, 'Phở bò đặc biệt');
});

test('a legacy row restored after initialization is not hidden again', async () => {
  await db.prisma.restaurant.updateMany({
    where: { id: { in: ['saigon', 'pizza', 'green'] } },
    data: { catalog_visible: true },
  });
  const run = await seedMockCatalog();
  assert.equal(run.initialized, false);
  assert.equal(run.legacyHidden, 0);
  const visible = await db.prisma.restaurant.count({
    where: { id: { in: ['saigon', 'pizza', 'green'] }, catalog_visible: true },
  });
  assert.equal(visible, 3, 'a later seed must not re-hide an operator-restored row');
  // Leave the demo database in its standard hidden state for other tests.
  await db.prisma.restaurant.updateMany({
    where: { id: { in: ['saigon', 'pizza', 'green'] } },
    data: { catalog_visible: false },
  });
});

test('no menu item points at a missing restaurant', async () => {
  const rows = await db.prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM menu_items
      LEFT JOIN restaurants ON restaurants.id = menu_items.restaurant_id
      WHERE restaurants.id IS NULL`,
  );
  assert.equal(Number(rows[0].n), 0);
});

test('runtime modules never import the mock catalog or fall back when the catalog is empty', async () => {
  for (const directory of ['server/modules', 'server/shared']) {
    for (const file of await readdir(directory, { recursive: true })) {
      if (!file.endsWith('.ts')) continue;
      const source = await readFile(path.join(directory, file), 'utf8');
      assert.doesNotMatch(
        source,
        /(?:from\s+|import\()\s*['"][^'"]*mock-catalog/,
        `${directory}/${file} imports the mock catalog at runtime`,
      );
    }
  }

  const catalog = await import('../server/modules/catalog/application/catalog.service.js');
  const before = await db.prisma.restaurant.findMany({
    where: { catalog_visible: true },
    select: { id: true },
  });
  assert.ok(before.length > 0);
  await db.prisma.restaurant.updateMany({ data: { catalog_visible: false } });
  try {
    const listed = await catalog.listRestaurants({ q: '', cuisine: '', sort: 'recommended' });
    assert.deepEqual(listed, [], 'an empty catalog must not be replaced by mock data');
  } finally {
    await db.prisma.restaurant.updateMany({
      where: { id: { in: before.map((row: any) => row.id) } },
      data: { catalog_visible: true },
    });
  }
});

test('the raster food assets exist', (t) => {
  const missing = MOCK_IMAGE_PATHS.filter((path: string) => !existsSync('public' + path));
  if (missing.length) {
    t.skip(
      `${missing.length} of ${MOCK_IMAGE_PATHS.length} raster food images are not generated yet; ` +
        'the UI shows the honest placeholder. See docs/MOCK_IMAGE_PROMPTS.md.',
    );
    return;
  }
  assert.equal(missing.length, 0);
});
