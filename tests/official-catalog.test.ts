import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { MOCK_ITEM_IDS, MOCK_RESTAURANTS } from '../server/seed/data/mock-catalog.js';

/**
 * Official catalog initialization must work without `DEMO_MODE` and must write
 * the same ten restaurants and sixty dishes as system-managed business data.
 */
const schema = 'test_official_' + randomUUID().replaceAll('-', '');
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
process.env.DEMO_MODE = 'false';

let db: any;
let seedCatalog: typeof import('../server/seed/seed-catalog.js').seedCatalog;

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  db = await import('../server/shared/db.js');
  const { migrate } = await import('../server/migrate.js');
  await migrate();
  ({ seedCatalog } = await import('../server/seed/seed-catalog.js'));
  await seedCatalog();
});

after(async () => {
  if (db) await db.prisma.$disconnect();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

test('initialization creates the official catalog without DEMO_MODE', async () => {
  assert.equal(process.env.DEMO_MODE, 'false');
  assert.equal(await db.prisma.user.count(), 0, 'official provisioning creates no demo users');
  assert.equal(
    await db.prisma.restaurantMember.count(),
    0,
    'official provisioning assigns no restaurant owner',
  );

  const restaurants = await db.prisma.restaurant.findMany({ orderBy: { id: 'asc' } });
  assert.equal(restaurants.length, 10);
  assert.deepEqual(
    restaurants.map((row: any) => row.id),
    MOCK_RESTAURANTS.map((restaurant) => restaurant.id),
  );
  for (const row of restaurants) {
    assert.equal(row.mock, false);
    assert.equal(row.source, 'CATALOG');
    assert.equal(row.status, 'APPROVED');
    assert.equal(row.verified, false, 'seeding is not human verification');
    assert.equal(row.owner_managed, false, 'seeding does not assign an owner');
    assert.equal(row.catalog_visible, true);
    assert.equal(row.accepting_orders, true);
    const tags = row.osm_tags as Record<string, unknown>;
    assert.equal('mock' in tags, false);
    assert.equal('demo' in tags, false);
    assert.equal(tags.catalog, true);
  }

  const items = await db.prisma.menuItem.findMany();
  assert.equal(items.length, 60);
  assert.deepEqual(items.map((item: any) => item.id).sort(), [...MOCK_ITEM_IDS].sort());
  for (const item of items) assert.equal(item.mock, false);
  assert.equal(await db.prisma.menu.count(), 20);

  const marker = await db.prisma.seedRun.findUnique({ where: { name: 'official-catalog' } });
  assert.ok(marker);
  assert.equal(marker.version, 1);
});

test('the public runtime reads the official catalog from PostgreSQL', async () => {
  const catalog = await import('../server/modules/catalog/application/catalog.service.js');
  const listed = await catalog.listRestaurants({ q: '', cuisine: '', sort: 'recommended' });
  assert.equal(listed.length, 10);
  for (const row of listed) {
    assert.equal(row.mock, false);
    assert.equal(row.source, 'CATALOG');
  }
});

test('re-running initialization is idempotent and preserves operator edits', async () => {
  await db.prisma.restaurant.update({
    where: { id: 'mock-restaurant-02' },
    data: { name: 'Góc Bún Chả (operator edit)' },
  });
  await db.prisma.menuItem.update({
    where: { id: 'mock-item-007' },
    data: { price: 52_000, available: false },
  });

  const second = await seedCatalog();
  assert.equal(second.initialized, false);
  assert.equal(second.itemsCreated, 0);
  assert.equal(await db.prisma.restaurant.count(), 10);
  assert.equal(await db.prisma.menuItem.count(), 60);
  assert.equal(await db.prisma.menu.count(), 20);

  const restaurant = await db.prisma.restaurant.findUnique({
    where: { id: 'mock-restaurant-02' },
  });
  assert.equal(restaurant.name, 'Góc Bún Chả (operator edit)');
  assert.equal(restaurant.mock, false);
  const item = await db.prisma.menuItem.findUnique({ where: { id: 'mock-item-007' } });
  assert.equal(item.price, 52_000);
  assert.equal(item.available, false);
  assert.equal(item.mock, false);
});
