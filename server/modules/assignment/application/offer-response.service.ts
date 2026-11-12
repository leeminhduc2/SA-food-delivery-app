import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma, transaction, uniqueViolation, type DB } from '../../../shared/db.js';
import { check } from '../../../shared/errors.js';
import type { User } from '../../../shared/types.js';
import * as audits from '../../../shared/audit.repository.js';
import { confirmOfferAssignment, deliveryForAssignmentLocked } from '../../delivery/index.js';
import { activeDriverIds, lockDriver } from '../../identity/index.js';
import { notifyOnce } from '../../notification/index.js';
import { latestDriverLocation } from '../../location/index.js';
import { assignmentOrderGateway } from '../assignment.ports.js';
import { assignmentConfig } from '../config.js';
import { haversineMeters } from '../domain/assignment-strategy.js';
import { availabilityInTransaction } from './availability.service.js';
import { resolveAttempt } from '../infrastructure/assignment.repository.js';

type Decision = 'ACCEPTED' | 'REJECTED';
type Receipt = {
  fingerprint: string;
  offerId: string;
  deliveryId: string;
  status: Decision;
  assignmentId?: string;
};
const keySchema = z.string().min(8).max(120);
const acceptSchema = z.object({ idempotencyKey: keySchema });
const rejectSchema = z.object({
  idempotencyKey: keySchema,
  reason: z.string().trim().min(3).max(300),
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const activeOrder = (status: string) =>
  ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(status);

type LockedOffer = {
  offer_id: string;
  driver_id: string;
  offer_status: string;
  expires_at: Date;
  search_id: string;
  search_status: string;
  generation: number;
  deadline_at: Date;
};
async function lockOfferAndSearch(offerId: string, db: DB): Promise<LockedOffer | undefined> {
  return (
    await db.$queryRaw<LockedOffer[]>`
    SELECT o.id AS offer_id, o.driver_id, o.status AS offer_status, o.expires_at,
      s.id AS search_id, s.status AS search_status, s.generation, s.deadline_at
    FROM assignment_searches s JOIN driver_offers o ON o.search_id = s.id
    WHERE o.id = ${offerId} FOR UPDATE OF s, o`
  )[0];
}

export async function respondToOffer(
  actor: User,
  offerId: string,
  raw: unknown,
  decision: Decision,
  correlationId?: string,
) {
  const input =
    decision === 'ACCEPTED'
      ? { ...acceptSchema.parse(raw), reason: undefined }
      : rejectSchema.parse(raw);
  const reason = input.reason;
  const keyHash = hash(input.idempotencyKey);
  const fingerprint = hash(JSON.stringify({ decision, ...(reason ? { reason } : {}) }));
  const action = decision === 'ACCEPTED' ? 'OFFER_ACCEPTED' : 'OFFER_REJECTED';
  const offerMeta = await prisma.driverOffer.findUnique({
    where: { id: offerId },
    select: { driver_id: true, search_id: true },
  });
  check(offerMeta, 404, 'NOT_FOUND', 'Offer not found.');
  check(
    actor.role === 'DRIVER' && offerMeta.driver_id === actor.id,
    403,
    'FORBIDDEN',
    'This offer is not yours.',
  );
  const searchMeta = await prisma.assignmentSearch.findUnique({
    where: { id: offerMeta.search_id },
    select: { delivery_id: true, generation: true },
  });
  check(searchMeta, 404, 'NOT_FOUND', 'Offer not found.');
  const gateway = assignmentOrderGateway();
  const context = await gateway.context(searchMeta.delivery_id, prisma);
  check(context, 404, 'NOT_FOUND', 'Delivery not found.');
  try {
    return await transaction(async (db) => {
      const order = await gateway.lockOrder(context.orderId, db);
      const delivery = await deliveryForAssignmentLocked(searchMeta.delivery_id, db);
      await lockDriver(actor.id, db);
      const active = await activeDriverIds([actor.id], db);
      check(active.length === 1, 403, 'FORBIDDEN', 'An active driver account is required.');
      await db.$queryRaw`SELECT driver_id FROM driver_availability WHERE driver_id = ${actor.id} FOR UPDATE`;
      const locked = await lockOfferAndSearch(offerId, db);
      check(
        locked && locked.driver_id === actor.id && locked.search_id === offerMeta.search_id,
        403,
        'FORBIDDEN',
        'This offer is not yours.',
      );
      const old = await audits.findCommandReceipt<Receipt>(actor.id, action, offerId, keyHash, db);
      if (old) {
        check(
          old.fingerprint === fingerprint,
          409,
          'IDEMPOTENCY_CONFLICT',
          'This key was already used with different details.',
        );
        return {
          offerId: old.offerId,
          deliveryId: old.deliveryId,
          status: old.status,
          ...(old.assignmentId ? { assignmentId: old.assignmentId } : {}),
        };
      }
      check(
        locked.generation === searchMeta.generation &&
          locked.offer_status === 'OFFERED' &&
          locked.search_status === 'OFFERED',
        409,
        'OFFER_NOT_ACTIVE',
        'This offer is no longer active.',
      );
      const now = (await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]
        .now;
      check(
        locked.expires_at > now && locked.deadline_at > now,
        409,
        'OFFER_EXPIRED',
        'This offer has expired.',
      );
      check(
        order &&
          delivery &&
          delivery.order_id === context.orderId &&
          activeOrder(order.status) &&
          delivery.status === 'UNASSIGNED' &&
          !delivery.driver_id,
        409,
        'ORDER_NOT_ASSIGNABLE',
        'This delivery is no longer available.',
      );
      let assignmentId: string | undefined;
      if (decision === 'ACCEPTED') {
        const availability = await availabilityInTransaction(actor.id, db);
        check(availability.online, 409, 'DRIVER_OFFLINE', 'Go online before accepting.');
        check(availability.ready, 409, 'DRIVER_NOT_READY', 'Set yourself ready before accepting.');
        check(
          availability.heartbeatFresh && availability.locationFresh,
          409,
          'STALE_LOCATION',
          'Refresh your location and heartbeat before accepting.',
        );
        check(!availability.busy, 409, 'DRIVER_BUSY', 'Finish your active delivery first.');
        const currentContext = await gateway.context(searchMeta.delivery_id, db);
        const location = await latestDriverLocation(actor.id, db);
        check(
          currentContext?.pickup && location,
          409,
          'STALE_LOCATION',
          'A current pickup and driver location are required.',
        );
        check(
          haversineMeters(currentContext.pickup, location) <=
            assignmentConfig.ASSIGNMENT_RADIUS_METERS,
          409,
          'DRIVER_OUT_OF_RANGE',
          'You are outside the pickup area.',
        );
        assignmentId = await confirmOfferAssignment(db, delivery, actor.id);
      }
      await db.driverOffer.update({
        where: { id: offerId },
        data: {
          status: decision,
          responded_at: now,
          ...(assignmentId ? { assignment_id: assignmentId } : {}),
        },
      });
      await db.assignmentSearch.update({
        where: { id: locked.search_id },
        data: {
          status: decision === 'ACCEPTED' ? 'ASSIGNED' : 'SEARCHING',
          lease_owner: null,
          lease_until: null,
          next_run_at: now,
          version: { increment: 1 },
          updated_at: now,
        },
      });
      check(
        await resolveAttempt(locked.search_id, actor.id, decision, reason, db),
        409,
        'OFFER_NOT_ACTIVE',
        'This attempt is no longer active.',
      );
      const receipt: Receipt = {
        fingerprint,
        offerId,
        deliveryId: searchMeta.delivery_id,
        status: decision,
        ...(assignmentId ? { assignmentId } : {}),
      };
      await audits.audit(
        actor.id,
        action,
        offerId,
        { ...receipt, keyHash, ...(reason ? { reason } : {}) },
        db,
        { resourceType: 'DRIVER_OFFER', outcome: 'SUCCESS', correlationId },
      );
      if (assignmentId) {
        await notifyOnce(
          db,
          actor.id,
          'DRIVER_ASSIGNMENT_CONFIRMED',
          {
            offerId,
            deliveryId: searchMeta.delivery_id,
            assignmentId,
          },
          assignmentId,
        );
        await gateway.notifyAssigned(context.orderId, assignmentId, db);
      }
      return {
        offerId,
        deliveryId: searchMeta.delivery_id,
        status: decision,
        ...(assignmentId ? { assignmentId } : {}),
      };
    });
  } catch (error) {
    if (uniqueViolation(error))
      check(false, 409, 'DRIVER_BUSY', 'This driver already has an active trip.');
    throw error;
  }
}
