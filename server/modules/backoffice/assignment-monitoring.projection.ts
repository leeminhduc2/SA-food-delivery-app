import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../shared/db.js';
import { check } from '../../shared/errors.js';

type Kind = 'orders' | 'deliveries' | 'assignments';
const statuses: Record<Kind, readonly string[]> = {
  orders: [
    'PENDING_PAYMENT',
    'CONFIRMED',
    'ACCEPTED',
    'PREPARING',
    'READY_FOR_PICKUP',
    'OUT_FOR_DELIVERY',
    'DELIVERED',
    'DELIVERY_FAILED',
    'CANCELLED',
    'PAYMENT_FAILED',
  ],
  deliveries: [
    'UNASSIGNED',
    'ASSIGNED',
    'PICKED_UP',
    'IN_TRANSIT',
    'DELIVERED',
    'FAILED',
    'CANCELLED',
  ],
  assignments: ['WAITING', 'SEARCHING', 'OFFERED', 'ASSIGNED', 'EXHAUSTED', 'CANCELLED'],
};
function validUtc(value: string): boolean {
  if (value.startsWith('0000-')) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 19) === value.slice(0, 19);
}
const iso = z
  .string()
  .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/)
  .refine(validUtc);
const querySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    status: z.string().min(1).max(40).optional(),
    restaurantId: z.string().min(1).max(128).optional(),
    orderId: z.string().min(1).max(128).optional(),
    driverId: z.string().min(1).max(128).optional(),
    from: iso.optional(),
    to: iso.optional(),
  })
  .strict();
const cursorSchema = z
  .object({
    kind: z.enum(['orders', 'deliveries', 'assignments']),
    id: z.string().min(1).max(128),
    at: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/),
  })
  .strict();

export async function monitoringPage(kind: Kind, raw: unknown) {
  const query = querySchema.parse(raw);
  check(
    !query.status || statuses[kind].includes(query.status),
    400,
    'INVALID_FILTER',
    'Invalid status filter.',
  );
  check(
    !query.from || !query.to || Date.parse(query.from) < Date.parse(query.to),
    400,
    'INVALID_FILTER',
    'The from time must precede to.',
  );
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (query.cursor) {
    try {
      const bytes = Buffer.from(query.cursor, 'base64url');
      if (bytes.toString('base64url') !== query.cursor) throw new Error('cursor');
      cursor = cursorSchema.parse(JSON.parse(bytes.toString('utf8')));
      if (cursor.kind !== kind || !validUtc(cursor.at)) throw new Error('cursor');
    } catch {
      check(false, 400, 'INVALID_CURSOR', 'Invalid monitoring cursor.');
    }
  }
  // Delivery has no creation timestamp: use its order's immutable creation time.
  const time = kind === 'assignments' ? Prisma.sql`s.created_at` : Prisma.sql`o.created_at`;
  const itemId =
    kind === 'orders'
      ? Prisma.sql`o.id`
      : kind === 'deliveries'
        ? Prisma.sql`d.id`
        : Prisma.sql`s.id`;
  const status =
    kind === 'orders'
      ? Prisma.sql`o.status`
      : kind === 'deliveries'
        ? Prisma.sql`d.status`
        : Prisma.sql`s.status`;
  const joins =
    kind === 'orders'
      ? Prisma.sql`FROM orders o LEFT JOIN deliveries d ON d.order_id = o.id`
      : kind === 'deliveries'
        ? Prisma.sql`FROM deliveries d JOIN orders o ON o.id = d.order_id`
        : Prisma.sql`FROM assignment_searches s JOIN deliveries d ON d.id = s.delivery_id JOIN orders o ON o.id = d.order_id`;
  const extra =
    kind === 'assignments'
      ? Prisma.sql`, s.generation, s.round, s.offers_created AS "offersCreated", s.deadline_at AS "deadlineAt", s.next_run_at AS "nextRunAt"`
      : Prisma.empty;
  const driverFilter =
    kind === 'assignments'
      ? Prisma.sql`(d.driver_id = ${query.driverId} OR EXISTS (SELECT 1 FROM assignment_attempts a WHERE a.search_id = s.id AND a.driver_id = ${query.driverId}))`
      : Prisma.sql`d.driver_id = ${query.driverId}`;
  const rows = await prisma.$queryRaw<
    Array<Record<string, unknown> & { id: string; cursorAt: string }>
  >(Prisma.sql`
    SELECT ${itemId} AS id, ${status} AS status, o.id AS "orderId", o.restaurant_id AS "restaurantId",
      d.id AS "deliveryId", d.driver_id AS "driverId", ${time} AS "createdAt",
      to_char(${time} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt" ${extra}
    ${joins}
    WHERE TRUE
      ${query.status ? Prisma.sql`AND ${status} = ${query.status}` : Prisma.empty}
      ${query.restaurantId ? Prisma.sql`AND o.restaurant_id = ${query.restaurantId}` : Prisma.empty}
      ${query.orderId ? Prisma.sql`AND o.id = ${query.orderId}` : Prisma.empty}
      ${query.driverId ? Prisma.sql`AND ${driverFilter}` : Prisma.empty}
      ${query.from ? Prisma.sql`AND ${time} >= ${query.from}::timestamptz` : Prisma.empty}
      ${query.to ? Prisma.sql`AND ${time} < ${query.to}::timestamptz` : Prisma.empty}
      ${cursor ? Prisma.sql`AND (${time}, ${itemId}) < (${cursor.at}::timestamptz, ${cursor.id})` : Prisma.empty}
    ORDER BY ${time} DESC, ${itemId} DESC LIMIT ${query.limit + 1}`);
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(({ id, cursorAt: _cursorAt, ...row }) =>
      kind === 'assignments' ? { searchId: id, ...row } : { id, ...row },
    ),
    nextCursor:
      rows.length > query.limit
        ? Buffer.from(JSON.stringify({ kind, id: last.id, at: last.cursorAt })).toString(
            'base64url',
          )
        : null,
  };
}
