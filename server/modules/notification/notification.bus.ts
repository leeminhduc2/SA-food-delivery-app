import {
  createRedisBus,
  type NotificationBus,
  type NotificationPush,
  type TrackingLocation,
} from './infrastructure/redis-bus.js';

/**
 * Process-wide bus lifecycle. `null` when REDIS_URL is unset: the stream is
 * then disabled and publishing becomes a no-op.
 */
let bus: NotificationBus | null = null;

export function initNotificationBus(onMessage: (message: NotificationPush) => void): void {
  const url = process.env.REDIS_URL;
  if (!url || bus) return;
  bus = createRedisBus(url);
  bus.subscribe(onMessage);
}

export function notificationBus(): NotificationBus | null {
  return bus;
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
