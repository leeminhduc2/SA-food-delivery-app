import { lockRow, prisma, type DB } from '../db.js';
import type { Prisma } from '@prisma/client';

export type OrderRow = {
  id: string;
  customer_id: string;
  restaurant_id: string;
  status: string;
  subtotal: number;
  delivery_fee: number;
  total: number;
  currency: string;
  address: string;
  note: string;
  idempotency_key: string;
  fingerprint: string;
  stock_released: boolean;
  expires_at: Date | string;
  created_at: Date | string;
};

export type OrderInsert = {
  id: string;
  customerId: string;
  restaurantId: string;
  subtotal: number;
  deliveryFee: number;
  total: number;
  address: string;
  note: string;
  idempotencyKey: string;
  fingerprint: string;
  expiresAt: Date;
};

/** Serialize concurrent checkouts that share the same customer/key. */
export async function advisoryCheckoutLock(key: string, db: DB = prisma): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

export async function insert(order: OrderInsert, db: DB = prisma): Promise<void> {
  await db.order.create({
    data: {
      id: order.id,
      customer_id: order.customerId,
      restaurant_id: order.restaurantId,
      status: 'PENDING_PAYMENT',
      subtotal: order.subtotal,
      delivery_fee: order.deliveryFee,
      total: order.total,
      address: order.address,
      note: order.note,
      idempotency_key: order.idempotencyKey,
      fingerprint: order.fingerprint,
      expires_at: order.expiresAt,
    },
  });
}

export async function insertItem(
  item: {
    orderId: string;
    itemId: string;
    name: string;
    price: number;
    quantity: number;
    options: unknown;
  },
  id: string,
  db: DB = prisma,
): Promise<void> {
  await db.orderItem.create({
    data: {
      id,
      order_id: item.orderId,
      menu_item_id: item.itemId,
      name: item.name,
      price: item.price,
      quantity: item.quantity,
      options: item.options as Prisma.InputJsonValue,
    },
  });
}

export async function findById(
  orderId: string,
  db: DB = prisma,
  lock = false,
): Promise<OrderRow | undefined> {
  if (lock) await lockRow(db, 'orders', 'id', orderId);
  return ((await db.order.findUnique({ where: { id: orderId } })) as OrderRow | null) ?? undefined;
}

export async function findByCustomerAndKey(
  customerId: string,
  idempotencyKey: string,
  db: DB = prisma,
): Promise<OrderRow | undefined> {
  return (
    ((await db.order.findUnique({
      where: {
        customer_id_idempotency_key: {
          customer_id: customerId,
          idempotency_key: idempotencyKey,
        },
      },
    })) as OrderRow | null) ?? undefined
  );
}

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
      delivery: { is: { assignments: { some: { driver_id: userId, active: true } } } },
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
    include: { restaurant: { select: { name: true } } },
  });
  if (!row) return undefined;
  const { restaurant, ...order } = row;
  return { ...order, restaurant_name: restaurant.name };
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

export async function setStatus(orderId: string, status: string, db: DB = prisma): Promise<void> {
  await db.order.updateMany({ where: { id: orderId }, data: { status } });
}

export async function markStockReleased(orderId: string, db: DB = prisma): Promise<boolean> {
  const updated = await db.order.updateMany({
    where: { id: orderId, stock_released: false },
    data: { stock_released: true },
  });
  return updated.count > 0;
}

export async function itemsForStockRelease(
  orderId: string,
  db: DB = prisma,
): Promise<{ menu_item_id: string; quantity: number }[]> {
  return db.orderItem.findMany({
    where: { order_id: orderId },
    select: { menu_item_id: true, quantity: true },
    orderBy: { menu_item_id: 'asc' },
  });
}

export async function listExpiredIds(limit = 100, db: DB = prisma): Promise<{ id: string }[]> {
  return db.order.findMany({
    where: { status: 'PENDING_PAYMENT', expires_at: { lte: new Date() } },
    select: { id: true },
    take: limit,
  });
}

export async function lock(orderId: string, db: DB = prisma): Promise<OrderRow | undefined> {
  return findById(orderId, db, true);
}

export async function isDriverAssigned(
  orderId: string,
  driverId: string,
  db: DB = prisma,
): Promise<{ id: string } | undefined> {
  return (
    (await db.delivery.findFirst({
      where: {
        order_id: orderId,
        assignments: { some: { driver_id: driverId, active: true } },
      },
      select: { id: true },
    })) ?? undefined
  );
}
