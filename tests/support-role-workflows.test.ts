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

const schema = `test_support_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 });
const target = testSchemaUrl(testDatabaseUrl(), schema);
const pool = new pg.Pool({ connectionString: target, connectionTimeoutMillis: 3000 });
process.env.DATABASE_URL = target;
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'SupportRoles123!';
process.env.LOG_REQUESTS = 'false';
process.env.ASSIGNMENT_AUTOMATION_ENABLED = 'false';
let created = false,
  server: Server,
  base = '';
let db: typeof import('../server/shared/db.js');
const cookies: Record<string, string> = {};

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
const get = (path: string, who: string) => request(path, who, undefined, 'GET');
async function login(who: string, email = `${who}@bep.local`) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Bep' },
    body: JSON.stringify({ email, password: process.env.DEMO_PASSWORD }),
  });
  assert.equal(response.status, 200);
  cookies[who] = response.headers.get('set-cookie')!.split(';')[0];
}
async function user(id: string, role: string) {
  const password = (await db.prisma.user.findUniqueOrThrow({ where: { id: 'customer' } }))
    .password_hash;
  await db.prisma.user.create({
    data: { id, email: `${id}@test.local`, name: id, role, active: true, password_hash: password },
  });
  await login(id, `${id}@test.local`);
}

/** A delivered order: driver2 was reassigned away, then driver delivered it. */
async function deliveredOrder(suffix: string) {
  const order = `support-order-${suffix}`,
    delivery = `support-delivery-${suffix}`;
  await db.prisma.order.create({
    data: {
      id: order,
      customer_id: 'customer',
      restaurant_id: 'saigon',
      status: 'DELIVERED',
      subtotal: 1000,
      delivery_fee: 0,
      total: 1000,
      address: 'private address',
      idempotency_key: order,
      fingerprint: 'test',
      expires_at: new Date('2099-01-01T00:00:00Z'),
    },
  });
  await db.prisma.delivery.create({
    data: { id: delivery, order_id: order, driver_id: 'driver', status: 'DELIVERED' },
  });
  await db.prisma.driverAssignment.createMany({
    data: [
      {
        id: `${delivery}-old`,
        delivery_id: delivery,
        driver_id: 'driver2',
        active: false,
        end_reason: 'REASSIGNED',
      },
      {
        id: `${delivery}-final`,
        delivery_id: delivery,
        driver_id: 'driver',
        active: false,
        end_reason: 'DELIVERED',
      },
    ],
  });
  const review = randomUUID();
  await db.prisma.review.create({
    data: {
      id: review,
      order_id: order,
      customer_id: 'customer',
      restaurant_id: 'saigon',
      rating: 2,
      content: 'Cold soup and a rude message.',
    },
  });
  return { order, delivery, review };
}

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
  for (const who of ['customer', 'restaurant', 'restaurant2', 'driver', 'driver2', 'admin'])
    await login(who);
  await user('customer-other', 'CUSTOMER');
  await user('driver-unrelated', 'DRIVER');
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

test('complaint ownership matrix covers every reporter role and reader', async () => {
  const f = await deliveredOrder('matrix');
  const content = 'The order had a problem I need help with.';
  const tickets: Record<string, string> = {};
  for (const who of ['customer', 'restaurant', 'driver', 'driver2']) {
    const response = await request(`/orders/${f.order}/complaints`, who, { content });
    assert.equal(response.status, 201, who);
    tickets[who] = response.data.id;
  }
  // driver2 was reassigned away: it may report but still cannot read the order.
  assert.equal((await get(`/orders/${f.order}`, 'driver2')).status, 403);
  for (const who of ['customer-other', 'restaurant2', 'driver-unrelated', 'admin'])
    assert.equal(
      (await request(`/orders/${f.order}/complaints`, who, { content })).status,
      403,
      who,
    );
  for (const [who, ticket] of Object.entries(tickets)) {
    const own = await get('/complaints', who);
    assert.deepEqual(
      own.data.map((row: any) => row.id),
      [ticket],
      who,
    );
    assert.equal((await get(`/complaints/${ticket}`, who)).status, 200);
    for (const other of Object.keys(tickets).filter((name) => name !== who))
      assert.equal(
        (await get(`/complaints/${tickets[other]}`, who)).status,
        403,
        `${who}->${other}`,
      );
  }
  for (const who of ['restaurant', 'driver', 'driver2']) {
    const dto = (await get(`/complaints/${tickets[who]}`, who)).data;
    assert.equal('customer_id' in dto, false);
    assert.equal('reporter_id' in dto, false);
    assert.equal(dto.reporter_role, who === 'restaurant' ? 'RESTAURANT' : 'DRIVER');
  }
  const all = (await get('/complaints', 'admin')).data.map((row: any) => row.id);
  for (const ticket of Object.values(tickets)) assert.ok(all.includes(ticket));
  assert.equal((await get('/complaints/not-a-ticket', 'admin')).status, 404);
  const rows = await pool.query(
    'SELECT reporter_role, customer_id FROM complaints WHERE order_id=$1 ORDER BY reporter_role',
    [f.order],
  );
  for (const row of rows.rows)
    assert.equal(row.customer_id, row.reporter_role === 'CUSTOMER' ? 'customer' : null);
});

test('legacy customer tickets stay readable and resolution notifies the real reporter', async () => {
  const f = await deliveredOrder('legacy');
  const legacy = randomUUID();
  // An old process writes only customer_id; the trigger fills the reporter.
  await pool.query(
    "INSERT INTO complaints (id,order_id,customer_id,content) VALUES ($1,$2,'customer','Legacy complaint from an older release')",
    [legacy, f.order],
  );
  const stored = (
    await pool.query('SELECT reporter_id, reporter_role FROM complaints WHERE id=$1', [legacy])
  ).rows[0];
  assert.deepEqual(stored, { reporter_id: 'customer', reporter_role: 'CUSTOMER' });
  assert.ok((await get('/complaints', 'customer')).data.some((row: any) => row.id === legacy));
  const staff = (
    await request(`/orders/${f.order}/complaints`, 'driver', {
      content: 'Customer was unreachable at the door for ten minutes.',
    })
  ).data.id;
  for (const ticket of [legacy, staff])
    assert.equal(
      (
        await request(`/admin/complaints/${ticket}/resolve`, 'admin', {
          resolution: 'Reviewed with all parties.',
        })
      ).status,
      200,
    );
  const notes = await pool.query(
    "SELECT user_id, payload->>'complaintId' AS complaint FROM outbox WHERE type='COMPLAINT_RESOLVED' AND payload->>'orderId'=$1 ORDER BY user_id",
    [f.order],
  );
  assert.deepEqual(
    notes.rows.map((row) => [row.user_id, row.complaint]),
    [
      ['customer', legacy],
      ['driver', staff],
    ],
  );
  const history = (await get(`/complaints/${staff}`, 'admin')).data.history;
  assert.deepEqual(
    history.map((entry: any) => entry.action),
    ['CREATED', 'RESOLVED'],
  );
  assert.equal(history[1].actor_id, 'admin');
  assert.equal(
    (
      await request(`/admin/complaints/${staff}/resolve`, 'admin', {
        resolution: 'Second resolution',
      })
    ).status,
    409,
  );
});

test('replies keep revisions and never modify the original review', async () => {
  const f = await deliveredOrder('reply');
  const original = (await pool.query('SELECT content, rating FROM reviews WHERE id=$1', [f.review]))
    .rows[0];
  const first = {
    content: 'Sorry about the soup, we fixed the warmer.',
    idempotencyKey: 'reply-1-key',
  };
  const [a, b] = await Promise.all([
    request(`/reviews/${f.review}/reply`, 'restaurant', first),
    request(`/reviews/${f.review}/reply`, 'restaurant', first),
  ]);
  assert.equal(a.status, 200);
  assert.deepEqual(a.data, b.data);
  assert.equal(
    (
      await request(`/reviews/${f.review}/reply`, 'restaurant', {
        content: 'Different text',
        idempotencyKey: 'reply-1-key',
      })
    ).data.code,
    'IDEMPOTENCY_CONFLICT',
  );
  const revised = await request(
    `/reviews/${f.review}/reply`,
    'restaurant',
    { content: 'Updated: a voucher is on its way.', idempotencyKey: 'reply-2-key' },
    'PUT',
  );
  assert.equal(revised.data.revision, 2);
  for (const who of ['restaurant2', 'customer', 'driver', 'admin'])
    assert.equal(
      (
        await request(`/reviews/${f.review}/reply`, who, {
          content: 'Not my review',
          idempotencyKey: `foreign-${who}`,
        })
      ).status,
      403,
      who,
    );
  const revisions = await pool.query(
    'SELECT r.revision, r.content FROM review_reply_revisions r JOIN review_replies p ON p.id=r.reply_id WHERE p.review_id=$1 ORDER BY r.revision',
    [f.review],
  );
  assert.deepEqual(
    revisions.rows.map((row) => row.revision),
    [1, 2],
  );
  assert.deepEqual(
    (await pool.query('SELECT content, rating FROM reviews WHERE id=$1', [f.review])).rows[0],
    original,
  );
  const publicView = (await get('/restaurants/saigon', 'customer')).data;
  const shown = publicView.reviews.find((review: any) => review.content === original.content);
  assert.equal(shown.reply.content, 'Updated: a voucher is on its way.');
});

test('moderation requests keep reasons, decisions and history; hide needs a reason', async () => {
  const f = await deliveredOrder('moderation');
  const g = await deliveredOrder('moderation-reject');
  const ask = (review: string, key: string, who = 'restaurant') =>
    request(`/reviews/${review}/moderation-requests`, who, {
      reason: 'Contains a personal insult toward our staff.',
      idempotencyKey: key,
    });
  const first = await ask(f.review, 'moderation-key-1');
  assert.equal(first.status, 201);
  assert.deepEqual((await ask(f.review, 'moderation-key-1')).data, first.data);
  assert.equal((await ask(f.review, 'moderation-key-2')).data.code, 'MODERATION_PENDING');
  assert.equal((await ask(f.review, 'moderation-key-3', 'restaurant2')).status, 403);
  const queue = (await get('/admin/review-moderation-requests?status=PENDING', 'admin')).data;
  assert.ok(queue.items.some((item: any) => item.id === first.data.requestId));
  assert.equal((await get('/admin/review-moderation-requests', 'restaurant')).status, 403);
  const decide = (id: string, decision: string, key: string) =>
    request(
      `/admin/review-moderation-requests/${id}`,
      'admin',
      { decision, reason: 'Checked against the content policy.', idempotencyKey: key },
      'PATCH',
    );
  assert.equal((await decide(first.data.requestId, 'APPROVE', 'decision-key-1')).status, 200);
  assert.deepEqual((await decide(first.data.requestId, 'APPROVE', 'decision-key-1')).data, {
    requestId: first.data.requestId,
    status: 'APPROVED',
  });
  assert.equal((await decide(first.data.requestId, 'REJECT', 'decision-key-2')).status, 409);
  const approved = (
    await pool.query(
      'SELECT r.hidden, r.content, m.status, m.reason, m.decision_reason, m.decided_by FROM reviews r JOIN review_moderation_requests m ON m.review_id=r.id WHERE r.id=$1',
      [f.review],
    )
  ).rows[0];
  assert.deepEqual(approved, {
    hidden: true,
    content: 'Cold soup and a rude message.',
    status: 'APPROVED',
    reason: 'Contains a personal insult toward our staff.',
    decision_reason: 'Checked against the content policy.',
    decided_by: 'admin',
  });
  const rejected = (await ask(g.review, 'moderation-reject-key')).data.requestId;
  assert.equal((await decide(rejected, 'REJECT', 'decision-key-3')).status, 200);
  assert.equal(
    (await pool.query('SELECT hidden FROM reviews WHERE id=$1', [g.review])).rows[0].hidden,
    false,
  );
  const audit = await pool.query(
    "SELECT action FROM audit_logs WHERE action IN ('REVIEW_MODERATION_REQUESTED','REVIEW_MODERATION_DECIDED') AND (resource_id=$1 OR resource_id=$2) ORDER BY created_at",
    [f.review, first.data.requestId],
  );
  assert.deepEqual(
    audit.rows.map((row) => row.action),
    ['REVIEW_MODERATION_REQUESTED', 'REVIEW_MODERATION_DECIDED'],
  );
  assert.equal(
    (await request(`/admin/reviews/${g.review}`, 'admin', { hidden: true }, 'PATCH')).status,
    400,
  );
  assert.equal(
    (
      await request(
        `/admin/reviews/${g.review}`,
        'admin',
        { hidden: true, reason: 'Spam link' },
        'PATCH',
      )
    ).status,
    200,
  );
  const managed = (await get('/restaurants/saigon/reviews/manage', 'restaurant')).data.items;
  assert.ok(managed.some((item: any) => item.id === f.review && item.hidden));
  assert.equal((await get('/restaurants/saigon/reviews/manage', 'restaurant2')).status, 403);
});
