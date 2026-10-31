import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { PrismaClient } from '@prisma/client';

const schema = 'test_import_' + randomUUID().replaceAll('-', '');
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
process.env.DEMO_PASSWORD = 'ImportTest123!';
process.env.PAYMENT_MODE = 'simulated';
process.env.PAYMENT_WEBHOOK_SECRET = 'import-test-webhook-secret-at-least-32-chars';
process.env.APP_ORIGIN = 'http://127.0.0.1:3002';

let server: Server;
let base = '';
let db: any;
let overpass: any;
let osm: any;
let importService: any;
let repository: any;
const cookies: Record<string, string> = {};
// Keep a direct reference so tests that stub globalThis.fetch for Overpass do
// not also intercept this file's HTTP calls to the app.
const httpFetch = globalThis.fetch;

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => data,
  } as Response;
}

function element(id: number, overrides: Record<string, any> = {}) {
  return {
    type: 'node',
    id,
    lat: 21.03,
    lon: 105.85,
    tags: {
      amenity: 'restaurant',
      name: `Quán ${id}`,
      'addr:housenumber': String(id),
      'addr:street': 'Hàng Bài',
      'addr:district': 'Hoàn Kiếm',
      'addr:city': 'Hà Nội',
      ...(overrides.tags ?? {}),
    },
    ...overrides,
  };
}

function fetchSequence(responses: Array<() => Promise<Response> | Response>) {
  let index = 0;
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const impl = (async (input: string, init?: RequestInit) => {
    calls.push({ input, init });
    const next = responses[Math.min(index++, responses.length - 1)];
    return next();
  }) as any;
  return { impl, calls };
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

async function osmRow(osmId: string, osmType = 'node') {
  return (
    await schemaPool.query('SELECT * FROM restaurants WHERE osm_type=$1 AND osm_id=$2', [
      osmType,
      osmId,
    ])
  ).rows[0];
}

before(async () => {
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  db = await import('../server/db.js');
  const { migrate } = await import('../server/migrate.js');
  await migrate();
  const { seed } = await import('../server/seed.js');
  await seed();
  overpass = await import('../server/services/overpass.service.js');
  osm = await import('../server/domain/osm.js');
  importService = await import('../server/services/restaurant-import.service.js');
  repository = await import('../server/repositories/restaurant-import.repository.js');
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
  assert.match(schema, /^test_import_[a-f0-9]{32}$/);
  await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
  await adminPool.end();
});

test('Overpass retries a rate-limit response and honours Retry-After', async () => {
  const sleeps: number[] = [];
  const sequence = fetchSequence([
    () => jsonResponse({}, 429, { 'Retry-After': '0' }),
    () => jsonResponse({ elements: [element(1)] }),
  ]);
  const result = await overpass.fetchOsmRestaurants(
    { bbox: [20.9, 105.7, 21.1, 105.9], retries: 2, retryBaseMs: 0 },
    { fetchImpl: sequence.impl, sleep: async (ms: number) => sleeps.push(ms) },
  );
  assert.equal(sequence.calls.length, 2);
  assert.equal(result.elements.length, 1);
  assert.equal(sleeps.length, 1);
  const body = String(sequence.calls[0].init!.body);
  assert.match(body, /amenity/);
  assert.match(body, /restaurant/);
  assert.match(sequence.calls[0].input, /interpreter/);
});

test('Overpass timeout is retried and surfaced as a clear error', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    throw error;
  };
  await assert.rejects(
    overpass.fetchOsmRestaurants(
      { retries: 1, retryBaseMs: 0 },
      { fetchImpl: fetchImpl as any, sleep: async () => undefined },
    ),
    (error: any) => error.code === 'TIMEOUT' && error.attempts === 2,
  );
  assert.equal(calls, 2);
});

test('normalization deduplicates OSM ids and rejects invalid coordinates or unnamed records', () => {
  const result = osm.normalizeOsmElements([
    element(10),
    element(10, { tags: { amenity: 'restaurant', name: 'Duplicate name' } }),
    element(11, { lat: 999 }),
    element(12, { tags: { amenity: 'restaurant' } }),
    {
      type: 'way',
      id: 13,
      center: { lat: 21.04, lon: 105.86 },
      tags: { amenity: 'fast_food', name: 'Bánh mì centre' },
    },
  ]);
  assert.equal(result.valid.length, 2);
  assert.equal(result.duplicates, 1);
  assert.equal(result.invalid.length, 2);
  assert.deepEqual(result.invalid.map((record: any) => record.reason).sort(), [
    'invalid_coordinates',
    'missing_name',
  ]);
  assert.equal(result.missing.address, 1);
  assert.equal(result.missing.phone, 2);
  assert.equal(result.valid.find((record: any) => record.osmType === 'way').latitude, 21.04);
});

