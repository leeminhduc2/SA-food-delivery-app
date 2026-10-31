import 'dotenv/config';
import pg from 'pg';
// Windows may force-kill child processes without delivering SIGTERM. Always clean up in the runner.
export default async function cleanup() {
  const schema = process.env.E2E_SCHEMA!;
  if (!/^e2e_[a-f0-9]{32}$/.test(schema)) throw new Error('Invalid test schema; refusing cleanup.');
  const pool = new pg.Pool({
    connectionString:
      process.env.TEST_DATABASE_URL ||
      process.env.DATABASE_URL ||
      'postgres://food:food_local_only@localhost:5433/food_delivery',
  });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await pool.end();
  }
}
