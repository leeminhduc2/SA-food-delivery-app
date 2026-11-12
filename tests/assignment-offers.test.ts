import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';
import pg from 'pg';
import {
  testDatabaseUrl,
  testSchemaUrl,
  verifyTestSchema,
  dropTestSchema,
} from './test-database.js';
import type { User } from '../server/shared/types.js';

const schema = `test_offers_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 });
process.env.DATABASE_URL = testSchemaUrl(testDatabaseUrl(), schema);
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'OfferTest123!';
process.env.PAYMENT_MODE = 'simulated';
process.env.PAYMENT_WEBHOOK_SECRET = 'test-webhook-secret-only-123456789';
let created = false,
  server: Server,
  base = '';
let db: typeof import('../server/shared/db.js');
let respond: typeof import('../server/modules/assignment/application/offer-response.service.js').respondToOffer;
const cookies: Record<string, string> = {};
async function request(path: string, body: unknown, who: string) {
  const res = await fetch(`${base}/api${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'Bep',
      cookie: cookies[who],
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}
async function offerFixture(
  suffix: string,
  driverId: string,
  options: {
    active?: boolean;
    online?: boolean;
    ready?: boolean;
    stale?: boolean;
    far?: boolean;
    expired?: boolean;
    cancelled?: boolean;
    closedSearch?: boolean;
    busy?: boolean;
  } = {},
) {
  if (!['driver', 'driver2'].includes(driverId))
    await db.prisma.user.create({
      data: {
        id: driverId,
        email: `${driverId}@test`,
        name: driverId,
        password_hash: 'test',
        role: 'DRIVER',
        active: options.active ?? true,
      },
    });
  const now = (await db.prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`)[0].now;
  const stale = new Date(now.getTime() - 120000);
  await db.prisma.driverAvailability.upsert({
    where: { driver_id: driverId },
    create: {
      driver_id: driverId,
      online: options.online ?? true,
      ready: options.ready ?? true,
      heartbeat_at: now,
    },
    update: { online: options.online ?? true, ready: options.ready ?? true, heartbeat_at: now },
  });
  await db.prisma.driverLocation.upsert({
    where: { driver_id: driverId },
    create: {
      driver_id: driverId,
      latitude: options.far ? 22 : 21,
      longitude: 105,
      captured_at: options.stale ? stale : now,
      received_at: options.stale ? stale : now,
    },
    update: { captured_at: options.stale ? stale : now, received_at: options.stale ? stale : now },
  });
  await db.prisma.order.create({
    data: {
      id: `order-${suffix}`,
      customer_id: 'customer',
      restaurant_id: 'saigon',
      status: options.cancelled ? 'CANCELLED' : 'ACCEPTED',
      subtotal: 1000,
      delivery_fee: 10000,
      total: 11000,
      address: 'Private customer address',
      idempotency_key: `key-${suffix}`,
      fingerprint: 'test',
      expires_at: new Date('2099-01-01T00:00:00Z'),
    },
  });
  await db.prisma.delivery.create({
    data: { id: `delivery-${suffix}`, order_id: `order-${suffix}` },
  });
  await db.prisma.assignmentSearch.create({
    data: {
      id: `search-${suffix}`,
      delivery_id: `delivery-${suffix}`,
      status: options.closedSearch ? 'CANCELLED' : 'OFFERED',
      deadline_at: new Date(now.getTime() + 600000),
      offers_created: 1,
    },
  });
  await db.prisma.driverOffer.create({
    data: {
      id: `offer-${suffix}`,
      search_id: `search-${suffix}`,
      driver_id: driverId,
      expires_at: new Date(now.getTime() + (options.expired ? -1000 : 30000)),
    },
  });
  await db.prisma.assignmentAttempt.create({
    data: {
      id: `attempt-${suffix}`,
      search_id: `search-${suffix}`,
      driver_id: driverId,
      round: 1,
      offer_id: `offer-${suffix}`,
      outcome: 'OFFERED',
    },
  });
  if (options.busy) {
    await db.prisma.order.create({
      data: {
        id: `other-${suffix}`,
        customer_id: 'customer',
        restaurant_id: 'saigon',
        status: 'ACCEPTED',
        subtotal: 1000,
        delivery_fee: 0,
        total: 1000,
        address: 'test',
        idempotency_key: `other-${suffix}`,
        fingerprint: 'test',
        expires_at: new Date('2099-01-01T00:00:00Z'),
      },
    });
    await db.prisma.delivery.create({
      data: {
        id: `other-delivery-${suffix}`,
        order_id: `other-${suffix}`,
        driver_id: driverId,
        status: 'ASSIGNED',
      },
    });
    await db.prisma.driverAssignment.create({
      data: {
        id: `other-assignment-${suffix}`,
        delivery_id: `other-delivery-${suffix}`,
        driver_id: driverId,
      },
    });
  }
  return (await db.prisma.user.findUniqueOrThrow({ where: { id: driverId } })) as User;
}
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  created = true;
  db = await import('../server/shared/db.js');
  await verifyTestSchema(schema, db.prisma);
  await (await import('../server/migrate.js')).migrate();
  await (await import('../server/seed/seed.js')).seed();
  await db.prisma.restaurant.update({
    where: { id: 'saigon' },
    data: { latitude: 21, longitude: 105 },
  });
  const app = (await import('../server/app.js')).createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  for (const name of ['driver', 'driver2']) {
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Bep' },
      body: JSON.stringify({ email: `${name}@bep.local`, password: process.env.DEMO_PASSWORD }),
    });
    assert.equal(res.status, 200);
    cookies[name] = res.headers.get('set-cookie')!.split(';')[0];
  }
  respond = (await import('../server/modules/assignment/application/offer-response.service.js'))
    .respondToOffer;
});
after(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  if (db) await db.prisma.$disconnect();
  await dropTestSchema(admin, schema, created);
  await admin.end();
});

test('accept and reject are authorized, atomic and idempotent', async () => {
  await offerFixture('accept', 'driver');
  const key = { idempotencyKey: 'accept-key-0001' };
  assert.equal((await request('/driver/offers/offer-accept/accept', key, 'driver2')).status, 403);
  const results = await Promise.all([
    request('/driver/offers/offer-accept/accept', key, 'driver'),
    request('/driver/offers/offer-accept/accept', key, 'driver'),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    [200, 200],
  );
  assert.deepEqual(results[0].data, results[1].data);
  assert.equal(results[0].data.status, 'ACCEPTED');
  assert.equal(
    await db.prisma.driverAssignment.count({
      where: { delivery_id: 'delivery-accept', active: true },
    }),
    1,
  );
  assert.equal(
    await db.prisma.outbox.count({
      where: { type: 'DRIVER_ASSIGNMENT_CONFIRMED', user_id: 'driver' },
    }),
    1,
  );
  assert.equal(
    await db.prisma.auditLog.count({
      where: { action: 'OFFER_ACCEPTED', resource_id: 'offer-accept' },
    }),
    1,
  );
  const acceptedAudit = await db.prisma.auditLog.findFirstOrThrow({
    where: { action: 'OFFER_ACCEPTED', resource_id: 'offer-accept' },
  });
  assert.doesNotMatch(
    JSON.stringify(acceptedAudit.detail),
    /accept-key-0001|latitude|longitude|Private customer/,
  );
  assert.equal(
    (await db.prisma.assignmentAttempt.findUniqueOrThrow({ where: { id: 'attempt-accept' } }))
      .outcome,
    'ACCEPTED',
  );
  await offerFixture('reject', 'driver2');
  const reject = { idempotencyKey: 'reject-key-0001', reason: 'Too far away' };
  const first = await request('/driver/offers/offer-reject/reject', reject, 'driver2');
  assert.equal(first.status, 200);
  assert.deepEqual(
    (await request('/driver/offers/offer-reject/reject', reject, 'driver2')).data,
    first.data,
  );
  assert.equal(
    (
      await request(
        '/driver/offers/offer-reject/reject',
        { ...reject, reason: 'Different reason' },
        'driver2',
      )
    ).data.code,
    'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(
    (
      await request(
        '/driver/offers/offer-reject/reject',
        { ...reject, idempotencyKey: 'different-key-0001' },
        'driver2',
      )
    ).data.code,
    'OFFER_NOT_ACTIVE',
  );
  assert.equal(
    await db.prisma.auditLog.count({
      where: { action: 'OFFER_REJECTED', resource_id: 'offer-reject' },
    }),
    1,
  );
  assert.equal(
    (await db.prisma.assignmentSearch.findUniqueOrThrow({ where: { id: 'search-reject' } })).status,
    'SEARCHING',
  );
});

test('unavailable, expired and stale offers never leave a partial assignment', async () => {
  const cases: Array<[string, Parameters<typeof offerFixture>[2], string]> = [
    ['offline', { online: false }, 'DRIVER_OFFLINE'],
    ['unready', { ready: false }, 'DRIVER_NOT_READY'],
    ['stale', { stale: true }, 'STALE_LOCATION'],
    ['far', { far: true }, 'DRIVER_OUT_OF_RANGE'],
    ['busy', { busy: true }, 'DRIVER_BUSY'],
    ['expired', { expired: true }, 'OFFER_EXPIRED'],
    ['cancelled', { cancelled: true }, 'ORDER_NOT_ASSIGNABLE'],
    ['generation', { closedSearch: true }, 'OFFER_NOT_ACTIVE'],
    ['inactive', { active: false }, 'FORBIDDEN'],
  ];
  for (const [name, options, code] of cases) {
    const actor = await offerFixture(name, `test-${name}`, options);
    await assert.rejects(
      respond(actor, `offer-${name}`, { idempotencyKey: `response-${name}-key` }, 'ACCEPTED'),
      (error: any) => error.code === code,
      name,
    );
    assert.equal(
      await db.prisma.driverAssignment.count({ where: { delivery_id: `delivery-${name}` } }),
      0,
      name,
    );
    assert.equal(
      (await db.prisma.driverOffer.findUniqueOrThrow({ where: { id: `offer-${name}` } })).status,
      'OFFERED',
      name,
    );
  }
});

test('failure to persist audit rolls back assignment and offer changes', async () => {
  const actor = await offerFixture('rollback', 'test-rollback');
  await db.prisma.$executeRawUnsafe(
    `CREATE FUNCTION reject_offer_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'OFFER_ACCEPTED' THEN RAISE EXCEPTION 'forced receipt failure'; END IF; RETURN NEW; END $$`,
  );
  await db.prisma.$executeRawUnsafe(
    'CREATE TRIGGER reject_offer_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_offer_audit()',
  );
  try {
    await assert.rejects(
      respond(actor, 'offer-rollback', { idempotencyKey: 'rollback-key-0001' }, 'ACCEPTED'),
    );
  } finally {
    await db.prisma.$executeRawUnsafe('DROP TRIGGER reject_offer_audit ON audit_logs');
    await db.prisma.$executeRawUnsafe('DROP FUNCTION reject_offer_audit()');
  }
  assert.equal(
    await db.prisma.driverAssignment.count({ where: { delivery_id: 'delivery-rollback' } }),
    0,
  );
  assert.equal(
    (await db.prisma.driverOffer.findUniqueOrThrow({ where: { id: 'offer-rollback' } })).status,
    'OFFERED',
  );
  assert.equal(
    (await db.prisma.assignmentAttempt.findUniqueOrThrow({ where: { id: 'attempt-rollback' } }))
      .outcome,
    'OFFERED',
  );
});
