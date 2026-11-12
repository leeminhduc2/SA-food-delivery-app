import { id, prisma, type DB } from '../../../shared/db.js';
import {
  canTransitionOffer,
  canTransitionSearch,
  type OfferStatus,
  type SearchStatus,
} from '../domain/assignment-status.js';
import type { Prisma } from '@prisma/client';

/** Idempotent initial generation; caller transaction owns the accepted transition. */
export async function createInitialSearch(deliveryId: string, deadlineSeconds: number, db: DB) {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    INSERT INTO assignment_searches (id, delivery_id, generation, deadline_at)
    VALUES (${id()}, ${deliveryId}, 1, now() + ${deadlineSeconds} * interval '1 second')
    ON CONFLICT (delivery_id, generation) DO NOTHING RETURNING id`;
  return (
    rows[0] ??
    db.assignmentSearch.findUniqueOrThrow({
      where: { delivery_id_generation: { delivery_id: deliveryId, generation: 1 } },
      select: { id: true },
    })
  );
}

/** Claim one due item, never holding this row lock across provider calls. */
export async function claimDue(worker: string, leaseSeconds: number, db: DB = prisma) {
  return (
    (
      await db.$queryRaw<
        Array<{
          id: string;
          generation: number;
          version: number;
          status: SearchStatus;
          lease_owner: string;
          lease_until: Date;
        }>
      >`
    UPDATE assignment_searches AS search SET lease_owner = ${worker},
      lease_until = now() + ${leaseSeconds} * interval '1 second',
      version = search.version + 1, updated_at = now()
    WHERE search.id = (
      SELECT id FROM assignment_searches WHERE status IN ('WAITING', 'SEARCHING', 'OFFERED')
        AND next_run_at <= now() AND (lease_until IS NULL OR lease_until <= now())
      ORDER BY next_run_at, id FOR UPDATE SKIP LOCKED LIMIT 1
    ) RETURNING search.id, search.generation, search.version, search.status, search.lease_owner, search.lease_until`
    )[0] ?? null
  );
}

/** Version, generation, owner and DB lease expiry fence every worker result. */
export async function transitionClaimedSearch(
  input: {
    id: string;
    generation: number;
    version: number;
    owner: string;
    from: SearchStatus;
    to: SearchStatus;
  },
  db: DB = prisma,
): Promise<boolean> {
  if (!canTransitionSearch(input.from, input.to)) return false;
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE assignment_searches SET status = ${input.to}, lease_owner = NULL, lease_until = NULL,
      version = version + 1, updated_at = now()
    WHERE id = ${input.id} AND generation = ${input.generation} AND version = ${input.version}
      AND status = ${input.from} AND lease_owner = ${input.owner} AND lease_until > now()
    RETURNING id`;
  return rows.length === 1;
}

export async function transitionOffer(
  offerId: string,
  from: OfferStatus,
  to: OfferStatus,
  db: DB = prisma,
): Promise<boolean> {
  if (!canTransitionOffer(from, to)) return false;
  const result = await db.driverOffer.updateMany({
    where: { id: offerId, status: from },
    data: { status: to, responded_at: new Date() },
  });
  return result.count === 1;
}
export async function recordAttempt(
  input: {
    searchId: string;
    driverId: string;
    round: number;
    rank?: number;
    criterion?: Prisma.InputJsonValue;
    offerId?: string;
    outcome: OfferStatus | 'INELIGIBLE';
    reason?: string;
  },
  db: DB = prisma,
) {
  return db.assignmentAttempt.create({
    data: {
      id: id(),
      search_id: input.searchId,
      driver_id: input.driverId,
      round: input.round,
      rank: input.rank,
      criterion: input.criterion,
      offer_id: input.offerId,
      outcome: input.outcome,
      reason: input.reason,
    },
  });
}
export async function resolveAttempt(
  searchId: string,
  driverId: string,
  outcome: Exclude<OfferStatus, 'OFFERED'>,
  reason: string | undefined,
  db: DB = prisma,
): Promise<boolean> {
  const result = await db.assignmentAttempt.updateMany({
    where: { search_id: searchId, driver_id: driverId, outcome: 'OFFERED' },
    data: { outcome, reason, updated_at: new Date() },
  });
  return result.count === 1;
}

export async function candidateAvailability(ids: readonly string[], db: DB = prisma) {
  const rows = await db.driverAvailability.findMany({
    where: { driver_id: { in: [...ids] } },
    select: { driver_id: true, online: true, ready: true, heartbeat_at: true },
  });
  return rows.map((row) => ({
    driverId: row.driver_id,
    online: row.online,
    ready: row.ready,
    heartbeatAt: row.heartbeat_at,
  }));
}
export async function excludedCandidateIds(
  searchId: string,
  ids: readonly string[],
  db: DB = prisma,
): Promise<string[]> {
  const [attempts, offers] = await Promise.all([
    db.assignmentAttempt.findMany({
      where: { search_id: searchId, driver_id: { in: [...ids] } },
      select: { driver_id: true },
    }),
    db.driverOffer.findMany({
      where: { status: 'OFFERED', driver_id: { in: [...ids] } },
      select: { driver_id: true },
    }),
  ]);
  return [...new Set([...attempts, ...offers].map((row) => row.driver_id))];
}
