import { createHash } from 'node:crypto';
import { z } from 'zod';
import { id, prisma, transaction, type DB } from '../../../shared/db.js';
import { check } from '../../../shared/errors.js';
import { publish } from '../../../shared/events.js';
import type { User } from '../../../shared/types.js';
import * as audits from '../../../shared/audit.repository.js';
import { orderGateway } from '../delivery.ports.js';
import * as deliveries from '../infrastructure/delivery.repository.js';

const key = z.string().min(8).max(120);
const reason = z.string().trim().min(3).max(300);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const resolutions = ['REFUND_REQUESTED', 'NO_REFUND', 'NO_ACTION'] as const;

/**
 * Terminal FAILED after pickup. Closes the assignment in the same transaction
 * (capacity release), records actor and reason, and opens one DELIVERY_FAILED
 * incident. Stock is never restocked after pickup and no payment changes here.
 */
export async function failAfterPickup(
  db: DB,
  delivery: { id: string; order_id: string; status: string },
  actorId: string,
  failureReason: string,
): Promise<string | null> {
  await deliveries.setStatus(delivery.id, 'FAILED', db);
  await deliveries.deactivateAssignments(delivery.id, 'FAILED', db);
  await audits.history(
    delivery.order_id,
    'DELIVERY',
    delivery.status,
    'FAILED',
    actorId,
    failureReason,
    db,
  );
  const incidentId = await deliveries.insertFailureIncident(
    delivery.id,
    delivery.order_id,
    failureReason,
    db,
    actorId,
  );
  await publish(db, 'DeliveryFailed', {
    orderId: delivery.order_id,
    actor: actorId,
    reason: failureReason,
  });
  await audits.audit(actorId, 'DELIVERY_FAILED', delivery.id, { reason: failureReason }, db, {
    resourceType: 'DELIVERY',
    outcome: 'SUCCESS',
  });
  return incidentId;
}

/**
 * Exception path for a trip that cannot finish normally, e.g. the driver's
 * account was locked after pickup. Requires an open operational incident; the
 * driver is never replaced after pickup.
 */
export async function adminFailDelivery(actor: User, deliveryId: string, raw: unknown) {
  check(actor.role === 'ADMIN', 403, 'FORBIDDEN', 'Administrator access required.');
  const input = z.object({ reason, idempotencyKey: key }).parse(raw);
  const keyHash = digest(input.idempotencyKey);
  return transaction(async (db) => {
    const found = await deliveries.findOrderId(deliveryId, db);
    check(found, 404, 'NOT_FOUND', 'Delivery not found.');
    await orderGateway().lockOrder(db, found.order_id);
    const delivery = await deliveries.findForUpdate(deliveryId, db);
    check(delivery, 404, 'NOT_FOUND', 'Delivery not found.');
    const receipt = await audits.findCommandReceipt<{
      fingerprint: string;
      incidentId: string | null;
    }>(actor.id, 'ADMIN_DELIVERY_FAIL', deliveryId, keyHash, db);
    if (receipt) {
      check(
        receipt.fingerprint === input.reason,
        409,
        'IDEMPOTENCY_CONFLICT',
        'This key was used with a different reason.',
      );
      return { deliveryId, status: 'FAILED', incidentId: receipt.incidentId };
    }
    check(
      ['PICKED_UP', 'IN_TRANSIT'].includes(delivery.status),
      409,
      'INVALID_TRANSITION',
      'Only a delivery in progress after pickup can be failed.',
    );
    const operational = await db.deliveryIncident.findFirst({
      where: { delivery_id: deliveryId, status: 'OPEN', type: 'DRIVER_UNAVAILABLE' },
      select: { id: true },
    });
    check(
      operational,
      409,
      'INCIDENT_REQUIRED',
      'An open operational incident is required before failing a delivery.',
    );
    const incidentId = await failAfterPickup(db, delivery, actor.id, input.reason);
    await closeIncident(
      db,
      operational.id,
      actor.id,
      'NO_ACTION',
      `Delivery closed as failed: ${input.reason}`,
      [],
    );
    await audits.audit(
      actor.id,
      'ADMIN_DELIVERY_FAIL',
      deliveryId,
      { keyHash, fingerprint: input.reason, incidentId },
      db,
      { resourceType: 'DELIVERY', outcome: 'SUCCESS' },
    );
    return { deliveryId, status: 'FAILED', incidentId };
  });
}

async function closeIncident(
  db: DB,
  incidentId: string,
  actorId: string,
  resolution: (typeof resolutions)[number],
  resolutionReason: string,
  evidence: string[],
) {
  const updated = await db.$executeRaw`
    UPDATE delivery_incidents
    SET status = 'RESOLVED', resolution = ${resolution}, resolution_reason = ${resolutionReason},
        resolved_by = ${actorId}, resolved_at = clock_timestamp(), updated_at = clock_timestamp(),
        evidence = evidence || ${JSON.stringify(evidence)}::jsonb
    WHERE id = ${incidentId} AND status = 'OPEN'`;
  if (updated === 1)
    await db.deliveryIncidentHistory.create({
      data: {
        id: id(),
        incident_id: incidentId,
        action: 'RESOLVED',
        actor_id: actorId,
        reason: resolutionReason,
      },
    });
  return updated === 1;
}

