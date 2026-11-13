import { createHash } from 'node:crypto';
import { id, prisma, transaction, type DB } from '../../../shared/db.js';
import { check } from '../../../shared/errors.js';
import type { User } from '../../../shared/types.js';
import * as audits from '../../../shared/audit.repository.js';
import * as menu from '../infrastructure/menu.repository.js';
import { assertMember } from './authorization.service.js';
import { activeRestaurantIds } from '../../identity/index.js';
import { notifyOnce } from '../../notification/index.js';
import { memberUserIds } from '../infrastructure/restaurant.repository.js';
import { inventoryConfig } from '../config.js';
import { z } from 'zod';

export type MovementKind = 'OPENING' | 'RESERVE' | 'RELEASE' | 'ADJUSTMENT';

/** Locks the item before opening, backfill, or any movement; safe to call repeatedly. */
export async function ensureOpeningBalance(db: DB, itemId: string) {
  const items = await db.$queryRaw<
    Array<{ stock: number }>
  >`SELECT stock FROM menu_items WHERE id = ${itemId} FOR UPDATE`;
  check(items.length, 404, 'NOT_FOUND', 'Dish not found.');
  const stock = items[0].stock;
  await db.$executeRaw`INSERT INTO stock_movements (id, item_id, kind, delta, balance_after, actor, reason, operation_key)
    VALUES (${id()}, ${itemId}, 'OPENING', ${stock}, ${stock}, 'system', 'Opening balance at ledger cutover', 'opening')
    ON CONFLICT (item_id, operation_key) DO NOTHING`;
  return stock;
}

export async function ensureOpeningBalances(db: DB, ids: readonly string[]) {
  for (const itemId of [...new Set(ids)].sort()) await ensureOpeningBalance(db, itemId);
}

/** All stock mutations and their movement records share the item lock and transaction. */
export async function moveStock(
  db: DB,
  input: {
    itemId: string;
    kind: 'RESERVE' | 'RELEASE' | 'ADJUSTMENT';
    delta: number;
    actor: string;
    reason: string;
    operationKey: string;
    orderId?: string;
  },
) {
  const stock = await ensureOpeningBalance(db, input.itemId);
  const rows = await db.$queryRaw<
    Array<{
      id: string;
      kind: string;
      delta: number;
      balance_after: number;
      order_id: string | null;
    }>
  >`SELECT id, kind, delta, balance_after, order_id FROM stock_movements WHERE item_id = ${input.itemId} AND operation_key = ${input.operationKey}`;
  if (rows.length) {
    const old = rows[0];
    check(
      old.kind === input.kind &&
        old.delta === input.delta &&
        old.order_id === (input.orderId ?? null),
      409,
      'IDEMPOTENCY_CONFLICT',
      'This stock operation has different details.',
    );
    return { movementId: old.id, balanceAfter: old.balance_after, replayed: true };
  }
  const balance = stock + input.delta;
  check(
    Number.isSafeInteger(balance) && balance >= 0 && balance <= 2147483647,
    409,
    'OUT_OF_STOCK',
    'The adjustment would produce an invalid stock balance.',
  );
  const movementId = id();
  const [metadata] = await db.$queryRaw<
    Array<{ restaurant_id: string; low_stock_threshold: number }>
  >`SELECT restaurant_id,COALESCE(low_stock_threshold, ${inventoryConfig.LOW_STOCK_THRESHOLD}::integer) AS low_stock_threshold FROM menu_items WHERE id = ${input.itemId}`;
  await db.menuItem.update({ where: { id: input.itemId }, data: { stock: balance } });
  await db.$executeRaw`INSERT INTO stock_movements (id,item_id,kind,delta,balance_after,actor,reason,operation_key,order_id)
    VALUES (${movementId},${input.itemId},${input.kind},${input.delta},${balance},${input.actor},${input.reason},${input.operationKey},${input.orderId ?? null})`;
  if (stock > metadata.low_stock_threshold && balance <= metadata.low_stock_threshold) {
    const members = await activeRestaurantIds(await memberUserIds(metadata.restaurant_id, db), db);
    for (const recipient of members)
      await notifyOnce(
        db,
        recipient,
        'LOW_STOCK',
        {
          itemId: input.itemId,
          restaurantId: metadata.restaurant_id,
          stock: balance,
          threshold: metadata.low_stock_threshold,
        },
        movementId,
      );
  }
  return { movementId, balanceAfter: balance, replayed: false };
}

