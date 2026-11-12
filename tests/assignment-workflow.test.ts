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
import {
  canTransitionOffer,
  canTransitionSearch,
} from '../server/modules/assignment/domain/assignment-status.js';

const schema = `test_assignment_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 });
process.env.DATABASE_URL = testSchemaUrl(testDatabaseUrl(), schema);
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'AssignmentTest123!';
let created = false;
let db: typeof import('../server/shared/db.js');
let repository: typeof import('../server/modules/assignment/infrastructure/assignment.repository.js');

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  created = true;
  db = await import('../server/shared/db.js');
  await verifyTestSchema(schema, db.prisma);
  await (await import('../server/migrate.js')).migrate();
  await (await import('../server/seed/seed.js')).seed();
  repository = await import('../server/modules/assignment/infrastructure/assignment.repository.js');
  for (const n of [1, 2]) {
    await db.prisma.order.create({
      data: {
        id: `test-order-${n}`,
        customer_id: 'customer',
        restaurant_id: 'saigon',
        status: 'ACCEPTED',
        subtotal: 1000,
        delivery_fee: 0,
        total: 1000,
        address: 'test',
        idempotency_key: `test-key-${n}`,
        fingerprint: 'test',
        expires_at: new Date('2099-01-01T00:00:00Z'),
      },
    });
    await db.prisma.delivery.create({
      data: { id: `test-delivery-${n}`, order_id: `test-order-${n}` },
    });
  }
});
after(async () => {
  if (db) await db.prisma.$disconnect();
  await dropTestSchema(admin, schema, created);
  await admin.end();
});

test('durable search constraints, lease fencing and immutable attempts', async () => {
  const create = () =>
    db.prisma.$transaction((tx) => repository.createInitialSearch('test-delivery-1', 600, tx));
  const [first, repeated] = await Promise.all([create(), create()]);
  assert.equal(first.id, repeated.id);
  assert.equal(
    await db.prisma.assignmentSearch.count({ where: { delivery_id: 'test-delivery-1' } }),
    1,
  );
  await assert.rejects(
    db.prisma.assignmentSearch.create({
      data: {
        id: 'duplicate-live',
        delivery_id: 'test-delivery-1',
        generation: 2,
        deadline_at: new Date('2099-01-01T00:00:00Z'),
      },
    }),
  );
  const second = await db.prisma.$transaction((tx) =>
    repository.createInitialSearch('test-delivery-2', 600, tx),
  );
  await db.prisma.assignmentSearch.update({
    where: { id: second.id },
    data: { next_run_at: new Date('2099-01-01T00:00:00Z') },
  });
  const expiry = new Date('2099-01-01T00:00:00Z');
  await db.prisma.driverOffer.create({
    data: { id: 'offer-1', search_id: first.id, driver_id: 'driver', expires_at: expiry },
  });
  await assert.rejects(
    db.prisma.driverOffer.create({
      data: {
        id: 'duplicate-driver',
        search_id: second.id,
        driver_id: 'driver',
        expires_at: expiry,
      },
    }),
  );
  await assert.rejects(
    db.prisma.driverOffer.create({
      data: {
        id: 'duplicate-search',
        search_id: first.id,
        driver_id: 'driver2',
        expires_at: expiry,
      },
    }),
  );
  await repository.recordAttempt({
    searchId: first.id,
    driverId: 'driver',
    round: 1,
    offerId: 'offer-1',
    outcome: 'OFFERED',
  });
  await assert.rejects(
    repository.recordAttempt({
      searchId: first.id,
      driverId: 'driver',
      round: 2,
      outcome: 'INELIGIBLE',
    }),
  );
  assert.equal(await repository.transitionOffer('offer-1', 'OFFERED', 'REJECTED'), true);
  assert.equal(await repository.transitionOffer('offer-1', 'REJECTED', 'ACCEPTED'), false);
  assert.equal(await repository.resolveAttempt(first.id, 'driver', 'REJECTED', 'declined'), true);
  assert.equal(await repository.resolveAttempt(first.id, 'driver', 'ACCEPTED', undefined), false);
  assert.equal(
    (await db.prisma.assignmentAttempt.findFirstOrThrow({ where: { search_id: first.id } }))
      .outcome,
    'REJECTED',
  );
  const claims = await Promise.all([
    repository.claimDue('worker-a', 30),
    repository.claimDue('worker-b', 30),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  const old = claims.find((claim) => claim !== null)!;
  await db.prisma
    .$executeRaw`UPDATE assignment_searches SET lease_until = now() - interval '1 second' WHERE id = ${old.id}`;
  const next = await repository.claimDue('worker-new', 30);
  assert.ok(next);
  assert.equal(next.id, old.id);
  assert.ok(next.version > old.version);
  assert.equal(
    await repository.transitionClaimedSearch({
      id: old.id,
      generation: old.generation,
      version: old.version,
      owner: old.lease_owner,
      from: 'WAITING',
      to: 'SEARCHING',
    }),
    false,
  );
  assert.equal(
    await repository.transitionClaimedSearch({
      id: next.id,
      generation: next.generation,
      version: next.version,
      owner: next.lease_owner,
      from: 'WAITING',
      to: 'SEARCHING',
    }),
    true,
  );
  assert.equal(canTransitionSearch('ASSIGNED', 'SEARCHING'), false);
  assert.equal(canTransitionSearch('EXHAUSTED', 'WAITING'), false);
  assert.equal(canTransitionOffer('EXPIRED', 'ACCEPTED'), false);
});

test('candidate query uses module capabilities and excludes unavailable drivers', async () => {
  const search = await db.prisma.assignmentSearch.findUniqueOrThrow({
    where: { delivery_id_generation: { delivery_id: 'test-delivery-2', generation: 1 } },
  });
  const otherSearch = await db.prisma.assignmentSearch.findUniqueOrThrow({
    where: { delivery_id_generation: { delivery_id: 'test-delivery-1', generation: 1 } },
  });
  const names = [
    'ok',
    'inactive',
    'offline',
    'unready',
    'oldgps',
    'oldheartbeat',
    'busy',
    'far',
    'attempted',
    'offered',
  ];
  const userId = (name: string) => `candidate-${name}`;
  await db.prisma.user.createMany({
    data: names.map((name) => ({
      id: userId(name),
      email: `${name}@candidate.test`,
      name,
      password_hash: 'test',
      role: 'DRIVER',
      active: name !== 'inactive',
    })),
  });
  const time = (await db.prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`)[0].now;
  const old = new Date(time.getTime() - 120000);
  await db.prisma.driverLocation.createMany({
    data: names.map((name) => ({
      driver_id: userId(name),
      latitude: name === 'far' ? 22 : 21,
      longitude: 105,
      captured_at: name === 'oldgps' ? old : time,
      received_at: name === 'oldgps' ? old : time,
    })),
  });
  await db.prisma.driverAvailability.createMany({
    data: names.map((name) => ({
      driver_id: userId(name),
      online: name !== 'offline',
      ready: name !== 'unready',
      heartbeat_at: name === 'oldheartbeat' ? old : time,
    })),
  });
  await db.prisma.driverAssignment.create({
    data: {
      id: 'candidate-busy-assignment',
      delivery_id: 'test-delivery-2',
      driver_id: userId('busy'),
    },
  });
  await repository.recordAttempt({
    searchId: search.id,
    driverId: userId('attempted'),
    round: 1,
    outcome: 'INELIGIBLE',
    reason: 'test',
  });
  await db.prisma.driverOffer.create({
    data: {
      id: 'candidate-offered',
      search_id: otherSearch.id,
      driver_id: userId('offered'),
      expires_at: new Date('2099-01-01T00:00:00Z'),
    },
  });
  (await import('../server/modules/index.js')).registerModules();
  const selected = await (
    await import('../server/modules/assignment/index.js')
  ).findEligibleCandidates(search.id, { latitude: 21, longitude: 105 }, db.prisma);
  assert.deepEqual(
    selected.map((item) => item.driverId),
    [userId('ok')],
  );
});
