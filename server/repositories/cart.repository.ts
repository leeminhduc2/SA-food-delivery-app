import { lockRow, prisma, type DB } from '../db.js';
import type { z } from 'zod';
import type { lineSchema } from '../domain/schemas.js';
import type { Prisma } from '@prisma/client';

export type CartRow = {
  customer_id: string;
  items: z.infer<typeof lineSchema>[];
  version: number;
};

function cartRow(row: { customer_id: string; items: Prisma.JsonValue; version: number }): CartRow {
  return {
    customer_id: row.customer_id,
    items: row.items as CartRow['items'],
    version: row.version,
  };
}

export async function ensure(customerId: string, db: DB = prisma): Promise<void> {
  await db.cart.upsert({
    where: { customer_id: customerId },
    update: {},
    create: { customer_id: customerId },
  });
}

export async function findByCustomer(
  customerId: string,
  db: DB = prisma,
): Promise<CartRow | undefined> {
  const row = await db.cart.findUnique({ where: { customer_id: customerId } });
  return row ? cartRow(row) : undefined;
}

export async function findForUpdate(
  customerId: string,
  db: DB = prisma,
): Promise<CartRow | undefined> {
  await lockRow(db, 'carts', 'customer_id', customerId);
  return findByCustomer(customerId, db);
}

export async function updateItems(
  customerId: string,
  items: unknown[],
  db: DB = prisma,
): Promise<CartRow> {
  const row = await db.cart.update({
    where: { customer_id: customerId },
    data: { items: items as Prisma.InputJsonValue, version: { increment: 1 } },
  });
  return cartRow(row);
}

export async function clear(customerId: string, db: DB = prisma): Promise<void> {
  await db.cart.updateMany({
    where: { customer_id: customerId },
    data: { items: [], version: { increment: 1 } },
  });
}
