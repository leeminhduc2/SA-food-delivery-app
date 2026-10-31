import { id, prisma, type DB } from '../db.js';
import type { Prisma } from '@prisma/client';

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

export async function listInbox(userId: string, db: DB = prisma): Promise<any[]> {
  return db.notification.findMany({
    where: { user_id: userId },
    orderBy: { created_at: 'desc' },
    take: 50,
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