test('an empty Overpass response is a successful no-op', async () => {
  const beforeCount = (await schemaPool.query('SELECT count(*)::int AS n FROM restaurants')).rows[0]
    .n;
  const report = await importService.runRestaurantImport(
    { dryRun: false, bbox: [20.9, 105.7, 21.1, 105.9] },
    { fetchImpl: async () => jsonResponse({ elements: [] }) },
  );
  assert.equal(report.fetched, 0);
  assert.equal(report.created, 0);
  assert.equal(report.failed, 0);
  const afterCount = (await schemaPool.query('SELECT count(*)::int AS n FROM restaurants')).rows[0]
    .n;
  assert.equal(afterCount, beforeCount);
});

test('a successful import stores unverified PENDING establishments without inventing fields', async () => {
  const elements = [
    element(101, {
      tags: {
        amenity: 'restaurant',
        name: '  Phở   Hà Nội  ',
        cuisine: 'vietnamese',
        phone: '+84 24 1234 5678',
        website: 'https://pho.example.test',
        opening_hours: 'Mo-Su 08:00-22:00',
        'addr:housenumber': '12',
        'addr:street': 'Hàng Bài',
        'addr:district': 'Hoàn Kiếm',
        'addr:city': 'Hà Nội',
      },
    }),
    {
      type: 'way',
      id: 102,
      center: { lat: 21.04, lon: 105.86 },
      tags: { amenity: 'fast_food', name: 'Bánh Mì Hai' },
    },
    {
      type: 'relation',
      id: 103,
      center: { lat: 21.05, lon: 105.87 },
      tags: { amenity: 'food_court', name: 'Food Court Ba' },
    },
  ];
  const report = await importService.runRestaurantImport(
    { bbox: [20.9, 105.7, 21.1, 105.9] },
    { fetchImpl: async () => jsonResponse({ elements }) },
  );
  assert.equal(report.created, 3, JSON.stringify(report));
  assert.equal(report.updated, 0);
  assert.equal(report.failed, 0);
  const pho = await osmRow('101');
  assert.equal(pho.status, 'PENDING');
  assert.equal(pho.verified, false);
  assert.equal(pho.owner_managed, false);
  assert.equal(pho.source, 'OSM');
  assert.equal(pho.name, 'Phở Hà Nội');
  assert.equal(pho.address, '12, Hàng Bài, Hoàn Kiếm, Hà Nội');
  assert.equal(pho.phone, '+84 24 1234 5678');
  assert.equal(pho.opening_hours, 'Mo-Su 08:00-22:00');
  assert.equal(pho.delivery_fee, 0);
  assert.equal(pho.image, '');
  assert.equal(pho.description, '');
  assert.equal(pho.osm_tags.amenity, 'restaurant');
  assert.equal((await osmRow('102', 'way')).osm_type, 'way');
  assert.equal((await osmRow('103', 'relation')).osm_type, 'relation');
});

test('repeated imports are idempotent and refresh only unverified OSM rows', async () => {
  const second = [
    element(101, {
      tags: { amenity: 'restaurant', name: 'Phở Hà Nội (updated)' },
    }),
  ];
  const report = await importService.runRestaurantImport(
    { bbox: [20.9, 105.7, 21.1, 105.9] },
    { fetchImpl: async () => jsonResponse({ elements: second }) },
  );
  assert.equal(report.created, 0);
  assert.equal(report.updated, 1, JSON.stringify(report));
  assert.equal(report.newRecords, 0);
  assert.equal(report.existingRecords, 1);
  assert.equal((await osmRow('101')).name, 'Phở Hà Nội (updated)');
  assert.equal(
    (await schemaPool.query('SELECT count(*)::int AS n FROM restaurants WHERE osm_id=$1', ['101']))
      .rows[0].n,
    1,
  );
});

test('admin-verified and owner-managed rows are never overwritten', async () => {
  await schemaPool.query('UPDATE restaurants SET verified=true WHERE osm_type=$1 AND osm_id=$2', [
    'node',
    '101',
  ]);
  const report = await importService.runRestaurantImport(
    { bbox: [20.9, 105.7, 21.1, 105.9] },
    {
      fetchImpl: async () =>
        jsonResponse({
          elements: [element(101, { tags: { amenity: 'restaurant', name: 'Wrong name' } })],
        }),
    },
  );
  assert.equal(report.skipped, 1);
  assert.equal(report.wouldSkip, 1);
  assert.equal(report.updated, 0);
  assert.equal((await osmRow('101')).name, 'Phở Hà Nội (updated)');
});

test('invalid coordinates are reported and do not block valid records', async () => {
  const report = await importService.runRestaurantImport(
    { bbox: [20.9, 105.7, 21.1, 105.9] },
    {
      fetchImpl: async () =>
        jsonResponse({
          elements: [element(201, { lat: 'not a number' }), element(202)],
        }),
    },
  );
  assert.equal(report.valid, 1);
  assert.equal(report.invalid, 1);
  assert.equal(report.invalidReasons.invalid_coordinates, 1);
  assert.ok(await osmRow('202'));
  assert.equal(await osmRow('201'), undefined);
});

