import 'dotenv/config';
import pg from 'pg';
import { pathToFileURL } from 'node:url';

export async function inspectDriverAssignments(db: pg.Pool | pg.PoolClient) {
  const assignments = await db.query(`
    SELECT a.id AS assignment_id, a.driver_id, a.delivery_id,
      CASE WHEN d.id IS NULL THEN 'ORPHAN_DELIVERY'
           WHEN u.id IS NULL OR u.role <> 'DRIVER' THEN 'MISSING_DRIVER'
           WHEN d.driver_id IS DISTINCT FROM a.driver_id THEN 'DRIVER_MISMATCH'
           WHEN d.status IN ('DELIVERED','FAILED','CANCELLED') THEN 'TERMINAL_ACTIVE'
           ELSE 'OPEN' END AS category
    FROM driver_assignments a LEFT JOIN deliveries d ON d.id=a.delivery_id
    LEFT JOIN users u ON u.id=a.driver_id WHERE a.active ORDER BY a.id`);
  const multiple =
    await db.query(`SELECT a.driver_id, array_agg(a.id ORDER BY a.id) AS assignment_ids
    FROM driver_assignments a JOIN deliveries d ON d.id=a.delivery_id
    WHERE a.active AND d.status NOT IN ('DELIVERED','FAILED','CANCELLED')
    GROUP BY a.driver_id HAVING count(*) > 1 ORDER BY a.driver_id`);
  const missing = await db.query(`SELECT d.id AS delivery_id, d.driver_id FROM deliveries d
    WHERE d.status IN ('ASSIGNED','PICKED_UP','IN_TRANSIT') AND
      (d.driver_id IS NULL OR NOT EXISTS (SELECT 1 FROM driver_assignments a
       WHERE a.delivery_id=d.id AND a.driver_id=d.driver_id AND a.active)) ORDER BY d.id`);
  const issues = assignments.rows.filter(
    (row) => !['OPEN', 'TERMINAL_ACTIVE'].includes(row.category),
  );
  return {
    terminalActive: assignments.rows.filter((row) => row.category === 'TERMINAL_ACTIVE'),
    issues,
    multiple: multiple.rows,
    missing: missing.rows,
    ok: issues.length === 0 && multiple.rowCount === 0 && missing.rowCount === 0,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const url = new URL(process.env.DATABASE_URL);
  const schema = url.searchParams.get('schema') || 'public';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error('Invalid target schema');
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new pg.Pool({
    connectionString: url.toString(),
    connectionTimeoutMillis: 3000,
  });
  try {
    const target = await pool.query('SELECT current_schema() AS schema');
    if (target.rows[0]?.schema !== schema) throw new Error('Schema mismatch');
    const report = await inspectDriverAssignments(pool);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch {
    console.error('Preflight could not query the database; check connectivity and permissions.');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
