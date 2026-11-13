import { randomUUID } from 'node:crypto';
import { id, prisma, transaction, type DB } from '../../../shared/db.js';
import {
  activeDeliveryForDriver,
  deliveryForAssignmentLocked,
  recordOperationalIncident,
  revokeUnavailableDriver,
} from '../../delivery/index.js';
import { activeAdministratorIds, activeDriverIds, lockDriver } from '../../identity/index.js';
import { latestDriverLocation } from '../../location/index.js';
import { notifyOnce } from '../../notification/index.js';
import { assignmentOrderGateway } from '../assignment.ports.js';
import { assignmentConfig as config } from '../config.js';
import { haversineMeters } from '../domain/assignment-strategy.js';
import { resolveAttempt } from '../infrastructure/assignment.repository.js';
import { availabilityInTransaction } from './availability.service.js';

type Claim = { id: string; driver_id: string; lease_owner: string };
async function claimChange(owner: string): Promise<Claim | undefined> {
  return (
    await prisma.$queryRaw<Claim[]>`
    UPDATE driver_operational_changes AS work
    SET lease_owner = ${owner}, lease_until = clock_timestamp() + interval '30 seconds', attempts = attempts + 1
    WHERE id = (SELECT id FROM driver_operational_changes
      WHERE processed_at IS NULL AND (lease_until IS NULL OR lease_until <= clock_timestamp())
        AND due_at <= clock_timestamp()
      ORDER BY due_at, created_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING id, driver_id, lease_owner`
  )[0];
}
async function lockClaim(claim: Claim, db: DB): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM driver_operational_changes
    WHERE id = ${claim.id} AND processed_at IS NULL AND lease_owner = ${claim.lease_owner}
      AND lease_until > clock_timestamp() FOR UPDATE`;
  return rows.length === 1;
}
async function invalidReason(
  driverId: string,
  pickup: { latitude: number; longitude: number } | null,
  includeBusy: boolean,
  db: DB,
  requirePickupProximity = true,
  requireReady = true,
) {
  if (!(await activeDriverIds([driverId], db)).length) return 'ACCOUNT_INACTIVE';
  const state = await availabilityInTransaction(driverId, db);
  if (!state.online) return 'DRIVER_OFFLINE';
  if (requireReady && !state.ready) return 'DRIVER_NOT_READY';
  if (!state.heartbeatFresh) return 'STALE_HEARTBEAT';
  if (!state.locationFresh) return 'STALE_LOCATION';
  if (includeBusy && state.busy) return 'DRIVER_BUSY';
  const location = await latestDriverLocation(driverId, db);
  if (
    requirePickupProximity &&
    (!pickup || !location || haversineMeters(pickup, location) > config.ASSIGNMENT_RADIUS_METERS)
  )
    return 'DRIVER_OUT_OF_RANGE';
  return null;
}
async function handleOffer(claim: Claim): Promise<void> {
  const offer = await prisma.driverOffer.findFirst({
    where: { driver_id: claim.driver_id, status: 'OFFERED' },
    select: { id: true, search_id: true },
  });
  if (!offer) return;
  const search = await prisma.assignmentSearch.findUnique({
    where: { id: offer.search_id },
    select: { delivery_id: true },
  });
  if (!search) return;
  const gateway = assignmentOrderGateway();
  const context = await gateway.context(search.delivery_id, prisma);
  if (!context) return;
  await transaction(async (db) => {
    const order = await gateway.lockOrder(context.orderId, db);
    const delivery = await deliveryForAssignmentLocked(search.delivery_id, db);
    await lockDriver(claim.driver_id, db);
    await db.$queryRaw`SELECT driver_id FROM driver_availability WHERE driver_id = ${claim.driver_id} FOR UPDATE`;
    const rows = await db.$queryRaw<Array<{ offer_id: string; search_id: string }>>`
      SELECT o.id AS offer_id, s.id AS search_id FROM assignment_searches s JOIN driver_offers o ON o.search_id = s.id
      WHERE o.id = ${offer.id} AND o.driver_id = ${claim.driver_id} AND o.status = 'OFFERED' AND s.status = 'OFFERED'
      FOR UPDATE OF s, o`;
    if (!rows.length || !(await lockClaim(claim, db))) return;
    const currentContext = await gateway.context(search.delivery_id, db);
    const reason =
      !order ||
      !delivery ||
      delivery.order_id !== context.orderId ||
      !['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(order.status) ||
      delivery.status !== 'UNASSIGNED' ||
      delivery.driver_id
        ? 'ORDER_NOT_ASSIGNABLE'
        : await invalidReason(claim.driver_id, currentContext?.pickup ?? null, true, db);
    if (!reason) return;
    const now = (await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0].now;
    await db.driverOffer.update({
      where: { id: offer.id },
      data: { status: 'REVOKED', responded_at: now },
    });
    if (!(await resolveAttempt(offer.search_id, claim.driver_id, 'REVOKED', reason, db)))
      throw new Error('Offer attempt missing');
    await db.assignmentSearch.update({
      where: { id: offer.search_id },
      data: {
        status: reason === 'ORDER_NOT_ASSIGNABLE' ? 'CANCELLED' : 'SEARCHING',
        next_run_at: now,
        lease_owner: null,
        lease_until: null,
        version: { increment: 1 },
        updated_at: now,
      },
    });
    await notifyOnce(db, claim.driver_id, 'DRIVER_OFFER_REVOKED', { offerId: offer.id }, offer.id);
  });
}
async function handleActiveDelivery(claim: Claim): Promise<void> {
  const active = await activeDeliveryForDriver(claim.driver_id);
  if (!active) return;
  const gateway = assignmentOrderGateway();
  const context = await gateway.context(active.delivery_id, prisma);
  if (!context) return;
  await transaction(async (db) => {
    await gateway.lockOrder(context.orderId, db);
    const delivery = await deliveryForAssignmentLocked(active.delivery_id, db);
    await lockDriver(claim.driver_id, db);
    await db.$queryRaw`SELECT driver_id FROM driver_availability WHERE driver_id = ${claim.driver_id} FOR UPDATE`;
    if (
      !delivery ||
      delivery.order_id !== context.orderId ||
      delivery.driver_id !== claim.driver_id ||
      !(await lockClaim(claim, db))
    )
      return;
    const currentContext = await gateway.context(active.delivery_id, db);
    const reason = await invalidReason(
      claim.driver_id,
      currentContext?.pickup ?? null,
      false,
      db,
      delivery.status === 'ASSIGNED',
      false,
    );
    if (!reason) return;
    if (await revokeUnavailableDriver(delivery, claim.driver_id, reason, db)) {
      const live = await db.assignmentSearch.findFirst({
        where: { delivery_id: delivery.id, status: { in: ['WAITING', 'SEARCHING', 'OFFERED'] } },
      });
      if (!live) {
        const latest = await db.assignmentSearch.aggregate({
          where: { delivery_id: delivery.id },
          _max: { generation: true },
        });
        await db.$executeRaw`
          INSERT INTO assignment_searches (id, delivery_id, generation, deadline_at)
          VALUES (${id()}, ${delivery.id}, ${(latest._max.generation ?? 0) + 1},
            clock_timestamp() + ${config.ASSIGNMENT_SEARCH_DEADLINE_SECONDS} * interval '1 second')`;
      }
      await notifyOnce(
        db,
        claim.driver_id,
        'DRIVER_ASSIGNMENT_REVOKED',
        { deliveryId: delivery.id },
        claim.id,
      );
      await gateway.notifyRevoked(context.orderId, claim.id, db);
    } else if (await recordOperationalIncident(delivery, claim.driver_id, reason, db)) {
      for (const adminId of await activeAdministratorIds(db))
        await notifyOnce(
          db,
          adminId,
          'DELIVERY_OPERATIONAL_INCIDENT',
          { deliveryId: delivery.id, reason },
          delivery.id,
        );
    }
  });
}

/** Finish the claim and schedule a DB-clock recheck when heartbeat or GPS will expire. */
async function finishChange(claim: Claim): Promise<boolean> {
  return transaction(async (db) => {
    await lockDriver(claim.driver_id, db);
    await db.$queryRaw`SELECT driver_id FROM driver_availability WHERE driver_id = ${claim.driver_id} FOR UPDATE`;
    if (!(await lockClaim(claim, db))) return false;
    const state = await availabilityInTransaction(claim.driver_id, db);
    const location = await latestDriverLocation(claim.driver_id, db);
    const [active, trip, offer] = await Promise.all([
      activeDriverIds([claim.driver_id], db),
      activeDeliveryForDriver(claim.driver_id, db),
      db.driverOffer.findFirst({
        where: { driver_id: claim.driver_id, status: 'OFFERED' },
        select: { id: true },
      }),
    ]);
    await db.$executeRaw`
      UPDATE driver_operational_changes SET processed_at = clock_timestamp(), lease_owner = NULL, lease_until = NULL
      WHERE id = ${claim.id} AND lease_owner = ${claim.lease_owner}`;
    if (
      active.length &&
      (trip || offer) &&
      state.online &&
      (state.ready || trip) &&
      state.heartbeatFresh &&
      state.locationFresh &&
      state.heartbeatAt &&
      location
    ) {
      const due = new Date(
        Math.min(
          state.heartbeatAt.getTime() + config.DRIVER_HEARTBEAT_MAX_AGE_SECONDS * 1000,
          location.captured_at.getTime() + config.DRIVER_LOCATION_MAX_AGE_SECONDS * 1000,
          location.received_at.getTime() + config.DRIVER_LOCATION_MAX_AGE_SECONDS * 1000,
        ) + 1,
      );
      await db.$executeRaw`
        INSERT INTO driver_operational_changes (id, driver_id, source, reason, due_at)
        VALUES (${id()}, ${claim.driver_id}, 'RECHECK', 'FRESHNESS_DEADLINE', ${due})
        ON CONFLICT DO NOTHING`;
    }
    return true;
  });
}
/** Claims are fenced; effects and final acknowledgement survive worker restarts. */
export async function runOperationalInvalidation(
  maxItems = 50,
  enabled = config.ASSIGNMENT_AUTOMATION_ENABLED,
): Promise<number> {
  if (!enabled) return 0;
  const owner = randomUUID();
  let processed = 0;
  while (processed < maxItems) {
    const claim = await claimChange(owner);
    if (!claim) break;
    await handleOffer(claim);
    await handleActiveDelivery(claim);
    if (await finishChange(claim)) processed++;
  }
  return processed;
}
