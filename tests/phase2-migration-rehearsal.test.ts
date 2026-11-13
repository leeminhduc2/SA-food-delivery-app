/**
 * Rehearses upgrading a pre-phase-2 (legacy) database through every phase 2
 * migration on throwaway schemas. Never touches the application database.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import pg from 'pg';
import { inspectDriverAssignments } from '../scripts/preflight-driver-assignments.js';
import {
  dropTestSchema,
  testDatabaseUrl,
  testSchemaUrl,
  verifyTestSchema,
} from './test-database.js';

const execFileAsync = promisify(execFile);
const FIRST_PHASE2 = '20261112100000_audit_metadata';
const schema = `test_rehearsal_${randomUUID().replaceAll('-', '')}`;
const conflictSchema = `test_conflict_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 });
const targetUrl = testSchemaUrl(testDatabaseUrl(), schema);
const conflictUrl = testSchemaUrl(testDatabaseUrl(), conflictSchema);
const target = new pg.Pool({ connectionString: targetUrl, connectionTimeoutMillis: 3000 });
const conflict = new pg.Pool({ connectionString: conflictUrl, connectionTimeoutMillis: 3000 });
process.env.DATABASE_URL = targetUrl;
process.env.NODE_ENV = 'test';
let created: string[] = [];
let tempDir = '';
let db: typeof import('../server/shared/db.js');

/** A private copy of prisma/ holding only the requested migrations. */
async function migrationDir(include: (name: string) => boolean): Promise<string> {
  const dir = await mkdtemp(path.join(tempDir, 'prisma-'));
  await mkdir(path.join(dir, 'migrations'), { recursive: true });
  await cp('prisma/schema.prisma', path.join(dir, 'schema.prisma'));
  for (const entry of await readdir('prisma/migrations', { withFileTypes: true }))
    if (!entry.isDirectory() || include(entry.name))
      await cp(
        path.join('prisma/migrations', entry.name),
        path.join(dir, 'migrations', entry.name),
        {
          recursive: true,
        },
      );
  return dir;
}
const prismaCli = (args: string[], url: string, dir: string) =>
  execFileAsync(
    process.execPath,
    [
      path.resolve('node_modules/prisma/build/index.js'),
      ...args,
      '--schema',
      path.join(dir, 'schema.prisma'),
    ],
    {
      env: { ...process.env, DATABASE_URL: url, DOTENV_CONFIG_PATH: '.env.test-does-not-exist' },
      timeout: 60000,
    },
  );

