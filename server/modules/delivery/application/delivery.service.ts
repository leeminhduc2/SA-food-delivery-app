import { z } from 'zod';
import { createHash } from 'node:crypto';
import { prisma, transaction, type DB } from '../../../shared/db.js';
import { check } from '../../../shared/errors.js';
import { publish } from '../../../shared/events.js';
import type { User } from '../../../shared/types.js';
import * as audits from '../../../shared/audit.repository.js';
import * as deliveries from '../infrastructure/delivery.repository.js';
import { orderGateway } from '../delivery.ports.js';
import { canDriverTransition, hasFailureReason, isOpen } from '../domain/delivery-status.js';

const transitionSchema = z.object({
  status: z.enum(['PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED']),
  reason: z.string().max(300).default(''),
});

export async function createDelivery(db: DB, orderId: string): Promise<void> {
  await deliveries.insert(orderId, db);
  await audits.history(orderId, 'DELIVERY', null, 'UNASSIGNED', 'system', '', db);
}

export async function cancelDelivery(db: DB, orderId: string, actor: string): Promise<void> {
  const delivery = await deliveries.findByOrderForUpdate(orderId, db);
  if (delivery && isOpen(delivery.status)) {
    await deliveries.setStatus(delivery.id, 'CANCELLED', db);
    await deliveries.deactivateAssignments(delivery.id, 'CANCELLED', db);
    await audits.history(orderId, 'DELIVERY', delivery.status, 'CANCELLED', actor, '', db);
  }
}

export async function isDriverAssigned(
  orderId: string,
  driverId: string,
  db: DB = prisma,
): Promise<boolean> {
  return Boolean(await deliveries.findActiveForOrderAndDriver(orderId, driverId, db));
}

export async function hasActiveTrip(driverId: string, db: DB = prisma): Promise<boolean> {
  return Boolean(await deliveries.findActiveForDriver(driverId, db));
}

/** Metadata only; the caller must lock Order and Delivery and revalidate before changing it. */
export async function activeDeliveryForDriver(driverId: string, db: DB = prisma) {
  return deliveries.findActiveDeliveryForDriver(driverId, db);
}

export async function unassignedDeliveriesForBootstrap(
  after: string | undefined,
  limit: number,
  db: DB = prisma,
) {
  return deliveries.listUnassignedForBootstrap(after, limit, db);
}

export async function activeAssignmentsForBootstrap(
  after: string | undefined,
  limit: number,
  db: DB = prisma,
) {
  return deliveries.listActiveAssignmentsForBootstrap(after, limit, db);
}

/** Caller holds Order, Delivery and Driver locks. */
export async function revokeUnavailableDriver(
  delivery: { id: string; order_id: string; driver_id: string | null; status: string },
  driverId: string,
  reason: string,
  db: DB,
): Promise<boolean> {
  if (delivery.status !== 'ASSIGNED' || delivery.driver_id !== driverId) return false;
  if (!(await deliveries.findActiveAssignment(delivery.id, driverId, db))) return false;
  await deliveries.deactivateAssignments(delivery.id, reason, db);
  await deliveries.unassign(delivery.id, db);
  await audits.history(
    delivery.order_id,
    'DELIVERY',
    'ASSIGNED',
    'UNASSIGNED',
    'system',
    reason,
    db,
  );
  await audits.audit('system', 'DRIVER_ASSIGNMENT_REVOKED', delivery.id, { driverId, reason }, db, {
    resourceType: 'DELIVERY',
    outcome: 'SUCCESS',
  });
  return true;
}

/** Record one open operational incident; keeps the active trip and occupancy intact. */
export async function recordOperationalIncident(
  delivery: { id: string; order_id: string; driver_id: string | null; status: string },
  driverId: string,
  reason: string,
  db: DB,
): Promise<boolean> {
  if (delivery.driver_id !== driverId || !['PICKED_UP', 'IN_TRANSIT'].includes(delivery.status))
    return false;
  if (!(await deliveries.findActiveAssignment(delivery.id, driverId, db))) return false;
  return deliveries.insertOperationalIncident(delivery.id, delivery.order_id, reason, db);
}

