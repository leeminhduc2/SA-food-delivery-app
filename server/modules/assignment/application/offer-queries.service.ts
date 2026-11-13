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
  const events = await prisma.$queryRaw<
    Array<{
      id: string;
      round: number;
      event: string;
      reason: string | null;
      nextRunAt: Date | null;
      createdAt: Date;
    }>
  >`
    SELECT id, round, event, reason, next_run_at AS "nextRunAt", created_at AS "createdAt"
    FROM assignment_search_events WHERE search_id = ${searchId} ORDER BY created_at, id`;
  return {
    searchId: row.id,
    deliveryId: row.delivery_id,
    status: row.status,
    generation: row.generation,
    round: row.round,
    offersCreated: row.offers_created,
    deadlineAt: row.deadline_at,
    nextRunAt: row.next_run_at,
    events,
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
