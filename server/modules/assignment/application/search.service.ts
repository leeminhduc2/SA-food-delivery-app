import { randomUUID } from 'node:crypto';
import { id, prisma, transaction, type DB } from '../../../shared/db.js';
import { subscribe } from '../../../shared/events.js';
import { deliveryForAssignmentLocked } from '../../delivery/index.js';
import { lockDriver } from '../../identity/index.js';
import { notify } from '../../notification/index.js';
import { assignmentOrderGateway } from '../assignment.ports.js';
import { assignmentConfig as config } from '../config.js';
import {
  nearestStrategy,
  haversineMeters,
  type RankedDriver,
} from '../domain/assignment-strategy.js';
import * as searches from '../infrastructure/assignment.repository.js';
import { findEligibleCandidates } from './candidates.service.js';

export function registerAssignmentHandlers(): void {
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
      await searches.finishClaim(claim, 'EXHAUSTED', 0, db);
      return;
    }
    const context = await gateway.context(claim.delivery_id, db);
    if (!ranked || !context?.pickup) {
      await searches.finishClaim(claim, 'WAITING', 30, db);
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
    await notify(db, ranked.driverId, 'DRIVER_OFFER', {
      offerId,
      pickup: context.pickup,
      deliveryFee: context.deliveryFee,
      expiresAt: expiresAt.toISOString(),
    });
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
