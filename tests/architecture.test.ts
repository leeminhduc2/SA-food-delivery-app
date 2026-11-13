import {
  testDatabaseUrl,
  testSchemaUrl,
  verifyTestSchema,
  dropTestSchema,
} from './test-database.js';
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';
import pg from 'pg';
import {
  setGeocodingProvider,
  type GeocodingProvider,
} from '../server/modules/location/infrastructure/geocoding.client.js';
import {
  setRoutingProvider,
  type RoutingProvider,
} from '../server/modules/location/infrastructure/routing.client.js';

// Checkout now requires a saved, routed address. Keep these integration tests
// hermetic by replacing the external providers with instant fakes.
const fakeGeocoding: GeocodingProvider = {
  name: 'architecture-fake-geocoder',
  async search(query) {
    return {
      address: query,
      formattedAddress: query + ', Hà Nội, Việt Nam',
      latitude: 21.0301,
      longitude: 105.8527,
      provider: 'architecture-fake-geocoder',
    };
  },
  async reverse(latitude, longitude) {
    return {
      address: `${latitude}, ${longitude}`,
      formattedAddress: `Saved address (${latitude.toFixed(4)}, ${longitude.toFixed(4)})`,
      latitude,
      longitude,
      provider: 'architecture-fake-geocoder',
    };
  },
};
const fakeRouting: RoutingProvider = {
  name: 'architecture-fake-router',
  async walkingRoute(from, to) {
    return {
      distanceMeters: 1_200,
      durationSeconds: 1_000,
      routeGeometry: {
        type: 'LineString',
        coordinates: [
          [from.longitude, from.latitude],
          [to.longitude, to.latitude],
        ],
      },
      provider: 'architecture-fake-router',
    };
  },
};
setGeocodingProvider(fakeGeocoding);
setRoutingProvider(fakeRouting);
const schema = 'test_' + randomUUID().replaceAll('-', '');
const originalUrl = testDatabaseUrl();
const admin = new pg.Pool({ connectionString: originalUrl, connectionTimeoutMillis: 3000 });
process.env.DATABASE_URL = testSchemaUrl(originalUrl, schema);
const schemaPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 3000,
});
let schemaCreated = false;
process.env.NODE_ENV = 'test';
process.env.LOG_REQUESTS = 'false';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'ArchitectureTest123!';
process.env.PAYMENT_MODE = 'simulated';
process.env.ASSIGNMENT_AUTOMATION_ENABLED = 'false';
process.env.PAYMENT_WEBHOOK_SECRET = 'test-secret-for-signed-callback-validation';
let server: Server, base: string, db: any, payment: any, ops: any, jobs: any;
const cookies: Record<string, string> = {};
async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  actor = 'customer',
  extra: Record<string, string> = {},
) {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'Bep',
      cookie: cookies[actor] || '',
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json(), headers: response.headers };
}
function overrideInput(driverId: string, key = randomUUID()) {
  return {
    driverId,
    reason: 'Operational recovery',
    exceptionCode: 'OPERATIONAL_ERROR',
    idempotencyKey: key,
  };
}
async function prepareEligibleDrivers(...driverIds: string[]) {
  await db.prisma.restaurant.update({
    where: { id: 'saigon' },
    data: { latitude: 21, longitude: 105 },
  });
  for (const driverId of driverIds) {
    await schemaPool.query(
      `INSERT INTO driver_locations (driver_id, latitude, longitude, captured_at, received_at)
      VALUES ($1,21,105,now(),now()) ON CONFLICT (driver_id) DO UPDATE SET latitude=21,longitude=105,captured_at=now(),received_at=now()`,
      [driverId],
    );
    await schemaPool.query(
      `INSERT INTO driver_availability (driver_id,online,ready,heartbeat_at) VALUES ($1,true,true,now())
      ON CONFLICT (driver_id) DO UPDATE SET online=true,ready=true,heartbeat_at=now()`,
      [driverId],
    );
  }
}
const lines = [{ itemId: 'pho', quantity: 1, optionIds: [] }];
async function checkout(items = lines, key = randomUUID(), actor = 'customer') {
  const q = await request('/checkout/quote', 'POST', { items }, actor);
  assert.equal(q.status, 200, JSON.stringify(q.data));
  return request(
    '/checkout',
    'POST',
    {
      items,
      address: '12 Test Street, District 1',
      expectedTotal: q.data.total,
      idempotencyKey: key,
    },
    actor,
  );
}
async function pay(o: any, status = 'SUCCEEDED', eventId = randomUUID(), changes = {}) {
  const event = {
    eventId,
    reference: o.payment.reference,
    orderId: o.id,
    amount: o.total,
    currency: 'VND',
    status,
    externalTransactionId: 'ext_' + o.payment.reference,
    ...changes,
  };
  const raw = JSON.stringify(event);
  return request('/payments/webhook', 'POST', event, 'customer', {
    'x-payment-signature': payment.signature(raw),
  });
}
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  db = await import('../server/shared/db.js');
  await verifyTestSchema(schema, db.prisma);
  const { migrate } = await import('../server/migrate.js');
  await migrate();
  const { seed } = await import('../server/seed/seed.js');
  await seed();
  payment = await import('../server/modules/payment/index.js');
  jobs = await import('../server/jobs.js');
  ops = await import('../server/modules/notification/index.js');
  const { createApp } = await import('../server/app.js');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const address = server.address();
  assert(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  for (const actor of ['customer', 'restaurant', 'restaurant2', 'driver', 'driver2', 'admin']) {
    const r = await request('/auth/login', 'POST', {
      email: actor + '@bep.local',
      password: process.env.DEMO_PASSWORD,
    });
    assert.equal(r.status, 200);
    cookies[actor] = r.headers.get('set-cookie')!.split(';')[0];
  }
  const saved = await request(
    '/users/me/delivery-address',
    'PUT',
    { address: '12 Test Street, District 1', latitude: 21.03, longitude: 105.85 },
    'customer',
  );
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
});
after(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  if (db) await db.prisma.$disconnect();
  await schemaPool.end();
  assert.match(schema, /^test_[a-f0-9]{32}$/);
  await dropTestSchema(admin, schema, schemaCreated);
  await admin.end();
});
test('authentication, CSRF, registration, profile, role and account suspension', async () => {
  assert.equal((await request('/orders', 'GET', undefined, 'unknown')).status, 401);
  assert.equal((await request('/admin/overview')).status, 403);
  assert.equal(
    (await request('/auth/login', 'POST', { email: 'customer@bep.local', password: 'bad' })).status,
    401,
  );
  assert.equal(
    (
      await request('/auth/me', 'PATCH', { name: 'Wrong' }, 'customer', {
        origin: 'https://attacker.test',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request('/auth/register', 'POST', {
        name: 'Hacker',
        email: 'hacker@example.test',
        password: 'LongPassword123',
        role: 'ADMIN',
      })
    ).status,
    400,
  );
  const registration = await request('/auth/register', 'POST', {
    name: 'Another buyer',
    email: 'new@example.test',
    password: 'LongPassword123',
  });
  assert.equal(registration.status, 201);
  cookies.buyer2 = registration.headers.get('set-cookie')!.split(';')[0];
  assert.equal(
    (
      await request(
        '/users/me/delivery-address',
        'PUT',
        { address: '12 Test Street, District 1', latitude: 21.03, longitude: 105.85 },
        'buyer2',
      )
    ).status,
    200,
  );
  assert.equal(
    (await request('/auth/me', 'PATCH', { name: 'New name' }, 'buyer2')).data.name,
    'New name',
  );
  const u = await request('/auth/register', 'POST', {
    name: 'Pending driver',
    email: 'pending@example.test',
    password: 'LongPassword123',
    role: 'DRIVER',
  });
  assert.equal(u.data.pendingApproval, true);
  assert.equal(
    (await request('/admin/users/driver2', 'PATCH', { active: false }, 'admin')).status,
    400,
  );
  assert.equal((await db.prisma.user.findUnique({ where: { id: 'driver2' } })).active, true);
  assert.equal(
    await db.prisma.auditLog.count({ where: { action: 'ACCOUNT_STATUS', resource_id: 'driver2' } }),
    0,
  );
  await request(
    '/admin/users/driver2',
    'PATCH',
    { active: false, reason: 'Safety review' },
    'admin',
  );
  const statusAudit = await db.prisma.auditLog.findFirst({
    where: { action: 'ACCOUNT_STATUS', resource_id: 'driver2' },
  });
  assert.equal(statusAudit.resource_type, 'USER');
  assert.equal(statusAudit.outcome, 'SUCCESS');
  assert.ok(statusAudit.correlation_id);
  assert.equal(statusAudit.detail.reason, 'Safety review');
  assert.equal(
    await db.prisma.driverOperationalChange.count({
      where: { driver_id: 'driver2', source: 'ACCOUNT', reason: 'ACCOUNT_LOCKED' },
    }),
    1,
  );
  assert.equal((await request('/orders', 'GET', undefined, 'driver2')).status, 401);
  assert.equal(
    (await request('/driver/availability', 'PATCH', { ready: true }, 'driver2')).status,
    401,
  );
  await request(
    '/admin/users/driver2',
    'PATCH',
    { active: true, reason: 'Review complete' },
    'admin',
  );
  cookies.driver2 = (
    await request('/auth/login', 'POST', {
      email: 'driver2@bep.local',
      password: process.env.DEMO_PASSWORD,
    })
  ).headers
    .get('set-cookie')!
    .split(';')[0];
});
test('account status and its audit roll back together on audit failure', async () => {
  const changesBefore = await db.prisma.driverOperationalChange.count({
    where: { driver_id: 'driver2', source: 'ACCOUNT' },
  });
  await schemaPool.query(
    `CREATE FUNCTION reject_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'ACCOUNT_STATUS' AND NEW.detail->>'reason' = 'force audit failure' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$`,
  );
  await schemaPool.query(
    'CREATE TRIGGER reject_test_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_test_audit()',
  );
  try {
    const result = await request(
      '/admin/users/driver2',
      'PATCH',
      { active: false, reason: 'force audit failure' },
      'admin',
    );
    assert.equal(result.status, 500);
    assert.equal((await db.prisma.user.findUnique({ where: { id: 'driver2' } })).active, true);
    assert.equal(
      await db.prisma.driverOperationalChange.count({
        where: { driver_id: 'driver2', source: 'ACCOUNT' },
      }),
      changesBefore,
    );
    assert.equal(
      await db.prisma.auditLog.count({
        where: {
          action: 'ACCOUNT_STATUS',
          resource_id: 'driver2',
          detail: { path: ['reason'], equals: 'force audit failure' },
        },
      }),
      0,
    );
  } finally {
    await schemaPool.query('DROP TRIGGER reject_test_audit ON audit_logs');
    await schemaPool.query('DROP FUNCTION reject_test_audit()');
  }
});
test('discovery searches dishes; cart enforces single restaurant and optimistic version', async () => {
  const found = await request('/restaurants?q=Ph%E1%BB%9F');
  assert.equal(found.data.length, 1);
  assert.equal(found.data[0].id, 'saigon');
  const r = await request('/cart', 'PUT', { items: lines, version: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.data.version, 1);
  assert.equal((await request('/cart', 'PUT', { items: [], version: 0 })).status, 409);
  assert.equal(
    (
      await request('/cart', 'PUT', {
        items: [...lines, { itemId: 'bowl', quantity: 1, optionIds: [] }],
        version: 1,
      })
    ).data.code,
    'SINGLE_RESTAURANT',
  );
});
test('manual mode leaves an accepted unassigned delivery without an automatic search', async () => {
  const order = (await checkout()).data;
  await pay(order);
  assert.equal(
    (await request(`/orders/${order.id}/transition`, 'POST', { status: 'ACCEPTED' }, 'restaurant'))
      .status,
    200,
  );
  assert.equal(
    await db.prisma.assignmentSearch.count({ where: { delivery_id: order.delivery.id } }),
    0,
  );
});
test('checkout retry is atomic and payload conflicts are rejected', async () => {
  const key = randomUUID();
  const body = {
    items: lines,
    address: '12 Test Street, District 1',
    expectedTotal: 75_000,
    idempotencyKey: key,
    total: 1,
  };
  const responses = await Promise.all(
    Array.from({ length: 5 }, () => request('/checkout', 'POST', body)),
  );
  assert(
    responses.every((r) => r.status === 201),
    JSON.stringify(responses),
  );
  assert.equal(new Set(responses.map((r) => r.data.id)).size, 1);
  assert.equal(responses[0].data.total, 75_000);
  // A client-supplied address is ignored, so the conflict must come from a
  // field that is actually part of the canonical order payload.
  assert.equal(
    (await request('/checkout', 'POST', { ...body, note: 'different' })).data.code,
    'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(
    (await request('/orders/' + responses[0].data.id, 'GET', undefined, 'buyer2')).status,
    403,
  );
});
test('checkout replay survives catalog, address and router changes without reserving twice', async () => {
  const body = { items: lines, expectedTotal: 75_000, idempotencyKey: randomUUID() };
  const first = await request('/checkout', 'POST', body);
  assert.equal(first.status, 201);
  const stock = (await schemaPool.query("SELECT stock FROM menu_items WHERE id='pho'")).rows[0]
    .stock;
  const address = (
    await schemaPool.query(
      "SELECT id, address, is_default FROM addresses WHERE user_id='customer' AND is_default=true",
    )
  ).rows[0];
  assert.ok(address);
  let routerCalls = 0;
  try {
    await schemaPool.query("UPDATE menu_items SET stock=0 WHERE id='pho'");
    await schemaPool.query("UPDATE restaurants SET accepting_orders=false WHERE id='saigon'");
    await schemaPool.query('UPDATE addresses SET address=$1, is_default=false WHERE id=$2', [
      'Changed destination',
      address.id,
    ]);
    setRoutingProvider({
      name: 'unavailable',
      async walkingRoute() {
        routerCalls++;
        throw new Error('router unavailable');
      },
    });
    const replay = await request('/checkout', 'POST', body);
    assert.equal(replay.status, 201);
    assert.equal(replay.data.id, first.data.id);
    assert.equal(
      (await request('/checkout', 'POST', { ...body, note: 'changed' })).data.code,
      'IDEMPOTENCY_CONFLICT',
    );
    assert.equal(routerCalls, 0);
    assert.equal(
      (await schemaPool.query("SELECT stock FROM menu_items WHERE id='pho'")).rows[0].stock,
      0,
    );
    assert.equal(
      (await request('/checkout', 'POST', { ...body, idempotencyKey: randomUUID() })).data.code,
      'ADDRESS_REQUIRED',
    );
  } finally {
    setRoutingProvider(fakeRouting);
    await schemaPool.query("UPDATE menu_items SET stock=$1 WHERE id='pho'", [stock]);
    await schemaPool.query("UPDATE restaurants SET accepting_orders=true WHERE id='saigon'");
    await schemaPool.query('UPDATE addresses SET address=$1, is_default=$2 WHERE id=$3', [
      address.address,
      address.is_default,
      address.id,
    ]);
  }
});
test('concurrent exception assignments enforce one active trip and terminal failure releases it', async () => {
  const first = (await checkout()).data;
  const second = (await checkout()).data;
  await pay(first);
  await pay(second);
  for (const order of [first, second])
    assert.equal(
      (
        await request(
          `/orders/${order.id}/transition`,
          'POST',
          { status: 'ACCEPTED' },
          'restaurant',
        )
      ).status,
      200,
    );
  await prepareEligibleDrivers('driver');
  const keys = [randomUUID(), randomUUID()];
  const results = await Promise.all(
    [first, second].map((order, index) =>
      request(
        `/deliveries/${order.delivery.id}/assign`,
        'POST',
        overrideInput('driver', keys[index]),
        'admin',
      ),
    ),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal(results.find((result) => result.status === 409)?.data.code, 'DRIVER_BUSY');
  const winnerIndex = results[0].status === 200 ? 0 : 1;
  const winner = [first, second][winnerIndex];
  const loser = [second, first][winnerIndex];
  assert.equal(
    (
      await request(
        `/deliveries/${winner.delivery.id}/assign`,
        'POST',
        overrideInput('driver', keys[winnerIndex]),
        'admin',
      )
    ).status,
    200,
  );
  assert.equal(
    (await request('/driver/availability', 'PATCH', { online: false }, 'driver')).data.code,
    'ACTIVE_DELIVERY',
  );
  for (const status of ['PREPARING', 'READY_FOR_PICKUP'])
    assert.equal(
      (await request(`/orders/${winner.id}/transition`, 'POST', { status }, 'restaurant')).status,
      200,
    );
  assert.equal(
    (
      await request(
        `/deliveries/${winner.delivery.id}/transition`,
        'POST',
        { status: 'PICKED_UP' },
        'driver',
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        `/deliveries/${winner.delivery.id}/transition`,
        'POST',
        { status: 'FAILED', reason: 'Driver unavailable' },
        'driver',
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await db.prisma.driverAssignment.findFirstOrThrow({
        where: { delivery_id: winner.delivery.id },
      })
    ).end_reason,
    'FAILED',
  );
  await prepareEligibleDrivers('driver');
  assert.equal(
    (
      await request(
        `/deliveries/${loser.delivery.id}/assign`,
        'POST',
        overrideInput('driver'),
        'admin',
      )
    ).status,
    200,
  );
  for (const status of ['PREPARING', 'READY_FOR_PICKUP'])
    assert.equal(
      (await request(`/orders/${loser.id}/transition`, 'POST', { status }, 'restaurant')).status,
      200,
    );
  assert.equal(
    (
      await request(
        `/deliveries/${loser.delivery.id}/transition`,
        'POST',
        { status: 'PICKED_UP' },
        'driver',
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        `/deliveries/${loser.delivery.id}/transition`,
        'POST',
        { status: 'FAILED', reason: 'Driver unavailable' },
        'driver',
      )
    ).status,
    200,
  );
  await db.prisma.driverLocation.deleteMany({ where: { driver_id: 'driver' } });
  await db.prisma.driverAvailability.deleteMany({ where: { driver_id: 'driver' } });
});
test('driver availability requires fresh GPS and heartbeat does not refresh location', async () => {
  assert.equal((await request('/driver/availability', 'GET', undefined, 'customer')).status, 403);
  assert.equal(
    (await request('/driver/availability', 'PATCH', { online: true }, 'driver')).data.code,
    'STALE_LOCATION',
  );
  await schemaPool.query(
    "INSERT INTO driver_locations (driver_id, latitude, longitude, captured_at, received_at) VALUES ('driver',21,105,now(),now())",
  );
  assert.equal(
    (await request('/driver/availability', 'PATCH', { online: true, ready: true }, 'driver'))
      .status,
    200,
  );
  await schemaPool.query(
    "UPDATE driver_locations SET captured_at=now()-interval '100 seconds',received_at=now()-interval '100 seconds' WHERE driver_id='driver'",
  );
  await schemaPool.query(
    "UPDATE driver_availability SET heartbeat_at=now()-interval '100 seconds' WHERE driver_id='driver'",
  );
  const stale = await request('/driver/availability', 'GET', undefined, 'driver');
  assert.equal(stale.data.heartbeatFresh, false);
  assert.equal(stale.data.locationFresh, false);
  const beat = await request('/driver/heartbeat', 'POST', {}, 'driver');
  assert.equal(beat.status, 200);
  assert.equal(beat.data.heartbeatFresh, true);
  assert.equal(beat.data.locationFresh, false);
  assert.equal(
    (await request('/driver/availability', 'PATCH', { online: false, ready: false }, 'driver'))
      .status,
    200,
  );
  assert.ok(
    (
      await schemaPool.query(
        "SELECT count(*)::int AS n FROM driver_operational_changes WHERE driver_id='driver'",
      )
    ).rows[0].n >= 3,
  );
});
test('driver GPS validates ownership, time and rate without overwriting latest position', async () => {
  await db.prisma.driverLocation.deleteMany({ where: { driver_id: 'driver' } });
  const now = (await schemaPool.query('SELECT now() AS now')).rows[0].now as Date;
  const at = (seconds: number) => new Date(now.getTime() + seconds * 1000).toISOString();
  const input = { latitude: 21, longitude: 105, capturedAt: at(0) };
  assert.equal((await request('/driver/location', 'POST', input, 'customer')).status, 403);
  assert.equal(
    (await request('/driver/location', 'POST', { ...input, latitude: 91 }, 'driver')).status,
    400,
  );
  assert.equal(
    (await request('/driver/location', 'POST', { ...input, capturedAt: at(-100) }, 'driver')).data
      .code,
    'STALE_LOCATION',
  );
  assert.equal(
    (await request('/driver/location', 'POST', { ...input, capturedAt: at(20) }, 'driver')).data
      .code,
    'STALE_LOCATION',
  );
  assert.equal((await request('/driver/location', 'POST', input, 'driver')).status, 200);
  assert.equal(
    await db.prisma.driverOperationalChange.count({
      where: { driver_id: 'driver', source: 'LOCATION', reason: 'LOCATION_CHANGED' },
    }),
    1,
  );
  assert.equal(
    (await request('/driver/location', 'POST', input, 'driver')).data.code,
    'LOCATION_OUT_OF_ORDER',
  );
  assert.equal(
    (
      await request(
        '/driver/location',
        'POST',
        { ...input, latitude: 22, capturedAt: at(1) },
        'driver',
      )
    ).data.code,
    'LOCATION_RATE_LIMITED',
  );
  const row = await db.prisma.driverLocation.findUnique({ where: { driver_id: 'driver' } });
  assert.equal(row.latitude, 21);
  await schemaPool.query(
    "UPDATE driver_locations SET captured_at=now()-interval '20 minutes',received_at=now()-interval '20 minutes' WHERE driver_id='driver'",
  );
  await (await import('../server/modules/location/index.js')).purgeStaleDriverLocations();
  assert.equal(await db.prisma.driverLocation.findUnique({ where: { driver_id: 'driver' } }), null);
});
test('last serving concurrency permits exactly one checkout and never negative stock', async () => {
  await schemaPool.query("UPDATE menu_items SET stock=1 WHERE id='banhmi'");
  const body = {
    items: [{ itemId: 'banhmi', quantity: 1, optionIds: [] }],
    address: '12 Test Street, District 1',
    expectedTotal: 45_000,
  };
  const responses = await Promise.all([
    request('/checkout', 'POST', { ...body, idempotencyKey: randomUUID() }),
    request('/checkout', 'POST', { ...body, idempotencyKey: randomUUID() }, 'buyer2'),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  assert.equal(responses.find((r) => r.status === 409)!.data.code, 'OUT_OF_STOCK');
  assert.equal(
    (await schemaPool.query("SELECT stock FROM menu_items WHERE id='banhmi'")).rows[0].stock,
    0,
  );
});
test('all-or-nothing checkout, price revalidation, unavailable items, and options', async () => {
  const before = (await schemaPool.query("SELECT stock FROM menu_items WHERE id='rice'")).rows[0]
    .stock;
  const bad = await request('/checkout', 'POST', {
    items: [
      { itemId: 'rice', quantity: 1, optionIds: [] },
      { itemId: 'rolls', quantity: 1, optionIds: ['invented'] },
    ],
    address: '12 Test Street',
    expectedTotal: 120000,
    idempotencyKey: randomUUID(),
  });
  assert.equal(bad.data.code, 'INVALID_OPTION');
  assert.equal(
    (await schemaPool.query("SELECT stock FROM menu_items WHERE id='rice'")).rows[0].stock,
    before,
  );
  const changed = await request('/checkout', 'POST', {
    items: lines,
    address: '12 Test Street',
    expectedTotal: 1,
    idempotencyKey: randomUUID(),
  });
  assert.equal(changed.data.code, 'PRICE_CHANGED');
  const quote = await request('/checkout/quote', 'POST', {
    items: [{ itemId: 'pho', quantity: 2, optionIds: ['extra'] }],
  });
  assert.equal(quote.data.total, 170_000);
  await schemaPool.query("UPDATE menu_items SET available=false WHERE id='rolls'");
  assert.equal(
    (
      await request('/checkout/quote', 'POST', {
        items: [{ itemId: 'rolls', quantity: 1, optionIds: [] }],
      })
    ).data.code,
    'UNAVAILABLE',
  );
  await schemaPool.query("UPDATE menu_items SET available=true WHERE id='rolls'");
});
test('signed callbacks validate amount, currency and identity; duplicate confirmation has one effect', async () => {
  const o = (await checkout()).data;
  assert.equal(
    (await request('/payments/webhook', 'POST', {}, 'customer', { 'x-payment-signature': 'bad' }))
      .status,
    401,
  );
  assert.equal(
    (await pay(o, 'SUCCEEDED', randomUUID(), { amount: o.total + 1 })).data.code,
    'PAYMENT_MISMATCH',
  );
  assert.equal((await pay(o, 'SUCCEEDED', randomUUID(), { currency: 'USD' })).status, 400);
  const eventId = randomUUID();
  assert.equal((await pay(o, 'SUCCEEDED', eventId)).status, 200);
  assert.equal((await pay(o, 'SUCCEEDED', eventId)).data.duplicate, true);
  assert.equal((await pay(o)).data.duplicate, true);
  const saved = await request('/orders/' + o.id);
  assert.equal(saved.data.status, 'CONFIRMED');
  assert.equal(
    saved.data.history.filter((h: any) => h.entity === 'ORDER' && h.to_state === 'CONFIRMED')
      .length,
    1,
  );
  assert.equal((await pay(o, 'FAILED', eventId)).data.code, 'EVENT_CONFLICT');
});
test('restaurant ownership and invalid transitions preserve state and history', async () => {
  const o = (await checkout()).data;
  await pay(o);
  assert.equal((await request('/orders/' + o.id, 'GET', undefined, 'restaurant2')).status, 403);
  assert.equal(
    (await request(`/orders/${o.id}/transition`, 'POST', { status: 'ACCEPTED' }, 'restaurant2'))
      .status,
    403,
  );
  const before = (await request('/orders/' + o.id)).data;
  assert.equal(
    (
      await request(
        `/orders/${o.id}/transition`,
        'POST',
        { status: 'READY_FOR_PICKUP' },
        'restaurant',
      )
    ).status,
    409,
  );
  const after = (await request('/orders/' + o.id)).data;
  assert.equal(after.status, before.status);
  assert.equal(after.history.length, before.history.length);
  assert.equal(
    (await request(`/orders/${o.id}/review`, 'POST', { rating: 5, content: 'Good meal' })).data
      .code,
    'NOT_DELIVERED',
  );
});
test('complete lifecycle: preparation, reassignment, authorized delivery and buyer review', async () => {
  const o = (await checkout()).data;
  await pay(o);
  await prepareEligibleDrivers('driver', 'driver2');
  assert.equal(
    (await request(`/orders/${o.id}/transition`, 'POST', { status: 'ACCEPTED' }, 'restaurant'))
      .status,
    200,
  );
  assert.equal(
    (await request(`/deliveries/${o.delivery.id}/assign`, 'POST', overrideInput('driver'), 'admin'))
      .status,
    200,
  );
  const firstArrival = await request(
    `/deliveries/${o.delivery.id}/arrive`,
    'POST',
    { idempotencyKey: 'arrival-driver-0001' },
    'driver',
  );
  assert.equal(firstArrival.status, 200);
  assert.equal(
    (
      await request(
        `/deliveries/${o.delivery.id}/transition`,
        'POST',
        { status: 'PICKED_UP' },
        'driver',
      )
    ).data.code,
    'NOT_READY',
  );
  await request(`/deliveries/${o.delivery.id}/assign`, 'POST', overrideInput('driver2'), 'admin');
  assert.equal(
    (await db.prisma.delivery.findUniqueOrThrow({ where: { id: o.delivery.id } })).arrived_at,
    null,
  );
  assert.equal(
    (
      await request(
        `/deliveries/${o.delivery.id}/arrive`,
        'POST',
        { idempotencyKey: 'arrival-driver2-001' },
        'driver2',
      )
    ).status,
    200,
  );
  assert.equal(
    await db.prisma.outbox.count({
      where: {
        type: 'ORDER_DRIVER_ARRIVED',
        user_id: 'customer',
        payload: { path: ['orderId'], equals: o.id },
      },
    }),
    2,
  );
  await request(`/deliveries/${o.delivery.id}/assign`, 'POST', overrideInput('driver'), 'admin');
  assert.deepEqual(
    (
      await request(
        `/deliveries/${o.delivery.id}/arrive`,
        'POST',
        { idempotencyKey: 'arrival-driver-0001' },
        'driver',
      )
    ).data,
    firstArrival.data,
  );
  assert.equal(
    (await db.prisma.delivery.findUniqueOrThrow({ where: { id: o.delivery.id } })).arrived_at,
    null,
  );
  assert.equal(
    (
      await request(
        `/deliveries/${o.delivery.id}/arrive`,
        'POST',
        { idempotencyKey: 'arrival-driver-0002' },
        'driver',
      )
    ).status,
    200,
  );
  await request(`/deliveries/${o.delivery.id}/assign`, 'POST', overrideInput('driver2'), 'admin');
  assert.equal(
    (
      await request(
        `/deliveries/${o.delivery.id}/arrive`,
        'POST',
        { idempotencyKey: 'arrival-driver2-002' },
        'driver2',
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        `/deliveries/${o.delivery.id}/transition`,
        'POST',
        { status: 'PICKED_UP' },
        'driver',
      )
    ).status,
    403,
  );
  assert.equal((await request('/orders/' + o.id, 'GET', undefined, 'driver')).status, 403);
  const revokedHistory = await request(
    '/driver/deliveries/history?limit=1',
    'GET',
    undefined,
    'driver',
  );
  assert.equal(revokedHistory.status, 200);
  assert.equal(revokedHistory.data.items[0].result, 'REASSIGNED');
  assert.equal(revokedHistory.data.items[0].finalDriver, false);
  assert.ok(revokedHistory.data.nextCursor);
  const previousPage = await request(
    '/driver/deliveries/history?limit=1&cursor=' + revokedHistory.data.nextCursor,
    'GET',
    undefined,
    'driver',
  );
  assert.equal(previousPage.status, 200);
  assert.notEqual(
    previousPage.data.items[0].assignmentId,
    revokedHistory.data.items[0].assignmentId,
  );
  assert.equal(
    (await request('/driver/deliveries/history?cursor=invalid', 'GET', undefined, 'driver2'))
      .status,
    400,
  );
  for (const field of ['address', 'note', 'payment', 'location', 'items'])
    assert.equal(field in revokedHistory.data.items[0], false);
  for (const status of ['PREPARING', 'READY_FOR_PICKUP'])
    assert.equal(
      (await request(`/orders/${o.id}/transition`, 'POST', { status }, 'restaurant')).status,
      200,
    );
  assert.equal(
    await db.prisma.assignmentSearch.count({ where: { delivery_id: o.delivery.id } }),
    0,
    'manual mode must not start a search',
  );
  for (const status of ['PICKED_UP', 'IN_TRANSIT', 'DELIVERED'])
    assert.equal(
      (await request(`/deliveries/${o.delivery.id}/transition`, 'POST', { status }, 'driver2'))
        .status,
      200,
    );
  const deliveredAssignment = await schemaPool.query(
    "SELECT active, end_reason FROM driver_assignments WHERE delivery_id=$1 AND driver_id=$2 AND end_reason='DELIVERED'",
    [o.delivery.id, 'driver2'],
  );
  assert.deepEqual(deliveredAssignment.rows[0], { active: false, end_reason: 'DELIVERED' });
  const milestones = await db.prisma.delivery.findUnique({ where: { id: o.delivery.id } });
  assert.ok(milestones.picked_up_at);
  assert.ok(milestones.in_transit_at);
  assert.ok(milestones.delivered_at);
  assert.equal(milestones.failed_at, null);
  const finalDetail = await request('/orders/' + o.id, 'GET', undefined, 'driver2');
  assert.equal(finalDetail.status, 200);
  assert.ok(finalDetail.data.pickup.address);
  assert.equal('payment' in finalDetail.data, false);
  assert.equal((await request('/orders/' + o.id, 'GET', undefined, 'driver')).status, 403);
  assert.ok(
    (await request('/orders', 'GET', undefined, 'driver2')).data.some(
      (row: any) => row.id === o.id,
    ),
  );
  const history = await request('/driver/deliveries/history?limit=1', 'GET', undefined, 'driver2');
  assert.equal(history.status, 200);
  assert.equal(history.data.items[0].finalDriver, true);
  assert.equal(history.data.items[0].result, 'DELIVERED');
  const other = await request('/driver/deliveries/history', 'GET', undefined, 'customer');
  assert.equal(other.status, 403);
  assert.equal((await request('/orders/' + o.id)).data.status, 'DELIVERED');
  assert.equal(
    (
      await request(
        `/orders/${o.id}/review`,
        'POST',
        { rating: 5, content: 'Lovely food, arrived warm.' },
        'buyer2',
      )
    ).status,
    403,
  );
  const review = await request(`/orders/${o.id}/review`, 'POST', {
    rating: 5,
    content: 'Lovely food, arrived warm.',
  });
  assert.equal(review.status, 201);
  assert.equal(
    (await request(`/orders/${o.id}/review`, 'POST', { rating: 4, content: 'Duplicate' })).status,
    409,
  );
  assert.equal(
    (await request('/admin/reviews/' + review.data.id, 'PATCH', { hidden: true }, 'admin')).status,
    200,
  );
  assert.equal((await request('/restaurants/saigon')).data.reviews.length, 0);
  const report = (await request('/reports', 'GET', undefined, 'restaurant')).data;
  assert.equal(report.delivered, 1);
  assert.equal(Number(report.revenue), o.total);
});
test('failed payment and cancellation restore stock once; late success never reopens an order', async () => {
  const before = (await schemaPool.query("SELECT stock FROM menu_items WHERE id='pho'")).rows[0]
    .stock;
  const o = (await checkout()).data;
  assert.equal(
    (await request(`/orders/${o.id}/cancel`, 'POST', { reason: 'Changed plans' })).status,
    200,
  );
  assert.equal(
    (await request(`/orders/${o.id}/cancel`, 'POST', { reason: 'Changed plans' })).status,
    409,
  );
  assert.equal(
    (await schemaPool.query("SELECT stock FROM menu_items WHERE id='pho'")).rows[0].stock,
    before,
  );
  await pay(o);
  const saved = (await request('/orders/' + o.id)).data;
  assert.equal(saved.status, 'CANCELLED');
  assert.equal(saved.payment.status, 'REFUND_PENDING');
  assert.equal(saved.payment.reconciliation_required, true);
  const failed = (await checkout()).data;
  await pay(failed, 'FAILED');
  assert.equal((await request('/orders/' + failed.id)).data.status, 'PAYMENT_FAILED');
  assert.equal(
    (await schemaPool.query("SELECT stock FROM menu_items WHERE id='pho'")).rows[0].stock,
    before,
  );
});
test('expiration, crash recovery, query reconciliation and simulated refunds', async () => {
  const o = (await checkout()).data;
  await schemaPool.query("UPDATE orders SET expires_at=now()-interval '1 minute' WHERE id=$1", [
    o.id,
  ]);
  await jobs.runPaymentMaintenance();
  assert.equal((await request('/orders/' + o.id)).data.status, 'PAYMENT_FAILED');
  const pending = (await checkout()).data;
  await schemaPool.query('DELETE FROM simulated_transactions WHERE reference=$1', [
    pending.payment.reference,
  ]);
  await schemaPool.query('UPDATE payments SET provider_created=false WHERE id=$1', [
    pending.payment.id,
  ]);
  await jobs.runPaymentMaintenance();
  assert(
    (
      await schemaPool.query('SELECT * FROM simulated_transactions WHERE reference=$1', [
        pending.payment.reference,
      ])
    ).rowCount === 1,
  );
  await schemaPool.query(
    "UPDATE simulated_transactions SET status='SUCCEEDED' WHERE reference=$1",
    [pending.payment.reference],
  );
  await schemaPool.query('UPDATE payments SET next_reconcile_at=now() WHERE order_id=$1', [
    pending.id,
  ]);
  await jobs.runPaymentMaintenance();
  assert.equal((await request('/orders/' + pending.id)).data.status, 'CONFIRMED');
  await request(`/orders/${pending.id}/cancel`, 'POST', { reason: 'Please cancel' });
  await schemaPool.query('UPDATE payments SET next_reconcile_at=now() WHERE order_id=$1', [
    pending.id,
  ]);
  await jobs.runPaymentMaintenance();
  assert.equal((await request('/orders/' + pending.id)).data.payment.status, 'REFUNDED');
});
test('provider timeout keeps a recoverable pending order; outages do not hold stock forever', async () => {
  const original = payment.paymentAdapter.create;
  process.env.PROVIDER_TIMEOUT_MS = '20';
  payment.paymentAdapter.create = async () => new Promise(() => {});
  let o: any;
  try {
    o = (await checkout()).data;
    assert.equal(o.status, 'PENDING_PAYMENT');
    assert.equal(o.payment.provider_created, false);
    await schemaPool.query("UPDATE orders SET expires_at=now()-interval '1 second' WHERE id=$1", [
      o.id,
    ]);
    await jobs.runPaymentMaintenance();
    assert.equal((await request('/orders/' + o.id)).data.status, 'PAYMENT_FAILED');
  } finally {
    payment.paymentAdapter.create = original;
    delete process.env.PROVIDER_TIMEOUT_MS;
  }
  const next = (await checkout()).data;
  await schemaPool.query(
    'UPDATE payments SET provider_created=false,next_reconcile_at=now() WHERE id=$1',
    [next.payment.id],
  );
  await jobs.runPaymentMaintenance();
  assert.equal(
    (
      await schemaPool.query(
        'SELECT count(*)::int AS total FROM simulated_transactions WHERE reference=$1',
        [next.payment.reference],
      )
    ).rows[0].total,
    1,
  );
});
test('delivery failure requires a reason and stays distinct from successful delivery', async () => {
  const o = (await checkout()).data;
  await pay(o);
  await prepareEligibleDrivers('driver');
  assert.equal(
    (await request(`/orders/${o.id}/transition`, 'POST', { status: 'ACCEPTED' }, 'restaurant'))
      .status,
    200,
  );
  await request(`/deliveries/${o.delivery.id}/assign`, 'POST', overrideInput('driver'), 'admin');
  for (const status of ['PREPARING', 'READY_FOR_PICKUP'])
    await request(`/orders/${o.id}/transition`, 'POST', { status }, 'restaurant');
  assert.equal(
    (await request(`/orders/${o.id}/cancel`, 'POST', { reason: 'Too late' })).data.code,
    'CANCELLATION_NOT_ALLOWED',
  );
  await request(
    `/deliveries/${o.delivery.id}/transition`,
    'POST',
    { status: 'PICKED_UP' },
    'driver',
  );
  assert.equal(
    (
      await request(
        `/deliveries/${o.delivery.id}/transition`,
        'POST',
        { status: 'FAILED' },
        'driver',
      )
    ).data.code,
    'REASON_REQUIRED',
  );
  await schemaPool.query(
    `CREATE FUNCTION reject_failed_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity = 'DELIVERY' AND NEW.to_state = 'FAILED' THEN RAISE EXCEPTION 'forced history failure'; END IF; RETURN NEW; END $$`,
  );
  await schemaPool.query(
    'CREATE TRIGGER reject_failed_history BEFORE INSERT ON state_history FOR EACH ROW EXECUTE FUNCTION reject_failed_history()',
  );
  try {
    assert.equal(
      (
        await request(
          `/deliveries/${o.delivery.id}/transition`,
          'POST',
          { status: 'FAILED', reason: 'Customer unreachable' },
          'driver',
        )
      ).status,
      500,
    );
    assert.equal(
      (
        await schemaPool.query(
          'SELECT active FROM driver_assignments WHERE delivery_id=$1 AND driver_id=$2',
          [o.delivery.id, 'driver'],
        )
      ).rows[0].active,
      true,
    );
  } finally {
    await schemaPool.query('DROP TRIGGER reject_failed_history ON state_history');
    await schemaPool.query('DROP FUNCTION reject_failed_history()');
  }
  assert.equal(
    (
      await request(
        `/deliveries/${o.delivery.id}/transition`,
        'POST',
        { status: 'FAILED', reason: 'Customer unreachable' },
        'driver',
      )
    ).status,
    200,
  );
  assert.equal((await request('/orders/' + o.id)).data.status, 'DELIVERY_FAILED');
  assert.equal(
    await db.prisma.outbox.count({
      where: {
        user_id: 'admin',
        type: 'DELIVERY_FAILED',
        payload: { path: ['orderId'], equals: o.id },
      },
    }),
    1,
  );
  assert.equal(
    (
      await schemaPool.query(
        'SELECT end_reason FROM driver_assignments WHERE delivery_id=$1 AND driver_id=$2',
        [o.delivery.id, 'driver'],
      )
    ).rows[0].end_reason,
    'FAILED',
  );
});
test('outbox retry is idempotent, complaints are owned, sensitive actions audited', async () => {
  await ops.deliverNotifications();
  await ops.deliverNotifications();
  const counts = await schemaPool.query(
    'SELECT count(*)::int AS total,count(DISTINCT id)::int AS unique FROM notifications',
  );
  assert.equal(counts.rows[0].total, counts.rows[0].unique);
  assert(counts.rows[0].total > 0);
  const o = (await checkout()).data;
  assert.equal(
    (
      await request(
        `/orders/${o.id}/complaints`,
        'POST',
        { content: 'Help with this order please' },
        'buyer2',
      )
    ).status,
    403,
  );
  const c = await request(`/orders/${o.id}/complaints`, 'POST', {
    content: 'Help with this order please',
  });
  assert.equal(c.status, 201);
  assert.equal(
    (
      await request(
        `/admin/complaints/${c.data.id}/resolve`,
        'POST',
        { resolution: 'We contacted the kitchen.' },
        'admin',
      )
    ).status,
    200,
  );
  const audit = await schemaPool.query(
    "SELECT * FROM audit_logs WHERE action IN ('COMPLAINT_RESOLVED','INVALID_PAYMENT_SIGNATURE','ADMIN_DRIVER_OVERRIDE')",
  );
  assert(audit.rows.length >= 3);
});
test('restaurant registration approval, menu CRUD and cross-restaurant write protection', async () => {
  const r = await request(
    '/restaurants',
    'POST',
    {
      name: 'New kitchen',
      description: 'Fresh meals',
      address: '20 Test Street, District 2',
      cuisine: 'Vietnamese',
    },
    'restaurant',
  );
  assert.equal(r.status, 201);
  assert.equal((await request('/restaurants/' + r.data.id)).status, 403);
  assert.equal(
    (
      await request(
        `/admin/restaurants/${r.data.id}/approval`,
        'POST',
        { status: 'APPROVED' },
        'restaurant',
      )
    ).status,
    403,
  );
  await request(
    `/admin/restaurants/${r.data.id}/approval`,
    'POST',
    { status: 'APPROVED' },
    'admin',
  );
  const input = {
    name: 'Fresh dish',
    description: 'Test',
    price: 30000,
    stock: 3,
    available: true,
    category: 'Lunch',
    options: [],
  };
  const i = await request(`/restaurants/${r.data.id}/items`, 'POST', input, 'restaurant');
  assert.equal(i.status, 201);
  assert.equal(
    (await request('/items/' + i.data.id, 'PUT', { ...input, price: 35000 }, 'restaurant2')).status,
    403,
  );
  assert.equal(
    (await request('/items/' + i.data.id, 'PUT', { ...input, price: 35000 }, 'restaurant')).status,
    200,
  );
  assert.equal(
    (await request('/items/' + i.data.id, 'DELETE', undefined, 'restaurant')).status,
    200,
  );
  assert.equal(
    (
      await request('/checkout/quote', 'POST', {
        items: [{ itemId: i.data.id, quantity: 1, optionIds: [] }],
      })
    ).data.code,
    'UNAVAILABLE',
  );
});
