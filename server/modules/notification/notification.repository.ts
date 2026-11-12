import { id, prisma, type DB } from '../../shared/db.js';
import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';

export async function enqueue(
  userId: string,
  type: string,
  payload: unknown,
  db: DB = prisma,
): Promise<void> {
  await db.outbox.create({
    data: {
      id: id(),
      user_id: userId,
      type,
      payload: payload as Prisma.InputJsonValue,
    },
  });
}

/** Stable recipient-scoped IDs make enqueue retry-safe without changing legacy rows. */
export async function enqueueOnce(
  userId: string,
  type: string,
  payload: unknown,
  businessKey: string,
  db: DB = prisma,
): Promise<void> {
  const eventId =
    'dedupe_' +
    createHash('sha256')
      .update(JSON.stringify([userId, type, businessKey]))
      .digest('hex');
  await db.outbox.createMany({
    data: [{ id: eventId, user_id: userId, type, payload: payload as Prisma.InputJsonValue }],
    skipDuplicates: true,
  });
}

export async function listInbox(userId: string, db: DB = prisma): Promise<any[]> {
  return db.notification.findMany({
    where: { user_id: userId },
    orderBy: { created_at: 'desc' },
    take: 50,
  });
}

/**
 * Notifications after the cursor, ordered by (created_at, id). Rows written
 * in one transaction share a timestamp, so the id breaks ties. Returns null
 * when the cursor is unknown for this user (expired, foreign or mistyped).
 */
export async function listAfter(
  userId: string,
  cursorId: string,
  limit: number,
  db: DB = prisma,
): Promise<any[] | null> {
  const cursor = await db.notification.findFirst({
    where: { id: cursorId, user_id: userId },
    select: { created_at: true },
  });
  if (!cursor) return null;
  return db.notification.findMany({
    where: {
      user_id: userId,
      OR: [
        { created_at: { gt: cursor.created_at } },
        { created_at: cursor.created_at, id: { gt: cursorId } },
      ],
    },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    take: limit,
  });
}

export async function markRead(userId: string, db: DB = prisma): Promise<void> {
  await db.notification.updateMany({ where: { user_id: userId }, data: { read: true } });
}

export async function claimEvents(db: DB = prisma): Promise<any[]> {
  // Prisma has no FOR UPDATE SKIP LOCKED equivalent. Parameterless and safe.
  return db.$queryRaw<
    Array<{
      id: string;
      user_id: string;
      type: string;
      payload: unknown;
      attempts: number;
    }>
  >`SELECT * FROM outbox WHERE processed_at IS NULL AND attempts<5 AND available_at<=now() ORDER BY available_at LIMIT 50 FOR UPDATE SKIP LOCKED`;
}

export async function insertNotification(
  event: { id: string; user_id: string; type: string; payload: unknown },
  db: DB = prisma,
): Promise<void> {
  await db.notification.createMany({
    data: [
      {
        id: event.id,
        user_id: event.user_id,
        type: event.type,
        payload: event.payload as Prisma.InputJsonValue,
      },
    ],
    skipDuplicates: true,
  });
}

export async function markProcessed(eventId: string, db: DB = prisma): Promise<void> {
  await db.outbox.updateMany({
    where: { id: eventId },
    data: { processed_at: new Date(), attempts: { increment: 1 } },
  });
}

export async function markFailed(eventId: string, db: DB = prisma): Promise<void> {
  await db.outbox.updateMany({
    where: { id: eventId },
    data: {
      attempts: { increment: 1 },
      last_error: 'Notification delivery failed',
      available_at: new Date(Date.now() + 30000),
    },
  });
}

/** Deliver one claimed outbox event, isolating a failure in a savepoint. */
export async function deliverEvent(event: any, db: DB = prisma): Promise<boolean> {
  // Savepoints are not exposed by Prisma; this is an intentional raw exception.
  await db.$executeRawUnsafe('SAVEPOINT notification_attempt');
  try {
    await insertNotification(event, db);
    await markProcessed(event.id, db);
    return true;
  } catch {
    await db.$executeRawUnsafe('ROLLBACK TO SAVEPOINT notification_attempt');
    await markFailed(event.id, db);
    return false;
  } finally {
    await db.$executeRawUnsafe('RELEASE SAVEPOINT notification_attempt');
  }
}

export async function outboxHealth(db: DB = prisma): Promise<{ pending: number; failed: number }> {
  const [pending, failed] = await Promise.all([
    db.outbox.count({ where: { processed_at: null } }),
    db.outbox.count({ where: { processed_at: null, attempts: { gte: 5 } } }),
  ]);
  return { pending, failed };
}
