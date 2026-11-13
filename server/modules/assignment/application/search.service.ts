import { randomUUID } from 'node:crypto';
import { id, prisma, transaction, type DB } from '../../../shared/db.js';
import { subscribe } from '../../../shared/events.js';
import { deliveryForAssignmentLocked } from '../../delivery/index.js';
import { activeAdministratorIds, lockDriver } from '../../identity/index.js';
import { notifyOnce } from '../../notification/index.js';
import { assignmentOrderGateway } from '../assignment.ports.js';
import { assignmentConfig as config } from '../config.js';
import {
  nearestStrategy,
  haversineMeters,
  type RankedDriver,
} from '../domain/assignment-strategy.js';
import { decideNoCandidate } from '../domain/search-policy.js';
import * as searches from '../infrastructure/assignment.repository.js';
import { findEligibleCandidates } from './candidates.service.js';

export function registerAssignmentHandlers(): void {
  subscribe('DriverOperationalStateChanged', async (db, event) => {
    await db.driverOperationalChange.create({
      data: {
        id: id(),
        driver_id: event.driverId,
        source: event.source,
        reason: event.reason,
        observed_version: event.observedVersion,
      },
    });
  });
  subscribe('OrderAccepted', async (db, event) => {
    if (config.ASSIGNMENT_AUTOMATION_ENABLED)
      await searches.createInitialSearch(
        event.deliveryId,
        config.ASSIGNMENT_SEARCH_DEADLINE_SECONDS,
        db,
      );
  });
}
const orderEligible = (status: string) =>
  ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(status);
async function notifyExhausted(claim: searches.SearchClaim, reason: string, db: DB): Promise<void> {
  await db.$executeRaw`INSERT INTO assignment_search_events (id, search_id, round, event, reason)
    SELECT ${id()}, id, round, 'EXHAUSTED', ${reason} FROM assignment_searches WHERE id = ${claim.id}`;
  for (const adminId of await activeAdministratorIds(db))
    await notifyOnce(
      db,
      adminId,
      'ASSIGNMENT_EXHAUSTED',
      {
        searchId: claim.id,
        deliveryId: claim.delivery_id,
        reason,
      },
      claim.id,
    );
}
async function lockAvailability(driverId: string, db: DB): Promise<void> {
  await db.$queryRaw`SELECT driver_id FROM driver_availability WHERE driver_id = ${driverId} FOR UPDATE`;
}
async function applyClaim(
  claim: searches.SearchClaim,
  ranked: RankedDriver | undefined,
): Promise<void> {
  const gateway = assignmentOrderGateway();
  const metadata = await gateway.context(claim.delivery_id, prisma);
  if (!metadata) {
    await transaction(async (db) => {
      if (await searches.lockCurrentClaim(claim, db))
        await searches.finishClaim(claim, 'CANCELLED', 0, db);
    });
    return;
  }
  await transaction(async (db) => {
    const order = await gateway.lockOrder(metadata.orderId, db);
    const delivery = await deliveryForAssignmentLocked(claim.delivery_id, db);
    if (ranked) {
      await lockDriver(ranked.driverId, db);
      await lockAvailability(ranked.driverId, db);
    }
    const search = await searches.lockCurrentClaim(claim, db);
    if (!search) return;
    if (
      !order ||
      !delivery ||
      delivery.order_id !== metadata.orderId ||
      !orderEligible(order.status) ||
      delivery.status !== 'UNASSIGNED' ||
      delivery.driver_id
    ) {
      await searches.finishClaim(claim, 'CANCELLED', 0, db);
      return;
    }
    const now = (await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0].now;
    if (search.deadline_at <= now || search.offers_created >= config.ASSIGNMENT_MAX_OFFERS) {
      const finished = await searches.finishClaim(claim, 'EXHAUSTED', 0, db);
      if (finished)
        await notifyExhausted(claim, search.deadline_at <= now ? 'DEADLINE' : 'OFFER_LIMIT', db);
      return;
    }
    const context = await gateway.context(claim.delivery_id, db);
    if (!ranked || !context?.pickup) {
      const decision = decideNoCandidate(
        {
          round: search.round,
          offersCreated: search.offers_created,
          deadlineAt: search.deadline_at,
        },
        now,
        { maxRounds: config.ASSIGNMENT_MAX_ROUNDS, maxOffers: config.ASSIGNMENT_MAX_OFFERS },
      );
      if (decision.kind === 'EXHAUSTED') {
        const finished = await searches.finishClaim(claim, 'EXHAUSTED', 0, db);
        if (finished) await notifyExhausted(claim, decision.reason, db);
      } else {
        const nextRun = await searches.finishClaim(
          claim,
          'WAITING',
          decision.delaySeconds,
          db,
          decision.nextRound,
        );
        if (nextRun)
          await db.$executeRaw`INSERT INTO assignment_search_events (id, search_id, round, event, reason, next_run_at)
          VALUES (${id()}, ${claim.id}, ${search.round}, 'RETRY_SCHEDULED', ${context?.pickup ? 'NO_CANDIDATE' : 'PICKUP_UNAVAILABLE'}, ${nextRun})`;
      }
      return;
    }
    const eligible = await findEligibleCandidates(claim.id, context.pickup, db);
    const candidate = eligible.find((entry) => entry.driverId === ranked.driverId);
    if (!candidate) {
      const done = await searches.finishClaim(claim, 'SEARCHING', 0, db);
      if (done)
        await searches.recordAttempt(
          {
            searchId: claim.id,
            driverId: ranked.driverId,
            round: search.round,
            rank: ranked.rank,
            criterion: ranked.criterion,
            outcome: 'INELIGIBLE',
            reason: 'REVALIDATION_FAILED',
          },
          db,
        );
      return;
    }
    const expiresAt = await searches.finishClaim(
      claim,
      'OFFERED',
      config.ASSIGNMENT_OFFER_TTL_SECONDS,
      db,
    );
    if (!expiresAt) return;
    const offerId = id();
    await db.driverOffer.create({
      data: { id: offerId, search_id: claim.id, driver_id: ranked.driverId, expires_at: expiresAt },
    });
    await db.driverOperationalChange.create({
      data: {
        id: id(),
        driver_id: ranked.driverId,
        source: 'OFFER',
        reason: 'OFFER_CREATED',
      },
    });
    await searches.recordAttempt(
      {
        searchId: claim.id,
        driverId: ranked.driverId,
        round: search.round,
        rank: ranked.rank,
        criterion: {
          kind: 'HAVERSINE_METERS',
          distanceMeters: haversineMeters(context.pickup, candidate.location),
        },
        offerId,
        outcome: 'OFFERED',
      },
      db,
    );
    await notifyOnce(
      db,
      ranked.driverId,
      'DRIVER_OFFER',
      {
        offerId,
        pickup: context.pickup,
        deliveryFee: context.deliveryFee,
        expiresAt: expiresAt.toISOString(),
      },
      offerId,
    );
  });
}

