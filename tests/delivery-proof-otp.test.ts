import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { parseDeliveryConfig } from '../server/modules/delivery/config.js';
import {
  testDatabaseUrl,
  testSchemaUrl,
  verifyTestSchema,
  dropTestSchema,
} from './test-database.js';

const schema = `test_otp_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 });
const target = testSchemaUrl(testDatabaseUrl(), schema);
const pool = new pg.Pool({ connectionString: target, connectionTimeoutMillis: 3000 });
process.env.DATABASE_URL = target;
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'OtpProofTest123!';
process.env.LOG_REQUESTS = 'false';
process.env.ASSIGNMENT_AUTOMATION_ENABLED = 'false';
let created = false,
  server: Server,
  base = '';
let db: typeof import('../server/shared/db.js');
const cookies: Record<string, string> = {};
test('OTP policy has bounded configurable expiry and attempt limits', () => {
  const defaults = parseDeliveryConfig({});
  assert.equal(defaults.DELIVERY_OTP_TTL_SECONDS, 600);
  assert.equal(defaults.DELIVERY_OTP_MAX_ATTEMPTS, 5);
  assert.equal(defaults.DELIVERY_PROOF_REQUIRED, true);
  assert.equal(defaults.DELIVERY_PROOF_MAX_BYTES, 5242880);
  assert.equal(defaults.DELIVERY_PROOF_RETENTION_DAYS, 30);
  assert.equal(defaults.DELIVERY_PROOF_STORAGE_DIR, '.data/delivery-proofs');
  const custom = parseDeliveryConfig({
    DELIVERY_OTP_TTL_SECONDS: '30',
    DELIVERY_OTP_MAX_ATTEMPTS: '3',
    DELIVERY_PROOF_REQUIRED: 'false',
  });
  assert.equal(custom.DELIVERY_OTP_TTL_SECONDS, 30);
  assert.equal(custom.DELIVERY_OTP_MAX_ATTEMPTS, 3);
  assert.equal(custom.DELIVERY_PROOF_REQUIRED, false);
  assert.throws(() => parseDeliveryConfig({ DELIVERY_PROOF_REQUIRED: 'yes' }));
  assert.throws(() => parseDeliveryConfig({ DELIVERY_PROOF_MAX_BYTES: '5242881' }));
  for (const value of ['0', '-1', '601', 'abc'])
    assert.throws(() => parseDeliveryConfig({ DELIVERY_OTP_TTL_SECONDS: value }));
  assert.throws(() => parseDeliveryConfig({ DELIVERY_OTP_MAX_ATTEMPTS: '6' }));
});
async function request(path: string, who: string, body?: unknown, method = 'POST') {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'Bep',
      cookie: cookies[who] ?? '',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json(), headers: response.headers };
}
async function login(who: string, email = `${who}@bep.local`) {
  const response = await request('/auth/login', '', { email, password: process.env.DEMO_PASSWORD });
  assert.equal(response.status, 200);
  cookies[who] = response.headers.get('set-cookie')!.split(';')[0];
}
async function fixture(suffix: string) {
  const order = `otp-order-${suffix}`,
    delivery = `otp-delivery-${suffix}`,
    driver = `otp-driver-${suffix}`,
    assignment = `otp-assignment-${suffix}`;
  const password = (await db.prisma.user.findUniqueOrThrow({ where: { id: 'driver' } }))
    .password_hash;
  await db.prisma.user.create({
    data: {
      id: driver,
      email: `${driver}@test.local`,
      name: driver,
      role: 'DRIVER',
      active: true,
      password_hash: password,
    },
  });
  await login(driver, `${driver}@test.local`);
  await db.prisma.order.create({
    data: {
      id: order,
      customer_id: 'customer',
      restaurant_id: 'saigon',
      status: 'OUT_FOR_DELIVERY',
      subtotal: 1000,
      delivery_fee: 0,
      total: 1000,
      address: 'private',
      idempotency_key: order,
      fingerprint: 'test',
      expires_at: new Date('2099-01-01T00:00:00Z'),
    },
  });
  await db.prisma.delivery.create({
    data: { id: delivery, order_id: order, driver_id: driver, status: 'PICKED_UP' },
  });
  await db.prisma.driverAssignment.create({
    data: { id: assignment, delivery_id: delivery, driver_id: driver, active: true },
  });
  return { order, delivery, driver, assignment };
}
const create = (order: string, key: string, who = 'customer') =>
  request(`/orders/${order}/delivery-proof/otp`, who, { idempotencyKey: key });
const verify = (delivery: string, who: string, challengeId: string, otp: string, key: string) =>
  request(`/deliveries/${delivery}/proofs/otp`, who, { challengeId, otp, idempotencyKey: key });
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  created = true;
  db = await import('../server/shared/db.js');
  await verifyTestSchema(schema, db.prisma);
  await (await import('../server/migrate.js')).migrate();
  await (await import('../server/seed/seed.js')).seed();
  const password = (await db.prisma.user.findUniqueOrThrow({ where: { id: 'customer' } }))
    .password_hash;
  await db.prisma.user.create({
    data: {
      id: 'customer-other',
      email: 'customer-other@test.local',
      name: 'Other',
      role: 'CUSTOMER',
      active: true,
      password_hash: password,
    },
  });
  server = (await import('../server/app.js')).createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  for (const who of ['customer', 'restaurant', 'driver', 'driver2', 'admin']) await login(who);
  await login('customer-other', 'customer-other@test.local');
});
after(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  if (db) await db.prisma.$disconnect();
  await pool.end();
  await dropTestSchema(admin, schema, created);
  await admin.end();
});

test('only owner receives plaintext once and secrets never enter order, audit or outbox', async () => {
  const f = await fixture('private');
  for (const who of ['restaurant', 'driver', 'admin', 'customer-other'])
    assert.equal((await create(f.order, 'create-private-key', who)).status, 403);
  const first = await create(f.order, 'create-private-key');
  assert.equal(first.status, 200);
  assert.match(first.data.otp, /^\d{6}$/);
  assert.match(first.headers.get('cache-control') ?? '', /no-store/);
  const replay = await create(f.order, 'create-private-key');
  assert.equal(replay.data.challengeId, first.data.challengeId);
  assert.equal(replay.data.otp, null);
  const stored = (
    await pool.query('SELECT salt,otp_hash FROM delivery_otp_challenges WHERE id=$1', [
      first.data.challengeId,
    ])
  ).rows[0];
  assert.notEqual(stored.otp_hash, first.data.otp);
  assert.equal(stored.salt.length, 32);
  assert.equal(stored.otp_hash.length, 128);
  for (const who of ['customer', f.driver, 'restaurant', 'admin']) {
    const response = await request(`/orders/${f.order}`, who, undefined, 'GET');
    assert.equal(response.status, 200);
    assert.ok(!JSON.stringify(response.data).includes(`"${first.data.otp}"`));
  }
  const sideEffects = await pool.query(
    "SELECT detail::text AS body FROM audit_logs WHERE resource_id=$1 UNION ALL SELECT payload::text FROM outbox WHERE payload->>'orderId'=$2",
    [f.delivery, f.order],
  );
  assert.ok(!JSON.stringify(sideEffects.rows).includes(`"${first.data.otp}"`));
});

test('concurrent creation with one key reveals the code only once', async () => {
  const f = await fixture('concurrent-create');
  const [first, second] = await Promise.all([
    create(f.order, 'concurrent-create-key'),
    create(f.order, 'concurrent-create-key'),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.data.challengeId, second.data.challengeId);
  assert.equal([first.data.otp, second.data.otp].filter((value) => value !== null).length, 1);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int AS n FROM delivery_otp_challenges WHERE order_id=$1', [
        f.order,
      ])
    ).rows[0].n,
    1,
  );
});

test('wrong OTP attempts commit once per key and the fifth locks the challenge', async () => {
  const f = await fixture('lock'),
    challenge = (await create(f.order, 'create-lock-key')).data;
  const wrong = challenge.otp === '000000' ? '000001' : '000000';
  assert.equal(
    (await verify(f.delivery, 'driver2', challenge.challengeId, challenge.otp, 'other-driver-key'))
      .status,
    403,
  );
  assert.equal(
    (
      await verify(
        f.delivery,
        'customer',
        challenge.challengeId,
        challenge.otp,
        'customer-verify-key',
      )
    ).status,
    403,
  );
  const [first, replay] = await Promise.all([
    verify(f.delivery, f.driver, challenge.challengeId, wrong, 'wrong-attempt-key'),
    verify(f.delivery, f.driver, challenge.challengeId, wrong, 'wrong-attempt-key'),
  ]);
  assert.equal(first.status, 400);
  assert.equal(replay.status, 400);
  assert.equal(
    (await verify(f.delivery, f.driver, challenge.challengeId, challenge.otp, 'wrong-attempt-key'))
      .data.code,
    'OTP_INVALID',
  );
  assert.equal(
    (
      await pool.query('SELECT attempts FROM delivery_otp_challenges WHERE id=$1', [
        challenge.challengeId,
      ])
    ).rows[0].attempts,
    1,
  );
  for (let n = 2; n <= 5; n++) {
    const result = await verify(
      f.delivery,
      f.driver,
      challenge.challengeId,
      wrong,
      `wrong-attempt-${n}`,
    );
    assert.equal(result.data.code, n === 5 ? 'OTP_LOCKED' : 'OTP_INVALID');
  }
  assert.equal(
    (await verify(f.delivery, f.driver, challenge.challengeId, challenge.otp, 'locked-correct-key'))
      .data.code,
    'OTP_LOCKED',
  );
  const row = (
    await pool.query('SELECT attempts,status FROM delivery_otp_challenges WHERE id=$1', [
      challenge.challengeId,
    ])
  ).rows[0];
  assert.deepEqual(row, { attempts: 5, status: 'LOCKED' });
});

test('correct OTP replays the same proof and cannot expose the code via receipts', async () => {
  const f = await fixture('success'),
    challenge = (await create(f.order, 'create-success-key')).data;
  const body = {
    challengeId: challenge.challengeId,
    otp: challenge.otp,
    idempotencyKey: 'verify-success-key',
  };
  const [first, replay] = await Promise.all([
    request(`/deliveries/${f.delivery}/proofs/otp`, f.driver, body),
    request(`/deliveries/${f.delivery}/proofs/otp`, f.driver, body),
  ]);
  assert.equal(first.status, 200);
  assert.deepEqual(first.data, replay.data);
  assert.equal(first.data.method, 'OTP');
  assert.equal(first.data.status, 'VERIFIED');
  assert.equal(
    (
      await pool.query('SELECT count(*)::int AS n FROM delivery_proofs WHERE delivery_id=$1', [
        f.delivery,
      ])
    ).rows[0].n,
    1,
  );
  const receipts = await pool.query(
    'SELECT row_to_json(a)::text AS body FROM delivery_otp_attempts a WHERE delivery_id=$1',
    [f.delivery],
  );
  assert.ok(!JSON.stringify(receipts.rows).includes(`"${challenge.otp}"`));
  assert.equal((await create(f.order, 'new-code-after-proof')).data.code, 'PROOF_ALREADY_VERIFIED');
});

test('regeneration, expiry, assignment changes and rate limits invalidate old codes', async () => {
  const f = await fixture('expiry');
  const a = (await create(f.order, 'challenge-first-key')).data;
  const b = (await create(f.order, 'challenge-second-key')).data;
  assert.equal(
    (await verify(f.delivery, f.driver, a.challengeId, a.otp, 'verify-old-code')).data.code,
    'OTP_REVOKED',
  );
  await pool.query(
    "UPDATE delivery_otp_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [b.challengeId],
  );
  assert.equal(
    (await verify(f.delivery, f.driver, b.challengeId, b.otp, 'verify-expired-key')).data.code,
    'OTP_EXPIRED',
  );
  const c = (await create(f.order, 'challenge-third-key')).data;
  assert.equal((await create(f.order, 'challenge-fourth-key')).status, 429);
  await db.prisma.driverAssignment.update({ where: { id: f.assignment }, data: { active: false } });
  await db.prisma.delivery.update({ where: { id: f.delivery }, data: { driver_id: 'driver2' } });
  await db.prisma.driverAssignment.create({
    data: { id: 'otp-reassignment', delivery_id: f.delivery, driver_id: 'driver2', active: true },
  });
  assert.equal(
    (await verify(f.delivery, f.driver, c.challengeId, c.otp, 'former-driver-key')).status,
    403,
  );
  assert.equal(
    (await verify(f.delivery, 'driver2', c.challengeId, c.otp, 'new-driver-key')).data.code,
    'ASSIGNMENT_CHANGED',
  );
});

for (const winner of ['regenerate', 'verify'] as const) {
  test(`${winner} and verification serialize without using a revoked code`, async () => {
    const f = await fixture(`race-${winner}`);
    const challenge = (await create(f.order, `create-race-${winner}`)).data;
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [f.order]);
      const regenerate = () => create(f.order, `regenerate-race-${winner}`);
      const verification = () =>
        verify(f.delivery, f.driver, challenge.challengeId, challenge.otp, `verify-race-${winner}`);
      const operations =
        winner === 'regenerate' ? [regenerate, verification] : [verification, regenerate];
      const first = operations[0]();
      const waitFor = async (count: number) => {
        for (let i = 0; i < 100; i++) {
          const result = await admin.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT id FROM orders WHERE id =%' AND pid <> pg_backend_pid()",
          );
          if (result.rows[0].n >= count) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error('Commands did not reach order lock');
      };
      await waitFor(1);
      const second = operations[1]();
      const results = Promise.all([first, second]);
      await waitFor(2);
      await blocker.query('COMMIT');
      const [success, rejected] = await results;
      assert.equal(success.status, 200);
      assert.equal(rejected.status, 409);
      if (winner === 'regenerate') {
        assert.equal(rejected.data.code, 'OTP_REVOKED');
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int AS n FROM delivery_proofs WHERE delivery_id=$1',
              [f.delivery],
            )
          ).rows[0].n,
          0,
        );
      } else {
        assert.equal(rejected.data.code, 'PROOF_ALREADY_VERIFIED');
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int AS n FROM delivery_proofs WHERE delivery_id=$1',
              [f.delivery],
            )
          ).rows[0].n,
          1,
        );
      }
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  });
}
