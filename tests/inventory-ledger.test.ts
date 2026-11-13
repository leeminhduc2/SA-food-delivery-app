import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import {
  testDatabaseUrl,
  testSchemaUrl,
  verifyTestSchema,
  dropTestSchema,
} from './test-database.js';

const schema = `test_ledger_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 });
const target = testSchemaUrl(testDatabaseUrl(), schema);
const pool = new pg.Pool({ connectionString: target, connectionTimeoutMillis: 3000 });
process.env.DATABASE_URL = target;
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'InventoryTest123!';
let created = false;
let db: typeof import('../server/shared/db.js');
let inventory: typeof import('../server/modules/catalog/application/inventory.service.js');
let backfill: typeof import('../server/modules/catalog/application/inventory-backfill.service.js');
let catalog: typeof import('../server/modules/catalog/application/catalog.service.js');
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  created = true;
  db = await import('../server/shared/db.js');
  await verifyTestSchema(schema, db.prisma);
  await (await import('../server/migrate.js')).migrate();
  await (await import('../server/seed/seed.js')).seed();
  inventory = await import('../server/modules/catalog/application/inventory.service.js');
  backfill = await import('../server/modules/catalog/application/inventory-backfill.service.js');
  catalog = await import('../server/modules/catalog/application/catalog.service.js');
});
after(async () => {
  if (db) await db.prisma.$disconnect();
  await pool.end();
  await dropTestSchema(admin, schema, created);
  await admin.end();
});

test('opening, backfill and checkout serialize on the same item and reconcile', async () => {
  await pool.query("DELETE FROM stock_movements WHERE item_id='pho'");
  await pool.query("UPDATE menu_items SET stock=5 WHERE id='pho'");
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query("SELECT id FROM menu_items WHERE id='pho' FOR UPDATE");
    const open = db.prisma.$transaction((tx) => inventory.ensureOpeningBalance(tx, 'pho'));
    const reserve = db.prisma.$transaction((tx) =>
      catalog.priceCart(tx, [{ itemId: 'pho', quantity: 1, optionIds: [] }], true, {
        orderId: 'concurrent-order',
        actorId: 'customer',
      }),
    );
    const both = Promise.all([open, reserve]);
    let waiting = 0;
    for (let i = 0; i < 100 && waiting < 2; i++) {
      waiting = (
        await admin.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%menu_items%' AND pid <> pg_backend_pid()",
        )
      ).rows[0].n;
      if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(waiting >= 2, 'both writers reached the item lock');
    const skipped = await backfill.backfillOpeningBatch(100);
    assert.equal(skipped.initialized, 0);
    assert.equal(skipped.remaining, 1);
    await blocker.query('COMMIT');
    await both;
    const rows = (
      await pool.query(
        "SELECT kind,delta,balance_after FROM stock_movements WHERE item_id='pho' ORDER BY created_at,id",
      )
    ).rows;
    assert.deepEqual(
      rows.map((row) => row.kind),
      ['OPENING', 'RESERVE'],
    );
    assert.deepEqual(
      rows.map((row) => row.delta),
      [5, -1],
    );
    assert.equal(rows.at(-1).balance_after, 4);
    const result = await pool.query(
      "SELECT i.stock, sum(m.delta)::int AS ledger FROM menu_items i JOIN stock_movements m ON m.item_id=i.id WHERE i.id='pho' GROUP BY i.stock",
    );
    assert.deepEqual(result.rows[0], { stock: 4, ledger: 4 });
    await db.prisma.$transaction((tx) =>
      catalog.releaseStock(tx, [{ menu_item_id: 'pho', quantity: 1 }], 'concurrent-order'),
    );
    const released = await pool.query(
      "SELECT i.stock, sum(m.delta)::int AS ledger FROM menu_items i JOIN stock_movements m ON m.item_id=i.id WHERE i.id='pho' GROUP BY i.stock",
    );
    assert.deepEqual(released.rows[0], { stock: 5, ledger: 5 });
    assert.equal((await backfill.backfillOpeningBatch()).remaining, 0);
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined);
    blocker.release();
  }
});

test('zero stock has one zero opening and seed reruns preserve stock and history', async () => {
  await db.prisma.menuItem.create({
    data: {
      id: 'zero-ledger',
      restaurant_id: 'saigon',
      menu_id: 'saigon-main',
      name: 'Zero stock',
      price: 1000,
      stock: 0,
      options: [],
    },
  });
  await Promise.all([
    db.prisma.$transaction((tx) => inventory.ensureOpeningBalance(tx, 'zero-ledger')),
    backfill.backfillOpeningBatch(),
  ]);
  const zero = await pool.query(
    "SELECT kind,delta,balance_after FROM stock_movements WHERE item_id='zero-ledger'",
  );
  assert.deepEqual(zero.rows, [{ kind: 'OPENING', delta: 0, balance_after: 0 }]);
  const actor = {
    ...(await db.prisma.user.findUniqueOrThrow({ where: { id: 'restaurant' } })),
    role: 'RESTAURANT' as const,
  };
  await catalog.updateItem(actor, 'pho', { stock: 9 });
  const before = await pool.query(
    "SELECT id,kind,delta,balance_after FROM stock_movements WHERE item_id='pho' ORDER BY created_at,id",
  );
  await (await import('../server/seed/seed.js')).seed();
  assert.equal((await db.prisma.menuItem.findUniqueOrThrow({ where: { id: 'pho' } })).stock, 9);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT id,kind,delta,balance_after FROM stock_movements WHERE item_id='pho' ORDER BY created_at,id",
      )
    ).rows,
    before.rows,
  );
  assert.equal(
    (await pool.query("SELECT sum(delta)::int AS total FROM stock_movements WHERE item_id='pho'"))
      .rows[0].total,
    9,
  );
});