test('dry-run classifies records without writing restaurant data', async () => {
  const beforeRows = (await schemaPool.query('SELECT count(*)::int AS n FROM restaurants')).rows[0]
    .n;
  const beforeJobs = (
    await schemaPool.query('SELECT count(*)::int AS n FROM restaurant_import_jobs')
  ).rows[0].n;
  const report = await importService.runRestaurantImport(
    { dryRun: true, bbox: [20.9, 105.7, 21.1, 105.9] },
    { fetchImpl: async () => jsonResponse({ elements: [element(301)] }) },
  );
  assert.equal(report.dryRun, true);
  assert.equal(report.wouldCreate, 1);
  assert.equal(report.created, 0);
  assert.equal(report.updated, 0);
  assert.equal(await osmRow('301'), undefined);
  const afterRows = (await schemaPool.query('SELECT count(*)::int AS n FROM restaurants')).rows[0]
    .n;
  const afterJobs = (
    await schemaPool.query('SELECT count(*)::int AS n FROM restaurant_import_jobs')
  ).rows[0].n;
  assert.equal(afterRows, beforeRows);
  assert.equal(afterJobs, beforeJobs);
});

test('a partial batch failure is isolated by a savepoint', async () => {
  await schemaPool.query(`
    CREATE FUNCTION fail_import() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.osm_id = 'bad' AND NEW.source = 'OSM' THEN
        RAISE EXCEPTION 'forced import failure';
      END IF;
      RETURN NEW;
    END;
    $fn$;
  `);
  await schemaPool.query(
    'CREATE TRIGGER fail_import_trigger BEFORE INSERT OR UPDATE ON restaurants FOR EACH ROW EXECUTE FUNCTION fail_import()',
  );
  try {
    const report = await importService.runRestaurantImport(
      { bbox: [20.9, 105.7, 21.1, 105.9] },
      {
        fetchImpl: async () =>
          jsonResponse({ elements: [element(401), element(402, { id: 402 })].map((e: any) => e) }),
      },
    );
    // The trigger only matches literal "bad", so force the failure by using
    // osm ids through a second import with the special id.
    assert.equal(report.failed, 0);
    const failed = await importService.runRestaurantImport(
      { bbox: [20.9, 105.7, 21.1, 105.9] },
      {
        fetchImpl: async () =>
          jsonResponse({
            elements: [
              {
                type: 'node',
                id: 'bad',
                lat: 21.03,
                lon: 105.85,
                tags: { amenity: 'restaurant', name: 'Bad row' },
              },
              element(403),
            ],
          }),
      },
    );
    assert.equal(failed.created, 1, JSON.stringify(failed));
    assert.equal(failed.failed, 1);
    assert.equal(failed.failures[0].osmId, 'bad');
    assert.ok(await osmRow('403'));
    assert.equal(await osmRow('bad'), undefined);
  } finally {
    await schemaPool.query('DROP TRIGGER IF EXISTS fail_import_trigger ON restaurants');
    await schemaPool.query('DROP FUNCTION IF EXISTS fail_import()');
  }
});

test('a database connection failure is surfaced instead of reported as success', async () => {
  const broken = new PrismaClient({
    datasources: {
      db: { url: 'postgres://food:food_local_only@127.0.0.1:1/food_delivery' },
    },
  });
  try {
    await assert.rejects(
      repository.findOsmOwnership([{ osmType: 'node', osmId: '1' }], broken),
      (error: any) => Boolean(error?.message),
    );
  } finally {
    await broken.$disconnect().catch(() => undefined);
  }
});

test('unauthorized and invalid admin import requests are rejected', async () => {
  const anonymous = await fetch(base + '/api/admin/restaurants/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Bep' },
    body: '{}',
  });
  assert.equal(anonymous.status, 401);
  assert.equal((await request('/admin/restaurants/import', 'POST', {})).status, 403);
  const invalid = await request(
    '/admin/restaurants/import',
    'POST',
    {
      bbox: [0, 0, 10, 10],
    },
    'admin',
  );
  assert.equal(invalid.status, 400);
  assert.equal((await request('/admin/restaurants/import/history')).status, 403);
});

test('an admin import queues a background job and records history', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse({ elements: [element(501)] })) as typeof fetch;
  try {
    const queued = await request('/admin/restaurants/import', 'POST', { dryRun: true }, 'admin');
    assert.equal(queued.status, 202, JSON.stringify(queued.data));
    assert.equal(queued.data.status, 'RUNNING');
    assert.match(queued.data.jobId, /^[0-9a-f-]{36}$/);
    let job: any;
    for (let attempt = 0; attempt < 100; attempt++) {
      const history = await request('/admin/restaurants/import/history', 'GET', undefined, 'admin');
      job = history.data.find((row: any) => row.id === queued.data.jobId);
      if (job && job.status !== 'RUNNING') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(job?.status, 'SUCCEEDED', JSON.stringify(job));
    assert.equal(job.dry_run, true);
    assert.equal(job.stats.fetched, 1);
    assert.equal(job.stats.wouldCreate, 1);
    assert.equal(await osmRow('501'), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
