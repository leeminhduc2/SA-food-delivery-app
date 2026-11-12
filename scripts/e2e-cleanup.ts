import 'dotenv/config';
import pg from 'pg';
// Windows may force-kill child processes without delivering SIGTERM. Always clean up in the runner.
export default async function cleanup() {
  const schema = process.env.E2E_SCHEMA!;
  if (!/^e2e_[a-f0-9]{32}$/.test(schema)) throw new Error('Invalid test schema; refusing cleanup.');
  const owner = process.env.E2E_OWNER;
  if (!owner || !process.env.TEST_DATABASE_URL)
    throw new Error('E2E_OWNER and TEST_DATABASE_URL are required.');
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    connectionTimeoutMillis: 3000,
  });
  try {
    const marker = await pool.query(
      "SELECT obj_description(oid, 'pg_namespace') AS token FROM pg_namespace WHERE nspname = $1",
      [schema],
    );
    if (marker.rows.length === 0) return;
    if (marker.rows.length !== 1 || marker.rows[0].token !== owner)
      throw new Error('E2E schema ownership mismatch; refusing cleanup.');
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  } finally {
    await pool.end();
  }
}
