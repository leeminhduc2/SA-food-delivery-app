import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../shared/db.js';
import { check } from '../../../shared/errors.js';
import type { User } from '../../../shared/types.js';
import * as menu from '../infrastructure/menu.repository.js';
import { assertMember } from './authorization.service.js';

const querySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict();
const cursorSchema = z
  .object({
    itemId: z.string().min(1).max(128),
    id: z.string().min(1).max(128),
    at: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/),
  })
  .strict();

export async function stockHistory(actor: User, itemId: string, raw: unknown) {
  const query = querySchema.parse(raw);
  const item = await menu.findById(itemId);
  check(item, 404, 'NOT_FOUND', 'Dish not found.');
  if (actor.role !== 'ADMIN') await assertMember(undefined, actor, item.restaurant_id);
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (query.cursor) {
    try {
      const bytes = Buffer.from(query.cursor, 'base64url');
      if (bytes.toString('base64url') !== query.cursor) throw new Error('cursor');
      cursor = cursorSchema.parse(JSON.parse(bytes.toString('utf8')));
      const date = new Date(cursor.at);
      if (
        cursor.itemId !== itemId ||
        cursor.at.startsWith('0000-') ||
        Number.isNaN(date.getTime()) ||
        date.toISOString().slice(0, 19) !== cursor.at.slice(0, 19)
      )
        throw new Error('cursor');
    } catch {
      check(false, 400, 'INVALID_CURSOR', 'Invalid stock history cursor.');
    }
  }
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      kind: string;
      delta: number;
      balanceAfter: number;
      actor: string;
      reason: string;
      orderId: string | null;
      createdAt: Date;
      cursorAt: string;
    }>
  >(Prisma.sql`
    SELECT id,kind,delta,balance_after AS "balanceAfter",actor,reason,order_id AS "orderId",created_at AS "createdAt",
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt"
    FROM stock_movements WHERE item_id = ${itemId}
      ${cursor ? Prisma.sql`AND (created_at,id) < (${cursor.at}::timestamptz,${cursor.id})` : Prisma.empty}
    ORDER BY created_at DESC,id DESC LIMIT ${query.limit + 1}`);
  const page = rows.slice(0, query.limit),
    last = page[page.length - 1];
  return {
    items: page.map(({ cursorAt: _cursorAt, ...row }) => row),
    nextCursor:
      rows.length > query.limit
        ? Buffer.from(JSON.stringify({ itemId, id: last.id, at: last.cursorAt })).toString(
            'base64url',
          )
        : null,
  };
}
