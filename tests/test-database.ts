import assert from 'node:assert/strict';
import pg from 'pg';

// Test code must never silently fall back to the application database.
export function testDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) throw new Error('TEST_DATABASE_URL is required for database integration tests');
  return value;
}

export function testSchemaUrl(base: string, schema: string): string {
  assert.match(schema, /^test_(?:[a-z]+_)?[a-f0-9]{32}$/);
  const url = new URL(base);
  url.searchParams.set('options', `-c search_path=${schema}`);
  url.searchParams.set('schema', schema);
  return url.toString();
}

export async function verifyTestSchema(
  schema: string,
  prisma: { $queryRawUnsafe: (query: string) => Promise<unknown> },
): Promise<void> {
  const target = testSchemaUrl(testDatabaseUrl(), schema);
  assert.equal(process.env.DATABASE_URL, target, 'Prisma URL must target this test schema');
  const pool = new pg.Pool({ connectionString: target, connectionTimeoutMillis: 3000 });
  try {
    const pgTarget = await pool.query('SELECT current_schema() AS schema');
    assert.equal(pgTarget.rows[0].schema, schema, 'pg must target this test schema');
    const prismaTarget = (await prisma.$queryRawUnsafe(
      'SELECT current_schema() AS schema',
    )) as Array<{ schema: string }>;
    assert.equal(prismaTarget[0]?.schema, schema, 'Prisma must target this test schema');
  } finally {
    await pool.end();
  }
}

export async function dropTestSchema(
  admin: pg.Pool,
  schema: string,
  created: boolean,
): Promise<void> {
  assert.match(schema, /^test_(?:[a-z]+_)?[a-f0-9]{32}$/);
  if (created) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}
