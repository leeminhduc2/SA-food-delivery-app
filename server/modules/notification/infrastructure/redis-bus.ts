import Redis from 'ioredis';

/**
 * Redis Pub/Sub transport for live notification pushes.
 *
 * Fire-and-forget by design: messages are not stored and not acknowledged.
 * The `notification` table in PostgreSQL remains the source of truth; a
 * client that misses a push replays from the database on reconnect.
 *
 * A subscribing connection cannot run ordinary commands, so publish and
 * subscribe use two separate connections.
 */
export const NOTIFICATION_CHANNEL = 'notifications';

export type NotificationPush = {
  id: string;
  userId: string;
  type: string;
  payload: unknown;
  created_at: string;
};

export type NotificationBus = {
  publish(message: NotificationPush): Promise<void>;
  subscribe(handler: (message: NotificationPush) => void): void;
  close(): Promise<void>;
};

export function createRedisBus(url: string): NotificationBus {
  const publisher = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 1 });
  const subscriber = new Redis(url, { lazyConnect: false });
  const handlers: Array<(message: NotificationPush) => void> = [];
  let subscribed = false;

  // Errors are logged, never thrown into request or worker paths.
  for (const client of [publisher, subscriber])
    client.on('error', (error) => console.error('Redis error', error.message));

  subscriber.on('message', (channel, raw) => {
    if (channel !== NOTIFICATION_CHANNEL) return;
    let message: NotificationPush;
    try {
      message = JSON.parse(raw) as NotificationPush;
    } catch {
      return;
    }
    for (const handler of handlers) handler(message);
  });

  return {
    async publish(message) {
      await publisher.publish(NOTIFICATION_CHANNEL, JSON.stringify(message));
    },
    subscribe(handler) {
      handlers.push(handler);
      // ioredis re-subscribes automatically after a reconnect.
      if (!subscribed) {
        subscribed = true;
        void subscriber.subscribe(NOTIFICATION_CHANNEL);
      }
    },
    async close() {
      await Promise.allSettled([publisher.quit(), subscriber.quit()]);
    },
  };
}
