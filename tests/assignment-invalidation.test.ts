import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import {
  testDatabaseUrl,
  testSchemaUrl,
  verifyTestSchema,
  dropTestSchema,
} from './test-database.js';

const schema = `test_operational_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 });
process.env.DATABASE_URL = testSchemaUrl(testDatabaseUrl(), schema);
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'OperationalTest123!';
let created = false;
let db: typeof import('../server/shared/db.js');
let worker: typeof import('../server/modules/assignment/application/operational-invalidation.service.js');

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
  (await import('../server/modules/index.js')).registerModules();
  worker =
    await import('../server/modules/assignment/application/operational-invalidation.service.js');
});
after(async () => {
  if (db) await db.prisma.$disconnect();
  await dropTestSchema(admin, schema, created);
  await admin.end();
});
async function fixture(suffix: string, state: 'OFFERED' | 'ASSIGNED' | 'PICKED_UP') {
  const driver = `operational-driver-${suffix}`;
  const delivery = `operational-delivery-${suffix}`;
  const order = `operational-order-${suffix}`;
  const search = `operational-search-${suffix}`;
  const now = new Date();
  await db.prisma.user.create({
    data: {
      id: driver,
      email: `${driver}@example.test`,
      name: driver,
      password_hash: 'test',
      role: 'DRIVER',
      active: true,
    },
  });
  await db.prisma.driverAvailability.create({
    data: { driver_id: driver, online: true, ready: true, heartbeat_at: now },
  });
  const restaurant = await db.prisma.restaurant.findUniqueOrThrow({ where: { id: 'saigon' } });
  await db.prisma.driverLocation.create({
    data: {
      driver_id: driver,
      latitude: restaurant.latitude!,
      longitude: restaurant.longitude!,
      captured_at: now,
      received_at: now,
    },
  });
  await db.prisma.order.create({
    data: {
      id: order,
      customer_id: 'customer',
      restaurant_id: 'saigon',
      status: 'ACCEPTED',
      subtotal: 1000,
      delivery_fee: 0,
      total: 1000,
      address: 'test',
      idempotency_key: order,
      fingerprint: 'test',
      expires_at: new Date('2099-01-01T00:00:00Z'),
    },
  });
  await db.prisma.delivery.create({
    data: {
      id: delivery,
      order_id: order,
      status: state === 'OFFERED' ? 'UNASSIGNED' : state,
      driver_id: state === 'OFFERED' ? null : driver,
    },
  });
  await db.prisma.assignmentSearch.create({
    data: {
      id: search,
      delivery_id: delivery,
      status: state === 'OFFERED' ? 'OFFERED' : 'ASSIGNED',
      offers_created: 1,
      deadline_at: new Date(now.getTime() + 600000),
      next_run_at: new Date(now.getTime() + 30000),
    },
  });
  if (state === 'OFFERED') {
    await db.prisma.driverOffer.create({
      data: {
        id: `offer-${suffix}`,
        search_id: search,
        driver_id: driver,
        expires_at: new Date(now.getTime() + 30000),
      },
    });
    await db.prisma.assignmentAttempt.create({
      data: {
        id: `attempt-${suffix}`,
        search_id: search,
        driver_id: driver,
        round: 1,
        offer_id: `offer-${suffix}`,
        outcome: 'OFFERED',
      },
    });
  } else {
    await db.prisma.driverAssignment.create({
      data: { id: `assignment-${suffix}`, delivery_id: delivery, driver_id: driver },
    });
  }
  return { driver, delivery, search };
}
async function enqueue(driver: string, suffix: string) {
  await db.prisma.driverOperationalChange.create({
    data: { id: `change-${suffix}`, driver_id: driver, source: 'TEST', reason: 'TEST' },
  });
}

test('offline driver revokes pending offer once and wakes candidate search', async () => {
  const f = await fixture('offer', 'OFFERED');
  await db.prisma.driverAvailability.update({
    where: { driver_id: f.driver },
    data: { online: false },
  });
  await enqueue(f.driver, 'offer');
  assert.equal(await worker.runOperationalInvalidation(50, true), 1);
  assert.equal(
    (await db.prisma.driverOffer.findUniqueOrThrow({ where: { id: 'offer-offer' } })).status,
    'REVOKED',
  );
  assert.equal(
    (await db.prisma.assignmentSearch.findUniqueOrThrow({ where: { id: f.search } })).status,
    'SEARCHING',
  );
  const attempt = await db.prisma.assignmentAttempt.findUniqueOrThrow({
    where: { id: 'attempt-offer' },
  });
  assert.equal(attempt.outcome, 'REVOKED');
  assert.equal(attempt.reason, 'DRIVER_OFFLINE');
  assert.equal(await worker.runOperationalInvalidation(50, true), 0);
});

test('locked account before pickup releases trip and schedules a new generation', async () => {
  const f = await fixture('assigned', 'ASSIGNED');
  await db.prisma.user.update({ where: { id: f.driver }, data: { active: false } });
  await enqueue(f.driver, 'assigned');
  assert.equal(await worker.runOperationalInvalidation(50, true), 1);
  const delivery = await db.prisma.delivery.findUniqueOrThrow({ where: { id: f.delivery } });
  assert.equal(delivery.status, 'UNASSIGNED');
  assert.equal(delivery.driver_id, null);
  assert.equal(
    (await db.prisma.driverAssignment.findUniqueOrThrow({ where: { id: 'assignment-assigned' } }))
      .end_reason,
    'ACCOUNT_INACTIVE',
  );
  assert.equal(
    await db.prisma.assignmentSearch.count({
      where: { delivery_id: f.delivery, generation: 2, status: 'WAITING' },
    }),
    1,
  );
  assert.equal(
    await db.prisma.outbox.count({
      where: {
        user_id: 'customer',
        type: 'ORDER_DRIVER_REVOKED',
        payload: { path: ['orderId'], equals: 'operational-order-assigned' },
      },
    }),
    1,
  );
});

test('admin retry creates one new generation and enforces eligibility and receipts', async () => {
  const f = await fixture('admin-retry', 'OFFERED');
  const actor = {
    ...(await db.prisma.user.findUniqueOrThrow({ where: { id: 'admin' } })),
    role: 'ADMIN' as const,
  };
  const { retrySearch } =
    await import('../server/modules/assignment/application/admin-retry.service.js');
  const input = { reason: 'Retry after operations review', idempotencyKey: 'retry-search-key-1' };
  await assert.rejects(retrySearch(actor, f.search, { ...input, reason: '' }));
  await assert.rejects(retrySearch(actor, f.search, input));
  await db.prisma.driverOffer.update({
    where: { id: 'offer-admin-retry' },
    data: { status: 'EXPIRED' },
  });
  await db.prisma.assignmentSearch.update({
    where: { id: f.search },
    data: { status: 'EXHAUSTED' },
  });
  const [first, replay] = await Promise.all([
    retrySearch(actor, f.search, input),
    retrySearch(actor, f.search, input),
  ]);
  assert.deepEqual(first, replay);
  assert.equal(first.generation, 2);
  assert.equal(await db.prisma.assignmentSearch.count({ where: { delivery_id: f.delivery } }), 2);
  assert.equal(
    await db.prisma.auditLog.count({
      where: { resource_id: f.search, action: 'ADMIN_SEARCH_RETRY' },
    }),
    1,
  );
  await assert.rejects(retrySearch(actor, f.search, { ...input, reason: 'Changed reason' }));
  await assert.rejects(
    retrySearch(actor, f.search, { ...input, idempotencyKey: 'another-retry-key' }),
  );
  const picked = await fixture('retry-picked-up', 'PICKED_UP');
  await db.prisma.assignmentSearch.update({
    where: { id: picked.search },
    data: { status: 'EXHAUSTED' },
  });
  await assert.rejects(
    retrySearch(actor, picked.search, { ...input, idempotencyKey: 'retry-picked-key' }),
  );
  const incident = await fixture('retry-incident', 'OFFERED');
  await db.prisma.driverOffer.update({
    where: { id: 'offer-retry-incident' },
    data: { status: 'REVOKED' },
  });
  await db.prisma.assignmentSearch.update({
    where: { id: incident.search },
    data: { status: 'CANCELLED' },
  });
  await db.prisma.deliveryIncident.create({
    data: {
      id: 'retry-incident-open',
      delivery_id: incident.delivery,
      order_id: 'operational-order-retry-incident',
      type: 'DRIVER_UNAVAILABLE',
      reason: 'Offline',
    },
  });
  assert.equal(
    (await retrySearch(actor, incident.search, { ...input, idempotencyKey: 'retry-incident-key' }))
      .generation,
    2,
  );
  const customer = {
    ...(await db.prisma.user.findUniqueOrThrow({ where: { id: 'customer' } })),
    role: 'CUSTOMER' as const,
  };
  await assert.rejects(retrySearch(customer, incident.search, input));
});

for (const winner of ['pickup', 'reassign'] as const) {
  test(`${winner} wins the order lock against the other operation`, async () => {
    const f = await fixture(`race-${winner}`, 'ASSIGNED');
    const replacement = await fixture(`replacement-${winner}`, 'OFFERED');
    await db.prisma.driverOffer.update({
      where: { id: `offer-replacement-${winner}` },
      data: { status: 'REVOKED' },
    });
    const orderId = `operational-order-race-${winner}`;
    await db.prisma.order.update({ where: { id: orderId }, data: { status: 'READY_FOR_PICKUP' } });
    const actor = {
      ...(await db.prisma.user.findUniqueOrThrow({ where: { id: 'admin' } })),
      role: 'ADMIN' as const,
    };
    const driver = {
      ...(await db.prisma.user.findUniqueOrThrow({ where: { id: f.driver } })),
      role: 'DRIVER' as const,
    };
    const { overrideDriver } =
      await import('../server/modules/assignment/application/admin-override.service.js');
    const { transition } =
      await import('../server/modules/delivery/application/delivery.service.js');
    const { detail } = await import('../server/modules/ordering/application/order-queries.js');
    const blocker = await admin.connect();
    try {
      await blocker.query(`SET search_path TO "${schema}"`);
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
      const pickup = () => transition(driver, f.delivery, { status: 'PICKED_UP' });
      const reassign = () =>
        overrideDriver(actor, f.delivery, {
          driverId: replacement.driver,
          reason: 'Driver unavailable',
          exceptionCode: 'DRIVER_UNAVAILABLE',
          idempotencyKey: `race-${winner}-key`,
        });
      const operations = winner === 'pickup' ? [pickup, reassign] : [reassign, pickup];
      const first = operations[0]();
      const waitFor = async (count: number) => {
        for (let i = 0; i < 100; i++) {
          const result = await admin.query(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%SELECT id FROM orders WHERE id =%' AND pid <> pg_backend_pid()",
          );
          if (result.rows[0].count >= count) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error('Commands did not reach order lock barrier');
      };
      await waitFor(1);
      const second = operations[1]();
      const results = Promise.allSettled([first, second]);
      await waitFor(2);
      await blocker.query('COMMIT');
      const outcomes = await results;
      assert.equal(outcomes[0].status, 'fulfilled');
      assert.equal(outcomes[1].status, 'rejected');
      const delivery = await db.prisma.delivery.findUniqueOrThrow({ where: { id: f.delivery } });
      if (winner === 'pickup') {
        assert.equal(delivery.status, 'PICKED_UP');
        assert.equal(delivery.driver_id, f.driver);
      } else {
        assert.equal(delivery.status, 'ASSIGNED');
        assert.equal(delivery.driver_id, replacement.driver);
        await assert.rejects(detail(driver, orderId));
        const audit = await db.prisma.auditLog.findFirstOrThrow({
          where: { action: 'ADMIN_DRIVER_OVERRIDE', resource_id: f.delivery },
        });
        assert.equal((audit.detail as any).oldDriverId, f.driver);
      }
      assert.equal(
        await db.prisma.driverAssignment.count({
          where: { delivery_id: f.delivery, active: true },
        }),
        1,
      );
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      await db.prisma.driverOperationalChange.deleteMany({
        where: { driver_id: replacement.driver, reason: 'ADMIN_OVERRIDE' },
      });
    }
  });
}

test('locked account after pickup retains occupancy and opens a single incident', async () => {
  const f = await fixture('pickup', 'PICKED_UP');
  await db.prisma.user.update({ where: { id: f.driver }, data: { active: false } });
  await enqueue(f.driver, 'pickup-1');
  await enqueue(f.driver, 'pickup-2');
  assert.equal(await worker.runOperationalInvalidation(50, true), 2);
  assert.equal(
    (await db.prisma.delivery.findUniqueOrThrow({ where: { id: f.delivery } })).status,
    'PICKED_UP',
  );
  assert.equal(
    (await db.prisma.driverAssignment.findUniqueOrThrow({ where: { id: 'assignment-pickup' } }))
      .active,
    true,
  );
  assert.equal(
    await db.prisma.deliveryIncident.count({ where: { delivery_id: f.delivery, status: 'OPEN' } }),
    1,
  );
});

test('freshness deadline revokes a live offer even without another driver event', async () => {
  const f = await fixture('deadline', 'OFFERED');
  await enqueue(f.driver, 'deadline');
  assert.equal(await worker.runOperationalInvalidation(50, true), 1);
  const timer = await db.prisma.driverOperationalChange.findFirstOrThrow({
    where: { driver_id: f.driver, source: 'RECHECK', processed_at: null },
  });
  await db.prisma
    .$executeRaw`UPDATE driver_operational_changes SET due_at = now() - interval '1 second' WHERE id = ${timer.id}`;
  await db.prisma
    .$executeRaw`UPDATE driver_availability SET heartbeat_at = now() - interval '120 seconds' WHERE driver_id = ${f.driver}`;
  assert.equal(await worker.runOperationalInvalidation(50, true), 1);
  assert.equal(
    (await db.prisma.driverOffer.findUniqueOrThrow({ where: { id: 'offer-deadline' } })).status,
    'REVOKED',
  );
  assert.equal(
    (await db.prisma.assignmentAttempt.findUniqueOrThrow({ where: { id: 'attempt-deadline' } }))
      .reason,
    'STALE_HEARTBEAT',
  );
});

test('lease expiration recovers pending work and restored state is revalidated', async () => {
  const f = await fixture('recovered', 'OFFERED');
  await enqueue(f.driver, 'recovered');
  await db.prisma
    .$executeRaw`UPDATE driver_operational_changes SET lease_owner = 'old-worker', lease_until = now() + interval '1 minute' WHERE id = 'change-recovered'`;
  assert.equal(await worker.runOperationalInvalidation(50, true), 0);
  await db.prisma
    .$executeRaw`UPDATE driver_operational_changes SET lease_until = now() - interval '1 second' WHERE id = 'change-recovered'`;
  assert.equal(await worker.runOperationalInvalidation(50, true), 1);
  assert.equal(
    (await db.prisma.driverOffer.findUniqueOrThrow({ where: { id: 'offer-recovered' } })).status,
    'OFFERED',
  );
  assert.ok(
    (
      await db.prisma.driverOperationalChange.findUniqueOrThrow({
        where: { id: 'change-recovered' },
      })
    ).processed_at,
  );
});

test('moving away from the restaurant after pickup does not create an incident', async () => {
  const f = await fixture('enroute', 'PICKED_UP');
  await db.prisma.driverLocation.update({
    where: { driver_id: f.driver },
    data: { latitude: 22, longitude: 106 },
  });
  await enqueue(f.driver, 'enroute');
  assert.equal(await worker.runOperationalInvalidation(50, true), 1);
  assert.equal(await db.prisma.deliveryIncident.count({ where: { delivery_id: f.delivery } }), 0);
  assert.equal(
    (await db.prisma.driverAssignment.findUniqueOrThrow({ where: { id: 'assignment-enroute' } }))
      .active,
    true,
  );
});

test('bootstrap is rerunnable, excludes confirmed orders and preserves assigned deliveries', async () => {
  const base = await fixture('bootstrap', 'OFFERED');
  const assigned = await fixture('bootstrap-assigned', 'ASSIGNED');
  const confirmed = await fixture('bootstrap-confirmed', 'OFFERED');
  for (const f of [base, confirmed]) {
    await db.prisma.assignmentAttempt.deleteMany({ where: { search_id: f.search } });
    await db.prisma.driverOffer.deleteMany({ where: { search_id: f.search } });
    await db.prisma.assignmentSearch.deleteMany({ where: { id: f.search } });
  }
  await db.prisma.order.update({
    where: { id: 'operational-order-bootstrap-confirmed' },
    data: { status: 'CONFIRMED' },
  });
  const { bootstrapAssignmentSearches } =
    await import('../server/modules/assignment/application/bootstrap.service.js');
  const [first, parallel] = await Promise.all([
    bootstrapAssignmentSearches(),
    bootstrapAssignmentSearches(),
  ]);
  assert.equal(first.created + parallel.created, 1);
  assert.equal(
    await db.prisma.assignmentSearch.count({ where: { delivery_id: base.delivery } }),
    1,
  );
  assert.equal(
    await db.prisma.assignmentSearch.count({ where: { delivery_id: confirmed.delivery } }),
    0,
  );
  assert.equal(
    (await db.prisma.delivery.findUniqueOrThrow({ where: { id: assigned.delivery } })).driver_id,
    assigned.driver,
  );
  assert.equal((await bootstrapAssignmentSearches()).created, 0);
});

test('admin override requires reason and eligibility, closes offer and replays its receipt', async () => {
  const f = await fixture('override', 'OFFERED');
  const { overrideDriver } =
    await import('../server/modules/assignment/application/admin-override.service.js');
  const adminUser = await db.prisma.user.findUniqueOrThrow({ where: { id: 'admin' } });
  const actor = {
    id: adminUser.id,
    name: adminUser.name,
    email: adminUser.email,
    role: 'ADMIN' as const,
    active: true,
  };
  const input = {
    driverId: f.driver,
    reason: 'Operational recovery',
    exceptionCode: 'OPERATIONAL_ERROR',
    idempotencyKey: 'override-key-123',
  };
  await assert.rejects(overrideDriver(actor, f.delivery, { ...input, reason: '' }));
  await db.prisma.driverAvailability.update({
    where: { driver_id: f.driver },
    data: { ready: false },
  });
  await assert.rejects(overrideDriver(actor, f.delivery, input));
  assert.equal(
    (await db.prisma.driverOffer.findUniqueOrThrow({ where: { id: 'offer-override' } })).status,
    'OFFERED',
  );
  await db.prisma.driverAvailability.update({
    where: { driver_id: f.driver },
    data: { ready: true },
  });
  const result = await overrideDriver(actor, f.delivery, input);
  assert.deepEqual(await overrideDriver(actor, f.delivery, input), result);
  await assert.rejects(overrideDriver(actor, f.delivery, { ...input, reason: 'Changed reason' }));
  assert.equal(
    (await db.prisma.driverOffer.findUniqueOrThrow({ where: { id: 'offer-override' } })).status,
    'REVOKED',
  );
  assert.equal(
    (await db.prisma.assignmentSearch.findUniqueOrThrow({ where: { id: f.search } })).status,
    'CANCELLED',
  );
  assert.equal(
    await db.prisma.driverAssignment.count({ where: { delivery_id: f.delivery, active: true } }),
    1,
  );
  assert.equal(
    await db.prisma.deliveryIncident.count({
      where: { delivery_id: f.delivery, type: 'ADMIN_OVERRIDE' },
    }),
    1,
  );
  assert.equal(
    await db.prisma.auditLog.count({
      where: { resource_id: f.delivery, action: 'ADMIN_DRIVER_OVERRIDE' },
    }),
    1,
  );
});

test('account lock wins while acceptance waits on the driver row', async () => {
  const f = await fixture('lock-race', 'OFFERED');
  const driver = await db.prisma.user.findUniqueOrThrow({ where: { id: f.driver } });
  const actor = {
    id: driver.id,
    name: driver.name,
    email: driver.email,
    role: 'DRIVER' as const,
    active: true,
  };
  const { respondToOffer } =
    await import('../server/modules/assignment/application/offer-response.service.js');
  const blocker = await admin.connect();
  try {
    await blocker.query(`SET search_path TO "${schema}"`);
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [f.driver]);
    const accepting = respondToOffer(
      actor,
      'offer-lock-race',
      { idempotencyKey: 'race-lock-123' },
      'ACCEPTED',
    ).then(
      () => 'accepted',
      () => 'rejected',
    );
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      const result = await admin.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%SELECT id FROM users WHERE id =%' AND pid <> pg_backend_pid()",
      );
      waiting = result.rowCount! > 0;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(waiting, true, 'accept must reach the database lock barrier');
    await blocker.query('UPDATE users SET active = false WHERE id = $1', [f.driver]);
    await blocker.query('COMMIT');
    assert.equal(await accepting, 'rejected');
    assert.equal(await db.prisma.driverAssignment.count({ where: { delivery_id: f.delivery } }), 0);
    assert.equal(
      (await db.prisma.driverOffer.findUniqueOrThrow({ where: { id: 'offer-lock-race' } })).status,
      'OFFERED',
    );
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined);
    blocker.release();
  }
});

test('override endpoint and legacy alias enforce the same contract and receipt', async () => {
  const f = await fixture('override-http', 'OFFERED');
  const server = (await import('../server/app.js')).createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  try {
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Bep' },
      body: JSON.stringify({ email: 'admin@bep.local', password: process.env.DEMO_PASSWORD }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Bep', cookie },
        body: JSON.stringify(body),
      });
    assert.equal(
      (await post(`/deliveries/${f.delivery}/assign`, { driverId: f.driver })).status,
      400,
    );
    const input = {
      driverId: f.driver,
      reason: 'Operational recovery',
      exceptionCode: 'NO_DRIVER',
      idempotencyKey: 'override-http-123',
    };
    const result = await post(`/admin/deliveries/${f.delivery}/reassign`, input);
    assert.equal(result.status, 200);
    const replay = await post(`/deliveries/${f.delivery}/assign`, input);
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), await result.json());
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('concurrent accept and reject produce only one offer outcome', async () => {
  const f = await fixture('response-race', 'OFFERED');
  const driver = await db.prisma.user.findUniqueOrThrow({ where: { id: f.driver } });
  const actor = {
    id: driver.id,
    name: driver.name,
    email: driver.email,
    role: 'DRIVER' as const,
    active: true,
  };
  const { respondToOffer } =
    await import('../server/modules/assignment/application/offer-response.service.js');
  const blocker = await admin.connect();
  try {
    await blocker.query(`SET search_path TO "${schema}"`);
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [f.driver]);
    const accept = respondToOffer(
      actor,
      'offer-response-race',
      { idempotencyKey: 'race-accept-123' },
      'ACCEPTED',
    );
    const reject = respondToOffer(
      actor,
      'offer-response-race',
      { idempotencyKey: 'race-reject-123', reason: 'Cannot take trip' },
      'REJECTED',
    );
    const results = Promise.allSettled([accept, reject]);
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      const result = await admin.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%SELECT id FROM users WHERE id =%' AND pid <> pg_backend_pid()",
      );
      waiting = result.rowCount! > 0;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(waiting, true, 'response must reach the database lock barrier');
    await blocker.query('COMMIT');
    const completed = await results;
    assert.equal(completed.filter((item) => item.status === 'fulfilled').length, 1);
    const offer = await db.prisma.driverOffer.findUniqueOrThrow({
      where: { id: 'offer-response-race' },
    });
    assert.ok(['ACCEPTED', 'REJECTED'].includes(offer.status));
    assert.equal(
      await db.prisma.driverAssignment.count({ where: { delivery_id: f.delivery, active: true } }),
      offer.status === 'ACCEPTED' ? 1 : 0,
    );
    assert.equal(
      (
        await db.prisma.assignmentAttempt.findUniqueOrThrow({
          where: { id: 'attempt-response-race' },
        })
      ).outcome,
      offer.status,
    );
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined);
    blocker.release();
  }
});

for (const invalidation of ['offline', 'expiry'] as const) {
  test(`accept rechecks ${invalidation} after waiting for the driver lock`, async () => {
    const f = await fixture(`race-${invalidation}`, 'OFFERED');
    const driver = await db.prisma.user.findUniqueOrThrow({ where: { id: f.driver } });
    const actor = {
      id: driver.id,
      name: driver.name,
      email: driver.email,
      role: 'DRIVER' as const,
      active: true,
    };
    const { respondToOffer } =
      await import('../server/modules/assignment/application/offer-response.service.js');
    const blocker = await admin.connect();
    try {
      await blocker.query(`SET search_path TO "${schema}"`);
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [f.driver]);
      const accepting = respondToOffer(
        actor,
        `offer-race-${invalidation}`,
        { idempotencyKey: `race-${invalidation}-key` },
        'ACCEPTED',
      ).then(
        () => 'accepted',
        () => 'rejected',
      );
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        const result = await admin.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%SELECT id FROM users WHERE id =%' AND pid <> pg_backend_pid()",
        );
        waiting = result.rowCount! > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(waiting, true, 'accept must reach the database lock barrier');
      if (invalidation === 'offline')
        await blocker.query('UPDATE driver_availability SET online = false WHERE driver_id = $1', [
          f.driver,
        ]);
      else
        await blocker.query(
          "UPDATE driver_offers SET expires_at = now() - interval '1 second' WHERE id = $1",
          [`offer-race-${invalidation}`],
        );
      await blocker.query('COMMIT');
      assert.equal(await accepting, 'rejected');
      assert.equal(
        await db.prisma.driverAssignment.count({ where: { delivery_id: f.delivery } }),
        0,
      );
      assert.equal(
        (
          await db.prisma.assignmentAttempt.findUniqueOrThrow({
            where: { id: `attempt-race-${invalidation}` },
          })
        ).outcome,
        'OFFERED',
      );
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  });
}

test('expiry worker and acceptance have a single valid outcome under contention', async () => {
  const f = await fixture('worker-expiry', 'OFFERED');
  const driver = await db.prisma.user.findUniqueOrThrow({ where: { id: f.driver } });
  const actor = {
    id: driver.id,
    name: driver.name,
    email: driver.email,
    role: 'DRIVER' as const,
    active: true,
  };
  const { respondToOffer } =
    await import('../server/modules/assignment/application/offer-response.service.js');
  const { runAssignmentWorker } =
    await import('../server/modules/assignment/application/search.service.js');
  await db.prisma
    .$executeRaw`UPDATE assignment_searches SET next_run_at = '2000-01-01T00:00:00Z' WHERE id = ${f.search}`;
  const blocker = await admin.connect();
  try {
    await blocker.query(`SET search_path TO "${schema}"`);
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [f.driver]);
    const expiry = runAssignmentWorker(true, 1);
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      const result = await admin.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%SELECT id FROM users WHERE id =%' AND pid <> pg_backend_pid()",
      );
      waiting = result.rowCount! > 0;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(waiting, true, 'expiry worker must reach the database lock barrier');
    const accepting = respondToOffer(
      actor,
      'offer-worker-expiry',
      { idempotencyKey: 'worker-expiry-key' },
      'ACCEPTED',
    ).then(
      () => 'accepted',
      () => 'rejected',
    );
    await blocker.query(
      "UPDATE driver_offers SET expires_at = now() - interval '1 second' WHERE id = 'offer-worker-expiry'",
    );
    await blocker.query('COMMIT');
    assert.equal(await expiry, 1);
    assert.equal(await accepting, 'rejected');
    assert.equal(
      (await db.prisma.driverOffer.findUniqueOrThrow({ where: { id: 'offer-worker-expiry' } }))
        .status,
      'EXPIRED',
    );
    assert.equal(
      (
        await db.prisma.assignmentAttempt.findUniqueOrThrow({
          where: { id: 'attempt-worker-expiry' },
        })
      ).outcome,
      'EXPIRED',
    );
    assert.equal(await db.prisma.driverAssignment.count({ where: { delivery_id: f.delivery } }), 0);
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined);
    blocker.release();
  }
});

test('cancellation cannot overtake acceptance for an already accepted order', async () => {
  const f = await fixture('cancel-race', 'OFFERED');
  const driver = await db.prisma.user.findUniqueOrThrow({ where: { id: f.driver } });
  const customer = await db.prisma.user.findUniqueOrThrow({ where: { id: 'customer' } });
  const driverActor = {
    id: driver.id,
    name: driver.name,
    email: driver.email,
    role: 'DRIVER' as const,
    active: true,
  };
  const customerActor = {
    id: customer.id,
    name: customer.name,
    email: customer.email,
    role: 'CUSTOMER' as const,
    active: true,
  };
  const { respondToOffer } =
    await import('../server/modules/assignment/application/offer-response.service.js');
  const { cancel } = await import('../server/modules/ordering/application/order-lifecycle.js');
  const blocker = await admin.connect();
  try {
    await blocker.query(`SET search_path TO "${schema}"`);
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [
      'operational-order-cancel-race',
    ]);
    const response = Promise.allSettled([
      respondToOffer(
        driverActor,
        'offer-cancel-race',
        { idempotencyKey: 'cancel-race-key' },
        'ACCEPTED',
      ),
      cancel(customerActor, 'operational-order-cancel-race', { reason: 'Changed plans' }),
    ]);
    let waiting = 0;
    for (let i = 0; i < 100 && waiting < 2; i++) {
      const result = await admin.query(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%SELECT id FROM orders WHERE id =%' AND pid <> pg_backend_pid()",
      );
      waiting = result.rows[0].count;
      if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(waiting >= 2, 'both commands must reach the database order lock barrier');
    await blocker.query('COMMIT');
    const [accept, cancellation] = await response;
    assert.equal(accept.status, 'fulfilled');
    assert.equal(cancellation.status, 'rejected');
    assert.equal(
      (await db.prisma.order.findUniqueOrThrow({ where: { id: 'operational-order-cancel-race' } }))
        .status,
      'ACCEPTED',
    );
    assert.equal(
      await db.prisma.driverAssignment.count({ where: { delivery_id: f.delivery, active: true } }),
      1,
    );
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined);
    blocker.release();
  }
});

test('two orders contend for one driver behind a PostgreSQL barrier', async () => {
  const first = await fixture('capacity-a', 'OFFERED');
  const second = await fixture('capacity-b', 'OFFERED');
  for (const f of [first, second]) {
    await db.prisma.assignmentAttempt.deleteMany({ where: { search_id: f.search } });
    await db.prisma.driverOffer.deleteMany({ where: { search_id: f.search } });
    await db.prisma.assignmentSearch.deleteMany({ where: { id: f.search } });
  }
  const adminUser = await db.prisma.user.findUniqueOrThrow({ where: { id: 'admin' } });
  const actor = {
    id: adminUser.id,
    name: adminUser.name,
    email: adminUser.email,
    role: 'ADMIN' as const,
    active: true,
  };
  const { overrideDriver } =
    await import('../server/modules/assignment/application/admin-override.service.js');
  const blocker = await admin.connect();
  try {
    await blocker.query(`SET search_path TO "${schema}"`);
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [first.driver]);
    const input = {
      driverId: first.driver,
      reason: 'Operational recovery',
      exceptionCode: 'NO_DRIVER',
    };
    const results = Promise.allSettled([
      overrideDriver(actor, first.delivery, { ...input, idempotencyKey: 'capacity-race-a' }),
      overrideDriver(actor, second.delivery, { ...input, idempotencyKey: 'capacity-race-b' }),
    ]);
    let waiting = 0;
    for (let i = 0; i < 100 && waiting < 2; i++) {
      const result = await admin.query(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%SELECT id FROM users WHERE id =%' AND pid <> pg_backend_pid()",
      );
      waiting = result.rows[0].count;
      if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(waiting >= 2, 'both commands must reach the driver lock barrier');
    await blocker.query('COMMIT');
    const completed = await results;
    assert.equal(completed.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(
      await db.prisma.driverAssignment.count({ where: { driver_id: first.driver, active: true } }),
      1,
    );
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined);
    blocker.release();
  }
});

test('concurrent administrative retries share one durable receipt', async () => {
  const f = await fixture('override-retry', 'OFFERED');
  const adminUser = await db.prisma.user.findUniqueOrThrow({ where: { id: 'admin' } });
  const actor = {
    id: adminUser.id,
    name: adminUser.name,
    email: adminUser.email,
    role: 'ADMIN' as const,
    active: true,
  };
  const { overrideDriver } =
    await import('../server/modules/assignment/application/admin-override.service.js');
  const input = {
    driverId: f.driver,
    reason: 'Operational recovery',
    exceptionCode: 'NO_DRIVER',
    idempotencyKey: 'concurrent-retry-key',
  };
  const [first, second] = await Promise.all([
    overrideDriver(actor, f.delivery, input),
    overrideDriver(actor, f.delivery, input),
  ]);
  assert.deepEqual(first, second);
  assert.equal(await db.prisma.driverAssignment.count({ where: { delivery_id: f.delivery } }), 1);
  assert.equal(
    await db.prisma.auditLog.count({
      where: { resource_id: f.delivery, action: 'ADMIN_DRIVER_OVERRIDE' },
    }),
    1,
  );
});

test('setting not-ready prevents new offers without revoking an existing trip', async () => {
  const f = await fixture('not-ready-active', 'ASSIGNED');
  await db.prisma.driverOperationalChange.deleteMany({ where: { processed_at: null } });
  await db.prisma.driverAvailability.update({
    where: { driver_id: f.driver },
    data: { ready: false },
  });
  await enqueue(f.driver, 'not-ready-active');
  assert.equal(await worker.runOperationalInvalidation(50, true), 1);
  assert.equal(
    (await db.prisma.delivery.findUniqueOrThrow({ where: { id: f.delivery } })).status,
    'ASSIGNED',
  );
  assert.equal(
    (
      await db.prisma.driverAssignment.findUniqueOrThrow({
        where: { id: 'assignment-not-ready-active' },
      })
    ).active,
    true,
  );
  assert.equal(await db.prisma.deliveryIncident.count({ where: { delivery_id: f.delivery } }), 0);
  assert.equal(
    await db.prisma.driverOperationalChange.count({
      where: { driver_id: f.driver, source: 'RECHECK', processed_at: null },
    }),
    1,
  );
});

test('setting not-ready revokes a pending offer', async () => {
  const f = await fixture('not-ready-offer', 'OFFERED');
  await db.prisma.driverAvailability.update({
    where: { driver_id: f.driver },
    data: { ready: false },
  });
  await enqueue(f.driver, 'not-ready-offer');
  assert.equal(await worker.runOperationalInvalidation(50, true), 1);
  assert.equal(
    (await db.prisma.driverOffer.findUniqueOrThrow({ where: { id: 'offer-not-ready-offer' } }))
      .status,
    'REVOKED',
  );
  assert.equal(
    (
      await db.prisma.assignmentAttempt.findUniqueOrThrow({
        where: { id: 'attempt-not-ready-offer' },
      })
    ).reason,
    'DRIVER_NOT_READY',
  );
});

test(
  'application startup bootstraps accepted legacy deliveries when enabled',
  { timeout: 20000 },
  async () => {
    const f = await fixture('startup', 'OFFERED');
    await db.prisma.assignmentAttempt.deleteMany({ where: { search_id: f.search } });
    await db.prisma.driverOffer.deleteMany({ where: { search_id: f.search } });
    await db.prisma.assignmentSearch.deleteMany({ where: { id: f.search } });
    const { spawn } = await import('node:child_process');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      LOG_REQUESTS: 'false',
      PAYMENT_WEBHOOK_SECRET: 'startup-test-webhook-secret-at-least-32-bytes',
    };
    env.ASSIGNMENT_AUTOMATION_ENABLED = 'true';
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const exited = new Promise<number | null>((resolve) => child.once('close', resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`startup timeout: ${output}`)), 12000);
        child.stdout.on('data', (data: Buffer) => {
          output += data.toString();
          if (output.includes('API:')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.stderr.on('data', (data: Buffer) => {
          output += data.toString();
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          reject(new Error(`startup exited ${code}: ${output}`));
        });
      });
      assert.equal(
        await db.prisma.assignmentSearch.count({
          where: { delivery_id: f.delivery, generation: 1 },
        }),
        1,
        `startup output: ${output}`,
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
  },
);
