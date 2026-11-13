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
import {
  CircuitOpenError,
  createCircuitBreaker,
  parseResilienceConfig,
  resetBreakers,
  retryRead,
} from '../server/shared/resilience.js';

const schema = `test_resilience_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 });
const target = testSchemaUrl(testDatabaseUrl(), schema);
const pool = new pg.Pool({ connectionString: target, connectionTimeoutMillis: 3000 });
process.env.DATABASE_URL = target;
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'true';
process.env.DEMO_PASSWORD = 'Resilience123!';
process.env.LOG_REQUESTS = 'false';
process.env.PAYMENT_MODE = 'simulated';
process.env.ASSIGNMENT_AUTOMATION_ENABLED = 'false';
let created = false,
  server: Server,
  base = '';
let db: typeof import('../server/shared/db.js');
let payment: typeof import('../server/modules/payment/index.js');
const cookies: Record<string, string> = {};

const clock = () => {
  let time = 1_000_000;
  return { now: () => time, advance: (ms: number) => (time += ms) };
};
const fail = async () => {
  throw new Error('network down');
};

test('breaker moves CLOSED → OPEN → HALF_OPEN with one probe and resets on success', async () => {
  const c = clock();
  let calls = 0;
  const b = createCircuitBreaker('test', { failureThreshold: 5, openMs: 30000, now: c.now });
  for (let i = 0; i < 4; i++) await assert.rejects(b.run(fail));
  assert.equal(await b.run(async () => 'ok'), 'ok');
  assert.equal(b.snapshot().consecutiveFailures, 0, 'success resets the count');
  for (let i = 0; i < 5; i++) await assert.rejects(b.run(fail));
  assert.equal(b.snapshot().state, 'OPEN');
  await assert.rejects(
    b.run(async () => {
      calls++;
      return 'never';
    }),
    CircuitOpenError,
  );
  assert.equal(calls, 0, 'an open breaker does not call the provider');
  c.advance(29999);
  assert.equal(b.snapshot().state, 'OPEN');
  c.advance(1);
  assert.equal(b.snapshot().state, 'HALF_OPEN');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const probe = b.run(async () => {
    calls++;
    await gate;
    throw new Error('still down');
  });
  const others = await Promise.allSettled([b.run(async () => calls++), b.run(async () => calls++)]);
  assert.ok(others.every((r) => r.status === 'rejected' && r.reason instanceof CircuitOpenError));
  release();
  await assert.rejects(probe);
  assert.equal(calls, 1, 'concurrent callers do not stampede the half-open probe');
  assert.equal(b.snapshot().state, 'OPEN', 'a failed probe opens again');
  c.advance(30000);
  assert.equal(await b.run(async () => 'back'), 'back');
  assert.equal(b.snapshot().state, 'CLOSED');
});

test('business rejections never trip the breaker; config defaults are 5 and 30 s', async () => {
  const b = createCircuitBreaker('validation', {
    failureThreshold: 5,
    openMs: 30000,
    counts: (error) => (error as { status?: number }).status !== 404,
  });
  for (let i = 0; i < 12; i++)
    await assert.rejects(
      b.run(async () => {
        throw Object.assign(new Error('no route'), { status: 404 });
      }),
    );
  assert.equal(b.snapshot().state, 'CLOSED');
  assert.deepEqual(parseResilienceConfig({}), {
    EXTERNAL_BREAKER_FAILURES: 5,
    EXTERNAL_BREAKER_OPEN_SECONDS: 30,
  });
  assert.throws(() => parseResilienceConfig({ EXTERNAL_BREAKER_FAILURES: '0' }));
});

test('read retries are bounded by count, jitter and the request budget', async () => {
  const c = clock();
  const waits: number[] = [];
  const sleep = async (ms: number) => {
    waits.push(ms);
    c.advance(ms);
  };
  let attempts = 0;
  await assert.rejects(
    retryRead(
      async () => {
        attempts++;
        throw new Error('503');
      },
      { now: c.now, sleep, random: () => 0.999, budgetMs: 5000 },
    ),
  );
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [350, 600]);
  attempts = 0;
  waits.length = 0;
  await assert.rejects(
    retryRead(
      async () => {
        attempts++;
        throw new Error('503');
      },
      { now: c.now, sleep, random: () => 0, budgetMs: 400 },
    ),
  );
  assert.equal(attempts, 2, 'the second retry would exceed the budget');
  attempts = 0;
  await assert.rejects(
    retryRead(
      async () => {
        attempts++;
        throw new CircuitOpenError('provider');
      },
      { now: c.now, sleep },
    ),
  );
  assert.equal(attempts, 1, 'an open breaker is not retried');
  attempts = 0;
  assert.equal(
    await retryRead(
      async () => {
        if (++attempts < 2) throw new Error('blip');
        return 'ok';
      },
      { now: c.now, sleep, random: () => 0 },
    ),
    'ok',
  );
});

async function login(who: string) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Bep' },
    body: JSON.stringify({ email: `${who}@bep.local`, password: process.env.DEMO_PASSWORD }),
  });
  assert.equal(response.status, 200);
  cookies[who] = response.headers.get('set-cookie')!.split(';')[0];
}
const get = async (path: string, who: string) => {
  const response = await fetch(`${base}/api${path}`, { headers: { cookie: cookies[who] ?? '' } });
  return { status: response.status, data: await response.json() };
};

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
  for (const who of ['admin', 'customer']) await login(who);
});
after(async () => {
  resetBreakers();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  if (db) await db.prisma.$disconnect();
  await pool.end();
  await dropTestSchema(admin, schema, created);
  await admin.end();
});

async function refundable(suffix: string) {
  const order = `res-order-${suffix}`,
    reference = `pay_res_${suffix}`,
    paymentId = randomUUID();
  await db.prisma.order.create({
    data: {
      id: order,
      customer_id: 'customer',
      restaurant_id: 'saigon',
      status: 'CANCELLED',
      subtotal: 1000,
      delivery_fee: 0,
      total: 1000,
      address: 'x',
      idempotency_key: order,
      fingerprint: 'res',
      expires_at: new Date('2099-01-01T00:00:00Z'),
    },
  });
  await db.prisma.payment.create({
    data: { id: paymentId, order_id: order, reference, amount: 1000, status: 'REFUND_PENDING' },
  });
  await db.prisma.simulatedTransaction.create({
    data: { reference, amount: 1000, status: 'SUCCEEDED', external_id: `sim_${reference}` },
  });
  await pool.query(
    "INSERT INTO refund_requests (id,order_id,payment_id,source,requested_by,requester_role,reason,amount,status,next_attempt_at) VALUES ($1,$2,$3,'CANCELLATION','system','SYSTEM','x',1000,'APPROVED',clock_timestamp())",
    [`refund-${suffix}`, order, paymentId],
  );
  return { order, paymentId, reference, refund: `refund-${suffix}` };
}

test('provider calls hold no row locks and an outage never refunds twice', async () => {
  resetBreakers();
  const f = await refundable('outage');
  const original = payment.paymentAdapter.refund;
  const originalQuery = payment.paymentAdapter.query;
  // Full outage: status reads fail too, so nothing resets the breaker.
  payment.paymentAdapter.query = async () => {
    throw new Error('provider outage');
  };
  let lockFree = true,
    calls = 0;
  payment.paymentAdapter.refund = async (reference: string) => {
    calls++;
    const probe = await pool.connect();
    try {
      await probe.query('BEGIN');
      await probe.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE NOWAIT', [f.order]);
      await probe.query('SELECT id FROM payments WHERE id=$1 FOR UPDATE NOWAIT', [f.paymentId]);
      await probe.query('SELECT id FROM refund_requests WHERE id=$1 FOR UPDATE NOWAIT', [f.refund]);
    } catch {
      lockFree = false;
    } finally {
      await probe.query('ROLLBACK');
      probe.release();
    }
    throw new Error('provider outage');
  };
  try {
    for (let i = 0; i < 6; i++) {
      await pool.query('UPDATE refund_requests SET next_attempt_at=clock_timestamp() WHERE id=$1', [
        f.refund,
      ]);
      await payment.processRefunds();
    }
  } finally {
    payment.paymentAdapter.refund = original;
    payment.paymentAdapter.query = originalQuery;
  }
  assert.ok(lockFree, 'no Order/Payment/Refund lock is held across the provider call');
  assert.ok(calls >= 1 && calls <= 5);
  const state = (
    await pool.query(
      "SELECT r.status, p.status AS payment, (SELECT count(*)::int FROM state_history WHERE order_id=$1 AND to_state='REFUNDED') AS refunded FROM refund_requests r JOIN payments p ON p.id=r.payment_id WHERE r.id=$2",
      [f.order, f.refund],
    )
  ).rows[0];
  assert.deepEqual(state, { status: 'FAILED', payment: 'REFUND_PENDING', refunded: 0 });
  const health = (await get('/admin/health/backlog', 'admin')).data;
  const breaker = health.breakers.find((item: any) => item.name === 'payment-provider');
  assert.equal(breaker.state, 'OPEN');
  // With the breaker open the next due refund is not sent to the provider at all.
  const second = await refundable('while-open');
  let sent = 0;
  payment.paymentAdapter.refund = async () => {
    sent++;
    return original.call(payment.paymentAdapter, second.reference);
  };
  try {
    await payment.processRefunds();
  } finally {
    payment.paymentAdapter.refund = original;
  }
  assert.equal(sent, 0);
  const waiting = (
    await pool.query('SELECT status, last_error FROM refund_requests WHERE id=$1', [second.refund])
  ).rows[0];
  assert.equal(waiting.status, 'PROCESSING');
  assert.match(waiting.last_error, /temporarily unavailable/);
  resetBreakers();
});

test('routing outages trip the routing breaker but "no route" answers do not', async () => {
  const routing = await import('../server/modules/location/infrastructure/routing.client.js');
  const { estimateWalking } = await import('../server/modules/location/index.js');
  let calls = 0,
    mode: 'down' | 'no-route' = 'no-route';
  routing.setRoutingProvider({
    name: 'flaky',
    async walkingRoute() {
      calls++;
      throw new routing.RoutingProviderError(mode === 'down' ? 'PROVIDER_ERROR' : 'NO_ROUTE', mode);
    },
  });
  const from = { latitude: 21.03, longitude: 105.85 },
    to = { latitude: 21.031, longitude: 105.851 };
  try {
    for (let i = 0; i < 7; i++) await assert.rejects(estimateWalking(from, to));
    assert.equal(calls, 7, 'NO_ROUTE never opens the breaker');
    mode = 'down';
    for (let i = 0; i < 5; i++) await assert.rejects(estimateWalking(from, to));
    const before = calls;
    await assert.rejects(estimateWalking(from, to), (error: any) => {
      assert.equal(error.code, 'PROVIDER_ERROR');
      assert.match(error.message, /temporarily unavailable/);
      return true;
    });
    assert.equal(calls, before, 'open routing breaker skips the provider');
  } finally {
    routing.resetRoutingProvider();
  }
});

test('backlog health exposes queues, last errors and next runs; job stages are isolated', async () => {
  await pool.query(
    "INSERT INTO outbox (id,user_id,type,payload,attempts,available_at,last_error) VALUES ($1,'customer','TEST','{}',2,clock_timestamp()-interval '20 minutes','smtp down')",
    [randomUUID()],
  );
  const { runIsolatedStages } = await import('../server/jobs.js');
  let ran = false;
  const failed = await runIsolatedStages([
    {
      name: 'broken stage',
      run: async () => {
        throw new Error('boom');
      },
    },
    {
      name: 'healthy stage',
      run: async () => {
        ran = true;
      },
    },
  ]);
  assert.deepEqual(failed, ['broken stage']);
  assert.ok(ran, 'one failing stage does not starve the next');
  const health = await get('/admin/health/backlog', 'admin');
  assert.equal(health.status, 200);
  const queue = (name: string) => health.data.queues.find((item: any) => item.queue === name);
  assert.equal(queue('notifications').overdue, true);
  assert.equal(queue('notifications').lastError, 'smtp down');
  assert.ok(queue('notifications').nextRunAt);
  assert.ok(queue('refunds').failed >= 1);
  assert.match(queue('refunds').lastError, /outage|temporarily unavailable/);
  const stage = health.data.stages.find((item: any) => item.name === 'broken stage');
  assert.equal(stage.lastError, 'boom');
  assert.equal(stage.consecutiveFailures, 1);
  assert.equal((await get('/admin/health/backlog', 'customer')).status, 403);
  const { alertBacklog } = await import('../server/modules/backoffice/index.js');
  const now = new Date();
  const first = await alertBacklog(now);
  assert.ok(first >= 2);
  await alertBacklog(now);
  const alerts = await pool.query(
    "SELECT payload->>'queue' AS queue, count(*)::int AS n FROM outbox WHERE user_id='admin' AND type='BACKLOG_ATTENTION' GROUP BY 1 ORDER BY 1",
  );
  assert.ok(
    alerts.rows.every((row) => row.n === 1),
    'one alert per queue per hour',
  );
  assert.ok(alerts.rows.some((row) => row.queue === 'refunds'));
});
