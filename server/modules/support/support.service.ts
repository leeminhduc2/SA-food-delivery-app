import { z } from 'zod';
import { transaction } from '../../shared/db.js';
import { check } from '../../shared/errors.js';
import type { User } from '../../shared/types.js';
import * as audits from '../../shared/audit.repository.js';
import * as complaints from './complaint.repository.js';
import { accessOrder } from '../ordering/index.js';
import { driverParticipated } from '../delivery/index.js';
import { activeAdministratorIds } from '../identity/index.js';
import { notify, notifyOnce } from '../notification/index.js';

const reporterRoles = ['CUSTOMER', 'RESTAURANT', 'DRIVER'];

/** Ticket DTO. Staff reporters never receive customer identifiers. */
function toDto(row: complaints.ComplaintRow, viewer: User) {
  return {
    id: row.id,
    order_id: row.order_id,
    reporter_role: row.reporter_role,
    content: row.content,
    status: row.status,
    resolution: row.resolution,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
    ...(viewer.role === 'ADMIN'
      ? { reporter_id: row.reporter_id, customer_id: row.customer_id }
      : viewer.role === 'CUSTOMER'
        ? { customer_id: row.customer_id }
        : {}),
  };
}

/**
 * Customers and restaurant members use normal order access. A driver may report
 * any trip they were ever assigned to, including one reassigned away, without
 * gaining access to the order itself.
 */
async function authorizeReporter(actor: User, orderId: string) {
  check(
    reporterRoles.includes(actor.role),
    403,
    'FORBIDDEN',
    'Support tickets are for order participants.',
  );
  if (actor.role === 'DRIVER')
    check(
      await driverParticipated(orderId, actor.id),
      403,
      'FORBIDDEN',
      'You were not assigned to this delivery.',
    );
  else await accessOrder(undefined, actor, orderId);
}

export async function createComplaint(actor: User, orderId: string, raw: unknown) {
  const { content } = z.object({ content: z.string().trim().min(10).max(2000) }).parse(raw);
  await authorizeReporter(actor, orderId);
  const row = await transaction(async (db) => {
    const created = await complaints.insert(
      { orderId, reporterId: actor.id, reporterRole: actor.role, content },
      db,
    );
    await audits.audit(
      actor.id,
      'COMPLAINT_CREATED',
      created.id,
      { orderId, reporterRole: actor.role },
      db,
      { resourceType: 'COMPLAINT', outcome: 'SUCCESS' },
    );
    for (const adminId of await activeAdministratorIds(db))
      await notifyOnce(
        db,
        adminId,
        'SUPPORT_TICKET_CREATED',
        { orderId, complaintId: created.id },
        created.id,
      );
    return created;
  });
  return toDto(row, actor);
}

export async function list(actor: User) {
  return (await complaints.listForActor(actor.role, actor.id)).map((row) => toDto(row, actor));
}

export async function detail(actor: User, complaintId: string) {
  const row = await complaints.findById(complaintId);
  check(row, 404, 'NOT_FOUND', 'Support ticket not found.');
  check(
    actor.role === 'ADMIN' || row.reporter_id === actor.id,
    403,
    'FORBIDDEN',
    'You cannot view this support ticket.',
  );
  return {
    ...toDto(row, actor),
    history: row.history.map((entry) => ({
      action: entry.action,
      note: entry.note,
      created_at: entry.created_at,
      ...(actor.role === 'ADMIN' ? { actor_id: entry.actor_id } : {}),
    })),
  };
}

/** Resolution notifies the actual reporter; legacy rows fall back to customer_id. */
export async function resolve(actor: User, complaintId: string, raw: unknown): Promise<void> {
  const { resolution } = z.object({ resolution: z.string().trim().min(3).max(1000) }).parse(raw);
  await transaction(async (db) => {
    const complaint = await complaints.resolve(complaintId, resolution, actor.id, db);
    check(complaint, 409, 'INVALID_COMPLAINT', 'Complaint not found or already resolved.');
    await audits.audit(actor.id, 'COMPLAINT_RESOLVED', complaint.id, { resolution }, db, {
      resourceType: 'COMPLAINT',
      outcome: 'SUCCESS',
    });
    const recipient = complaint.reporter_id ?? complaint.customer_id;
    if (recipient)
      await notify(db, recipient, 'COMPLAINT_RESOLVED', {
        orderId: complaint.order_id,
        complaintId: complaint.id,
        resolution,
      });
  });
}
