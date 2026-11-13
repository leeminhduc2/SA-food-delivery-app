import { id, prisma, type DB } from '../../../shared/db.js';

export type RefundRow = {
  id: string;
  order_id: string;
  payment_id: string;
  customer_id: string | null;
  source: string;
  incident_id: string | null;
  complaint_id: string | null;
  requested_by: string;
  requester_role: string;
  reason: string;
  amount: number;
  status: string;
  decided_by: string | null;
  decision_reason: string | null;
  decided_at: Date | null;
  attempts: number;
  next_attempt_at: Date | null;
  last_error: string | null;
  confirmed_at: Date | null;
  key_hash: string | null;
  created_at: Date;
  updated_at: Date;
};

export const effectiveStatuses = ['REQUESTED', 'APPROVED', 'PROCESSING', 'SUCCEEDED', 'FAILED'];

export async function findById(requestId: string, db: DB = prisma): Promise<RefundRow | undefined> {
  return (
    ((await db.refundRequest.findUnique({ where: { id: requestId } })) as RefundRow) ?? undefined
  );
}

export async function findForUpdate(requestId: string, db: DB): Promise<RefundRow | undefined> {
  const rows = await db.$queryRaw<RefundRow[]>`
    SELECT * FROM refund_requests WHERE id = ${requestId} FOR UPDATE`;
  return rows[0];
}

export async function findReceipt(requestedBy: string, orderId: string, keyHash: string, db: DB) {
  return (
    ((await db.refundRequest.findFirst({
      where: { requested_by: requestedBy, order_id: orderId, key_hash: keyHash },
    })) as RefundRow | null) ?? undefined
  );
}

export async function findEffective(paymentId: string, db: DB = prisma) {
  return (
    ((await db.refundRequest.findFirst({
      where: { payment_id: paymentId, status: { in: effectiveStatuses } },
    })) as RefundRow | null) ?? undefined
  );
}

export async function insert(
  request: {
    orderId: string;
    paymentId: string;
    customerId: string | null;
    source: string;
    incidentId?: string | null;
    complaintId?: string | null;
    requestedBy: string;
    requesterRole: string;
    reason: string;
    amount: number;
    status: 'REQUESTED' | 'APPROVED';
    keyHash?: string | null;
  },
  db: DB,
): Promise<string | null> {
  const requestId = id();
  const approved = request.status === 'APPROVED';
  // The partial unique index keeps one effective operation per payment.
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    INSERT INTO refund_requests (id, order_id, payment_id, customer_id, source, incident_id, complaint_id,
      requested_by, requester_role, reason, amount, status, key_hash, decided_by, decided_at, next_attempt_at)
    VALUES (${requestId}, ${request.orderId}, ${request.paymentId}, ${request.customerId}, ${request.source},
      ${request.incidentId ?? null}, ${request.complaintId ?? null}, ${request.requestedBy},
      ${request.requesterRole}, ${request.reason}, ${request.amount}, ${request.status},
      ${request.keyHash ?? null}, ${approved ? 'system' : null},
      CASE WHEN ${approved} THEN clock_timestamp() END, CASE WHEN ${approved} THEN clock_timestamp() END)
    ON CONFLICT (payment_id) WHERE status IN ('REQUESTED','APPROVED','PROCESSING','SUCCEEDED','FAILED')
    DO NOTHING RETURNING id`;
  if (!rows.length) return null;
  await addHistory(requestId, null, request.status, request.requestedBy, request.reason, db);
  return requestId;
}

export async function addHistory(
  requestId: string,
  from: string | null,
  to: string,
  actor: string,
  reason: string | null,
  db: DB,
): Promise<void> {
  await db.refundRequestHistory.create({
    data: {
      id: id(),
      refund_request_id: requestId,
      from_status: from,
      to_status: to,
      actor,
      reason,
    },
  });
}

export async function update(requestId: string, data: Record<string, unknown>, db: DB) {
  await db.refundRequest.update({
    where: { id: requestId },
    data: { ...data, updated_at: new Date() },
  });
}

/**
 * Claims due work with a lease. SKIP LOCKED and the lease keep two workers from
 * handling the same request; attempts doubles as the claim generation.
 */
/** Due immediately by the database clock, which also drives claimDue. */
export async function makeDueNow(requestId: string, db: DB): Promise<void> {
  await db.$executeRaw`UPDATE refund_requests SET next_attempt_at = clock_timestamp() WHERE id = ${requestId}`;
}

export async function claimDue(limit: number, leaseSeconds: number) {
  return prisma.$queryRaw<
    Array<{ id: string; order_id: string; payment_id: string; attempts: number; was: string }>
  >`
    WITH due AS (
      SELECT id, status FROM refund_requests
      WHERE status IN ('APPROVED','PROCESSING') AND next_attempt_at <= clock_timestamp()
        AND (lease_until IS NULL OR lease_until < clock_timestamp())
      ORDER BY next_attempt_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED
    )
    UPDATE refund_requests r
    SET status = 'PROCESSING', attempts = r.attempts + 1, updated_at = clock_timestamp(),
        lease_until = clock_timestamp() + ${leaseSeconds} * interval '1 second'
    FROM due WHERE r.id = due.id
    RETURNING r.id, r.order_id, r.payment_id, r.attempts, due.status AS was`;
}

export async function list(where: { status?: string; orderId?: string }, db: DB = prisma) {
  return (await db.refundRequest.findMany({
    where: {
      ...(where.status ? { status: where.status } : {}),
      ...(where.orderId ? { order_id: where.orderId } : {}),
    },
    include: { history: { orderBy: { created_at: 'asc' } } },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    take: 100,
  })) as Array<RefundRow & { history: any[] }>;
}