async function processOfferedClaim(claim: searches.SearchClaim): Promise<void> {
  const gateway = assignmentOrderGateway();
  const [context, offerMeta] = await Promise.all([
    gateway.context(claim.delivery_id, prisma),
    prisma.driverOffer.findFirst({
      where: { search_id: claim.id, status: 'OFFERED' },
      select: { id: true, driver_id: true },
    }),
  ]);
  await transaction(async (db) => {
    const order = context ? await gateway.lockOrder(context.orderId, db) : undefined;
    const delivery = await deliveryForAssignmentLocked(claim.delivery_id, db);
    if (!offerMeta) {
      if (!(await searches.lockOfferedSearch(claim, db))) return;
      const now = (await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]
        .now;
      await searches.finishOfferedClaim(claim, 'SEARCHING', now, db);
      return;
    }
    await lockDriver(offerMeta.driver_id, db);
    await lockAvailability(offerMeta.driver_id, db);
    const offer = await searches.lockClaimedOffer(claim, offerMeta.id, db);
    if (!offer || offer.offer_status !== 'OFFERED') return;
    const now = (await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0].now;
    const invalidOrder =
      !order ||
      !delivery ||
      !context ||
      delivery.order_id !== context.orderId ||
      !orderEligible(order.status) ||
      delivery.status !== 'UNASSIGNED' ||
      Boolean(delivery.driver_id);
    if (!invalidOrder && offer.expires_at > now && offer.deadline_at > now) {
      await searches.finishOfferedClaim(
        claim,
        'OFFERED',
        new Date(Math.min(offer.expires_at.getTime(), offer.deadline_at.getTime())),
        db,
      );
      return;
    }
    const outcome = invalidOrder ? 'REVOKED' : 'EXPIRED';
    const exhausted =
      !invalidOrder &&
      (offer.deadline_at <= now || offer.offers_created >= config.ASSIGNMENT_MAX_OFFERS);
    const next = invalidOrder ? 'CANCELLED' : exhausted ? 'EXHAUSTED' : 'SEARCHING';
    if (!(await searches.finishOfferedClaim(claim, next, now, db))) return;
    await db.driverOffer.update({
      where: { id: offer.id },
      data: { status: outcome, responded_at: now },
    });
    if (
      !(await searches.resolveAttempt(
        claim.id,
        offer.driver_id,
        outcome,
        invalidOrder ? 'ORDER_NOT_ASSIGNABLE' : 'EXPIRED',
        db,
      ))
    )
      throw new Error('Offer attempt is missing or already finalized');
    await notifyOnce(
      db,
      offer.driver_id,
      outcome === 'EXPIRED' ? 'DRIVER_OFFER_EXPIRED' : 'DRIVER_OFFER_REVOKED',
      { offerId: offer.id },
      offer.id,
    );
    if (exhausted)
      await notifyExhausted(claim, offer.deadline_at <= now ? 'DEADLINE' : 'OFFER_LIMIT', db);
  });
}
/** One batch, with candidate discovery/ranking entirely outside any held transaction. */
export async function runAssignmentWorker(
  enabled = config.ASSIGNMENT_AUTOMATION_ENABLED,
  maxItems = 50,
): Promise<number> {
  if (!enabled) return 0;
  const worker = randomUUID();
  let processed = 0;
  while (processed < maxItems) {
    const claimed = await searches.claimDue(worker, 30);
    if (!claimed) break;
    if (claimed.status === 'OFFERED') {
      await processOfferedClaim(claimed);
      processed++;
      continue;
    }
    const current = await searches.beginClaim(claimed);
    if (!current) continue;
    const context = await assignmentOrderGateway().context(current.delivery_id, prisma);
    const candidates = context?.pickup
      ? await findEligibleCandidates(current.id, context.pickup)
      : [];
    const ranked = context?.pickup
      ? await nearestStrategy.rank({ pickup: context.pickup }, candidates)
      : [];
    await applyClaim(current, ranked[0]);
    processed++;
  }
  return processed;
}
