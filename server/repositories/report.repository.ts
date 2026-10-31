import { prisma, type DB } from '../db.js';
import type { Prisma } from '@prisma/client';

function accessWhere(role: string, userId: string): Prisma.OrderWhereInput {
  return role === 'ADMIN' ? {} : { restaurant: { members: { some: { user_id: userId } } } };
}

export async function summary(role: string, userId: string, db: DB = prisma): Promise<any> {
  const groups = await db.order.groupBy({
    by: ['status'],
    where: accessWhere(role, userId),
    _count: { _all: true },
    _sum: { total: true },
  });
  let orders = 0;
  let delivered = 0;
  let delivery_failed = 0;
  let revenue = 0;
  let pending = 0;
  for (const group of groups) {
    const count = group._count._all;
    orders += count;
    if (group.status === 'DELIVERED') {
      delivered += count;
      revenue += group._sum.total ?? 0;
    }
    if (group.status === 'DELIVERY_FAILED') delivery_failed += count;
    if (group.status === 'PENDING_PAYMENT') pending += count;
  }
  return { orders, delivered, delivery_failed, revenue, pending };
}

export async function daily(role: string, userId: string, db: DB = prisma): Promise<any[]> {
  const rows = await db.order.findMany({
    where: {
      ...accessWhere(role, userId),
      created_at: { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
    },
    select: { created_at: true, status: true, total: true },
  });
  const days = new Map<string, { day: string; orders: number; revenue: number }>();
  for (const row of rows) {
    const day = row.created_at.toISOString().slice(0, 10);
    const entry = days.get(day) ?? { day, orders: 0, revenue: 0 };
    entry.orders++;
    if (row.status === 'DELIVERED') entry.revenue += row.total;
    days.set(day, entry);
  }
  return [...days.values()].sort((a, b) => b.day.localeCompare(a.day)).slice(0, 14);
}