const adjustmentSchema = z
  .object({
    delta: z
      .number()
      .int()
      .min(-100000)
      .max(100000)
      .refine((value) => value !== 0),
    reason: z.string().trim().min(3).max(300),
    idempotencyKey: z.string().min(8).max(120),
  })
  .strict();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** The item is already locked and ownership checked by the caller. */
export async function adjustLocked(
  db: DB,
  actor: User,
  itemId: string,
  currentStock: number,
  input: {
    delta?: number;
    target?: number;
    reason: string;
    key: string;
    fingerprintExtra?: unknown;
  },
) {
  const keyHash = digest(input.key);
  const fingerprint = digest(
    JSON.stringify({
      delta: input.delta ?? null,
      target: input.target ?? null,
      reason: input.reason,
      extra: input.fingerprintExtra ?? null,
    }),
  );
  const receipt = await audits.findCommandReceipt<{
    fingerprint: string;
    movementId: string | null;
    balanceAfter: number;
  }>(actor.id, 'INVENTORY_ADJUSTED', itemId, keyHash, db);
  if (receipt) {
    check(
      receipt.fingerprint === fingerprint,
      409,
      'IDEMPOTENCY_CONFLICT',
      'This key was used with different stock details.',
    );
    return {
      movementId: receipt.movementId,
      stock: currentStock,
      balanceAfter: receipt.balanceAfter,
      replayed: true,
    };
  }
  const delta = input.delta ?? input.target! - currentStock;
  const result =
    delta === 0
      ? { movementId: null, balanceAfter: currentStock }
      : await moveStock(db, {
          itemId,
          kind: 'ADJUSTMENT',
          delta,
          actor: actor.id,
          reason: input.reason,
          operationKey: `adjust:${digest(JSON.stringify([actor.id, input.key]))}`,
        });
  await audits.audit(
    actor.id,
    'INVENTORY_ADJUSTED',
    itemId,
    {
      keyHash,
      fingerprint,
      movementId: result.movementId,
      balanceAfter: result.balanceAfter,
      reason: input.reason,
      delta,
    },
    db,
    { resourceType: 'MENU_ITEM', outcome: 'SUCCESS' },
  );
  return {
    movementId: result.movementId,
    stock: result.balanceAfter,
    balanceAfter: result.balanceAfter,
    replayed: false,
  };
}

export async function adjustStock(actor: User, itemId: string, raw: unknown) {
  const input = adjustmentSchema.parse(raw);
  return transaction(async (db) => {
    const item = await menu.findForUpdate(itemId, db);
    check(item, 404, 'NOT_FOUND', 'Dish not found.');
    await assertMember(db, actor, item.restaurant_id);
    const { replayed: _replayed, ...result } = await adjustLocked(db, actor, itemId, item.stock, {
      delta: input.delta,
      reason: input.reason,
      key: input.idempotencyKey,
    });
    return result;
  });
}

export async function setStockThreshold(actor: User, itemId: string, raw: unknown) {
  const input = z
    .object({
      threshold: z.number().int().min(0).max(100000),
      reason: z.string().trim().min(3).max(300),
    })
    .strict()
    .parse(raw);
  return transaction(async (db) => {
    const item = await menu.findForUpdate(itemId, db);
    check(item, 404, 'NOT_FOUND', 'Dish not found.');
    await assertMember(db, actor, item.restaurant_id);
    await db.$executeRaw`UPDATE menu_items SET low_stock_threshold = ${input.threshold} WHERE id = ${itemId}`;
    await audits.audit(
      actor.id,
      'STOCK_THRESHOLD_CHANGED',
      itemId,
      { oldThreshold: item.low_stock_threshold, threshold: input.threshold, reason: input.reason },
      db,
      { resourceType: 'MENU_ITEM', outcome: 'SUCCESS' },
    );
    return { threshold: input.threshold, stock: item.stock };
  });
}

/** Owner read API for dashboards: visible items at or below their threshold. */
export async function inventorySummary(restaurantId: string) {
  const rows = await prisma.$queryRaw<
    Array<{ id: string; name: string; stock: number; threshold: number }>
  >`
    SELECT id, name, stock,
      COALESCE(low_stock_threshold, ${inventoryConfig.LOW_STOCK_THRESHOLD}::integer) AS threshold
    FROM menu_items
    WHERE restaurant_id = ${restaurantId} AND visible
      AND stock <= COALESCE(low_stock_threshold, ${inventoryConfig.LOW_STOCK_THRESHOLD}::integer)
    ORDER BY stock ASC, name ASC, id ASC LIMIT 50`;
  return {
    lowStock: rows,
    soldOut: rows.filter((row) => row.stock === 0).length,
  };
}
