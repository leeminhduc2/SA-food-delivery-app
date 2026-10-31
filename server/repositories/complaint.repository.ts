import { id, prisma, type DB } from '../db.js';

export async function insert(
  complaint: { orderId: string; customerId: string; content: string },
  db: DB = prisma,
): Promise<any> {
  return db.complaint.create({
    data: {
      id: id(),
      order_id: complaint.orderId,
      customer_id: complaint.customerId,
      content: complaint.content,
    },
  });
}

export async function listForActor(role: string, userId: string, db: DB = prisma): Promise<any[]> {
  return db.complaint.findMany({
    where: role === 'ADMIN' ? {} : { customer_id: userId },
    orderBy: { created_at: 'desc' },
    take: 100,
  });
}

export async function resolve(
  complaintId: string,
  resolution: string,
  db: DB = prisma,
): Promise<any | undefined> {
  const updated = await db.complaint.updateMany({
    where: { id: complaintId, status: 'OPEN' },
    data: { status: 'RESOLVED', resolution },
  });
  if (!updated.count) return undefined;
  return (await db.complaint.findUnique({ where: { id: complaintId } })) ?? undefined;
}
