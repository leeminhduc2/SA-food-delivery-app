import { prisma, transaction } from '../../../shared/db.js';
import { ensureOpeningBalances } from './inventory.service.js';

/** Bounded batches lock the same rows as live stock writers. */
export async function backfillOpeningBatch(
  limit = 100,
): Promise<{ initialized: number; remaining: number }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid batch size');
  const initialized = await transaction(async (db) => {
    const rows = await db.$queryRaw<Array<{ id: string }>>`
      SELECT i.id FROM menu_items i WHERE NOT EXISTS
        (SELECT 1 FROM stock_movements m WHERE m.item_id = i.id AND m.operation_key = 'opening')
      ORDER BY i.id LIMIT ${limit} FOR UPDATE OF i SKIP LOCKED`;
    await ensureOpeningBalances(
      db,
      rows.map((row) => row.id),
    );
    return rows.length;
  });
  const [{ count }] = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*) AS count FROM menu_items i WHERE NOT EXISTS
      (SELECT 1 FROM stock_movements m WHERE m.item_id = i.id AND m.operation_key = 'opening')`;
  return { initialized, remaining: Number(count) };
}