/** Legacy data written with the pre-phase-2 schema only. */
async function legacyFixture(pool: pg.Pool, withConflict: boolean) {
  await pool.query(`
    INSERT INTO users (id,email,name,password_hash,role) VALUES
      ('l-customer','c@legacy.test','Customer','x','CUSTOMER'),
      ('l-owner','o@legacy.test','Owner','x','RESTAURANT'),
      ('l-driver','d@legacy.test','Driver','x','DRIVER'),
      ('l-driver2','d2@legacy.test','Driver 2','x','DRIVER');
    INSERT INTO restaurants (id,name,description,address,cuisine,status) VALUES ('l-rest','Legacy','','Addr','Test','APPROVED');
    INSERT INTO restaurant_members (user_id,restaurant_id) VALUES ('l-owner','l-rest');
    INSERT INTO menus (id,restaurant_id,name) VALUES ('l-menu','l-rest','Main');
    INSERT INTO menu_items (id,restaurant_id,menu_id,name,price,stock) VALUES ('l-item-1','l-rest','l-menu','Pho',50000,7),('l-item-2','l-rest','l-menu','Tea',10000,3);
    INSERT INTO orders (id,customer_id,restaurant_id,status,subtotal,delivery_fee,total,address,idempotency_key,fingerprint,expires_at) VALUES
      ('l-delivered','l-customer','l-rest','DELIVERED',100000,20000,120000,'Old address 1','k1','f',now()),
      ('l-transit','l-customer','l-rest','OUT_FOR_DELIVERY',50000,15000,65000,'Old address 2','k2','f',now()),
      ('l-cancelled','l-customer','l-rest','CANCELLED',30000,10000,40000,'Old address 3','k3','f',now()),
      ('l-refunded','l-customer','l-rest','CANCELLED',20000,10000,30000,'Old address 4','k4','f',now());
    INSERT INTO order_items (id,order_id,menu_item_id,name,price,quantity,options) VALUES ('l-oi-1','l-delivered','l-item-1','Pho',50000,2,'[]');
    INSERT INTO payments (id,order_id,reference,amount,status) VALUES
      ('l-pay-1','l-delivered','ref-1',120000,'SUCCEEDED'),
      ('l-pay-2','l-transit','ref-2',65000,'SUCCEEDED'),
      ('l-pay-3','l-cancelled','ref-3',40000,'REFUND_PENDING'),
      ('l-pay-4','l-refunded','ref-4',30000,'REFUNDED');
    INSERT INTO deliveries (id,order_id,driver_id,status) VALUES
      ('l-del-1','l-delivered','l-driver','DELIVERED'),
      ('l-del-2','l-transit','l-driver','IN_TRANSIT'),
      ('l-del-3','l-cancelled',NULL,'CANCELLED');
    INSERT INTO driver_assignments (id,delivery_id,driver_id,active) VALUES
      ('l-as-1','l-del-1','l-driver',true),
      ('l-as-2','l-del-2','l-driver',true);
    INSERT INTO state_history (id,order_id,entity,from_state,to_state,actor,reason) VALUES
      ('l-h-1','l-delivered','ORDER','OUT_FOR_DELIVERY','DELIVERED','l-driver','');
    INSERT INTO complaints (id,order_id,customer_id,content,status) VALUES ('l-comp','l-delivered','l-customer','Legacy complaint text','OPEN');
    INSERT INTO reviews (id,order_id,customer_id,restaurant_id,rating,content) VALUES ('l-rev','l-delivered','l-customer','l-rest',4,'Good');
  `);
  if (withConflict)
    await pool.query(`
      INSERT INTO orders (id,customer_id,restaurant_id,status,subtotal,delivery_fee,total,address,idempotency_key,fingerprint,expires_at)
        VALUES ('l-second','l-customer','l-rest','READY_FOR_PICKUP',1000,0,1000,'x','k5','f',now());
      INSERT INTO deliveries (id,order_id,driver_id,status) VALUES ('l-del-4','l-second','l-driver','ASSIGNED');
      INSERT INTO driver_assignments (id,delivery_id,driver_id,active) VALUES ('l-as-4','l-del-4','l-driver',true);`);
}
const snapshot = async (pool: pg.Pool) =>
  (
    await pool.query(`SELECT
      (SELECT json_agg(o ORDER BY o.id) FROM (SELECT id,status,subtotal,delivery_fee,total,address FROM orders) o) AS orders,
      (SELECT json_agg(i ORDER BY i.id) FROM (SELECT id,order_id,name,price,quantity FROM order_items) i) AS items,
      (SELECT json_agg(p ORDER BY p.id) FROM (SELECT id,order_id,amount,status FROM payments) p) AS payments,
      (SELECT json_agg(r ORDER BY r.id) FROM (SELECT id,rating,content FROM reviews) r) AS reviews,
      (SELECT count(*)::int FROM deliveries) AS deliveries,
      (SELECT count(*)::int FROM complaints) AS complaints,
      (SELECT count(*)::int FROM state_history WHERE id LIKE 'l-%') AS legacy_history`)
  ).rows[0];

before(async () => {
  tempDir = await mkdtemp(path.join(path.resolve('.tmp'), 'rehearsal-'));
  for (const name of [schema, conflictSchema]) {
    await admin.query(`CREATE SCHEMA "${name}"`);
    created.push(name);
  }
  db = await import('../server/shared/db.js');
  await verifyTestSchema(schema, db.prisma);
});
after(async () => {
  if (db) await db.prisma.$disconnect();
  await target.end();
  await conflict.end();
  for (const name of created) await dropTestSchema(admin, name, true);
  await admin.end();
  await rm(tempDir, { recursive: true, force: true });
});

