import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { inspectDriverAssignments } from '../scripts/preflight-driver-assignments.js';
import { testDatabaseUrl, testSchemaUrl, dropTestSchema } from './test-database.js';

test('legacy preflight refuses conflicting trips then closes only terminal assignment', async () => {
  const schema = `test_preflight_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 });
  const pool = new pg.Pool({
    connectionString: testSchemaUrl(testDatabaseUrl(), schema),
    connectionTimeoutMillis: 3000,
  });
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    created = true;
    await pool.query(`CREATE TABLE users (id text PRIMARY KEY, role text NOT NULL);
      CREATE TABLE orders (id text PRIMARY KEY, snapshot text);
      CREATE TABLE order_items (id text PRIMARY KEY, order_id text, snapshot text);
      CREATE TABLE payments (id text PRIMARY KEY, order_id text, amount integer);
      CREATE TABLE deliveries (id text PRIMARY KEY, order_id text, driver_id text, status text);
      CREATE TABLE driver_assignments (id text PRIMARY KEY, delivery_id text, driver_id text, active boolean);
      CREATE TABLE state_history (id text PRIMARY KEY, order_id text, entity text, from_state text, to_state text, actor text, reason text, created_at timestamptz);
      INSERT INTO users VALUES ('driver','DRIVER');
      INSERT INTO orders VALUES ('o1','kept'),('o2','kept');
      INSERT INTO order_items VALUES ('i1','o1','meal'),('i2','o2','meal');
      INSERT INTO payments VALUES ('p1','o1',100),('p2','o2',200);
      INSERT INTO deliveries VALUES ('d1','o1','driver','ASSIGNED'),('d2','o2','driver','IN_TRANSIT');
      INSERT INTO driver_assignments VALUES ('a1','d1','driver',true),('a2','d2','driver',true)`);
    const report = await inspectDriverAssignments(pool);
    assert.equal(report.ok, false);
    assert.deepEqual(report.multiple[0].assignment_ids, ['a1', 'a2']);
    assert.deepEqual(await inspectDriverAssignments(pool), report);
    const sql = await readFile(
      'prisma/migrations/20261112110000_driver_assignment_history/migration.sql',
      'utf8',
    );
    const client = await pool.connect();
    try {
      await assert.rejects(client.query(sql), /preflight failed/);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM driver_assignments WHERE active')).rows[0]
        .n,
      2,
    );
    await pool.query("UPDATE deliveries SET status='DELIVERED' WHERE id='d2'");
    assert.equal((await inspectDriverAssignments(pool)).ok, true);
    await pool.query(sql);
    const result = await pool.query(
      'SELECT id, active, ended_at, end_reason FROM driver_assignments ORDER BY id',
    );
    assert.equal(result.rows[0].active, true);
    assert.equal(result.rows[0].ended_at, null);
    assert.equal(result.rows[1].active, false);
    assert.ok(result.rows[1].ended_at);
    assert.equal(result.rows[1].end_reason, 'MIGRATION_TERMINAL');
    assert.equal(
      (await pool.query("SELECT reason FROM state_history WHERE order_id='o2'")).rows[0].reason,
      'MIGRATION_TERMINAL',
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int AS n FROM orders WHERE snapshot='kept'")).rows[0].n,
      2,
    );
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM order_items')).rows[0].n, 2);
    assert.equal((await pool.query('SELECT sum(amount)::int AS n FROM payments')).rows[0].n, 300);
    assert.equal((await inspectDriverAssignments(pool)).terminalActive.length, 0);
  } finally {
    await pool.end();
    await dropTestSchema(admin, schema, created);
    await admin.end();
  }
});
