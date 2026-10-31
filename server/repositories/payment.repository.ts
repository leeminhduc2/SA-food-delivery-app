import { dbNow, id, lockRow, prisma, type DB } from '../db.js';

export type PaymentRow = {
  id: string;
  order_id: string;
  reference: string;
  amount: number;
  currency: string;
  status: string;
  external_transaction_id: string | null;
  provider_created: boolean;
  reconciliation_required: boolean;
  next_reconcile_at: Date | string;
  created_at: Date | string;
};

export async function insert(
  orderId: string,
  reference: string,
  amount: number,
  db: DB = prisma,
): Promise<void> {
  await db.payment.create({
    data: { id: id(), order_id: orderId, reference, amount },
  });
}

export async function findByOrder(
  orderId: string,
  db: DB = prisma,
): Promise<PaymentRow | undefined> {
  return (
    ((await db.payment.findUnique({ where: { order_id: orderId } })) as PaymentRow | null) ??
    undefined
  );
}

export async function findByOrderForUpdate(
  orderId: string,
  db: DB = prisma,
): Promise<PaymentRow | undefined> {
  await lockRow(db, 'payments', 'order_id', orderId);
  return findByOrder(orderId, db);
}

export async function findByReferenceForUpdate(
  reference: string,
  db: DB = prisma,
): Promise<PaymentRow | undefined> {
  await lockRow(db, 'payments', 'reference', reference);
  return (
    ((await db.payment.findUnique({ where: { reference } })) as PaymentRow | null) ?? undefined
  );
}

export async function findByIdForUpdate(
  paymentId: string,
  db: DB = prisma,
): Promise<PaymentRow | undefined> {
  await lockRow(db, 'payments', 'id', paymentId);
  return (
    ((await db.payment.findUnique({ where: { id: paymentId } })) as PaymentRow | null) ?? undefined
  );
}

export async function setStatus(paymentId: string, status: string, db: DB = prisma): Promise<void> {
  await db.payment.updateMany({ where: { id: paymentId }, data: { status } });
}

export async function setProviderCreated(paymentId: string, db: DB = prisma): Promise<void> {
  await db.payment.updateMany({ where: { id: paymentId }, data: { provider_created: true } });
}

export async function setSucceeded(
  paymentId: string,
  status: string,
  externalTransactionId: string,
  reconciliationRequired: boolean,
  db: DB = prisma,
): Promise<void> {
  await db.payment.updateMany({
    where: { id: paymentId },
    data: {
      status,
      external_transaction_id: externalTransactionId,
      reconciliation_required: reconciliationRequired,
    },
  });
}

export async function setFailed(
  paymentId: string,
  externalTransactionId: string,
  db: DB = prisma,
): Promise<void> {
  await db.payment.updateMany({
    where: { id: paymentId },
    data: { status: 'FAILED', external_transaction_id: externalTransactionId },
  });
}

export async function setRefunded(paymentId: string, db: DB = prisma): Promise<void> {
  await db.payment.updateMany({
    where: { id: paymentId },
    data: { status: 'REFUNDED', reconciliation_required: false },
  });
}

export async function setReconciliationRequired(paymentId: string, db: DB = prisma): Promise<void> {
  await db.payment.updateMany({
    where: { id: paymentId },
    data: { reconciliation_required: true },
  });
}

export async function findEvent(
  eventId: string,
  db: DB = prisma,
): Promise<{ event_id: string; reference: string; payload_hash: string } | undefined> {
  return (
    (await db.paymentEvent.findUnique({
      where: { event_id: eventId },
      select: { event_id: true, reference: true, payload_hash: true },
    })) ?? undefined
  );
}

export async function insertEvent(
  eventId: string,
  reference: string,
  payloadHash: string,
  db: DB = prisma,
): Promise<void> {
  await db.paymentEvent.create({
    data: { event_id: eventId, reference, payload_hash: payloadHash },
  });
}

export async function listPendingReconcile(
  limit = 100,
  db: DB = prisma,
): Promise<(PaymentRow & { expires_at: Date | string; order_status: string })[]> {
  const now = await dbNow(db);
  const rows = await db.payment.findMany({
    where: {
      next_reconcile_at: { lte: now },
      OR: [
        { status: { in: ['PENDING', 'REFUND_PENDING'] } },
        {
          status: 'EXPIRED',
          order: { created_at: { gt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
        },
      ],
    },
    include: { order: { select: { expires_at: true, status: true } } },
    orderBy: [{ next_reconcile_at: 'asc' }, { created_at: 'asc' }],
    take: limit,
  });
  return rows.map(({ order, ...payment }) => ({
    ...payment,
    expires_at: order.expires_at,
    order_status: order.status,
  })) as (PaymentRow & { expires_at: Date | string; order_status: string })[];
}

export async function setNextReconcile(paymentId: string, db: DB = prisma): Promise<void> {
  await db.payment.updateMany({
    where: { id: paymentId },
    data: { next_reconcile_at: new Date(Date.now() + 3000) },
  });
}

export async function insertSimulated(
  reference: string,
  amount: number,
  externalId: string,
  db: DB = prisma,
): Promise<void> {
  await db.simulatedTransaction.upsert({
    where: { reference },
    update: {},
    create: { reference, amount, external_id: externalId },
  });
}

export async function findSimulated(reference: string, db: DB = prisma): Promise<any | undefined> {
  return (await db.simulatedTransaction.findUnique({ where: { reference } })) ?? undefined;
}

export async function refundSimulated(reference: string, db: DB = prisma): Promise<void> {
  await db.simulatedTransaction.updateMany({
    where: { reference, status: 'SUCCEEDED' },
    data: { status: 'REFUNDED' },
  });
}

export async function setSimulatedStatus(
  reference: string,
  status: string,
  db: DB = prisma,
): Promise<any | undefined> {
  const updated = await db.simulatedTransaction.updateMany({
    where: { reference, status: 'PENDING' },
    data: { status },
  });
  if (!updated.count) return undefined;
  return (await db.simulatedTransaction.findUnique({ where: { reference } })) ?? undefined;
}

export async function listReconciliationQueue(db: DB = prisma): Promise<any[]> {
  return db.payment.findMany({
    where: { OR: [{ reconciliation_required: true }, { status: 'REFUND_PENDING' }] },
  });
}

export async function outboxHealth(db: DB = prisma): Promise<{ pending: number; failed: number }> {
  const [pending, failed] = await Promise.all([
    db.outbox.count({ where: { processed_at: null } }),
    db.outbox.count({ where: { processed_at: null, attempts: { gte: 5 } } }),
  ]);
  return { pending, failed };
}
