import { z } from 'zod';
import { transaction } from '../../shared/db.js';
import { check } from '../../shared/errors.js';
import type { User } from '../../shared/types.js';
import * as audits from '../../shared/audit.repository.js';
import { listAllRestaurants } from '../catalog/index.js';
import { listUsers, setAccountActive } from '../identity/index.js';
import { outboxHealth } from '../notification/index.js';
import { listReconciliationQueue } from '../payment/index.js';
import { listRecent as listRecentReviews } from '../review/index.js';

export async function overview(): Promise<any> {
  return {
    restaurants: await listAllRestaurants(),
    users: await listUsers(),
    audit: await audits.listRecent(),
    reviews: await listRecentReviews(),
    reconciliation: await listReconciliationQueue(),
    outbox: await outboxHealth(),
  };
}

export async function setUserActive(
  actor: User,
  userId: string,
  raw: unknown,
  correlationId?: string,
): Promise<void> {
  const { active, reason } = z
    .object({ active: z.boolean(), reason: z.string().trim().min(3).max(300) })
    .parse(raw);
  check(userId !== actor.id, 409, 'SELF_CHANGE', 'You cannot disable your own account.');
  await transaction(async (db) => {
    const target = await setAccountActive(userId, active, db);
    check(target, 404, 'NOT_FOUND', 'Account not found.');
    await audits.audit(actor.id, 'ACCOUNT_STATUS', target.id, { active, reason }, db, {
      resourceType: 'USER',
      outcome: 'SUCCESS',
      correlationId,
    });
  });
}
