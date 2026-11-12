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
import { PrismaClient } from '@prisma/client';

const schema = 'test_hanoi_' + randomUUID().replaceAll('-', '');
const originalUrl = testDatabaseUrl();
const adminPool = new pg.Pool({ connectionString: originalUrl, connectionTimeoutMillis: 3000 });
process.env.DATABASE_URL = testSchemaUrl(originalUrl, schema);
const schemaPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 3000,
});
let schemaCreated = false;
process.env.NODE_ENV = 'test';
process.env.LOG_REQUESTS = 'false';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'HanoiTest123!';
process.env.PAYMENT_MODE = 'simulated';
process.env.PAYMENT_WEBHOOK_SECRET = 'hanoi-test-webhook-secret-at-least-32-chars';
process.env.APP_ORIGIN = 'http://127.0.0.1:3003';

const CAFE = 'node/3678370944';
const BANH_MI = 'node/3514125539';

const FIXTURES = [
  {
    type: 'node',
    id: 3678370944,
    lat: 21.0291515,
    lon: 105.8461905,
    tags: {
      'addr:district': 'Hoàn Kiếm',
      'addr:housenumber': '6',
      'addr:street': 'Ngõ Hội Vũ',
      amenity: 'cafe',
      cuisine: 'breakfast;burger;coffee_shop;tea',
      name: 'The Hanoi Social Club',
      opening_hours: '08:00-23:00',
      phone: '+84 24 3938 2117',
    },
  },
  {
    type: 'node',
    id: 3514125539,
    lat: 21.0360802,
    lon: 105.8486929,
    tags: {
      'addr:city': 'Hà Nội',
      'addr:district': 'Phường Hoàn Kiếm',
      'addr:housenumber': '25',
      'addr:street': 'Hàng Cá',
      amenity: 'fast_food',
      cuisine: 'sandwich',
      name: 'Bánh Mì 25',
      opening_hours: 'Mo-Sa 07:00-19:00, Su 07:00-17:00',
      phone: '+84977668895',
    },
  },
];

let server: Server;
let base = '';
let db: any;
let hanoi: any;
let cookies: Record<string, string> = {};
const httpFetch = globalThis.fetch;

function overpassFetch(elements: unknown[]) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string) => {
    calls.push(String(input));
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ elements }),
    } as Response;
  }) as any;
  return { fetchImpl, calls };
}

async function request(path: string, method = 'GET', body?: unknown, actor = 'customer') {
  const response = await httpFetch(base + '/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'Bep',
      cookie: cookies[actor] || '',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json(), headers: response.headers };
}

async function counts() {
  const result = await schemaPool.query(`
    SELECT
      (SELECT count(*)::int FROM restaurants) AS restaurants,
      (SELECT count(*)::int FROM menus) AS menus,
      (SELECT count(*)::int FROM menu_items) AS items,
      (SELECT count(*)::int FROM restaurant_import_jobs) AS jobs
  `);
  return result.rows[0];
}

async function rowByOsm(osmId: string) {
  return (
    await schemaPool.query('SELECT * FROM restaurants WHERE osm_type=$1 AND osm_id=$2', [
      'node',
      osmId,
    ])
  ).rows[0];
}

before(async () => {
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  db = await import('../server/shared/db.js');
  await verifyTestSchema(schema, db.prisma);
  const { migrate } = await import('../server/migrate.js');
  await migrate();
  const { seed } = await import('../server/seed/seed.js');
  await seed();
  hanoi = await import('../server/modules/catalog/import/hanoi-import.service.js');
  const { createApp } = await import('../server/app.js');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  for (const actor of ['customer', 'admin']) {
    const login = await request('/auth/login', 'POST', {
      email: actor + '@bep.local',
      password: process.env.DEMO_PASSWORD,
    });
    assert.equal(login.status, 200);
    cookies[actor] = login.headers.get('set-cookie')!.split(';')[0];
  }
});

after(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  if (db) await db.prisma.$disconnect();
  await schemaPool.end();
  assert.match(schema, /^test_hanoi_[a-f0-9]{32}$/);
  await dropTestSchema(adminPool, schema, schemaCreated);
  await adminPool.end();
});

