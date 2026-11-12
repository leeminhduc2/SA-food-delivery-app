import type { Prisma } from '@prisma/client';
import { prisma, type DB } from '../../../shared/db.js';

/**
 * Read model for order lists and the order detail screen.
 *
 * Projection exception (docs/DECISIONS.md): these queries read other modules'
 * tables (restaurants, restaurant members, payments, deliveries, reviews,
 * state history) for display only. Nothing here writes, and no other module
 * depends on these shapes.
 */

export async function listVisibleIds(
  role: string,
  userId: string,
  db: DB = prisma,
): Promise<{ id: string }[]> {
  let where: Prisma.OrderWhereInput = {};
  if (role === 'CUSTOMER') where = { customer_id: userId };
  else if (role === 'RESTAURANT')
    where = {
      status: { not: 'PENDING_PAYMENT' },
      restaurant: { members: { some: { user_id: userId } } },
    };
  else if (role === 'DRIVER')
    where = {
      delivery: {
        is: {
          OR: [
            { assignments: { some: { driver_id: userId, active: true } } },
            {
              driver_id: userId,
              status: { in: ['DELIVERED', 'FAILED', 'CANCELLED'] },
              assignments: {
                some: {
                  driver_id: userId,
                  end_reason: { in: ['DELIVERED', 'FAILED', 'CANCELLED', 'MIGRATION_TERMINAL'] },
                },
              },
            },
          ],
        },
      },
    };
  return db.order.findMany({
    where,
    select: { id: true },
    orderBy: { created_at: 'desc' },
    take: 100,
  });
}

export async function detailRow(orderId: string, db: DB = prisma): Promise<any | undefined> {
  const row = await db.order.findUnique({
    where: { id: orderId },
    include: {
      restaurant: { select: { name: true, address: true, latitude: true, longitude: true } },
    },
  });
  if (!row) return undefined;
  const { restaurant, ...order } = row;
  return {
    ...order,
    restaurant_name: restaurant.name,
    pickup: {
      name: restaurant.name,
      address: restaurant.address,
      latitude: restaurant.latitude,
      longitude: restaurant.longitude,
    },
  };
}

export async function detailItems(orderId: string, db: DB = prisma): Promise<any[]> {
  return db.orderItem.findMany({ where: { order_id: orderId }, orderBy: { id: 'asc' } });
}

export async function detailPayment(orderId: string, db: DB = prisma): Promise<any | undefined> {
  return (await db.payment.findUnique({ where: { order_id: orderId } })) ?? undefined;
}

export async function detailDelivery(orderId: string, db: DB = prisma): Promise<any | undefined> {
  const row = await db.delivery.findUnique({
    where: { order_id: orderId },
    include: { driver: { select: { name: true } } },
  });
  if (!row) return undefined;
  const { driver, ...delivery } = row;
  return { ...delivery, driver_name: driver?.name ?? null };
}

export async function detailHistory(orderId: string, db: DB = prisma): Promise<any[]> {
  const rows = await db.stateHistory.findMany({
    where: { order_id: orderId },
    orderBy: { sequence: 'asc' },
  });
  return rows.map((row) => ({ ...row, sequence: row.sequence.toString() }));
}

export async function detailReview(orderId: string, db: DB = prisma): Promise<any | undefined> {
  return (await db.review.findUnique({ where: { order_id: orderId } })) ?? undefined;
}
