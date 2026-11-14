import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { MOCK_RESTAURANTS } from '../server/seed/data/mock-catalog.js';

/**
 * Promotion coverage against a real PostgreSQL schema.
 *
 * The fixture first creates the legacy MOCK catalog exactly as an existing
 * deployment has it, then promotes it in place and verifies that every
 * business field and relationship survives.
 */
const schema = 'test_promote_' + randomUUID().replaceAll('-', '');
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
process.env.DEMO_PASSWORD = 'PromotionTest123!';

let db: any;
let promoteCatalog: typeof import('../server/seed/promote-catalog.js').promoteCatalog;

const expectedMenus = MOCK_RESTAURANTS.flatMap((restaurant) =>
  restaurant.menus.map((menu) => ({
    id: `${restaurant.id}-${menu.key}`,
    restaurant_id: restaurant.id,
  })),
);
const expectedItems = MOCK_RESTAURANTS.flatMap((restaurant) =>
  restaurant.menus.flatMap((menu) =>
    menu.items.map((item) => ({
      id: item.id,
      restaurant_id: restaurant.id,
      menu_id: `${restaurant.id}-${menu.key}`,
    })),
  ),
);

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  db = await import('../server/shared/db.js');
  const { migrate } = await import('../server/migrate.js');
  await migrate();
  const { seed } = await import('../server/seed/seed.js');
  await seed();
  const { seedMockCatalog } = await import('../server/seed/seed-mock.js');
  await seedMockCatalog();
  ({ promoteCatalog } = await import('../server/seed/promote-catalog.js'));
});