test('dry-run reports the curated plan without writing anything', async () => {
  const beforeCounts = await counts();
  const { fetchImpl, calls } = overpassFetch(FIXTURES);
  const report = await hanoi.runHanoiDemoImport(
    { dryRun: true, ids: [CAFE, BANH_MI] },
    { fetchImpl },
  );
  assert.equal(calls.length, 1);
  assert.equal(report.dryRun, true);
  assert.equal(report.selected, 2);
  assert.equal(report.fetched, 2);
  assert.equal(report.valid, 2);
  assert.equal(report.wouldCreate, 2);
  assert.equal(report.created, 0);
  assert.equal(report.approved, 0);
  assert.equal(report.jobId, null);
  assert.equal(report.restaurants.length, 2);
  assert.equal(report.restaurants.find((r: any) => r.key === CAFE).menuProfile, 'cafe');
  assert.equal(report.restaurants.find((r: any) => r.key === BANH_MI).menuProfile, 'sandwich');
  assert.deepEqual(await counts(), beforeCounts);
});

test('a missing Overpass record is reported and does not abort the rest', async () => {
  const { fetchImpl } = overpassFetch([FIXTURES[1]]);
  const report = await hanoi.runHanoiDemoImport(
    { dryRun: true, ids: [CAFE, BANH_MI] },
    { fetchImpl },
  );
  assert.equal(report.restaurants.length, 1);
  assert.deepEqual(
    report.missing.map((item: any) => item.key),
    [CAFE],
  );
  assert.equal(report.wouldCreate, 1);
});

test('the import creates approved but unverified restaurants with demo menus', async () => {
  const { fetchImpl, calls } = overpassFetch(FIXTURES);
  const report = await hanoi.runHanoiDemoImport({ ids: [CAFE, BANH_MI] }, { fetchImpl });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /interpreter/);
  assert.equal(report.created, 2);
  assert.equal(report.failed, 0);
  assert.equal(report.approved, 2);
  assert.equal(report.protectedSkipped, 0);
  assert.equal(report.menusEnsured, 6);
  assert.equal(report.itemsCreated, 20);
  assert.ok(report.jobId);

  const cafe = await rowByOsm('3678370944');
  assert.equal(cafe.name, 'The Hanoi Social Club');
  assert.equal(cafe.status, 'APPROVED');
  assert.equal(cafe.source, 'OSM');
  assert.equal(cafe.verified, false);
  assert.equal(cafe.owner_managed, false);
  assert.equal(cafe.cuisine, 'Breakfast, Burger, Coffee Shop');
  assert.equal(cafe.latitude, 21.0291515);
  assert.equal(cafe.longitude, 105.8461905);
  assert.equal(cafe.phone, '+84 24 3938 2117');
  assert.equal(cafe.opening_hours, '08:00-23:00');
  assert.equal(cafe.image, '/images/hanoi-3678370944.svg');
  assert.match(cafe.description, /demo data/i);
  assert.equal(cafe.osm_tags._bep.dataProvider, 'OpenStreetMap');
  assert.equal(cafe.osm_tags._bep.license, 'ODbL-1.0');
  assert.equal(cafe.osm_tags._bep.menu.dataType, 'DEMO');
  assert.equal(cafe.osm_tags._bep.menu.official, false);
  assert.equal(cafe.osm_tags._bep.image.type, 'ILLUSTRATION');

  const banhMi = await rowByOsm('3514125539');
  assert.equal(banhMi.cuisine, 'Sandwich');
  assert.equal(banhMi.osm_tags._bep.menu.profile, 'sandwich');

  const items = await schemaPool.query(
    'SELECT category, count(*)::int AS count FROM (SELECT m.name AS category FROM menu_items mi JOIN menus m ON m.id=mi.menu_id WHERE mi.restaurant_id=$1) x GROUP BY category ORDER BY category',
    [cafe.id],
  );
  assert.deepEqual(
    items.rows.map((row) => row.count),
    [3, 4, 3],
  );
  assert.equal(
    (
      await schemaPool.query(
        'SELECT count(*)::int AS count FROM menu_items WHERE restaurant_id=$1',
        [cafe.id],
      )
    ).rows[0].count,
    10,
  );

  const jobs = await schemaPool.query(
    'SELECT status, dry_run, bbox, stats FROM restaurant_import_jobs ORDER BY started_at DESC',
  );
  assert.equal(jobs.rows.length, 1);
  assert.equal(jobs.rows[0].status, 'SUCCEEDED');
  assert.equal(jobs.rows[0].dry_run, false);
  assert.match(jobs.rows[0].bbox, /curated:hanoi:2/);
  assert.equal(jobs.rows[0].stats.itemsCreated, 20);
});

