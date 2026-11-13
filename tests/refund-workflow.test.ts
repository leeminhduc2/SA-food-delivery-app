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

const schema = `test_refund_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 });
const target = testSchemaUrl(testDatabaseUrl(), schema);
const pool = new pg.Pool({ connectionString: target, connectionTimeoutMillis: 3000 });
process.env.DATABASE_URL = target;
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'RefundFlows123!';
process.env.LOG_REQUESTS = 'false';
process.env.PAYMENT_MODE = 'simulated';
process.env.ASSIGNMENT_AUTOMATION_ENABLED = 'false';
let created = false,
  server: Server,
  base = '';
let db: typeof import('../server/shared/db.js');
let payment: typeof import('../server/modules/payment/index.js');
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
async function login(who: string, email = `${who}@bep.local`) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Bep' },
    body: JSON.stringify({ email, password: process.env.DEMO_PASSWORD }),
  });
  assert.equal(response.status, 200);
  cookies[who] = response.headers.get('set-cookie')!.split(';')[0];
}

/** Paid order in the given state with a delivery and a simulated provider transaction. */
async function paidOrder(suffix: string, status: string, deliveryStatus = 'DELIVERED') {
  const order = `refund-order-${suffix}`,
    reference = `pay_refund_${suffix}`;
  await db.prisma.order.create({
    data: {
      id: order,
      customer_id: 'customer',
      restaurant_id: 'saigon',
      status,
      subtotal: 80000,
      delivery_fee: 20000,
      total: 100000,
      address: 'private',
      idempotency_key: order,
      fingerprint: 'test',
      expires_at: new Date('2099-01-01T00:00:00Z'),
    },
  });
  const paymentId = randomUUID();
  await db.prisma.payment.create({
    data: {
      id: paymentId,
      order_id: order,
      reference,
      amount: 100000,
      status: 'SUCCEEDED',
      provider_created: true,
      external_transaction_id: `sim_${reference}`,
    },
  });
  await db.prisma.simulatedTransaction.create({
    data: { reference, amount: 100000, status: 'SUCCEEDED', external_id: `sim_${reference}` },
  });
  const delivery = `refund-delivery-${suffix}`;
  await db.prisma.delivery.create({
    data: { id: delivery, order_id: order, driver_id: 'driver', status: deliveryStatus },
  });
  return { order, delivery, reference, paymentId };
}
async function complaintFor(order: string) {
  return (
    await request(`/orders/${order}/complaints`, 'customer', {
      content: 'The food was spoiled when it arrived.',
    })
  ).data.id as string;
}
const refundedHistory = async (order: string) =>
  (
    await pool.query(
      "SELECT count(*)::int AS n FROM state_history WHERE order_id=$1 AND entity='PAYMENT' AND to_state='REFUNDED'",
      [order],
    )
  ).rows[0].n;
const due = (id: string) =>
  pool.query(
    'UPDATE refund_requests SET next_attempt_at=clock_timestamp(), lease_until=NULL WHERE id=$1',
    [id],
  );
const approve = (id: string, key: string, reason = 'Customer evidence verified.') =>
  request(`/admin/refund-requests/${id}/decision`, 'admin', {
    decision: 'APPROVE',
    reason,
    idempotencyKey: key,
  });

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
  payment = await import('../server/modules/payment/index.js');
  for (const who of ['customer', 'restaurant', 'driver', 'admin']) await login(who);
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

test('eligibility: delivered needs a complaint, failed needs an incident, amount is the full payment', async () => {
  const delivered = await paidOrder('eligible-delivered', 'DELIVERED');
  const ask = (order: string, body: object, who = 'customer') =>
    request(`/orders/${order}/refund-requests`, who, {
      reason: 'Food was spoiled',
      idempotencyKey: `${who}-${order}-${JSON.stringify(body).length}`,
      ...body,
    });
  assert.equal((await ask(delivered.order, {})).data.code, 'COMPLAINT_REQUIRED');
  const other = await paidOrder('eligible-other', 'DELIVERED');
  const foreignComplaint = await complaintFor(other.order);
  assert.equal(
    (await ask(delivered.order, { complaintId: foreignComplaint })).data.code,
    'COMPLAINT_REQUIRED',
  );
  assert.equal((await ask(delivered.order, { amount: 1 })).status, 400);
  for (const who of ['restaurant', 'driver', 'customer-other'])
    assert.equal((await ask(delivered.order, {}, who)).status, 403, who);
  const complaint = await complaintFor(delivered.order);
  const created = await ask(delivered.order, { complaintId: complaint });
  assert.equal(created.status, 201);
  assert.equal(created.data.status, 'REQUESTED');
  assert.equal(created.data.amount, 100000);
  assert.equal(created.data.source, 'COMPLAINT');
  assert.equal(
    (
      await request(`/orders/${delivered.order}/refund-requests`, 'customer', {
        complaintId: complaint,
        reason: 'Second request',
        idempotencyKey: 'second-request-key',
      })
    ).data.code,
    'REFUND_ALREADY_REQUESTED',
  );
  const failed = await paidOrder('eligible-failed', 'DELIVERY_FAILED', 'FAILED');
  assert.equal((await ask(failed.order, {})).data.code, 'INCIDENT_REQUIRED');
  await pool.query(
    "INSERT INTO delivery_incidents (id,delivery_id,order_id,type,reason) VALUES ($1,$2,$3,'DELIVERY_FAILED','Road closed')",
    [randomUUID(), failed.delivery, failed.order],
  );
  const incidentRefund = await ask(failed.order, {});
  assert.equal(incidentRefund.status, 201);
  assert.equal(incidentRefund.data.source, 'INCIDENT');
  const active = await paidOrder('eligible-active', 'PREPARING', 'UNASSIGNED');
  assert.equal((await ask(active.order, {})).data.code, 'REFUND_NOT_ELIGIBLE');
  const byAdmin = await paidOrder('eligible-admin', 'DELIVERED');
  const adminComplaint = await complaintFor(byAdmin.order);
  assert.equal(
    (await ask(byAdmin.order, { complaintId: adminComplaint }, 'admin')).data.requesterRole,
    'ADMIN',
  );
});

test('approval refunds once, keeps the order delivered and leaves the complaint open', async () => {
  const f = await paidOrder('approve', 'DELIVERED');
  const complaint = await complaintFor(f.order);
  const refund = (
    await request(`/orders/${f.order}/refund-requests`, 'customer', {
      complaintId: complaint,
      reason: 'Spoiled food',
      idempotencyKey: 'approve-request-key',
    })
  ).data;
  const [a, b] = await Promise.all([
    approve(refund.id, 'approve-key-1'),
    approve(refund.id, 'approve-key-2'),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.deepEqual((await approve(refund.id, 'approve-key-1')).data.status, 'APPROVED');
  assert.equal(
    (await pool.query('SELECT status FROM payments WHERE order_id=$1', [f.order])).rows[0].status,
    'REFUND_PENDING',
  );
  const runs = await Promise.all([
    payment.processRefunds(),
    payment.processRefunds(),
    payment.reconcilePayments(),
  ]);
  assert.equal(runs[0].confirmed + runs[1].confirmed, 1);
  assert.equal(await refundedHistory(f.order), 1);
  const after = (
    await pool.query(
      `SELECT p.status AS payment, o.status AS "order", r.status AS refund, c.status AS complaint, s.status AS provider
       FROM payments p JOIN orders o ON o.id=p.order_id JOIN refund_requests r ON r.payment_id=p.id
       JOIN complaints c ON c.order_id=o.id JOIN simulated_transactions s ON s.reference=p.reference
       WHERE o.id=$1`,
      [f.order],
    )
  ).rows[0];
  assert.deepEqual(after, {
    payment: 'REFUNDED',
    order: 'DELIVERED',
    refund: 'SUCCEEDED',
    complaint: 'OPEN',
    provider: 'REFUNDED',
  });
  const notes = await pool.query(
    "SELECT type FROM outbox WHERE user_id='customer' AND payload->>'refundRequestId'=$1 ORDER BY type",
    [refund.id],
  );
  assert.deepEqual(
    notes.rows.map((row) => row.type),
    ['REFUND_APPROVED', 'REFUND_CONFIRMED'],
  );
  const customerView = await request(
    `/orders/${f.order}/refund-requests`,
    'customer',
    undefined,
    'GET',
  );
  assert.equal(customerView.data.items[0].status, 'SUCCEEDED');
  assert.equal('lastError' in customerView.data.items[0], false);
  assert.equal(
    (await request(`/orders/${f.order}/refund-requests`, 'customer-other', undefined, 'GET'))
      .status,
    403,
  );
});

test('rejection leaves the payment collected and allows a new request', async () => {
  const f = await paidOrder('reject', 'DELIVERED');
  const complaint = await complaintFor(f.order);
  const refund = (
    await request(`/orders/${f.order}/refund-requests`, 'customer', {
      complaintId: complaint,
      reason: 'Missing item',
      idempotencyKey: 'reject-request-key',
    })
  ).data;
  const rejected = await request(`/admin/refund-requests/${refund.id}/decision`, 'admin', {
    decision: 'REJECT',
    reason: 'Photo shows all items delivered.',
    idempotencyKey: 'reject-key',
  });
  assert.equal(rejected.data.status, 'REJECTED');
  assert.equal(
    (await pool.query('SELECT status FROM payments WHERE order_id=$1', [f.order])).rows[0].status,
    'SUCCEEDED',
  );
  assert.equal(
    (
      await request(`/orders/${f.order}/refund-requests`, 'customer', {
        complaintId: complaint,
        reason: 'New evidence attached',
        idempotencyKey: 'reject-second-key',
      })
    ).status,
    201,
  );
});

test('provider failure, timeout and missing confirmation retry with backoff, then need an Admin', async () => {
  const f = await paidOrder('failure', 'DELIVERED');
  const complaint = await complaintFor(f.order);
  const refund = (
    await request(`/orders/${f.order}/refund-requests`, 'customer', {
      complaintId: complaint,
      reason: 'Wrong order',
      idempotencyKey: 'failure-request-key',
    })
  ).data;
  await approve(refund.id, 'failure-approve-key');
  const original = { refund: payment.paymentAdapter.refund, query: payment.paymentAdapter.query };
  const previousTimeout = process.env.PROVIDER_TIMEOUT_MS;
  process.env.PROVIDER_TIMEOUT_MS = '50';
  const behaviours: Array<() => Promise<any>> = [
    async () => {
      throw new Error('Simulator refused');
    },
    () => new Promise(() => {}),
    async () => ({ status: 'SUCCEEDED' }),
    async () => {
      throw new Error('Simulator refused');
    },
    async () => {
      throw new Error('Simulator refused');
    },
  ];
  let calls = 0;
  payment.paymentAdapter.refund = async () => behaviours[calls++]();
  payment.paymentAdapter.query = async () => ({ status: 'SUCCEEDED' });
  try {
    for (let attempt = 1; attempt <= 5; attempt++) {
      await due(refund.id);
      await payment.processRefunds();
      const row = (
        await pool.query(
          'SELECT status, attempts, last_error, round(extract(epoch FROM next_attempt_at - updated_at))::int AS delay FROM refund_requests WHERE id=$1',
          [refund.id],
        )
      ).rows[0];
      assert.equal(row.attempts, attempt);
      if (attempt < 5) {
        assert.equal(row.status, 'PROCESSING');
        assert.equal(row.delay, [30, 60, 120, 240][attempt - 1]);
      } else assert.equal(row.status, 'FAILED');
    }
    assert.equal(calls, 5);
    assert.equal(await refundedHistory(f.order), 0);
    const paymentRow = (
      await pool.query('SELECT status, reconciliation_required FROM payments WHERE order_id=$1', [
        f.order,
      ])
    ).rows[0];
    assert.deepEqual(paymentRow, { status: 'REFUND_PENDING', reconciliation_required: true });
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM outbox WHERE user_id='admin' AND type='REFUND_FAILED' AND payload->>'refundRequestId'=$1",
          [refund.id],
        )
      ).rows[0].n,
      1,
    );
    assert.equal((await payment.processRefunds()).confirmed, 0);
  } finally {
    payment.paymentAdapter.refund = original.refund;
    payment.paymentAdapter.query = original.query;
    if (previousTimeout === undefined) delete process.env.PROVIDER_TIMEOUT_MS;
    else process.env.PROVIDER_TIMEOUT_MS = previousTimeout;
  }
  const queue = await request('/admin/refund-requests?status=FAILED', 'admin', undefined, 'GET');
  const failed = queue.data.items.find((item: any) => item.id === refund.id);
  assert.match(failed.lastError, /Simulator refused/);
  assert.deepEqual(
    failed.history.map((entry: any) => entry.to),
    ['REQUESTED', 'APPROVED', 'PROCESSING', 'FAILED'],
  );
  assert.equal(
    (
      await request(`/admin/refund-requests/${refund.id}/retry`, 'admin', {
        reason: 'x',
        idempotencyKey: 'retry-short-key',
      })
    ).status,
    400,
  );
  const retried = await request(`/admin/refund-requests/${refund.id}/retry`, 'admin', {
    reason: 'Simulator restored',
    idempotencyKey: 'retry-key-1',
  });
  assert.equal(retried.data.status, 'APPROVED');
  await payment.processRefunds();
  assert.equal(await refundedHistory(f.order), 1);
  assert.equal(
    (await pool.query('SELECT status FROM refund_requests WHERE id=$1', [refund.id])).rows[0]
      .status,
    'SUCCEEDED',
  );
});

test('a crash after the provider refunded is recovered by querying the stable reference', async () => {
  const f = await paidOrder('crash', 'DELIVERED');
  const complaint = await complaintFor(f.order);
  const refund = (
    await request(`/orders/${f.order}/refund-requests`, 'customer', {
      complaintId: complaint,
      reason: 'Damaged',
      idempotencyKey: 'crash-request-key',
    })
  ).data;
  await approve(refund.id, 'crash-approve-key');
  // Simulate: the worker claimed, the provider refunded, then the process died.
  await pool.query(
    "UPDATE refund_requests SET status='PROCESSING', attempts=1, lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [refund.id],
  );
  await pool.query("UPDATE simulated_transactions SET status='REFUNDED' WHERE reference=$1", [
    f.reference,
  ]);
  const original = payment.paymentAdapter.refund;
  let refundCalls = 0;
  payment.paymentAdapter.refund = async (...args) => {
    refundCalls++;
    return original.apply(payment.paymentAdapter, args);
  };
  try {
    await due(refund.id);
    assert.equal((await payment.processRefunds()).confirmed, 1);
  } finally {
    payment.paymentAdapter.refund = original;
  }
  assert.equal(refundCalls, 0);
  assert.equal(await refundedHistory(f.order), 1);
});

test('cancellation, late payment and legacy rows share the same single operation', async () => {
  const cancelled = await paidOrder('cancel', 'CONFIRMED', 'UNASSIGNED');
  assert.equal(
    (await request(`/orders/${cancelled.order}/cancel`, 'customer', { reason: 'Changed plans' }))
      .status,
    200,
  );
  const auto = (
    await pool.query('SELECT source, status FROM refund_requests WHERE order_id=$1', [
      cancelled.order,
    ])
  ).rows;
  assert.deepEqual(auto, [{ source: 'CANCELLATION', status: 'APPROVED' }]);
  await payment.reconcilePayments();
  assert.equal(await refundedHistory(cancelled.order), 1);

  const legacy = await paidOrder('legacy', 'CANCELLED', 'CANCELLED');
  await pool.query("UPDATE payments SET status='REFUND_PENDING' WHERE order_id=$1", [legacy.order]);
  await payment.reconcilePayments();
  await payment.reconcilePayments();
  const legacyRows = await pool.query(
    'SELECT source, status FROM refund_requests WHERE order_id=$1',
    [legacy.order],
  );
  assert.deepEqual(legacyRows.rows, [{ source: 'LEGACY', status: 'SUCCEEDED' }]);
  assert.equal(await refundedHistory(legacy.order), 1);

  const late = await paidOrder('late', 'PAYMENT_FAILED', 'CANCELLED');
  await pool.query(
    "UPDATE payments SET status='PENDING', external_transaction_id=NULL WHERE order_id=$1",
    [late.order],
  );
  await pool.query("UPDATE orders SET expires_at=now()-interval '1 minute' WHERE id=$1", [
    late.order,
  ]);
  const { applyPayment } = await import('../server/modules/payment/application/webhook.js');
  const event = {
    eventId: 'late-event',
    reference: late.reference,
    orderId: late.order,
    amount: 100000,
    currency: 'VND',
    status: 'SUCCEEDED',
    externalTransactionId: `sim_${late.reference}`,
  };
  await Promise.all([applyPayment(event), applyPayment(event)]);
  assert.deepEqual(
    (await pool.query('SELECT source FROM refund_requests WHERE order_id=$1', [late.order])).rows,
    [{ source: 'LATE_PAYMENT' }],
  );
  await Promise.all([payment.reconcilePayments(), payment.processRefunds()]);
  assert.equal(await refundedHistory(late.order), 1);
  assert.equal(
    (
      await request(`/orders/${late.order}/refund-requests`, 'customer', {
        reason: 'Again',
        idempotencyKey: 'late-manual-key',
      })
    ).data.code,
    'REFUND_NOT_ELIGIBLE',
  );
});
