import { z } from 'zod';
import { transaction, type DB } from '../db.js';
import { check } from '../domain/errors.js';
import type { User } from '../domain/types.js';
import * as audits from '../repositories/audit.repository.js';
import * as deliveries from '../repositories/delivery.repository.js';
import * as orders from '../repositories/order.repository.js';
import * as users from '../repositories/user.repository.js';
import { changeOrder } from './order.service.js';

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
  if (delivery && ['UNASSIGNED', 'ASSIGNED'].includes(delivery.status)) {
    await deliveries.setStatus(delivery.id, 'CANCELLED', db);
    await deliveries.deactivateAssignments(delivery.id, db);
    await audits.history(orderId, 'DELIVERY', delivery.status, 'CANCELLED', actor, '', db);
  }
}

export async function assign(actor: User, deliveryId: string, raw: unknown): Promise<void> {
  const { driverId } = z.object({ driverId: z.string().min(1) }).parse(raw);
  await transaction(async (db) => {
    const found = await deliveries.findById(deliveryId, db);
    check(found, 404, 'NOT_FOUND', 'Delivery not found.');
    const order = await orders.lock(found.order_id, db);
    check(order, 404, 'NOT_FOUND', 'Order not found.');
    const delivery = await deliveries.findForUpdate(deliveryId, db);
    check(delivery, 404, 'NOT_FOUND', 'Delivery not found.');
    check(
      ['CONFIRMED', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(order.status) &&
        ['UNASSIGNED', 'ASSIGNED'].includes(delivery.status),
      409,
      'INVALID_TRANSITION',
      'This delivery cannot be assigned.',
    );
    check(
      await users.findActiveDriver(driverId, db),
      400,
      'INVALID_DRIVER',
      'Choose an active driver.',
    );
    await deliveries.deactivateAssignments(delivery.id, db);
    await deliveries.insertAssignment(delivery.id, driverId, db);
    await deliveries.assign(delivery.id, driverId, db);
    await audits.history(order.id, 'DELIVERY', delivery.status, 'ASSIGNED', actor.id, '', db);
    await audits.audit(actor.id, 'DRIVER_ASSIGNED', delivery.id, { driverId }, db);
  });
}

export async function transition(actor: User, deliveryId: string, raw: unknown): Promise<void> {
  const input = transitionSchema.parse(raw);
  await transaction(async (db) => {
    const found = await deliveries.findOrderId(deliveryId, db);
    check(found, 404, 'NOT_FOUND', 'Delivery not found.');
    const order = await orders.lock(found.order_id, db);
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
    const transitions: Record<string, string[]> = {
      ASSIGNED: ['PICKED_UP'],
      PICKED_UP: ['IN_TRANSIT', 'FAILED'],
      IN_TRANSIT: ['DELIVERED', 'FAILED'],
    };
    check(
      transitions[delivery.status]?.includes(input.status),
      409,
      'INVALID_TRANSITION',
      'Invalid delivery transition.',
    );
    if (input.status === 'PICKED_UP')
      check(
        order.status === 'READY_FOR_PICKUP',
        409,
        'NOT_READY',
        'The restaurant has not marked the food ready.',
      );
    if (input.status === 'FAILED')
      check(
        input.reason.trim().length >= 3,
        400,
        'REASON_REQUIRED',
        'Please describe why delivery failed.',
      );
    await deliveries.setStatus(delivery.id, input.status, db);
    await audits.history(
      order.id,
      'DELIVERY',
      delivery.status,
      input.status,
      actor.id,
      input.reason,
      db,
    );
    if (input.status === 'PICKED_UP') await changeOrder(db, order, 'OUT_FOR_DELIVERY', actor.id);
    if (input.status === 'DELIVERED') await changeOrder(db, order, 'DELIVERED', actor.id);
    if (input.status === 'FAILED') {
      await changeOrder(db, order, 'DELIVERY_FAILED', actor.id, input.reason);
      await audits.audit(actor.id, 'DELIVERY_FAILED', delivery.id, { reason: input.reason }, db);
    }
  });
}