test('an unresolved double trip stops the upgrade safely, then resumes after preflight', async () => {
  const legacy = await migrationDir((name) => name < FIRST_PHASE2);
  await prismaCli(['migrate', 'deploy'], conflictUrl, legacy);
  await legacyFixture(conflict, true);
  const before = await snapshot(conflict);
  const report = await inspectDriverAssignments(conflict);
  assert.equal(report.ok, false);
  assert.deepEqual(report.multiple[0].assignment_ids, ['l-as-2', 'l-as-4']);
  const full = await migrationDir(() => true);
  await assert.rejects(
    prismaCli(['migrate', 'deploy'], conflictUrl, full),
    /20261112110000_driver_assignment_history/,
  );
  // The failed migration rolled back: nothing changed and nothing was dropped.
  assert.deepEqual(await snapshot(conflict), before);
  // Operator resolution: release the trip that was never picked up, then resume.
  await conflict.query(
    "UPDATE deliveries SET status='UNASSIGNED', driver_id=NULL WHERE id='l-del-4'; DELETE FROM driver_assignments WHERE id='l-as-4'",
  );
  assert.equal((await inspectDriverAssignments(conflict)).ok, true);
  await prismaCli(
    ['migrate', 'resolve', '--rolled-back', '20261112110000_driver_assignment_history'],
    conflictUrl,
    full,
  );
  await prismaCli(['migrate', 'deploy'], conflictUrl, full);
  const second = await prismaCli(['migrate', 'deploy'], conflictUrl, full);
  assert.match(second.stdout, /No pending migrations/);
  const after = await snapshot(conflict);
  assert.deepEqual(after.orders, before.orders);
  assert.deepEqual(after.payments, before.payments);
});

test('the legacy database upgrades through every phase with data preserved and gaps reported', async () => {
  const legacy = await migrationDir((name) => name < FIRST_PHASE2);
  await prismaCli(['migrate', 'deploy'], targetUrl, legacy);
  await legacyFixture(target, false);
  const before = await snapshot(target);
  assert.equal((await inspectDriverAssignments(target)).ok, true);
  const full = await migrationDir(() => true);
  await prismaCli(['migrate', 'deploy'], targetUrl, full);
  const rerun = await prismaCli(['migrate', 'deploy'], targetUrl, full);
  assert.match(rerun.stdout, /No pending migrations/);
  const after = await snapshot(target);
  assert.deepEqual(after, before, 'orders, items, payments, reviews and history are preserved');
  const assignments = await target.query(
    'SELECT id, active, end_reason FROM driver_assignments ORDER BY id',
  );
  assert.deepEqual(assignments.rows, [
    { id: 'l-as-1', active: false, end_reason: 'MIGRATION_TERMINAL' },
    { id: 'l-as-2', active: true, end_reason: null },
  ]);
  const complaint = (
    await target.query(
      "SELECT reporter_id, reporter_role, customer_id, (SELECT action FROM complaint_history WHERE complaint_id='l-comp') AS history FROM complaints WHERE id='l-comp'",
    )
  ).rows[0];
  assert.deepEqual(complaint, {
    reporter_id: 'l-customer',
    reporter_role: 'CUSTOMER',
    customer_id: 'l-customer',
    history: 'LEGACY_BACKFILL',
  });
  const proof = await target.query('SELECT DISTINCT proof_required FROM deliveries');
  assert.deepEqual(proof.rows, [{ proof_required: false }], 'legacy trips never require proof');
  const refunds = await target.query(
    'SELECT payment_id, source, status FROM refund_requests ORDER BY payment_id',
  );
  assert.deepEqual(refunds.rows, [
    { payment_id: 'l-pay-3', source: 'LEGACY', status: 'APPROVED' },
    { payment_id: 'l-pay-4', source: 'LEGACY', status: 'SUCCEEDED' },
  ]);
  assert.equal(
    (await target.query('SELECT count(*)::int AS n FROM driver_earning_estimates')).rows[0].n,
    0,
  );
  // Post-migration backfills (D19 cutover, earnings) are idempotent and never invent data.
  const { registerModules } = await import('../server/modules/index.js');
  registerModules();
  const { backfillOpeningBatch } = await import('../server/modules/catalog/index.js');
  assert.deepEqual(await backfillOpeningBatch(100), { initialized: 2, remaining: 0 });
  assert.deepEqual(await backfillOpeningBatch(100), { initialized: 0, remaining: 0 });
  const opening = await target.query(
    "SELECT item_id, delta, balance_after FROM stock_movements WHERE kind='OPENING' ORDER BY item_id",
  );
  assert.deepEqual(opening.rows, [
    { item_id: 'l-item-1', delta: 7, balance_after: 7 },
    { item_id: 'l-item-2', delta: 3, balance_after: 3 },
  ]);
  const { backfillEarningEstimates } = await import('../server/modules/delivery/index.js');
  const earnings = await backfillEarningEstimates();
  assert.equal(earnings.created, 0);
  assert.equal(earnings.missingDeliveredAt, 1, 'legacy delivered trip has no delivery time');
  assert.deepEqual(await backfillEarningEstimates(), earnings);
  assert.equal(
    (await target.query('SELECT count(*)::int AS n FROM delivery_incidents')).rows[0].n,
    0,
  );
});
