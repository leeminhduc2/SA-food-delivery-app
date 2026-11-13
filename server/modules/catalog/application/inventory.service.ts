import { id, type DB } from '../../../shared/db.js';
import { check } from '../../../shared/errors.js';

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

/** The caller owns the item lock and commits the stock update with this record. */
export async function recordStockMovement(
  db: DB,
  input: {
    itemId: string;
    kind: Exclude<MovementKind, 'OPENING'>;
    delta: number;
    balance: number;
    actor: string;
    reason: string;
    operationKey: string;
    orderId?: string;
  },
) {
  await db.$executeRaw`INSERT INTO stock_movements (id, item_id, kind, delta, balance_after, actor, reason, operation_key, order_id)
    VALUES (${id()}, ${input.itemId}, ${input.kind}, ${input.delta}, ${input.balance}, ${input.actor}, ${input.reason}, ${input.operationKey}, ${input.orderId ?? null})`;
}

export async function ensureOpeningBalances(db: DB, ids: readonly string[]) {
  for (const itemId of [...new Set(ids)].sort()) await ensureOpeningBalance(db, itemId);
}
