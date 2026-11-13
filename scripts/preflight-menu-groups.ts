import 'dotenv/config';
import pg from 'pg';
import { pathToFileURL } from 'node:url';

/** Read-only report matching the migration's normalization and uniqueness key. */
export async function inspectMenuGroups(db: pg.Pool | pg.PoolClient) {
  const result = await db.query<{
    restaurant_id: string;
    normalized_name: string;
    menu_ids: string[];
  }>(`
    SELECT restaurant_id, lower(btrim(name)) AS normalized_name, array_agg(id ORDER BY id) AS menu_ids
    FROM menus GROUP BY restaurant_id, lower(btrim(name)) HAVING count(*) > 1
    ORDER BY restaurant_id, lower(btrim(name))`);
  return { ok: result.rows.length === 0, conflicts: result.rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const url = new URL(process.env.DATABASE_URL);
  const schema = url.searchParams.get('schema') || 'public';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error('Invalid target schema');
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new pg.Pool({ connectionString: url.toString(), connectionTimeoutMillis: 3000 });
  try {
    if ((await pool.query('SELECT current_schema() AS schema')).rows[0]?.schema !== schema)
      throw new Error('Schema mismatch');
    const report = await inspectMenuGroups(pool);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch {
    console.error('Preflight could not query the database; check connectivity and permissions.');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
