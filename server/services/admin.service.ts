import { z } from 'zod';
import { transaction } from '../db.js';
import { check } from '../domain/errors.js';
import type { User } from '../domain/types.js';
import * as audits from '../repositories/audit.repository.js';
import * as payments from '../repositories/payment.repository.js';
import * as restaurants from '../repositories/restaurant.repository.js';
import * as reviews from '../repositories/review.repository.js';
import * as sessions from '../repositories/session.repository.js';
import * as users from '../repositories/user.repository.js';

export async function overview(): Promise<any> {
  return {
    restaurants: await restaurants.listAll(),
    users: await users.listAll(),
    audit: await audits.listRecent(),
    reviews: await reviews.listRecent(),
    reconciliation: await payments.listReconciliationQueue(),
    outbox: await payments.outboxHealth(),
  };
}

export async function setUserActive(actor: User, userId: string, raw: unknown): Promise<void> {
  const { active } = z.object({ active: z.boolean() }).parse(raw);
  check(userId !== actor.id, 409, 'SELF_CHANGE', 'You cannot disable your own account.');
  await transaction(async (db) => {
    const target = await users.setActive(userId, active, db);
    check(target, 404, 'NOT_FOUND', 'Account not found.');
    if (!active) await sessions.deleteByUser(target.id, db);
    await audits.audit(actor.id, 'ACCOUNT_STATUS', target.id, { active }, db);
  });
}
