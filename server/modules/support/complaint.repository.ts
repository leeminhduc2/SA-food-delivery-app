import { id, prisma, type DB } from '../../shared/db.js';

export type ComplaintRow = {
  id: string;
  order_id: string;
  customer_id: string | null;
  reporter_id: string;
  reporter_role: string;
  content: string;
  status: string;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  created_at: Date;
};

export async function insert(
  complaint: { orderId: string; reporterId: string; reporterRole: string; content: string },
  db: DB,
): Promise<ComplaintRow> {
  const row = await db.complaint.create({
    data: {
      id: id(),
      order_id: complaint.orderId,
      reporter_id: complaint.reporterId,
      reporter_role: complaint.reporterRole,
      // Legacy alias: only Customer reporters keep customer_id.
      customer_id: complaint.reporterRole === 'CUSTOMER' ? complaint.reporterId : null,
      content: complaint.content,
    },
  });
  await addHistory(row.id, complaint.reporterId, 'CREATED', null, db);
  return row;
}

export async function addHistory(
  complaintId: string,
  actorId: string,
  action: 'CREATED' | 'RESOLVED',
  note: string | null,
  db: DB,
): Promise<void> {
  await db.complaintHistory.create({
    data: { id: id(), complaint_id: complaintId, actor_id: actorId, action, note },
  });
}

export async function hasOpenComplaint(orderId: string, db: DB = prisma): Promise<boolean> {
  return Boolean(
    await db.complaint.findFirst({
      where: { order_id: orderId, status: 'OPEN' },
      select: { id: true },
    }),
  );
}

/** Existence check used by refund eligibility; status does not matter. */
export async function findForOrder(
  complaintId: string,
  orderId: string,
  db: DB = prisma,
): Promise<{ id: string; status: string } | undefined> {
  return (
    (await db.complaint.findFirst({
      where: { id: complaintId, order_id: orderId },
      select: { id: true, status: true },
    })) ?? undefined
  );
}

export async function findById(complaintId: string, db: DB = prisma) {
  return (
    (await db.complaint.findUnique({
      where: { id: complaintId },
      include: { history: { orderBy: { created_at: 'asc' } } },
    })) ?? undefined
  );
}

/** Reporters see only their own tickets; Admin sees all. */
export async function listForActor(role: string, userId: string, db: DB = prisma) {
  return db.complaint.findMany({
    where: role === 'ADMIN' ? {} : { reporter_id: userId },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    take: 100,
  });
}

export async function resolve(
  complaintId: string,
  resolution: string,
  actorId: string,
  db: DB,
): Promise<ComplaintRow | undefined> {
  const updated = await db.complaint.updateMany({
    where: { id: complaintId, status: 'OPEN' },
    data: { status: 'RESOLVED', resolution, resolved_by: actorId, resolved_at: new Date() },
  });
  if (!updated.count) return undefined;
  await addHistory(complaintId, actorId, 'RESOLVED', resolution, db);
  return (await db.complaint.findUnique({ where: { id: complaintId } })) ?? undefined;
}
