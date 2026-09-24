import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL || 'postgres://food:food_local_only@localhost:55432/food_delivery',
  max: 12,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
export type DB = Pick<pg.PoolClient, 'query'>;
export const id = () => randomUUID();
export async function transaction<T>(fn: (db: DB) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
export async function one(db: DB, sql: string, params: unknown[] = []) {
  return (await db.query(sql, params)).rows[0];
}
