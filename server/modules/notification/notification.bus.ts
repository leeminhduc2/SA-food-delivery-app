import {
  createRedisBus,
  type NotificationBus,
  type NotificationPush,
  type RedisHealth,
  type TrackingLocation,
} from './infrastructure/redis-bus.js';

/**
 * Process-wide bus lifecycle. `null` when REDIS_URL is unset: the stream is
 * then disabled and publishing becomes a no-op.
 */
let bus: NotificationBus | null = null;

/**
 * `create` is a test seam for an in-memory bus; production always passes the
 * real Redis factory. Without a URL the real factory is skipped so Redis stays
 * optional.
 */
export function initNotificationBus(
  onMessage: (message: NotificationPush) => void,
  create: (url: string) => NotificationBus = createRedisBus,
): void {
  if (bus) return;
  const url = process.env.REDIS_URL ?? '';
  if (!url && create === createRedisBus) return;
  bus = create(url);
  bus.subscribe(onMessage);
}

export function notificationBus(): NotificationBus | null {
  return bus;
}

/** Statuses of the in-memory clients; `null` means Redis is not configured. */
export function redisHealth(): RedisHealth | null {
  return bus?.health() ?? null;
}

export type TrackingTransport = Pick<
  NotificationBus,
  'publishLocation' | 'readLocation' | 'subscribeLocations' | 'trackingReady'
>;
export type { TrackingLocation };
export function trackingTransport(): TrackingTransport | null {
  return bus;
}

export async function closeNotificationBus(): Promise<void> {
  const current = bus;
  bus = null;
  await current?.close();
}
