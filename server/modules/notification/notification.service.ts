import { transaction, type DB } from '../../shared/db.js';
import type { User } from '../../shared/types.js';
import * as notifications from './notification.repository.js';
import { notificationBus } from './notification.bus.js';

/** Queue an in-app notification inside the caller's business transaction. */
export async function notify(
  db: DB,
  userId: string,
  type: string,
  payload: unknown,
): Promise<void> {
  await notifications.enqueue(userId, type, payload, db);
}

export async function notifyOnce(
  db: DB,
  userId: string,
  type: string,
  payload: unknown,
  businessKey: string,
): Promise<void> {
  await notifications.enqueueOnce(userId, type, payload, businessKey, db);
}

export async function inbox(actor: User): Promise<any[]> {
  return notifications.listInbox(actor.id);
}

/** Stream reconnect: notifications the client missed after its last event id. */
export async function replaySince(userId: string, cursorId: string): Promise<any[] | null> {
  return notifications.listAfter(userId, cursorId, 100);
}

export async function markRead(actor: User): Promise<void> {
  await notifications.markRead(actor.id);
}

/**
 * Worker entry point: drain the transactional outbox.
 *
 * Live pushes are published only after the transaction commits. A push sent
 * inside the transaction could reach a client before its row is visible.
 */
export async function deliverNotifications(): Promise<number> {
  const delivered = await transaction(async (db) => {
    const events = await notifications.claimEvents(db);
    const done: Array<{ id: string; user_id: string; type: string; payload: unknown }> = [];
    for (const event of events) {
      if (await notifications.deliverEvent(event, db))
        done.push({
          id: event.id,
          user_id: event.user_id,
          type: event.type,
          payload: event.payload,
        });
    }
    return done;
  });
  await publishDelivered(delivered);
  return delivered.length;
}

/** Push delivered events to live clients. Failures never fail delivery: the database is the source of truth. */
async function publishDelivered(
  events: Array<{ id: string; user_id: string; type: string; payload: unknown }>,
): Promise<void> {
  const bus = notificationBus();
  if (!bus) return;
  const createdAt = new Date().toISOString();
  for (const event of events) {
    try {
      await bus.publish({
        id: event.id,
        userId: event.user_id,
        type: event.type,
        payload: event.payload,
        created_at: createdAt,
      });
    } catch (error) {
      console.error('Notification publish failed', error);
    }
  }
}

/** Back-office health figure for the notification outbox. */
export async function outboxHealth(): Promise<{ pending: number; failed: number }> {
  return notifications.outboxHealth();
}