test('catalog API exposes imported records, search and cuisine filtering', async () => {
  const list = await request('/restaurants');
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 5);
  const cafe = list.data.find((row: any) => row.osm_id === '3678370944');
  assert(cafe);
  assert.equal(cafe.osm_tags._bep.menu.dataType, 'DEMO');
  assert.equal(cafe.review_count, 0);

  const searched = await request('/restaurants?q=Social');
  assert.deepEqual(
    searched.data.map((row: any) => row.name),
    ['The Hanoi Social Club'],
  );
  const dishSearch = await request('/restaurants?q=Banana%20bread');
  assert.deepEqual(
    dishSearch.data.map((row: any) => row.osm_id),
    ['3678370944'],
  );
  const filtered = await request('/restaurants?cuisine=Sandwich');
  assert.deepEqual(
    filtered.data.map((row: any) => row.name),
    ['Bánh Mì 25'],
  );
  const sorted = await request('/restaurants?sort=name');
  const names = sorted.data.map((row: any) => row.name);
  assert.deepEqual(
    names,
    [...names].sort((a, b) => a.localeCompare(b)),
  );

  const detail = await request('/restaurants/' + cafe.id);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.items.length, 10);
  assert.deepEqual([...new Set(detail.data.items.map((item: any) => item.category))].sort(), [
    'Drinks',
    'Main dishes',
    'Starters',
  ]);
  assert.equal(detail.data.source, 'OSM');
  assert.equal(
    detail.data.osm_tags._bep.sourceUrl,
    'https://www.openstreetmap.org/node/3678370944',
  );
});

test('a second import is idempotent and does not duplicate rows or items', async () => {
  const beforeCounts = await counts();
  const { fetchImpl } = overpassFetch(FIXTURES);
  const report = await hanoi.runHanoiDemoImport({ ids: [CAFE, BANH_MI] }, { fetchImpl });
  assert.equal(report.created, 0);
  assert.equal(report.updated, 2);
  assert.equal(report.approved, 2);
  assert.equal(report.itemsCreated, 0);
  assert.equal(report.menusEnsured, 6);
  assert.deepEqual(await counts(), { ...beforeCounts, jobs: beforeCounts.jobs + 1 });
});

test('verified or owner-managed rows are never overwritten', async () => {
  const cafe = await rowByOsm('3678370944');
  await schemaPool.query(
    `UPDATE restaurants
     SET owner_managed=true, verified=true, description='Owner supplied description', name='Owner Cafe'
     WHERE id=$1`,
    [cafe.id],
  );
  const { fetchImpl } = overpassFetch(FIXTURES);
  const report = await hanoi.runHanoiDemoImport({ ids: [CAFE, BANH_MI] }, { fetchImpl });
  assert.equal(report.protectedSkipped, 1);
  assert.equal(report.approved, 1);
  assert.equal(report.itemsCreated, 0);
  const protectedRow = await rowByOsm('3678370944');
  assert.equal(protectedRow.name, 'Owner Cafe');
  assert.equal(protectedRow.description, 'Owner supplied description');
  assert.equal(protectedRow.owner_managed, true);

  const dry = await hanoi.runHanoiDemoImport({ dryRun: true, ids: [CAFE, BANH_MI] }, { fetchImpl });
  assert.equal(dry.wouldSkip, 1);
  assert.equal(dry.wouldUpdate, 1);
  assert.equal(dry.wouldCreate, 0);
});

test('the import CLI selection rejects unknown ids before any network call', async () => {
  const { fetchImpl, calls } = overpassFetch(FIXTURES);
  await assert.rejects(
    hanoi.runHanoiDemoImport({ ids: ['node/1'] }, { fetchImpl }),
    /Unknown curated OSM key/,
  );
  assert.equal(calls.length, 0);
});
