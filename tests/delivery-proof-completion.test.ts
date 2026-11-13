import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import pg from 'pg';
import {
  testDatabaseUrl,
  testSchemaUrl,
  verifyTestSchema,
  dropTestSchema,
} from './test-database.js';

const schema = `test_proofdone_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 });
const target = testSchemaUrl(testDatabaseUrl(), schema);
const pool = new pg.Pool({ connectionString: target, connectionTimeoutMillis: 3000 });
const storageDir = await mkdtemp(join(tmpdir(), 'bep-proof-done-'));
process.env.DATABASE_URL = target;
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'ProofCompletion123!';
process.env.LOG_REQUESTS = 'false';
process.env.ASSIGNMENT_AUTOMATION_ENABLED = 'false';
process.env.DELIVERY_PROOF_STORAGE_DIR = storageDir;
let created = false,
  server: Server,
  base = '';
let db: typeof import('../server/shared/db.js');
const cookies: Record<string, string> = {};
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);

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
  return { status: response.status, data: await response.json() };
}
async function login(who: string, email = `${who}@bep.local`) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Bep' },
    body: JSON.stringify({ email, password: process.env.DEMO_PASSWORD }),
  });
  assert.equal(response.status, 200);
  cookies[who] = response.headers.get('set-cookie')!.split(';')[0];
}

/** proofRequired undefined: create through the application path (config snapshot). */
async function fixture(suffix: string, proofRequired?: boolean) {
  const order = `done-order-${suffix}`,
    driver = `done-driver-${suffix}`,
    assignment = `done-assignment-${suffix}`;
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
      delivery_fee: 15000,
      total: 16000,
      address: 'private',
      idempotency_key: order,
      fingerprint: 'test',
      expires_at: new Date('2099-01-01T00:00:00Z'),
    },
  });
  if (proofRequired === undefined) {
    const { createDelivery } = await import('../server/modules/delivery/index.js');
    await db.transaction((tx) => createDelivery(tx, order));
  } else
    await db.prisma.delivery.create({
      data: { id: randomUUID(), order_id: order, proof_required: proofRequired },
    });
  const delivery = (await db.prisma.delivery.findUniqueOrThrow({ where: { order_id: order } })).id;
  await db.prisma.delivery.update({
    where: { id: delivery },
    data: { driver_id: driver, status: 'IN_TRANSIT' },
  });
  await db.prisma.driverAssignment.create({
    data: { id: assignment, delivery_id: delivery, driver_id: driver, active: true },
  });
  return { order, delivery, driver, assignment };
}
const deliver = (delivery: string, driver: string) =>
  request(`/deliveries/${delivery}/transition`, driver, { status: 'DELIVERED' });
const counts = async (order: string) =>
  (
    await pool.query(
      `SELECT (SELECT count(*)::int FROM state_history WHERE order_id=$1) AS history,
              (SELECT count(*)::int FROM outbox WHERE payload->>'orderId'=$1) AS outbox,
              (SELECT count(*)::int FROM notifications WHERE payload->>'orderId'=$1) AS notifications`,
      [order],
    )
  ).rows[0];

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  created = true;
  db = await import('../server/shared/db.js');
  await verifyTestSchema(schema, db.prisma);
  await (await import('../server/migrate.js')).migrate();
  await (await import('../server/seed/seed.js')).seed();
  server = (await import('../server/app.js')).createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  for (const who of ['customer', 'driver2']) await login(who);
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
  await rm(storageDir, { recursive: true, force: true });
});

test('new deliveries snapshot the proof policy and require one verified proof', async () => {
  const f = await fixture('required');
  assert.equal(
    (await pool.query('SELECT proof_required FROM deliveries WHERE id=$1', [f.delivery])).rows[0]
      .proof_required,
    true,
  );
  const blocked = await deliver(f.delivery, f.driver);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, 'PROOF_REQUIRED');
  const challenge = (
    await request(`/orders/${f.order}/delivery-proof/otp`, 'customer', {
      idempotencyKey: 'completion-otp',
    })
  ).data;
  const detail = (await request(`/orders/${f.order}`, f.driver, undefined, 'GET')).data;
  assert.equal(detail.delivery.otp_challenge.id, challenge.challengeId);
  assert.equal(detail.delivery.proof_verified, false);
  for (const secret of ['salt', 'otp_hash', 'storage_key', 'key_hash', `"${challenge.otp}"`])
    assert.ok(!JSON.stringify(detail).includes(secret), secret);
  assert.equal(
    (
      await request(`/deliveries/${f.delivery}/proofs/otp`, f.driver, {
        challengeId: challenge.challengeId,
        otp: challenge.otp,
        idempotencyKey: 'completion-verify',
      })
    ).status,
    200,
  );
  assert.equal((await deliver(f.delivery, f.driver)).status, 200);
  const final = (await request(`/orders/${f.order}`, 'customer', undefined, 'GET')).data;
  assert.equal(final.status, 'DELIVERED');
  assert.equal(final.delivery.proof_verified, true);
  assert.deepEqual(
    final.delivery.proofs.map((proof: any) => [proof.method, proof.status]),
    [['OTP', 'VERIFIED']],
  );
});

test('a photo alone is enough to complete', async () => {
  const f = await fixture('photo-only');
  const upload = await fetch(`${base}/api/deliveries/${f.delivery}/proofs/photo`, {
    method: 'POST',
    headers: {
      'Content-Type': 'image/jpeg',
      'X-Requested-With': 'Bep',
      'X-Idempotency-Key': 'completion-photo',
      cookie: cookies[f.driver],
    },
    body: new Uint8Array(jpeg),
  });
  assert.equal(upload.status, 201);
  assert.equal((await deliver(f.delivery, f.driver)).status, 200);
});

test('legacy deliveries complete without proof and terminal retries add no side effects', async () => {
  const f = await fixture('legacy', false);
  assert.equal((await deliver(f.delivery, f.driver)).status, 200);
  const once = await counts(f.order);
  for (let i = 0; i < 2; i++) assert.equal((await deliver(f.delivery, f.driver)).status, 200);
  assert.deepEqual(await counts(f.order), once);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM state_history WHERE order_id=$1 AND to_state='DELIVERED'",
        [f.order],
      )
    ).rows[0].n,
    2,
  );
  // Another driver cannot use the retry path.
  assert.equal((await deliver(f.delivery, 'driver2')).status, 403);
});

test('changing the policy never rewrites existing snapshots', async () => {
  const { deliveryConfig } = await import('../server/modules/delivery/index.js');
  const required = await fixture('snapshot-true');
  deliveryConfig.DELIVERY_PROOF_REQUIRED = false;
  try {
    const optional = await fixture('snapshot-false');
    const rows = await pool.query(
      'SELECT id,proof_required FROM deliveries WHERE id = ANY($1) ORDER BY proof_required',
      [[required.delivery, optional.delivery]],
    );
    assert.deepEqual(
      rows.rows.map((row) => [row.id, row.proof_required]),
      [
        [optional.delivery, false],
        [required.delivery, true],
      ],
    );
    assert.equal((await deliver(required.delivery, required.driver)).data.code, 'PROOF_REQUIRED');
    assert.equal((await deliver(optional.delivery, optional.driver)).status, 200);
  } finally {
    deliveryConfig.DELIVERY_PROOF_REQUIRED = true;
  }
});

test('proof from an earlier assignment does not complete the current one', async () => {
  const f = await fixture('old-assignment', true);
  await pool.query(
    "INSERT INTO delivery_proofs (id,delivery_id,assignment_id,method,status,driver_id,storage_key,content_type,byte_size,sha256,key_hash) VALUES ($1,$2,$3,'PHOTO','VERIFIED',$4,$5,'image/jpeg',10,'x','k')",
    [randomUUID(), f.delivery, f.assignment, f.driver, randomUUID().replaceAll('-', '')],
  );
  await pool.query(
    "UPDATE driver_assignments SET active=false,end_reason='REASSIGNED' WHERE id=$1",
    [f.assignment],
  );
  await pool.query("UPDATE deliveries SET driver_id='driver2' WHERE id=$1", [f.delivery]);
  await pool.query(
    "INSERT INTO driver_assignments (id,delivery_id,driver_id,active) VALUES ($1,$2,'driver2',true)",
    [randomUUID(), f.delivery],
  );
  assert.equal((await deliver(f.delivery, 'driver2')).data.code, 'PROOF_REQUIRED');
  const detail = (await request(`/orders/${f.order}`, 'driver2', undefined, 'GET')).data;
  assert.equal(detail.delivery.proof_verified, false);
});
