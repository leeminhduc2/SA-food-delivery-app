import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { inspectMenuGroups } from '../scripts/preflight-menu-groups.js';
import { testDatabaseUrl, testSchemaUrl, dropTestSchema } from './test-database.js';

test('menu migration reports legacy duplicates and preserves all menu and item relationships', async () => {
  const schema = `test_menus_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 });
  const pool = new pg.Pool({
    connectionString: testSchemaUrl(testDatabaseUrl(), schema),
    connectionTimeoutMillis: 3000,
  });
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    created = true;
    await pool.query(`CREATE TABLE menus (id text primary key, restaurant_id text not null, name text not null);
      CREATE TABLE menu_items (id text primary key, menu_id text references menus(id));
      INSERT INTO menus VALUES ('menu-a','restaurant-1','Foo'),('menu-b','restaurant-1',' foo '),('menu-c','restaurant-2','FOO');
      INSERT INTO menu_items VALUES ('item-a','menu-a'),('item-b','menu-b');`);
    const report = await inspectMenuGroups(pool);
    assert.equal(report.ok, false);
    assert.deepEqual(report.conflicts[0].menu_ids, ['menu-a', 'menu-b']);
    const sql = await readFile(
      'prisma/migrations/20261113170000_menu_case_insensitive_unique/migration.sql',
      'utf8',
    );
    await assert.rejects(pool.query(sql), /menu-a,menu-b/);
    assert.deepEqual((await pool.query('SELECT id,menu_id FROM menu_items ORDER BY id')).rows, [
      { id: 'item-a', menu_id: 'menu-a' },
      { id: 'item-b', menu_id: 'menu-b' },
    ]);
    await pool.query("UPDATE menus SET name='Bar' WHERE id='menu-b'");
    assert.equal((await inspectMenuGroups(pool)).ok, true);
    await pool.query(sql);
    await assert.rejects(
      pool.query("INSERT INTO menus VALUES ('menu-d','restaurant-1',' FOO ' )"),
      /unique/i,
    );
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM menu_items')).rows[0].n, 2);
  } finally {
    await pool.end();
    await dropTestSchema(admin, schema, created);
    await admin.end();
  }
});
