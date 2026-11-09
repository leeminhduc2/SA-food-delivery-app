import 'dotenv/config';
import type { Prisma } from '@prisma/client';
import { prisma, transaction } from './db.js';

/**
 * Demo-only: give every account up to five fake in-app notifications so the
 * bell indicator, unread styling and "Mark all as read" can be checked by hand.
 *
 * - Idempotent: ids are deterministic (`mock-notif-<userId>-<n>`), so re-running
 *   never adds more than five per account. It also resets their read state and
 *   timestamps, which makes the behaviour repeatable.
 * - `--clear` removes the mock rows and leaves real notifications untouched.
 *
 * A notification row shares its id with an outbox row (FK), so each mock gets
 * an outbox event that is already marked as processed; the worker skips it.
 */
const MOCKS: Array<{
  type: string;
  payload: Record<string, unknown>;
  read: boolean;
  minutesAgo: number;
}> = [
  { type: 'ORDER_STATUS', payload: { status: 'PREPARING' }, read: false, minutesAgo: 2 },
  { type: 'ORDER_STATUS', payload: { status: 'ACCEPTED' }, read: false, minutesAgo: 9 },
  { type: 'ORDER_CREATED', payload: {}, read: false, minutesAgo: 15 },
  {
    type: 'COMPLAINT_RESOLVED',
    payload: { resolution: 'Đã hoàn 30.000 ₫ cho món bị thiếu.' },
    read: true,
    minutesAgo: 60 * 5,
  },
  { type: 'ORDER_STATUS', payload: { status: 'DELIVERED' }, read: true, minutesAgo: 60 * 26 },
];

const mockId = (userId: string, n: number) => `mock-notif-${userId}-${n + 1}`;

export async function clearMockNotifications(): Promise<number> {
  return transaction(async (db) => {
    const { count } = await db.notification.deleteMany({
      where: { id: { startsWith: 'mock-notif-' } },
    });
    await db.outbox.deleteMany({ where: { id: { startsWith: 'mock-notif-' } } });
    return count;
  });
}

export async function seedMockNotifications(): Promise<{ users: number; notifications: number }> {
  if (process.env.DEMO_MODE !== 'true')
    throw new Error('Mock notifications are only available with DEMO_MODE=true.');
  const users = await prisma.user.findMany({ select: { id: true } });
  let total = 0;
  await transaction(async (db) => {
    for (const user of users)
      for (const [n, mock] of MOCKS.entries()) {
        const id = mockId(user.id, n);
        const createdAt = new Date(Date.now() - mock.minutesAgo * 60_000);
        const payload = {
          orderId: `mock-order-${n + 1}`,
          ...mock.payload,
        } as Prisma.InputJsonValue;
        await db.outbox.upsert({
          where: { id },
          update: { processed_at: createdAt },
          create: {
            id,
            user_id: user.id,
            type: mock.type,
            payload,
            attempts: 1,
            available_at: createdAt,
            processed_at: createdAt,
          },
        });
        await db.notification.upsert({
          where: { id },
          update: { type: mock.type, payload, read: mock.read, created_at: createdAt },
          create: {
            id,
            user_id: user.id,
            type: mock.type,
            payload,
            read: mock.read,
            created_at: createdAt,
          },
        });
        total++;
      }
  });
  return { users: users.length, notifications: total };
}

if (process.argv[1]?.endsWith('seed-notifications.ts')) {
  if (process.argv.includes('--clear')) {
    const removed = await clearMockNotifications();
    console.log(`Removed ${removed} mock notifications.`);
  } else {
    const report = await seedMockNotifications();
    console.log(
      `Mock notifications ready: ${report.notifications} rows for ${report.users} accounts ` +
        `(3 unread + 2 read each).`,
    );
  }
  await prisma.$disconnect();
}