after(async () => {
  if (db) await db.prisma.$disconnect();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

test('the fixture starts as 10 MOCK restaurants with 60 MOCK dishes', async () => {
  assert.equal(await db.prisma.restaurant.count({ where: { mock: true } }), 10);
  assert.equal(await db.prisma.menuItem.count({ where: { mock: true } }), 60);
});

test('promotion preserves IDs, business fields and relationships while removing MOCK metadata', async () => {
  // A MOCK row outside the managed catalog must not be promoted.
  await db.prisma.restaurant.create({
    data: {
      id: 'unrelated-mock-restaurant',
      name: 'Unrelated Mock Kitchen',
      description: 'Not part of the managed catalog.',
      address: '1 Nowhere Street, Hà Nội',
      cuisine: 'Vietnamese',
      status: 'APPROVED',
      source: 'MOCK',
      mock: true,
    },
  });

  // Simulate operator edits that must survive promotion.
  await db.prisma.restaurant.update({
    where: { id: 'mock-restaurant-01' },
    data: {
      name: 'Bếp Phố Hà Thành (admin edit)',
      description: 'An administrator edited this description.',
      address: '18 Phố Hàng Bạc, Hoàn Kiếm, Hà Nội (edited)',
      accepting_orders: false,
      catalog_visible: true,
      verified: false,
      owner_managed: false,
    },
  });
  await db.prisma.menuItem.update({
    where: { id: 'mock-item-001' },
    data: { price: 61_000, visible: false, available: true },
  });

  const report = await promoteCatalog();

  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.promoted.restaurants, 10);
  assert.equal(report.promoted.menuItems, 60);
  assert.equal(report.after.restaurants, report.before.restaurants);
  assert.equal(report.after.menuItems, report.before.menuItems);
  assert.equal(report.after.mockRestaurants, 0);
  assert.equal(report.after.mockMenuItems, 0);
  assert.equal(report.after.catalogRestaurants, 10);
  assert.equal(report.after.catalogMenuItems, 60);
  assert.equal(report.missing.restaurants.length, 0);
  assert.equal(report.missing.menuItems.length, 0);
  assert.equal(report.missing.menus.length, 0);
  assert.deepEqual(report.relationshipMismatches, []);

  // Exactly ten restaurants and sixty items remain.
  assert.equal(
    await db.prisma.restaurant.count({
      where: { id: { in: MOCK_RESTAURANTS.map((restaurant) => restaurant.id) } },
    }),
    10,
  );
  assert.equal(
    await db.prisma.menuItem.count({ where: { id: { in: expectedItems.map((item) => item.id) } } }),
    60,
  );

  // MOCK metadata is gone from every promoted row.
  const restaurants = await db.prisma.restaurant.findMany({
    where: { id: { in: MOCK_RESTAURANTS.map((restaurant) => restaurant.id) } },
  });
  for (const row of restaurants) {
    assert.equal(row.mock, false, `${row.id} is still MOCK`);
    assert.equal(row.source, 'CATALOG', `${row.id} has the wrong source`);
    assert.equal(row.status, 'APPROVED');
    assert.equal(row.verified, false, 'promotion must not claim human verification');
    assert.equal(row.owner_managed, false, 'promotion must not assign an owner');
    const tags = row.osm_tags as Record<string, unknown>;
    assert.equal('mock' in tags, false, `${row.id} still has mock tags`);
    assert.equal('demo' in tags, false, `${row.id} still has demo tags`);
    assert.equal(tags.catalog, true, `${row.id} is not marked as a catalog record`);
  }
  const items = await db.prisma.menuItem.findMany({
    where: { id: { in: expectedItems.map((item) => item.id) } },
  });
  assert.equal(items.length, 60);
  for (const item of items) assert.equal(item.mock, false, `${item.id} is still MOCK`);

  // The operator edits and untouched business data are intact.
  const editedRestaurant = await db.prisma.restaurant.findUnique({
    where: { id: 'mock-restaurant-01' },
  });
  assert.equal(editedRestaurant.name, 'Bếp Phố Hà Thành (admin edit)');
  assert.equal(editedRestaurant.description, 'An administrator edited this description.');
  assert.equal(editedRestaurant.address, '18 Phố Hàng Bạc, Hoàn Kiếm, Hà Nội (edited)');
  assert.equal(editedRestaurant.accepting_orders, false);
  const editedItem = await db.prisma.menuItem.findUnique({ where: { id: 'mock-item-001' } });
  assert.equal(editedItem.price, 61_000);
  assert.equal(editedItem.visible, false);
  assert.equal(editedItem.available, true);

  // Relationships are unchanged.
  const storedItems = await db.prisma.menuItem.findMany({
    where: { id: { in: expectedItems.map((item) => item.id) } },
    select: { id: true, restaurant_id: true, menu_id: true },
  });
  const storedById = new Map(storedItems.map((item: any) => [item.id, item]));
  for (const expected of expectedItems) {
    const stored = storedById.get(expected.id) as any;
    assert.ok(stored, `${expected.id} disappeared`);
    assert.equal(stored.restaurant_id, expected.restaurant_id);
    assert.equal(stored.menu_id, expected.menu_id);
  }
  const menus = await db.prisma.menu.findMany({
    where: { id: { in: expectedMenus.map((menu) => menu.id) } },
    select: { id: true, restaurant_id: true },
  });
  assert.equal(menus.length, expectedMenus.length);
  const menuById = new Map(menus.map((menu: any) => [menu.id, menu]));
  for (const expected of expectedMenus) {
    assert.equal((menuById.get(expected.id) as any)?.restaurant_id, expected.restaurant_id);
  }

  // The unrelated MOCK row is outside the managed catalog and stays as-is.
  const unrelated = await db.prisma.restaurant.findUnique({
    where: { id: 'unrelated-mock-restaurant' },
  });
  assert.equal(unrelated.mock, true);
  assert.equal(unrelated.source, 'MOCK');

  const audit = await db.prisma.auditLog.findFirst({
    where: { action: 'CATALOG_PROMOTED' },
    orderBy: { created_at: 'desc' },
  });
  assert.ok(audit, 'promotion must be audited');
  assert.equal(audit.resource_id, 'catalog');
});

test('re-running promotion changes nothing and creates no duplicates', async () => {
  const beforeRestaurants = await db.prisma.restaurant.count();
  const beforeItems = await db.prisma.menuItem.count();
  const beforeMenus = await db.prisma.menu.count();

  const second = await promoteCatalog();

  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.promoted.restaurants, 0);
  assert.equal(second.promoted.menuItems, 0);
  assert.equal(second.wouldPromote.restaurants, 0);
  assert.equal(second.wouldPromote.menuItems, 0);
  assert.equal(await db.prisma.restaurant.count(), beforeRestaurants);
  assert.equal(await db.prisma.menuItem.count(), beforeItems);
  assert.equal(await db.prisma.menu.count(), beforeMenus);
  assert.equal(await db.prisma.restaurant.count({ where: { mock: true } }), 1); // only the unrelated row
  assert.equal(await db.prisma.menuItem.count({ where: { mock: true } }), 0);
});

test('a dry run reports the work without writing', async () => {
  // Put one promoted row back into its pre-promotion state.
  await db.prisma.restaurant.update({
    where: { id: 'mock-restaurant-02' },
    data: { mock: true, source: 'MOCK', osm_tags: { mock: true, note: 'legacy' } },
  });
  const report = await promoteCatalog({ dryRun: true });
  assert.equal(report.dryRun, true);
  assert.equal(report.wouldPromote.restaurants, 1);
  const row = await db.prisma.restaurant.findUnique({ where: { id: 'mock-restaurant-02' } });
  assert.equal(row.mock, true, 'a dry run must not write');
  assert.equal(row.source, 'MOCK');

  // Apply so the remaining assertions see a fully promoted catalog.
  await promoteCatalog();
  const promoted = await db.prisma.restaurant.findUnique({ where: { id: 'mock-restaurant-02' } });
  assert.equal(promoted.mock, false);
  assert.equal(promoted.source, 'CATALOG');
});
