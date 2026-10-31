import { z } from 'zod';
import { transaction } from '../db.js';
import { check } from '../domain/errors.js';
import type { User } from '../domain/types.js';
import * as audits from '../repositories/audit.repository.js';
import * as complaints from '../repositories/complaint.repository.js';
import { accessOrder } from './order.service.js';
import { notify } from './notification.service.js';

export async function createComplaint(actor: User, orderId: string, raw: unknown): Promise<any> {
  const { content } = z.object({ content: z.string().trim().min(10).max(2000) }).parse(raw);
  await accessOrder(undefined, actor, orderId);
  return complaints.insert({ orderId, customerId: actor.id, content });
}

export async function list(actor: User): Promise<any[]> {
  return complaints.listForActor(actor.role, actor.id);
}

export async function resolve(actor: User, complaintId: string, raw: unknown): Promise<void> {
  const { resolution } = z.object({ resolution: z.string().trim().min(3).max(1000) }).parse(raw);
  await transaction(async (db) => {
    const complaint = await complaints.resolve(complaintId, resolution, db);
    check(complaint, 409, 'INVALID_COMPLAINT', 'Complaint not found or already resolved.');
    await audits.audit(actor.id, 'COMPLAINT_RESOLVED', complaint.id, {}, db);
    await notify(db, complaint.customer_id, 'COMPLAINT_RESOLVED', {
      orderId: complaint.order_id,
      resolution,
    });
  });
}
