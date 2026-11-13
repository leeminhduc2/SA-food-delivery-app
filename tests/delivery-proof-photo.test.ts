import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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

const schema = `test_photo_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 });
const target = testSchemaUrl(testDatabaseUrl(), schema);
const pool = new pg.Pool({ connectionString: target, connectionTimeoutMillis: 3000 });
const storageDir = await mkdtemp(join(tmpdir(), 'bep-proofs-'));
process.env.DATABASE_URL = target;
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'PhotoProofTest123!';
process.env.LOG_REQUESTS = 'false';
process.env.ASSIGNMENT_AUTOMATION_ENABLED = 'false';
process.env.DELIVERY_PROOF_STORAGE_DIR = storageDir;
process.env.DELIVERY_PROOF_MAX_BYTES = '4096';
let created = false,
  server: Server,
  base = '';
let db: typeof import('../server/shared/db.js');
let delivery: typeof import('../server/modules/delivery/index.js');
const cookies: Record<string, string> = {};

const jpeg = (fill = 1) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, fill)]);
const png = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 7),
  ]);

async function json(path: string, who: string, body?: unknown, method = 'POST') {
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
async function upload(
  deliveryId: string,
  who: string,
  bytes: Buffer,
  key?: string,
  type = 'image/jpeg',
) {
  const response = await fetch(`${base}/api/deliveries/${deliveryId}/proofs/photo`, {
    method: 'POST',
    headers: {
      'Content-Type': type,
      'X-Requested-With': 'Bep',
      cookie: cookies[who] ?? '',
      ...(key ? { 'X-Idempotency-Key': key } : {}),
    },
    body: new Uint8Array(bytes),
  });
  const text = await response.text();
  return { status: response.status, text, data: text ? JSON.parse(text) : null };
}
async function content(deliveryId: string, proofId: string, who: string) {
  const response = await fetch(`${base}/api/deliveries/${deliveryId}/proofs/${proofId}/content`, {
    headers: { cookie: cookies[who] ?? '' },
  });
  return {
    status: response.status,
    bytes: Buffer.from(await response.arrayBuffer()),
    headers: response.headers,
  };
}
async function login(who: string, email = `${who}@bep.local`) {
  const response = await json('/auth/login', '', { email, password: process.env.DEMO_PASSWORD });
  assert.equal(response.status, 200);
  cookies[who] = response.headers.get('set-cookie')!.split(';')[0];
}
async function fixture(suffix: string) {
  const order = `photo-order-${suffix}`,
    deliveryId = `photo-delivery-${suffix}`,
    driver = `photo-driver-${suffix}`,
    assignment = `photo-assignment-${suffix}`;
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
    data: { id: deliveryId, order_id: order, driver_id: driver, status: 'PICKED_UP' },
  });
  await db.prisma.driverAssignment.create({
    data: { id: assignment, delivery_id: deliveryId, driver_id: driver, active: true },
  });
  return { order, delivery: deliveryId, driver, assignment };
}
const files = async () => (await readdir(storageDir)).sort();

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
  delivery = await import('../server/modules/delivery/index.js');
  for (const who of ['customer', 'restaurant', 'restaurant2', 'driver', 'driver2', 'admin'])
    await login(who);
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
  await rm(storageDir, { recursive: true, force: true });
});

test('signature detection and storage keys reject spoofed types and path input', async () => {
  const { detectPhotoType } =
    await import('../server/modules/delivery/application/photo-proof.service.js');
  assert.equal(detectPhotoType(jpeg()), 'image/jpeg');
  assert.equal(detectPhotoType(png()), 'image/png');
  assert.equal(detectPhotoType(Buffer.from('GIF89a')), null);
  assert.equal(detectPhotoType(Buffer.from([0xff, 0xd8])), null);
  const storage = delivery.createLocalProofStorage(storageDir);
  for (const key of [
    '../escape',
    'a/b',
    '..',
    `${'a'.repeat(31)}/`,
    'ABCDEF0123456789ABCDEF0123456789',
  ])
    await assert.rejects(storage.read(key), /Invalid proof storage key/);
  assert.match(storage.newKey(), /^[a-f0-9]{32}$/);
});

test('JPEG and PNG proofs are readable only through authorized private responses', async () => {
  const f = await fixture('read');
  const first = await upload(f.delivery, f.driver, jpeg(), 'photo-read-key');
  assert.equal(first.status, 201);
  assert.deepEqual(Object.keys(first.data).sort(), ['method', 'proofId', 'status']);
  assert.equal(first.data.status, 'VERIFIED');
  assert.ok(!first.text.includes(storageDir) && !first.text.includes('delivery-proofs'));
  for (const who of ['customer', 'restaurant', f.driver, 'admin']) {
    const response = await content(f.delivery, first.data.proofId, who);
    assert.equal(response.status, 200, who);
    assert.deepEqual(response.bytes, jpeg());
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.match(response.headers.get('cache-control') ?? '', /private, no-store/);
  }
  for (const who of ['customer-other', 'restaurant2', 'driver2'])
    assert.equal((await content(f.delivery, first.data.proofId, who)).status, 403, who);
  assert.equal((await content(f.delivery, first.data.proofId, '')).status, 401);
  const g = await fixture('png');
  const second = await upload(g.delivery, g.driver, png(), 'photo-png-key', 'image/png');
  assert.equal(second.status, 201);
  assert.equal(
    (await content(g.delivery, second.data.proofId, 'customer')).headers.get('content-type'),
    'image/png',
  );
  // A proof ID from another delivery is not addressable through this delivery.
  assert.equal((await content(f.delivery, second.data.proofId, 'admin')).status, 404);
  for (const path of ['..%2F..%2Fpackage.json', '%2E%2E', 'not-a-proof'])
    assert.ok([400, 404].includes((await content(f.delivery, path, 'admin')).status));
  const stored = await pool.query('SELECT storage_key FROM delivery_proofs WHERE id=$1', [
    first.data.proofId,
  ]);
  assert.match(stored.rows[0].storage_key, /^[a-f0-9]{32}$/);
});

test('oversized, spoofed, unsupported or unauthorized uploads write nothing', async () => {
  const f = await fixture('reject');
  const before = await files();
  assert.equal(
    (
      await upload(
        f.delivery,
        f.driver,
        Buffer.concat([jpeg(), Buffer.alloc(5000)]),
        'too-large-key',
      )
    ).status,
    413,
  );
  assert.equal((await upload(f.delivery, f.driver, png(), 'spoofed-key-1')).status, 415);
  assert.equal(
    (await upload(f.delivery, f.driver, Buffer.from('<?php echo 1; ?>'), 'spoofed-key-2')).status,
    415,
  );
  assert.equal(
    (await upload(f.delivery, f.driver, jpeg(), 'text-type-key', 'text/plain')).status,
    415,
  );
  assert.equal((await upload(f.delivery, f.driver, jpeg())).status, 400);
  assert.equal((await upload(f.delivery, 'driver2', jpeg(), 'other-driver-key')).status, 403);
  assert.equal((await upload(f.delivery, 'customer', jpeg(), 'customer-upload-key')).status, 403);
  await db.prisma.delivery.update({ where: { id: f.delivery }, data: { status: 'DELIVERED' } });
  assert.equal((await upload(f.delivery, f.driver, jpeg(), 'after-terminal-key')).status, 409);
  assert.deepEqual(await files(), before);
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM delivery_proof_uploads')).rows[0].n,
    0,
  );
});

test('same key replays one proof, a changed photo conflicts and a second proof is refused', async () => {
  const f = await fixture('replay');
  const before = (await files()).length;
  const [a, b] = await Promise.all([
    upload(f.delivery, f.driver, jpeg(), 'photo-replay-key'),
    upload(f.delivery, f.driver, jpeg(), 'photo-replay-key'),
  ]);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(a.data.proofId, b.data.proofId);
  assert.equal(
    (await upload(f.delivery, f.driver, jpeg(2), 'photo-replay-key')).data.code,
    'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(
    (await upload(f.delivery, f.driver, jpeg(3), 'photo-second-key')).data.code,
    'PROOF_ALREADY_VERIFIED',
  );
  assert.equal((await files()).length, before + 1);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int AS n FROM delivery_proofs WHERE delivery_id=$1', [
        f.delivery,
      ])
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM delivery_proof_uploads')).rows[0].n,
    0,
  );
});

test('reassigned-away driver cannot read or add proof for the trip', async () => {
  const f = await fixture('reassigned');
  const proof = await upload(f.delivery, f.driver, jpeg(), 'reassigned-photo-key');
  await db.prisma.driverAssignment.update({
    where: { id: f.assignment },
    data: { active: false, end_reason: 'REASSIGNED' },
  });
  await db.prisma.delivery.update({ where: { id: f.delivery }, data: { driver_id: 'driver2' } });
  await db.prisma.driverAssignment.create({
    data: { id: 'photo-reassignment', delivery_id: f.delivery, driver_id: 'driver2', active: true },
  });
  assert.equal((await content(f.delivery, proof.data.proofId, f.driver)).status, 403);
  assert.equal((await content(f.delivery, proof.data.proofId, 'driver2')).status, 403);
  assert.equal((await upload(f.delivery, f.driver, jpeg(), 'former-driver-photo')).status, 403);
});

test('a database failure after the write removes the file and leaves no proof', async () => {
  const f = await fixture('db-failure');
  const before = await files();
  await pool.query(
    `CREATE FUNCTION fail_proof_insert() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$ LANGUAGE plpgsql`,
  );
  await pool.query(
    'CREATE TRIGGER fail_proof_insert BEFORE INSERT ON delivery_proofs FOR EACH ROW EXECUTE FUNCTION fail_proof_insert()',
  );
  try {
    assert.equal((await upload(f.delivery, f.driver, jpeg(), 'db-failure-key')).status, 500);
  } finally {
    await pool.query('DROP TRIGGER fail_proof_insert ON delivery_proofs');
    await pool.query('DROP FUNCTION fail_proof_insert()');
  }
  assert.deepEqual(await files(), before);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int AS n FROM delivery_proofs WHERE delivery_id=$1', [
        f.delivery,
      ])
    ).rows[0].n,
    0,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM delivery_proof_uploads')).rows[0].n,
    0,
  );
});

test('crash leftovers are cleaned up and failed deletes are retried with evidence', async () => {
  const storage = delivery.createLocalProofStorage(storageDir);
  const key = storage.newKey();
  await storage.put(key, jpeg());
  await pool.query(
    "INSERT INTO delivery_proof_uploads (storage_key,delivery_id,created_at) VALUES ($1,'crashed',clock_timestamp()-interval '1 hour')",
    [key],
  );
  let fail = true;
  delivery.setProofStorage({
    ...storage,
    remove: async (k) => {
      if (fail) throw new Error('disk busy');
      await storage.remove(k);
    },
  });
  try {
    assert.deepEqual(await delivery.cleanupStagedUploads(), { removed: 0, failed: 1 });
    const row = (
      await pool.query(
        'SELECT attempts,last_error,next_attempt_at > clock_timestamp() AS later FROM delivery_proof_uploads WHERE storage_key=$1',
        [key],
      )
    ).rows[0];
    assert.deepEqual(row, { attempts: 1, last_error: 'disk busy', later: true });
    assert.ok((await files()).includes(key));
    fail = false;
    assert.deepEqual(await delivery.cleanupStagedUploads(), { removed: 0, failed: 0 });
    await pool.query(
      'UPDATE delivery_proof_uploads SET next_attempt_at=clock_timestamp() WHERE storage_key=$1',
      [key],
    );
    assert.deepEqual(await delivery.cleanupStagedUploads(), { removed: 1, failed: 0 });
    assert.ok(!(await files()).includes(key));
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM delivery_proof_uploads')).rows[0].n,
      0,
    );
  } finally {
    delivery.setProofStorage(storage);
  }
});

test('retention purges bytes after 30 days unless a complaint or incident holds them', async () => {
  const f = await fixture('retention');
  const proof = (await upload(f.delivery, f.driver, jpeg(), 'retention-photo-key')).data;
  const deliveredAt = new Date('2026-01-01T00:00:00Z');
  await db.prisma.delivery.update({
    where: { id: f.delivery },
    data: { status: 'DELIVERED', delivered_at: deliveredAt },
  });
  await db.prisma.driverAssignment.update({
    where: { id: f.assignment },
    data: { active: false, end_reason: 'DELIVERED' },
  });
  const at = (days: number) => new Date(deliveredAt.getTime() + days * 86400000);
  const key = (
    await pool.query('SELECT storage_key FROM delivery_proofs WHERE id=$1', [proof.proofId])
  ).rows[0].storage_key;
  assert.deepEqual(await delivery.purgeExpiredProofPhotos({ now: at(29.99) }), {
    purged: 0,
    held: 0,
    failed: 0,
  });
  const complaint = randomUUID();
  await pool.query(
    "INSERT INTO complaints (id,order_id,customer_id,content,status) VALUES ($1,$2,'customer','Food arrived cold and damaged','OPEN')",
    [complaint, f.order],
  );
  assert.deepEqual(await delivery.purgeExpiredProofPhotos({ now: at(31) }), {
    purged: 0,
    held: 1,
    failed: 0,
  });
  await pool.query("UPDATE complaints SET status='RESOLVED' WHERE id=$1", [complaint]);
  const incident = randomUUID();
  await pool.query(
    "INSERT INTO delivery_incidents (id,delivery_id,order_id,type,reason) VALUES ($1,$2,$3,'DELIVERY_FAILED','hold')",
    [incident, f.delivery, f.order],
  );
  assert.equal((await delivery.purgeExpiredProofPhotos({ now: at(31) })).purged, 0);
  await pool.query("UPDATE delivery_incidents SET status='RESOLVED' WHERE id=$1", [incident]);
  assert.ok((await files()).includes(key));
  assert.deepEqual(await delivery.purgeExpiredProofPhotos({ now: at(31) }), {
    purged: 1,
    held: 0,
    failed: 0,
  });
  assert.ok(!(await files()).includes(key));
  const row = (
    await pool.query(
      'SELECT status,purged_at,sha256,byte_size,storage_key FROM delivery_proofs WHERE id=$1',
      [proof.proofId],
    )
  ).rows[0];
  assert.equal(row.status, 'PURGED');
  assert.equal(row.purged_at.toISOString(), at(31).toISOString());
  assert.ok(row.sha256 && row.byte_size > 0 && row.storage_key);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE action='DELIVERY_PHOTO_PURGED' AND resource_id=$1",
        [f.delivery],
      )
    ).rows[0].n,
    1,
  );
  assert.equal((await content(f.delivery, proof.proofId, 'customer')).status, 410);
  assert.deepEqual(await delivery.purgeExpiredProofPhotos({ now: at(32) }), {
    purged: 0,
    held: 0,
    failed: 0,
  });
});

test('missing bytes are reported, never replaced with placeholder content', async () => {
  const f = await fixture('missing');
  const proof = (await upload(f.delivery, f.driver, jpeg(), 'missing-photo-key')).data;
  const key = (
    await pool.query('SELECT storage_key FROM delivery_proofs WHERE id=$1', [proof.proofId])
  ).rows[0].storage_key;
  await writeFile(join(storageDir, 'unrelated.txt'), 'x');
  await rm(join(storageDir, key));
  const response = await content(f.delivery, proof.proofId, 'customer');
  assert.equal(response.status, 410);
  assert.equal(JSON.parse(response.bytes.toString()).code, 'PROOF_CONTENT_UNAVAILABLE');
  await rm(join(storageDir, 'unrelated.txt'));
});
