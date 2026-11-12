import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { dropTestSchema, testDatabaseUrl, testSchemaUrl } from './test-database.js';

test('test schemas isolate writes and cleanup only removes the owned schema', async () => {
  const base = testDatabaseUrl();
  const admin = new pg.Pool({ connectionString: base, connectionTimeoutMillis: 3000 });
  const names = [0, 1].map(() => `test_isolation_${randomUUID().replaceAll('-', '')}`);
  const created = [false, false];
  const pools = names.map(
    (schema) => new pg.Pool({ connectionString: testSchemaUrl(base, schema) }),
  );
  try {
    for (let i = 0; i < names.length; i++) {
      await admin.query(`CREATE SCHEMA "${names[i]}"`);
      created[i] = true;
    }
    await Promise.all(
      pools.map((pool, i) =>
        pool.query(`CREATE TABLE marker (value integer); INSERT INTO marker VALUES (${i})`),
      ),
    );
    const rows = await Promise.all(pools.map((pool) => pool.query('SELECT value FROM marker')));
    assert.deepEqual(
      rows.map((result) => result.rows[0].value),
      [0, 1],
    );
    await dropTestSchema(admin, names[0], created[0]);
    created[0] = false;
    assert.equal((await pools[1].query('SELECT value FROM marker')).rows[0].value, 1);
    const target = await admin.query(
      'SELECT to_regnamespace($1) AS removed, to_regnamespace($2) AS retained',
      names,
    );
    assert.equal(target.rows[0].removed, null);
    assert.ok(target.rows[0].retained);
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
    for (let i = 0; i < names.length; i++) await dropTestSchema(admin, names[i], created[i]);
    await admin.end();
  }
});
