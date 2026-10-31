import { transaction, type DB } from '../db.js';
import type { User } from '../domain/types.js';
import * as notifications from '../repositories/notification.repository.js';

/** Queue an in-app notification inside the caller's business transaction. */
export async function notify(
  db: DB,
  userId: string,
  type: string,
  payload: unknown,
): Promise<void> {
  await notifications.enqueue(userId, type, payload, db);
}

export async function inbox(actor: User): Promise<any[]> {
  return notifications.listInbox(actor.id);
}

export async function markRead(actor: User): Promise<void> {
  await notifications.markRead(actor.id);
}

/** Worker entry point: drain the transactional outbox. */
export async function deliverNotifications(): Promise<number> {
  return transaction(async (db) => {
    const events = await notifications.claimEvents(db);
    for (const event of events) await notifications.deliverEvent(event, db);
    return events.length;
  });
}