export async function deliveryForOrderLocked(orderId: string, db: DB) {
  return deliveries.findByOrderForUpdate(orderId, db);
}

export async function deliveryForAssignmentLocked(deliveryId: string, db: DB) {
  return deliveries.findForUpdate(deliveryId, db);
}

export async function deliveryForAssignment(deliveryId: string, db: DB = prisma) {
  return deliveries.findById(deliveryId, db);
}

/** Caller holds Order, Delivery and both Driver locks and has checked eligibility. */
export async function applyAdminDriverOverride(
  delivery: { id: string; order_id: string; driver_id: string | null; status: string },
  driverId: string,
  actorId: string,
  reason: string,
  db: DB,
): Promise<string> {
  check(
    ['UNASSIGNED', 'ASSIGNED'].includes(delivery.status),
    409,
    'INVALID_TRANSITION',
    'Cannot reassign after pickup.',
  );
  check(
    !(await deliveries.findActiveForDriver(driverId, db)),
    409,
    'DRIVER_BUSY',
    'This driver already has an active trip.',
  );
  await deliveries.deactivateAssignments(delivery.id, 'REASSIGNED', db);
  const assignmentId = await deliveries.insertAssignment(delivery.id, driverId, db);
  await deliveries.assign(delivery.id, driverId, db);
  await deliveries.insertOverrideIncident(delivery.id, delivery.order_id, reason, db);
  await audits.history(
    delivery.order_id,
    'DELIVERY',
    delivery.status,
    'ASSIGNED',
    actorId,
    reason,
    db,
  );
  return assignmentId;
}

export async function busyDriverIds(ids: readonly string[], db: DB = prisma): Promise<string[]> {
  return deliveries.busyDriverIds(ids, db);
}

/** Caller has locked the order, delivery and driver in that order. */
export async function confirmOfferAssignment(
  db: DB,
  delivery: { id: string; order_id: string; status: string; driver_id: string | null },
  driverId: string,
): Promise<string> {
  check(
    delivery.status === 'UNASSIGNED' && !delivery.driver_id,
    409,
    'ORDER_NOT_ASSIGNABLE',
    'This delivery is no longer available.',
  );
  check(
    !(await deliveries.findActiveForDriver(driverId, db)),
    409,
    'DRIVER_BUSY',
    'This driver already has an active trip.',
  );
  const assignmentId = await deliveries.insertAssignment(delivery.id, driverId, db);
  await deliveries.assign(delivery.id, driverId, db);
  await audits.history(
    delivery.order_id,
    'DELIVERY',
    delivery.status,
    'ASSIGNED',
    driverId,
    '',
    db,
  );
  return assignmentId;
}

