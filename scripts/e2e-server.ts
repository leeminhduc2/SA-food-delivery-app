import 'dotenv/config';
import pg from 'pg';
const schema = process.env.E2E_SCHEMA!;
if (!/^e2e_[a-f0-9]{32}$/.test(schema)) throw new Error('An isolated E2E_SCHEMA is required.');
const url = new URL(
  process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL ||
    'postgres://food:food_local_only@localhost:5433/food_delivery',
);
const admin = new pg.Pool({ connectionString: url.toString() });
await admin.query(`CREATE SCHEMA ${schema}`);
url.searchParams.set('options', `-c search_path=${schema}`);
// Prisma reads `schema`; libpq-based pg pools read `options`.
url.searchParams.set('schema', schema);
process.env.DATABASE_URL = url.toString();
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'BrowserTest123!';
process.env.PAYMENT_MODE = 'simulated';
process.env.PAYMENT_WEBHOOK_SECRET = 'browser-test-webhook-secret-only-123';
process.env.APP_ORIGIN = 'http://127.0.0.1:5174';
process.env.LOG_REQUESTS = 'false';
process.env.NODE_ENV = 'test';
const { migrate } = await import('../server/migrate.js');
await migrate();
const { seed } = await import('../server/seed.js');
await seed();
const { createApp } = await import('../server/app.js');
const { prisma } = await import('../server/db.js');
const server = createApp().listen(3002, '127.0.0.1');
async function close() {
  server.close(async () => {
    await prisma.$disconnect();
    if (!/^e2e_[a-f0-9]{32}$/.test(schema)) throw new Error('Unexpected schema');
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    process.exit(0);
  });
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
