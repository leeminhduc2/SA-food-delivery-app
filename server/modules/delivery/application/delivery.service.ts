import { z } from 'zod';
import { prisma, transaction, uniqueViolation, type DB } from '../../../shared/db.js';
import { check } from '../../../shared/errors.js';
import { publish } from '../../../shared/events.js';
import type { User } from '../../../shared/types.js';
import * as audits from '../../../shared/audit.repository.js';
import { lockActiveDriver } from '../../identity/index.js';
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

export async function deliveryForOrderLocked(orderId: string, db: DB) {
  return deliveries.findByOrderForUpdate(orderId, db);
}

export async function deliveryForAssignmentLocked(deliveryId: string, db: DB) {
  return deliveries.findForUpdate(deliveryId, db);
}

export async function busyDriverIds(ids: readonly string[], db: DB = prisma): Promise<string[]> {
  return deliveries.busyDriverIds(ids, db);
}

export async function assign(actor: User, deliveryId: string, raw: unknown): Promise<void> {
  const { driverId } = z.object({ driverId: z.string().min(1) }).parse(raw);
  const orders = orderGateway();
  try {
    await transaction(async (db) => {
      const found = await deliveries.findById(deliveryId, db);
      check(found, 404, 'NOT_FOUND', 'Delivery not found.');
      const order = await orders.lockOrder(db, found.order_id);
      check(order, 404, 'NOT_FOUND', 'Order not found.');
      const delivery = await deliveries.findForUpdate(deliveryId, db);
      check(delivery, 404, 'NOT_FOUND', 'Delivery not found.');
      check(
        orders.acceptsDriverAssignment(order) && isOpen(delivery.status),
        409,
        'INVALID_TRANSITION',
        'This delivery cannot be assigned.',
      );
      check(
        await lockActiveDriver(driverId, db),
        400,
        'INVALID_DRIVER',
        'Choose an active driver.',
      );
      if (
        delivery.driver_id === driverId &&
        (await deliveries.findActiveAssignment(delivery.id, driverId, db))
      )
        return;
      check(
        !(await deliveries.findActiveForDriver(driverId, db)),
        409,
        'DRIVER_BUSY',
        'This driver already has an active trip.',
      );
      await deliveries.deactivateAssignments(delivery.id, 'REASSIGNED', db);
      await deliveries.insertAssignment(delivery.id, driverId, db);
      await deliveries.assign(delivery.id, driverId, db);
      await audits.history(order.id, 'DELIVERY', delivery.status, 'ASSIGNED', actor.id, '', db);
      await audits.audit(actor.id, 'DRIVER_ASSIGNED', delivery.id, { driverId }, db);
    });
  } catch (error) {
    if (uniqueViolation(error))
      check(false, 409, 'DRIVER_BUSY', 'This driver already has an active trip.');
    throw error;
  }
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
      await publish(db, 'DeliveryFailed', {
        orderId: order.id,
        actor: actor.id,
        reason: input.reason,
      });
      await audits.audit(actor.id, 'DELIVERY_FAILED', delivery.id, { reason: input.reason }, db);
    }
  });
}
