import { z } from 'zod';
import { prisma } from '../../../shared/db.js';
import { check } from '../../../shared/errors.js';
import { assignmentOrderGateway } from '../assignment.ports.js';

export async function listDriverOffers(driverId: string) {
  const now = (await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]
    .now;
  const rows = await prisma.$queryRaw<Array<{ id: string; delivery_id: string; expires_at: Date }>>`
    SELECT o.id, s.delivery_id, o.expires_at FROM driver_offers o
    JOIN assignment_searches s ON s.id = o.search_id
    WHERE o.driver_id = ${driverId} AND o.status = 'OFFERED' AND s.status = 'OFFERED'
      AND o.expires_at > clock_timestamp() AND s.deadline_at > clock_timestamp()
    ORDER BY o.expires_at, o.id`;
  const gateway = assignmentOrderGateway();
  const items = [];
  for (const row of rows) {
    const context = await gateway.context(row.delivery_id, prisma);
    if (context?.pickup)
      items.push({
        offerId: row.id,
        pickup: context.pickup,
        deliveryFee: context.deliveryFee,
        expiresAt: row.expires_at,
      });
  }
  return { items, serverTime: now };
}

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});
export async function listAdminSearches(raw: unknown) {
  const { limit, cursor } = listSchema.parse(raw);
  let cursorId: string | undefined;
  if (cursor) {
    cursorId = Buffer.from(cursor, 'base64url').toString('utf8');
    check(
      Boolean(cursorId) &&
        Buffer.from(cursorId).toString('base64url') === cursor &&
        (await prisma.assignmentSearch.findUnique({
          where: { id: cursorId },
          select: { id: true },
        })),
      400,
      'INVALID_CURSOR',
      'Invalid search cursor.',
    );
  }
  const rows = await prisma.assignmentSearch.findMany({
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    select: {
      id: true,
      delivery_id: true,
      generation: true,
      status: true,
      round: true,
      offers_created: true,
      deadline_at: true,
      next_run_at: true,
      created_at: true,
    },
  });
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => ({
      searchId: row.id,
      deliveryId: row.delivery_id,
      generation: row.generation,
      status: row.status,
      round: row.round,
      offersCreated: row.offers_created,
      deadlineAt: row.deadline_at,
      nextRunAt: row.next_run_at,
      createdAt: row.created_at,
    })),
    nextCursor:
      rows.length > limit ? Buffer.from(page[page.length - 1].id).toString('base64url') : null,
  };
}
export async function adminSearchDetail(searchId: string) {
  const row = await prisma.assignmentSearch.findUnique({
    where: { id: searchId },
    select: {
      id: true,
      delivery_id: true,
      status: true,
      generation: true,
      round: true,
      offers_created: true,
      deadline_at: true,
      next_run_at: true,
    },
  });
  check(row, 404, 'NOT_FOUND', 'Assignment search not found.');
  const attempts = await prisma.assignmentAttempt.findMany({
    where: { search_id: searchId },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      driver_id: true,
      round: true,
      rank: true,
      outcome: true,
      reason: true,
      created_at: true,
    },
  });
  return {
    searchId: row.id,
    deliveryId: row.delivery_id,
    status: row.status,
    generation: row.generation,
    round: row.round,
    offersCreated: row.offers_created,
    deadlineAt: row.deadline_at,
    nextRunAt: row.next_run_at,
    attempts: attempts.map((entry) => ({
      attemptId: entry.id,
      driverId: entry.driver_id,
      round: entry.round,
      rank: entry.rank,
      outcome: entry.outcome,
      reason: entry.reason,
      createdAt: entry.created_at,
    })),
  };
}
