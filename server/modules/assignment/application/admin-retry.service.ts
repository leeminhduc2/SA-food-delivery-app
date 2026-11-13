import { createHash } from 'node:crypto';
import { z } from 'zod';
import { id, prisma, transaction } from '../../../shared/db.js';
import { check } from '../../../shared/errors.js';
import type { User } from '../../../shared/types.js';
import * as audits from '../../../shared/audit.repository.js';
import {
  deliveryForAssignment,
  deliveryForAssignmentLocked,
  hasOperationalIncident,
} from '../../delivery/index.js';
import { assignmentOrderGateway } from '../assignment.ports.js';
import { assignmentConfig } from '../config.js';

const inputSchema = z
  .object({ reason: z.string().trim().min(3).max(300), idempotencyKey: z.string().min(8).max(120) })
  .strict();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export async function retrySearch(
  actor: User,
  searchId: string,
  raw: unknown,
  correlationId?: string,
) {
  check(actor.role === 'ADMIN', 403, 'FORBIDDEN', 'Administrator access required.');
  const input = inputSchema.parse(raw);
  const keyHash = hash(input.idempotencyKey),
    fingerprint = hash(JSON.stringify({ reason: input.reason }));
  const search = await prisma.assignmentSearch.findUnique({
    where: { id: searchId },
    select: { delivery_id: true },
  });
  check(search, 404, 'NOT_FOUND', 'Assignment search not found.');
  const found = await deliveryForAssignment(search.delivery_id);
  check(found, 404, 'NOT_FOUND', 'Delivery not found.');
  const gateway = assignmentOrderGateway();
  return transaction(async (db) => {
    const order = await gateway.lockOrder(found.order_id, db);
    const delivery = await deliveryForAssignmentLocked(found.id, db);
    check(order && delivery, 404, 'NOT_FOUND', 'Delivery not found.');
    const receipt = await audits.findCommandReceipt<{
      fingerprint: string;
      searchId: string;
      generation: number;
    }>(actor.id, 'ADMIN_SEARCH_RETRY', searchId, keyHash, db);
    if (receipt) {
      check(
        receipt.fingerprint === fingerprint,
        409,
        'IDEMPOTENCY_CONFLICT',
        'This key was used with different details.',
      );
      return { searchId: receipt.searchId, generation: receipt.generation };
    }
    check(
      ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(order.status),
      409,
      'ORDER_NOT_ASSIGNABLE',
      'This order cannot be retried.',
    );
    check(
      delivery.status === 'UNASSIGNED' && !delivery.driver_id,
      409,
      'INVALID_TRANSITION',
      'Retry requires an unassigned delivery before pickup.',
    );
    const latest = await db.assignmentSearch.findFirst({
      where: { delivery_id: delivery.id },
      orderBy: { generation: 'desc' },
      select: { id: true, generation: true, status: true },
    });
    check(
      latest && latest.id === searchId,
      409,
      'STALE_SEARCH',
      'Retry the latest search generation.',
    );
    check(
      !['WAITING', 'SEARCHING', 'OFFERED'].includes(latest.status),
      409,
      'SEARCH_ACTIVE',
      'A search is already active.',
    );
    check(
      latest.status === 'EXHAUSTED' || (await hasOperationalIncident(delivery.id, db)),
      409,
      'RETRY_NOT_ALLOWED',
      'Retry requires exhaustion or an operational incident.',
    );
    const nextId = id(),
      generation = latest.generation + 1;
    await db.$executeRaw`INSERT INTO assignment_searches (id, delivery_id, generation, deadline_at) VALUES
      (${nextId}, ${delivery.id}, ${generation}, clock_timestamp() + ${assignmentConfig.ASSIGNMENT_SEARCH_DEADLINE_SECONDS} * interval '1 second')`;
    await audits.audit(
      actor.id,
      'ADMIN_SEARCH_RETRY',
      searchId,
      {
        keyHash,
        fingerprint,
        searchId: nextId,
        generation,
        deliveryId: delivery.id,
        reason: input.reason,
      },
      db,
      { resourceType: 'ASSIGNMENT_SEARCH', outcome: 'SUCCESS', correlationId },
    );
    return { searchId: nextId, generation };
  });
}
