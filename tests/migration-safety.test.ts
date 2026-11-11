import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import pg from 'pg';

/**
 * The catalog-management migration must be additive: existing databases keep
 * every row, every old row gets the documented defaults, and the new tables
 * enforce the quote invariants the services rely on.
 */
const schema = 'test_migration_' + randomUUID().replaceAll('-', '');
const originalUrl =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgres://food:food_local_only@localhost:5433/food_delivery';
const admin = new pg.Pool({ connectionString: originalUrl });
const url = new URL(originalUrl);
url.searchParams.set('options', `-c search_path=${schema}`);
url.searchParams.set('schema', schema);
process.env.DATABASE_URL = url.toString();
const schemaPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
process.env.NODE_ENV = 'test';
process.env.LOG_REQUESTS = 'false';

const migrationName = '20261103150000_catalog_management_and_delivery_quotes';
let db: any;

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  db = await import('../server/shared/db.js');
  const { migrate } = await import('../server/migrate.js');
  await migrate();
});

after(async () => {
  if (db) await db.prisma.$disconnect();
  await schemaPool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

async function columns(table: string) {
  const result = await admin.query(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2`,
    [schema, table],
  );
  return new Map(result.rows.map((row: any) => [row.column_name, row]));
}

test('new columns are NOT NULL with true defaults and the new tables exist', async () => {
  const restaurants = await columns('restaurants');
  const accepting = restaurants.get('accepting_orders');
  assert.ok(accepting, 'restaurants.accepting_orders must exist');
  assert.equal(accepting.data_type, 'boolean');
  assert.equal(accepting.is_nullable, 'NO');
  assert.equal(accepting.column_default, 'true');

  const items = await columns('menu_items');
  const visible = items.get('visible');
  assert.ok(visible, 'menu_items.visible must exist');
  assert.equal(visible.data_type, 'boolean');
  assert.equal(visible.is_nullable, 'NO');
  assert.equal(visible.column_default, 'true');

  for (const table of ['delivery_quotes', 'seed_runs']) {
    const result = await admin.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [
      `${schema}.${table}`,
    ]);
    assert.equal(result.rows[0].present, true, `${table} must exist`);
  }

  const quoteColumns = await columns('delivery_quotes');
  for (const name of [
    'address_id',
    'restaurant_id',
    'status',
    'reason',
    'distance_meters',
    'duration_seconds',
    'shipping_fee',
    'currency',
    'route_geometry',
    'address_latitude',
    'address_longitude',
    'restaurant_latitude',
    'restaurant_longitude',
    'pricing_key',
    'computed_at',
    'expires_at',
  ])
    assert.ok(quoteColumns.has(name), `missing delivery_quotes.${name}`);
  assert.equal(quoteColumns.get('currency').column_default, `'VND'::text`);
  assert.equal(quoteColumns.get('status').is_nullable, 'NO');
  assert.equal(quoteColumns.get('expires_at').is_nullable, 'NO');

  const seeds = await columns('seed_runs');
  for (const name of ['name', 'version', 'applied_at']) assert.ok(seeds.has(name));
});

test('the quote cache enforces one row per address and restaurant with cascading deletes', async () => {
  const indexes = await admin.query(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname = $1 AND tablename = 'delivery_quotes'`,
    [schema],
  );
  const definitions = indexes.rows.map((row: any) => row.indexdef).join('\n');
  assert.match(
    definitions,
    /CREATE UNIQUE INDEX (?:")?delivery_quotes_address_restaurant_key(?:"?) ON .*\(address_id, restaurant_id\)/,
  );
  assert.match(
    definitions,
    /CREATE INDEX (?:")?delivery_quotes_restaurant_idx(?:"?) ON .*\(restaurant_id\)/,
  );
  assert.match(
    definitions,
    /CREATE INDEX (?:")?delivery_quotes_expires_idx(?:"?) ON .*\(expires_at\)/,
  );

  const constraints = await admin.query(
    `SELECT c.conname, c.confdeltype
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = 'delivery_quotes' AND c.contype = 'f'`,
    [schema],
  );
  const byName = new Map(constraints.rows.map((row: any) => [row.conname, row.confdeltype]));
  assert.equal(byName.get('delivery_quotes_address_id_fkey'), 'c');
  assert.equal(byName.get('delivery_quotes_restaurant_id_fkey'), 'c');

  const checks = await admin.query(
    `SELECT conname FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = 'delivery_quotes' AND c.contype = 'c'`,
    [schema],
  );
  const names = new Set(checks.rows.map((row: any) => row.conname));
  for (const name of [
    'delivery_quotes_status_check',
    'delivery_quotes_amounts_check',
    'delivery_quotes_reason_check',
    'delivery_quotes_non_negative',
  ])
    assert.ok(names.has(name), `missing check constraint ${name}`);
});

test('rows inserted with the old column set receive the defaults', async () => {
  const restaurantId = 'legacy-restaurant-' + randomUUID();
  await schemaPool.query(
    `INSERT INTO restaurants (id, name, description, address, cuisine)
     VALUES ($1, 'Legacy Kitchen', 'Inserted without the new columns', '1 Old Street', 'Vietnamese')`,
    [restaurantId],
  );
  const restaurant = await schemaPool.query(
    `SELECT accepting_orders, catalog_visible FROM restaurants WHERE id = $1`,
    [restaurantId],
  );
  assert.equal(restaurant.rows[0].accepting_orders, true);
  assert.equal(restaurant.rows[0].catalog_visible, true);

  const menuId = 'legacy-menu-' + randomUUID();
  await schemaPool.query(
    `INSERT INTO menus (id, restaurant_id, name) VALUES ($1, $2, 'Legacy menu')`,
    [menuId, restaurantId],
  );
  const itemId = 'legacy-item-' + randomUUID();
  await schemaPool.query(
    `INSERT INTO menu_items (id, restaurant_id, menu_id, name, price)
     VALUES ($1, $2, $3, 'Legacy dish', 39000)`,
    [itemId, restaurantId, menuId],
  );
  const item = await schemaPool.query(`SELECT visible, available FROM menu_items WHERE id = $1`, [
    itemId,
  ]);
  assert.equal(item.rows[0].visible, true);
  assert.equal(item.rows[0].available, true);

  const counts = await schemaPool.query(
    `SELECT (SELECT count(*) FROM restaurants) AS restaurants,
            (SELECT count(*) FROM menu_items) AS items`,
  );
  assert.ok(Number(counts.rows[0].restaurants) >= 1);
  assert.ok(Number(counts.rows[0].items) >= 1);
});

test('the new migration only adds schema and never deletes data', async () => {
  const directory = path.resolve('prisma', 'migrations');
  const entries = await readdir(directory, { withFileTypes: true });
  const folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  assert.ok(folders.includes(migrationName), 'the additive migration folder must exist');

  const sql = await readFile(path.join(directory, migrationName, 'migration.sql'), 'utf8');
  const destructive = [
    /\bDROP\s+TABLE\b/i,
    /\bDROP\s+COLUMN\b/i,
    /\bTRUNCATE\b/i,
    /\bDELETE\s+FROM\b/i,
    /\bALTER\s+COLUMN\b[\s\S]{0,80}\bDROP\b/i,
  ];
  for (const pattern of destructive)
    assert.doesNotMatch(sql, pattern, `migration must not match ${pattern}`);
  assert.match(sql, /\bADD COLUMN\b/i);
  assert.match(sql, /\bCREATE TABLE\b/i);

  const applied = await schemaPool.query(
    `SELECT migration_name, finished_at, rolled_back_at
       FROM _prisma_migrations WHERE migration_name = $1`,
    [migrationName],
  );
  assert.equal(applied.rowCount, 1);
  assert.ok(applied.rows[0].finished_at);
  assert.equal(applied.rows[0].rolled_back_at, null);
});
