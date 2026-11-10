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
const { seed } = await import('../server/seed/seed.js');
await seed();
// The public catalog is the fictional Hanoi dataset; legacy demo rows are
// hidden by the same seed the application uses. No external API is called.
const { seedMockCatalog } = await import('../server/seed/seed-mock.js');
await seedMockCatalog();
// Browser tests must not depend on public geocoding/routing services. These
// deterministic adapters exercise the real service and fee code paths.
const { setGeocodingProvider } =
  await import('../server/modules/location/infrastructure/geocoding.client.js');
setGeocodingProvider({
  name: 'e2e-geocoder',
  async search(query) {
    const far = /Huế/i.test(query);
    return {
      address: query,
      formattedAddress: query + ', Hà Nội, Việt Nam',
      latitude: far ? 21.05 : 21.0301,
      longitude: far ? 105.86 : 105.8527,
      provider: 'e2e-geocoder',
    };
  },
  async reverse(latitude, longitude) {
    return {
      address: `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`,
      formattedAddress: `${latitude.toFixed(6)}, ${longitude.toFixed(6)}, Hà Nội, Việt Nam`,
      latitude,
      longitude,
      provider: 'e2e-geocoder',
    };
  },
});
const { setRoutingProvider } =
  await import('../server/modules/location/infrastructure/routing.client.js');
setRoutingProvider({
  name: 'e2e-pedestrian',
  async walkingRoute(from, to) {
    const distanceMeters = from.latitude > 21.045 ? 5_000 : 1_200;
    return {
      distanceMeters,
      durationSeconds: Math.round(distanceMeters / 1.2),
      routeGeometry: {
        type: 'LineString',
        coordinates: [
          [from.longitude, from.latitude],
          [to.longitude, to.latitude],
        ],
      },
      provider: 'e2e-pedestrian',
    };
  },
});
const { createApp } = await import('../server/app.js');
const { prisma } = await import('../server/shared/db.js');
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