/**
 * Records the Admin decision. REFUND_REQUESTED is only a label for the follow-up
 * refund request; it never marks a payment refunded, resolves complaints or
 * creates a redelivery.
 */
export async function resolveIncident(actor: User, incidentId: string, raw: unknown) {
  check(actor.role === 'ADMIN', 403, 'FORBIDDEN', 'Administrator access required.');
  const input = z
    .object({
      resolution: z.enum(resolutions),
      reason: z.string().trim().min(3).max(1000),
      evidence: z.array(z.string().min(1).max(128)).max(10).default([]),
      idempotencyKey: key,
    })
    .parse(raw);
  const keyHash = digest(input.idempotencyKey);
  const fingerprint = JSON.stringify([input.resolution, input.reason, input.evidence]);
  return transaction(async (db) => {
    const rows = await db.$queryRaw<
      Array<{ id: string; status: string }>
    >`SELECT id, status FROM delivery_incidents WHERE id = ${incidentId} FOR UPDATE`;
    check(rows[0], 404, 'NOT_FOUND', 'Incident not found.');
    const receipt = await audits.findCommandReceipt(
      actor.id,
      'INCIDENT_RESOLVED',
      incidentId,
      keyHash,
      db,
    );
    if (receipt) {
      check(
        receipt.fingerprint === fingerprint,
        409,
        'IDEMPOTENCY_CONFLICT',
        'This key was used for a different resolution.',
      );
      return { incidentId, status: 'RESOLVED', resolution: input.resolution };
    }
    check(
      await closeIncident(db, incidentId, actor.id, input.resolution, input.reason, input.evidence),
      409,
      'INCIDENT_NOT_OPEN',
      'This incident is already resolved.',
    );
    await audits.audit(
      actor.id,
      'INCIDENT_RESOLVED',
      incidentId,
      { keyHash, fingerprint, resolution: input.resolution },
      db,
      { resourceType: 'DELIVERY_INCIDENT', outcome: 'SUCCESS' },
    );
    return { incidentId, status: 'RESOLVED', resolution: input.resolution };
  });
}

const listQuery = z.object({
  status: z.enum(['OPEN', 'RESOLVED']).optional(),
  type: z.string().max(40).optional(),
  orderId: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(400).optional(),
});

/** Stable (created_at, id) desc keyset pagination. */
export async function listIncidents(raw: unknown) {
  const query = listQuery.parse(raw);
  let after: { createdAt: Date; id: string } | undefined;
  if (query.cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      after = { createdAt: new Date(parsed[0]), id: String(parsed[1]) };
      check(!Number.isNaN(after.createdAt.getTime()), 400, 'INVALID_CURSOR', 'Invalid cursor.');
    } catch {
      check(false, 400, 'INVALID_CURSOR', 'Invalid cursor.');
    }
  }
  const rows = await prisma.deliveryIncident.findMany({
    where: {
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.orderId ? { order_id: query.orderId } : {}),
      ...(after
        ? {
            OR: [
              { created_at: { lt: after.createdAt } },
              { created_at: after.createdAt, id: { lt: after.id } },
            ],
          }
        : {}),
    },
    include: { history: { orderBy: { created_at: 'asc' } } },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
  });
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const statuses = new Map(
    (
      await prisma.delivery.findMany({
        where: { id: { in: page.map((row) => row.delivery_id) } },
        select: { id: true, status: true },
      })
    ).map((row) => [row.id, row.status]),
  );
  return {
    items: page.map((row) => ({
      id: row.id,
      deliveryId: row.delivery_id,
      orderId: row.order_id,
      deliveryStatus: statuses.get(row.delivery_id) ?? null,
      type: row.type,
      status: row.status,
      reason: row.reason,
      evidence: row.evidence,
      resolution: row.resolution,
      resolutionReason: row.resolution_reason,
      resolvedAt: row.resolved_at,
      createdAt: row.created_at,
      history: row.history.map((entry) => ({
        action: entry.action,
        actorId: entry.actor_id,
        reason: entry.reason,
        createdAt: entry.created_at,
      })),
    })),
    nextCursor:
      rows.length > query.limit && last
        ? Buffer.from(JSON.stringify([last.created_at.toISOString(), last.id])).toString(
            'base64url',
          )
        : null,
  };
}

/** Refund eligibility reads only existence, type and status. */
export async function incidentForOrder(orderId: string, incidentId?: string) {
  return (
    (await prisma.deliveryIncident.findFirst({
      where: {
        order_id: orderId,
        type: 'DELIVERY_FAILED',
        ...(incidentId ? { id: incidentId } : {}),
      },
      select: { id: true, type: true, status: true },
      orderBy: { created_at: 'desc' },
    })) ?? undefined
  );
}
