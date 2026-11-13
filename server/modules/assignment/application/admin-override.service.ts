import { createHash } from 'node:crypto';
import { z } from 'zod';
import { id, prisma, transaction, uniqueViolation } from '../../../shared/db.js';
import { check } from '../../../shared/errors.js';
import type { User } from '../../../shared/types.js';
import * as audits from '../../../shared/audit.repository.js';
import {
  applyAdminDriverOverride,
  deliveryForAssignment,
  deliveryForAssignmentLocked,
} from '../../delivery/index.js';
import { activeDriverIds, lockDriver } from '../../identity/index.js';
import { latestDriverLocation } from '../../location/index.js';
import { notifyOnce } from '../../notification/index.js';
import { assignmentOrderGateway } from '../assignment.ports.js';
import { assignmentConfig } from '../config.js';
import { haversineMeters } from '../domain/assignment-strategy.js';
import { resolveAttempt } from '../infrastructure/assignment.repository.js';
import { availabilityInTransaction } from './availability.service.js';

const schema = z.object({
  driverId: z.string().min(1),
  reason: z.string().trim().min(3).max(300),
  exceptionCode: z.enum(['NO_DRIVER', 'DRIVER_UNAVAILABLE', 'OPERATIONAL_ERROR']),
  idempotencyKey: z.string().min(8).max(120),
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export async function overrideDriver(
  actor: User,
  deliveryId: string,
  raw: unknown,
  correlationId?: string,
) {
  check(actor.role === 'ADMIN', 403, 'FORBIDDEN', 'Administrator access required.');
  const input = schema.parse(raw);
  const keyHash = hash(input.idempotencyKey);
  const fingerprint = hash(
    JSON.stringify({
      driverId: input.driverId,
      reason: input.reason,
      exceptionCode: input.exceptionCode,
    }),
  );
  const found = await deliveryForAssignment(deliveryId);
  check(found, 404, 'NOT_FOUND', 'Delivery not found.');
  const gateway = assignmentOrderGateway();
  try {
    return await transaction(async (db) => {
      const order = await gateway.lockOrder(found.order_id, db);
      const delivery = await deliveryForAssignmentLocked(deliveryId, db);
      check(order && delivery, 404, 'NOT_FOUND', 'Delivery not found.');
      const receipt = await audits.findCommandReceipt<{
        fingerprint: string;
        assignmentId: string;
      }>(actor.id, 'ADMIN_DRIVER_OVERRIDE', deliveryId, keyHash, db);
      if (receipt) {
        check(
          receipt.fingerprint === fingerprint,
          409,
          'IDEMPOTENCY_CONFLICT',
          'This key was used with different details.',
        );
        return { ok: true, assignmentId: receipt.assignmentId };
      }
      check(
        ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(order.status),
        409,
        'ORDER_NOT_ASSIGNABLE',
        'This order cannot be assigned.',
      );
      check(
        ['UNASSIGNED', 'ASSIGNED'].includes(delivery.status),
        409,
        'INVALID_TRANSITION',
        'Cannot reassign after pickup.',
      );
      for (const driverId of [
        ...new Set([input.driverId, delivery.driver_id].filter((v): v is string => Boolean(v))),
      ].sort())
        await lockDriver(driverId, db);
      check(
        (await activeDriverIds([input.driverId], db)).length === 1,
        400,
        'INVALID_DRIVER',
        'Choose an active driver.',
      );
      await db.$queryRaw`SELECT driver_id FROM driver_availability WHERE driver_id = ${input.driverId} FOR UPDATE`;
      const state = await availabilityInTransaction(input.driverId, db);
      check(
        state.online && state.ready,
        409,
        'DRIVER_NOT_READY',
        'Choose an online and ready driver.',
      );
      check(
        state.heartbeatFresh && state.locationFresh,
        409,
        'STALE_LOCATION',
        'Choose a driver with current location and heartbeat.',
      );
      check(!state.busy, 409, 'DRIVER_BUSY', 'This driver already has an active trip.');
      const [context, location] = await Promise.all([
        gateway.context(deliveryId, db),
        latestDriverLocation(input.driverId, db),
      ]);
      check(
        context?.pickup &&
          location &&
          haversineMeters(context.pickup, location) <= assignmentConfig.ASSIGNMENT_RADIUS_METERS,
        409,
        'DRIVER_OUT_OF_RANGE',
        'Choose a driver within the pickup area.',
      );
      const otherOffer = await db.driverOffer.findFirst({
        where: { driver_id: input.driverId, status: 'OFFERED' },
        select: { search_id: true },
      });
      if (otherOffer) {
        const offeredSearch = await db.assignmentSearch.findUnique({
          where: { id: otherOffer.search_id },
          select: { delivery_id: true },
        });
        check(
          offeredSearch?.delivery_id === deliveryId,
          409,
          'DRIVER_HAS_OFFER',
          'This driver has an outstanding offer.',
        );
      }
      await db.$queryRaw`SELECT id FROM assignment_searches WHERE delivery_id = ${deliveryId} AND status IN ('WAITING','SEARCHING','OFFERED') ORDER BY id FOR UPDATE`;
      const searches = await db.assignmentSearch.findMany({
        where: { delivery_id: deliveryId, status: { in: ['WAITING', 'SEARCHING', 'OFFERED'] } },
        select: { id: true },
      });
      const now = (await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]
        .now;
      for (const search of searches) {
        const offers = await db.driverOffer.findMany({
          where: { search_id: search.id, status: 'OFFERED' },
          select: { id: true, driver_id: true },
        });
        for (const offer of offers) {
          await db.driverOffer.update({
            where: { id: offer.id },
            data: { status: 'REVOKED', responded_at: now },
          });
          if (!(await resolveAttempt(search.id, offer.driver_id, 'REVOKED', 'ADMIN_OVERRIDE', db)))
            throw new Error('Offer attempt missing');
          await notifyOnce(
            db,
            offer.driver_id,
            'DRIVER_OFFER_REVOKED',
            { offerId: offer.id },
            offer.id,
          );
        }
        await db.assignmentSearch.update({
          where: { id: search.id },
          data: {
            status: 'CANCELLED',
            lease_owner: null,
            lease_until: null,
            version: { increment: 1 },
            updated_at: now,
          },
        });
      }
      const assignmentId = await applyAdminDriverOverride(
        delivery,
        input.driverId,
        actor.id,
        input.reason,
        db,
      );
      await audits.audit(
        actor.id,
        'ADMIN_DRIVER_OVERRIDE',
        deliveryId,
        {
          keyHash,
          fingerprint,
          assignmentId,
          driverId: input.driverId,
          reason: input.reason,
          exceptionCode: input.exceptionCode,
        },
        db,
        { resourceType: 'DELIVERY', outcome: 'SUCCESS', correlationId },
      );
      if (delivery.driver_id)
        await notifyOnce(
          db,
          delivery.driver_id,
          'DRIVER_ASSIGNMENT_REVOKED',
          { deliveryId },
          assignmentId,
        );
      await notifyOnce(
        db,
        input.driverId,
        'DRIVER_ASSIGNMENT_CONFIRMED',
        { deliveryId, assignmentId },
        assignmentId,
      );
      await gateway.notifyAssigned(order.id, assignmentId, db);
      await db.driverOperationalChange.create({
        data: {
          id: id(),
          driver_id: input.driverId,
          source: 'ASSIGNMENT',
          reason: 'ADMIN_OVERRIDE',
        },
      });
      return { ok: true, assignmentId };
    });
  } catch (error) {
    if (uniqueViolation(error))
      check(false, 409, 'DRIVER_BUSY', 'This driver already has an active trip.');
    throw error;
  }
}
