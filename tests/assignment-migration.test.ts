import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import pg from 'pg';
import { dropTestSchema, testDatabaseUrl, testSchemaUrl } from './test-database.js';

const execFileAsync = promisify(execFile);
test(
  'P05 migration upgrades existing active assignments and queued work without data loss',
  { timeout: 60000 },
  async () => {
    const schema = `test_migration_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({
      connectionString: testDatabaseUrl(),
      connectionTimeoutMillis: 3000,
    });
    const targetUrl = testSchemaUrl(testDatabaseUrl(), schema);
    const target = new pg.Pool({ connectionString: targetUrl, connectionTimeoutMillis: 3000 });
    const tempRoot = path.resolve('.tmp');
    await mkdir(tempRoot, { recursive: true });
    const tempDir = await mkdtemp(path.join(tempRoot, 'p05-migration-'));
    const relative = path.relative(tempRoot, tempDir);
    assert.ok(
      relative.startsWith('p05-migration-') &&
        !relative.includes('..') &&
        !path.isAbsolute(relative),
    );
    const prismaDir = path.join(tempDir, 'prisma');
    const migrationDir = path.join(prismaDir, 'migrations');
    const newMigrations = [
      '20261113030000_operational_invalidation',
      '20261113031000_admin_override_receipt',
    ];
    let created = false;
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      await mkdir(migrationDir, { recursive: true });
      await cp('prisma/schema.prisma', path.join(prismaDir, 'schema.prisma'));
      for (const entry of await readdir('prisma/migrations', { withFileTypes: true })) {
        if (!newMigrations.includes(entry.name))
          await cp(
            path.join('prisma/migrations', entry.name),
            path.join(migrationDir, entry.name),
            { recursive: true },
          );
      }
      const deploy = () =>
        execFileAsync(
          process.execPath,
          [
            path.resolve('node_modules/prisma/build/index.js'),
            'migrate',
            'deploy',
            '--schema',
            path.join(prismaDir, 'schema.prisma'),
          ],
          {
            env: {
              ...process.env,
              DATABASE_URL: targetUrl,
              DOTENV_CONFIG_PATH: '.env.test-does-not-exist',
            },
            timeout: 30000,
          },
        );
      await deploy();
      assert.equal(
        (await target.query('SELECT current_schema() AS schema')).rows[0].schema,
        schema,
      );
      await target.query(`
      INSERT INTO users(id,email,name,password_hash,role) VALUES ('legacy-customer','customer@legacy.test','Customer','x','CUSTOMER'),('legacy-driver','driver@legacy.test','Driver','x','DRIVER');
      INSERT INTO restaurants(id,name,description,address,cuisine,status) VALUES ('legacy-restaurant','Restaurant','','Address','Test','APPROVED');
      INSERT INTO orders(id,customer_id,restaurant_id,status,subtotal,delivery_fee,total,address,idempotency_key,fingerprint,expires_at) VALUES ('legacy-order','legacy-customer','legacy-restaurant','ACCEPTED',1000,0,1000,'Address','legacy-key','legacy',now()+interval '1 hour');
      INSERT INTO deliveries(id,order_id,driver_id,status) VALUES ('legacy-delivery','legacy-order','legacy-driver','ASSIGNED');
      INSERT INTO driver_assignments(id,delivery_id,driver_id,active) VALUES ('legacy-assignment','legacy-delivery','legacy-driver',true);
      INSERT INTO driver_operational_changes(id,driver_id,source,reason) VALUES ('legacy-work','legacy-driver','ACCOUNT','ACCOUNT_LOCKED');
    `);
      for (const name of newMigrations)
        await cp(path.join('prisma/migrations', name), path.join(migrationDir, name), {
          recursive: true,
        });
      await deploy();
      await deploy();
      const assignment = await target.query(
        "SELECT active,driver_id,delivery_id FROM driver_assignments WHERE id='legacy-assignment'",
      );
      assert.deepEqual(assignment.rows[0], {
        active: true,
        driver_id: 'legacy-driver',
        delivery_id: 'legacy-delivery',
      });
      const work = await target.query(
        "SELECT processed_at, lease_owner, lease_until, attempts, due_at FROM driver_operational_changes WHERE id='legacy-work'",
      );
      assert.equal(work.rows[0].processed_at, null);
      assert.equal(work.rows[0].lease_owner, null);
      assert.equal(work.rows[0].lease_until, null);
      assert.equal(work.rows[0].attempts, 0);
      assert.ok(work.rows[0].due_at instanceof Date);
      assert.equal(
        (await target.query('SELECT count(*)::int AS count FROM delivery_incidents')).rows[0].count,
        0,
      );
      assert.equal(
        (
          await target.query(
            'SELECT count(*)::int AS count FROM _prisma_migrations WHERE migration_name = ANY($1) AND finished_at IS NOT NULL',
            [newMigrations],
          )
        ).rows[0].count,
        2,
      );
    } finally {
      await target.end();
      await dropTestSchema(admin, schema, created);
      await admin.end();
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);
