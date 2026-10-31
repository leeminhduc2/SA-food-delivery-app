import { id, prisma, type DB } from '../db.js';
import type { Prisma } from '@prisma/client';

export async function audit(
  actor: string,
  action: string,
  resourceId: string,
  detail: unknown = {},
  db: DB = prisma,
): Promise<void> {
  await db.auditLog.create({
    data: {
      id: id(),
      actor,
      action,
      resource_id: resourceId,
      detail: detail as Prisma.InputJsonValue,
    },
  });
}

export async function history(
  orderId: string,
  entity: string,
  from: string | null,
  to: string,
  actor: string,
  reason = '',
  db: DB = prisma,
): Promise<void> {
  await db.stateHistory.create({
    data: {
      id: id(),
      order_id: orderId,
      entity,
      from_state: from,
      to_state: to,
      actor,
      reason,
    },
  });
}

export async function listRecent(db: DB = prisma): Promise<any[]> {
  return db.auditLog.findMany({ orderBy: { created_at: 'desc' }, take: 100 });
}