export async function arrive(
  actor: User,
  deliveryId: string,
  raw: unknown,
): Promise<{ deliveryId: string; arrivedAt: Date }> {
  const input = z.object({ idempotencyKey: z.string().min(8).max(120) }).parse(raw);
  const keyHash = createHash('sha256').update(input.idempotencyKey).digest('hex');
  const orders = orderGateway();
  return transaction(async (db) => {
    const found = await deliveries.findOrderId(deliveryId, db);
    check(found, 404, 'NOT_FOUND', 'Delivery not found.');
    const order = await orders.lockOrder(db, found.order_id);
    check(order, 404, 'NOT_FOUND', 'Order not found.');
    const delivery = await deliveries.findForUpdate(deliveryId, db);
    check(delivery, 404, 'NOT_FOUND', 'Delivery not found.');
    const assignment = await deliveries.findActiveAssignment(delivery.id, actor.id, db);
    check(
      delivery.driver_id === actor.id && assignment,
      403,
      'FORBIDDEN',
      'This delivery is not assigned to you.',
    );
    const old = await audits.findCommandReceipt<{ fingerprint: string; arrivedAt: string }>(
      actor.id,
      'ARRIVAL_RECEIPT',
      deliveryId,
      keyHash,
      db,
    );
    if (old) return { deliveryId, arrivedAt: new Date(old.arrivedAt) };
    let arrivedAt = delivery.arrived_at;
    if (!arrivedAt) {
      check(
        delivery.status === 'ASSIGNED',
        409,
        'INVALID_TRANSITION',
        'Arrival is only available before pickup.',
      );
      arrivedAt = await deliveries.markArrived(deliveryId, actor.id, db);
      check(arrivedAt, 409, 'INVALID_TRANSITION', 'Arrival could not be recorded.');
      await audits.history(order.id, 'DRIVER_ARRIVAL', null, 'ARRIVED', actor.id, '', db);
      await audits.audit(actor.id, 'DRIVER_ARRIVED', deliveryId, {}, db, {
        resourceType: 'DELIVERY',
        outcome: 'SUCCESS',
      });
      await publish(db, 'DriverArrived', {
        orderId: order.id,
        deliveryId,
        assignmentId: assignment.id,
        actor: actor.id,
      });
    }
    await audits.audit(
      actor.id,
      'ARRIVAL_RECEIPT',
      deliveryId,
      {
        keyHash,
        fingerprint: 'ARRIVE',
        arrivedAt: arrivedAt.toISOString(),
        assignmentId: assignment.id,
      },
      db,
      { resourceType: 'DELIVERY', outcome: 'SUCCESS' },
    );
    return { deliveryId, arrivedAt };
  });
}

export async function transition(actor: User, deliveryId: string, raw: unknown): Promise<void> {
  const input = transitionSchema.parse(raw);
  const orders = orderGateway();
  await transaction(async (db) => {
    const found = await deliveries.findOrderId(deliveryId, db);
    check(found, 404, 'NOT_FOUND', 'Delivery not found.');
    const order = await orders.lockOrder(db, found.order_id);
    check(order, 404, 'NOT_FOUND', 'Order not found.');
    const delivery = await deliveries.findForUpdate(deliveryId, db);
    check(delivery, 404, 'NOT_FOUND', 'Delivery not found.');
    check(
      delivery.driver_id === actor.id &&
        (await deliveries.findActiveAssignment(delivery.id, actor.id, db)),
      403,
      'FORBIDDEN',
      'This delivery is not assigned to you.',
    );
    check(
      canDriverTransition(delivery.status, input.status),
      409,
      'INVALID_TRANSITION',
      'Invalid delivery transition.',
    );
    if (input.status === 'PICKED_UP')
      check(
        orders.isReadyForPickup(order),
        409,
        'NOT_READY',
        'The restaurant has not marked the food ready.',
      );
    if (input.status === 'FAILED')
      check(
        hasFailureReason(input.reason),
        400,
        'REASON_REQUIRED',
        'Please describe why delivery failed.',
      );
    await deliveries.setStatus(delivery.id, input.status, db);
    if (input.status === 'DELIVERED' || input.status === 'FAILED')
      await deliveries.deactivateAssignments(delivery.id, input.status, db);
    await audits.history(
      order.id,
      'DELIVERY',
      delivery.status,
      input.status,
      actor.id,
      input.reason,
      db,
    );
    if (input.status === 'PICKED_UP')
      await publish(db, 'DeliveryPickedUp', { orderId: order.id, actor: actor.id });
    if (input.status === 'DELIVERED')
      await publish(db, 'DeliveryCompleted', { orderId: order.id, actor: actor.id });
    if (input.status === 'FAILED') {
      await deliveries.insertFailureIncident(delivery.id, order.id, input.reason, db);
      await publish(db, 'DeliveryFailed', {
        orderId: order.id,
        actor: actor.id,
        reason: input.reason,
      });
      await audits.audit(actor.id, 'DELIVERY_FAILED', delivery.id, { reason: input.reason }, db);
    }
  });
}
