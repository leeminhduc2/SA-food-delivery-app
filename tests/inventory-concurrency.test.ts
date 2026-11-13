import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';
import pg from 'pg';
import {
  testDatabaseUrl,
  testSchemaUrl,
  verifyTestSchema,
  dropTestSchema,
} from './test-database.js';

const schema = `test_stock_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 });
const target = testSchemaUrl(testDatabaseUrl(), schema);
const pool = new pg.Pool({ connectionString: target, connectionTimeoutMillis: 3000 });
process.env.DATABASE_URL = target;
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'StockRaceTest123!';
process.env.LOG_REQUESTS = 'false';
process.env.ASSIGNMENT_AUTOMATION_ENABLED = 'false';
let created = false,
  server: Server,
  base = '';
let db: typeof import('../server/shared/db.js');
let catalog: typeof import('../server/modules/catalog/application/catalog.service.js');
let inventory: typeof import('../server/modules/catalog/application/inventory.service.js');
const cookies: Record<string, string> = {};
async function request(path: string, who: string, body: unknown, method = 'POST') {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      cookie: cookies[who] ?? '',
      'Content-Type': 'application/json',
      'X-Requested-With': 'Bep',
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
async function item(id: string, stock: number) {
  await db.prisma.menuItem.create({
    data: {
      id,
      restaurant_id: 'saigon',
      menu_id: 'saigon-main',
      name: id,
      price: 1000,
      stock,
      options: [],
    },
  });
  await db.prisma.$transaction((tx) => inventory.ensureOpeningBalance(tx, id));
}
async function balance(id: string) {
  return (
    await pool.query(
      'SELECT i.stock, sum(m.delta)::int AS ledger FROM menu_items i JOIN stock_movements m ON m.item_id=i.id WHERE i.id=$1 GROUP BY i.stock',
      [id],
    )
  ).rows[0];
}
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  created = true;
  db = await import('../server/shared/db.js');
  await verifyTestSchema(schema, db.prisma);
  await (await import('../server/migrate.js')).migrate();
  await (await import('../server/seed/seed.js')).seed();
  inventory = await import('../server/modules/catalog/application/inventory.service.js');
  catalog = await import('../server/modules/catalog/application/catalog.service.js');
  server = (await import('../server/app.js')).createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  for (const who of ['restaurant', 'restaurant2', 'customer', 'driver', 'admin']) {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Bep' },
      body: JSON.stringify({ email: `${who}@bep.local`, password: process.env.DEMO_PASSWORD }),
    });
    assert.equal(response.status, 200);
    cookies[who] = response.headers.get('set-cookie')!.split(';')[0];
  }
});
after(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  if (db) await db.prisma.$disconnect();
  await pool.end();
  await dropTestSchema(admin, schema, created);
  await admin.end();
});

test('adjustments and legacy targets are authorized, idempotent and preserve later changes', async () => {
  await item('stock-command', 10);
  const path = '/items/stock-command/stock-adjustments';
  const body = { delta: -3, reason: 'Inventory count', idempotencyKey: 'stock-adjust-key' };
  for (const who of ['restaurant2', 'customer', 'driver', 'admin'])
    assert.equal((await request(path, who, body)).status, 403);
  assert.equal((await request(path, 'restaurant', { ...body, delta: 0 })).status, 400);
  const [first, replay] = await Promise.all([
    request(path, 'restaurant', body),
    request(path, 'restaurant', body),
  ]);
  assert.equal(first.status, 200);
  assert.deepEqual(first.data, replay.data);
  assert.equal(first.data.balanceAfter, 7);
  assert.equal((await request(path, 'restaurant', { ...body, delta: -2 })).status, 409);
  assert.equal(
    (
      await request(path, 'restaurant', {
        ...body,
        delta: -100,
        idempotencyKey: 'too-negative-key',
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(path, 'restaurant', {
        delta: 2,
        reason: 'New delivery',
        idempotencyKey: 'later-stock-key',
      })
    ).status,
    200,
  );
  const lateReplay = await request(path, 'restaurant', body);
  assert.equal(lateReplay.data.stock, 9);
  assert.equal(lateReplay.data.balanceAfter, 7);
  const noReason = await request('/items/stock-command', 'restaurant', { stock: 6 }, 'PATCH');
  assert.equal(noReason.status, 400);
  assert.equal(noReason.data.code, 'STOCK_ADJUSTMENT_REQUIRED');
  assert.equal(
    (await request('/items/stock-command', 'restaurant', { stock: 9 }, 'PATCH')).status,
    200,
  );
  const legacy = { stock: 5, stockReason: 'Counted shelf', idempotencyKey: 'legacy-target-key' };
  assert.equal((await request('/items/stock-command', 'restaurant', legacy, 'PATCH')).status, 200);
  assert.equal(
    (
      await request(path, 'restaurant', {
        delta: 2,
        reason: 'Restock',
        idempotencyKey: 'restock-command',
      })
    ).status,
    200,
  );
  assert.equal((await request('/items/stock-command', 'restaurant', legacy, 'PATCH')).status, 200);
  assert.deepEqual(await balance('stock-command'), { stock: 7, ledger: 7 });
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM stock_movements WHERE item_id='stock-command' AND kind='ADJUSTMENT'",
      )
    ).rows[0].n,
    4,
  );
});

test('last serving checkout and adjustment race under a PostgreSQL item lock', async () => {
  await item('stock-race', 1);
  const actor = {
    ...(await db.prisma.user.findUniqueOrThrow({ where: { id: 'restaurant' } })),
    role: 'RESTAURANT' as const,
  };
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query("SELECT id FROM menu_items WHERE id='stock-race' FOR UPDATE");
    const operations = Promise.allSettled([
      db.prisma.$transaction((tx) =>
        catalog.priceCart(tx, [{ itemId: 'stock-race', quantity: 1, optionIds: [] }], true, {
          orderId: 'stock-race-order',
          actorId: 'customer',
        }),
      ),
      inventory.adjustStock(actor, 'stock-race', {
        delta: -1,
        reason: 'Inventory count',
        idempotencyKey: 'race-adjust-key',
      }),
    ]);
    let waiting = 0;
    for (let i = 0; i < 100 && waiting < 2; i++) {
      waiting = (
        await admin.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%menu_items%' AND pid <> pg_backend_pid()",
        )
      ).rows[0].n;
      if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(waiting >= 2);
    await blocker.query('COMMIT');
    const results = await operations;
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.deepEqual(await balance('stock-race'), { stock: 0, ledger: 0 });
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined);
    blocker.release();
  }
});

test('reserve/release replay is harmless and rollback includes the movement', async () => {
  await item('stock-replay', 1);
  const reserve = () =>
    db.prisma.$transaction((tx) =>
      catalog.priceCart(tx, [{ itemId: 'stock-replay', quantity: 1, optionIds: [] }], true, {
        orderId: 'stock-replay-order',
        actorId: 'customer',
      }),
    );
  await reserve();
  await reserve();
  assert.deepEqual(await balance('stock-replay'), { stock: 0, ledger: 0 });
  const release = () =>
    db.prisma.$transaction((tx) =>
      catalog.releaseStock(
        tx,
        [{ menu_item_id: 'stock-replay', quantity: 1 }],
        'stock-replay-order',
      ),
    );
  await release();
  await release();
  assert.deepEqual(await balance('stock-replay'), { stock: 1, ledger: 1 });
  await assert.rejects(
    db.prisma.$transaction(async (tx) => {
      await inventory.moveStock(tx, {
        itemId: 'stock-replay',
        kind: 'ADJUSTMENT',
        delta: 2,
        actor: 'restaurant',
        reason: 'Rollback test',
        operationKey: 'rollback-test',
      });
      throw new Error('rollback');
    }),
  );
  assert.deepEqual(await balance('stock-replay'), { stock: 1, ledger: 1 });
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM stock_movements WHERE item_id='stock-replay' AND operation_key='rollback-test'",
      )
    ).rows[0].n,
    0,
  );
});

test('release racing a negative adjustment stays nonnegative and reconciles', async () => {
  await item('stock-release-race', 1);
  await db.prisma.$transaction((tx) =>
    catalog.priceCart(tx, [{ itemId: 'stock-release-race', quantity: 1, optionIds: [] }], true, {
      orderId: 'release-race-order',
      actorId: 'customer',
    }),
  );
  const actor = {
    ...(await db.prisma.user.findUniqueOrThrow({ where: { id: 'restaurant' } })),
    role: 'RESTAURANT' as const,
  };
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query("SELECT id FROM menu_items WHERE id='stock-release-race' FOR UPDATE");
    const work = Promise.allSettled([
      db.prisma.$transaction((tx) =>
        catalog.releaseStock(
          tx,
          [{ menu_item_id: 'stock-release-race', quantity: 1 }],
          'release-race-order',
        ),
      ),
      inventory.adjustStock(actor, 'stock-release-race', {
        delta: -1,
        reason: 'Inventory count',
        idempotencyKey: 'release-race-key',
      }),
    ]);
    let waiting = 0;
    for (let i = 0; i < 100 && waiting < 2; i++) {
      waiting = (
        await admin.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%menu_items%' AND pid <> pg_backend_pid()",
        )
      ).rows[0].n;
      if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(waiting >= 2);
    await blocker.query('COMMIT');
    const [released, adjusted] = await work;
    assert.equal(released.status, 'fulfilled');
    const expected = adjusted.status === 'fulfilled' ? 0 : 1;
    assert.deepEqual(await balance('stock-release-race'), { stock: expected, ledger: expected });
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined);
    blocker.release();
  }
});

test('low stock crossing alerts once, rearms on restock, and history is scoped and paginated', async () => {
  await item('stock-alert', 7);
  const path = '/items/stock-alert/stock-adjustments';
  const alertCount = async () =>
    db.prisma.outbox.count({
      where: { type: 'LOW_STOCK', payload: { path: ['itemId'], equals: 'stock-alert' } },
    });
  assert.equal(await alertCount(), 0, 'opening never alerts');
  const adjust = (delta: number, key: string) =>
    request(path, 'restaurant', { delta, reason: 'Stock count', idempotencyKey: key });
  assert.equal((await adjust(-2, 'alert-cross-1')).status, 200);
  assert.equal((await adjust(-2, 'alert-cross-1')).status, 200);
  assert.equal((await adjust(-1, 'alert-still-low')).status, 200);
  assert.equal(await alertCount(), 1);
  assert.equal((await adjust(3, 'alert-rearm-key')).status, 200);
  assert.equal((await adjust(-2, 'alert-cross-2')).status, 200);
  assert.equal(await alertCount(), 2);
  const alerts = await db.prisma.outbox.findMany({
    where: { type: 'LOW_STOCK', payload: { path: ['itemId'], equals: 'stock-alert' } },
  });
  assert.deepEqual([...new Set(alerts.map((entry) => entry.user_id))], ['restaurant']);
  assert.equal(
    (
      await request(
        '/items/stock-alert/stock-threshold',
        'restaurant2',
        { threshold: 6, reason: 'Adjust threshold' },
        'PATCH',
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        '/items/stock-alert/stock-threshold',
        'admin',
        { threshold: 6, reason: 'Adjust threshold' },
        'PATCH',
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        '/items/stock-alert/stock-threshold',
        'restaurant',
        { threshold: 6, reason: 'Adjust threshold' },
        'PATCH',
      )
    ).status,
    200,
  );
  assert.equal(await alertCount(), 2, 'threshold edits do not invent a crossing');
  const get = async (who: string, query = '') => {
    const response = await fetch(`${base}/api/items/stock-alert/stock-movements${query}`, {
      headers: { cookie: cookies[who] ?? '' },
    });
    return { status: response.status, data: await response.json() };
  };
  for (const who of ['restaurant2', 'customer', 'driver'])
    assert.equal((await get(who)).status, 403);
  assert.equal((await get('admin')).status, 200);
  assert.equal((await get('restaurant', '?limit=101')).status, 400);
  assert.equal((await get('restaurant', '?cursor=invalid')).status, 400);
  await pool.query(
    "UPDATE stock_movements SET created_at='2026-01-01T00:00:00.123456Z' WHERE item_id='stock-alert'",
  );
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ limit: '1' });
    if (cursor) params.set('cursor', cursor);
    const page = await get('restaurant', `?${params}`);
    assert.equal(page.status, 200);
    ids.push(...page.data.items.map((row: any) => row.id));
    cursor = page.data.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, 5);
});

test('configured threshold applies to items without an owner override', async () => {
  const threshold = Number(process.env.LOW_STOCK_THRESHOLD ?? 5);
  await item('configured-threshold', threshold + 1);
  const response = await fetch(`${base}/api/items/configured-threshold`);
  const data = await response.json();
  assert.equal(data.low_stock_threshold, threshold);
  const result = await request('/items/configured-threshold/stock-adjustments', 'restaurant', {
    delta: -1,
    reason: 'Count stock',
    idempotencyKey: 'configured-cross-key',
  });
  assert.equal(result.status, 200);
  const alert = await db.prisma.outbox.findFirst({
    where: { type: 'LOW_STOCK', payload: { path: ['itemId'], equals: 'configured-threshold' } },
  });
  assert.ok(alert);
  assert.equal((alert.payload as any).threshold, threshold);
});

test('sold-out is derived without changing the owner availability setting', async () => {
  await item('stock-sold-out', 1);
  const adjust = (delta: number, key: string) =>
    request('/items/stock-sold-out/stock-adjustments', 'restaurant', {
      delta,
      reason: 'Count stock',
      idempotencyKey: key,
    });
  assert.equal((await adjust(-1, 'sold-out-key')).status, 200);
  const getItem = async () => await (await fetch(`${base}/api/items/stock-sold-out`)).json();
  let data = await getItem();
  assert.equal(data.available, true);
  assert.equal(data.sellable, false);
  assert.equal(data.unavailableReason, 'OUT_OF_STOCK');
  assert.equal(
    (
      await request('/checkout/quote', 'customer', {
        items: [{ itemId: 'stock-sold-out', quantity: 1, optionIds: [] }],
      })
    ).status,
    409,
  );
  assert.equal(
    (await request('/items/stock-sold-out', 'restaurant', { available: false }, 'PATCH')).status,
    200,
  );
  assert.equal((await adjust(3, 'sold-out-restock')).status, 200);
  data = await getItem();
  assert.equal(data.available, false);
  assert.equal(data.sellable, false);
  assert.equal(data.unavailableReason, 'ITEM_UNAVAILABLE');
});
