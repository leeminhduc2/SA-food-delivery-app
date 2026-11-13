import Redis from 'ioredis';
import { createHash } from 'node:crypto';

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

export type TrackingLocation = {
  driverId: string;
  latitude: number;
  longitude: number;
  capturedAt: string;
  receivedAt: string;
  version: number;
};

export type NotificationBus = {
  publish(message: NotificationPush): Promise<void>;
  subscribe(handler: (message: NotificationPush) => void): void;
  publishLocation(message: TrackingLocation, ttlSeconds: number): Promise<boolean>;
  readLocation(driverId: string): Promise<TrackingLocation | null>;
  subscribeLocations(handler: (message: TrackingLocation) => void): () => void;
  trackingReady(): boolean;
  close(): Promise<void>;
};

/** Stable across processes sharing a DB/schema, without putting credentials in Redis keys. */
export function trackingNamespace(
  databaseUrl = process.env.DATABASE_URL ?? '',
  redisUrl = process.env.REDIS_URL ?? '',
): string {
  const identity = (value: string, schema: boolean) => {
    try {
      const parsed = new URL(value);
      return [
        parsed.hostname,
        parsed.port,
        parsed.pathname,
        schema ? (parsed.searchParams.get('schema') ?? 'public') : '',
      ].join('|');
    } catch {
      return '';
    }
  };
  return createHash('sha256')
    .update(identity(databaseUrl, true) + '|' + identity(redisUrl, false))
    .digest('hex')
    .slice(0, 24);
}

function isTrackingLocation(value: unknown): value is TrackingLocation {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    typeof message.driverId === 'string' &&
    message.driverId.length > 0 &&
    typeof message.latitude === 'number' &&
    Number.isFinite(message.latitude) &&
    Math.abs(message.latitude) <= 90 &&
    typeof message.longitude === 'number' &&
    Number.isFinite(message.longitude) &&
    Math.abs(message.longitude) <= 180 &&
    typeof message.capturedAt === 'string' &&
    Number.isFinite(Date.parse(message.capturedAt)) &&
    new Date(message.capturedAt).toISOString() === message.capturedAt &&
    typeof message.receivedAt === 'string' &&
    Number.isFinite(Date.parse(message.receivedAt)) &&
    new Date(message.receivedAt).toISOString() === message.receivedAt &&
    typeof message.version === 'number' &&
    Number.isSafeInteger(message.version) &&
    message.version > 0
  );
}

export function createRedisBus(
  url: string,
  channel: string | undefined = undefined,
  namespace = trackingNamespace(process.env.DATABASE_URL, url),
): NotificationBus {
  const publisher = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2000,
  });
  const subscriber = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 1 });
  const handlers: Array<(message: NotificationPush) => void> = [];
  const locationHandlers: Array<(message: TrackingLocation) => void> = [];
  const notificationChannel = channel ?? `${NOTIFICATION_CHANNEL}:${namespace}`;
  const trackingChannel = `bep:tracking:${namespace}`;
  const keyFor = (driverId: string) => `${trackingChannel}:latest:${encodeURIComponent(driverId)}`;
  let subscribed = false;
  let trackingSubscribed = false;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  function retrySubscriptions(): void {
    if (closed || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      subscribeNeeded();
    }, 250);
    retryTimer.unref();
  }

  function subscribeNeeded(): void {
    if (handlers.length && !subscribed) {
      subscribed = true;
      void subscriber.subscribe(notificationChannel).catch(() => {
        subscribed = false;
        retrySubscriptions();
      });
    }
    if (locationHandlers.length && !trackingSubscribed) {
      trackingSubscribed = true;
      void subscriber.subscribe(trackingChannel).catch(() => {
        trackingSubscribed = false;
        retrySubscriptions();
      });
    }
  }

  // Errors are logged, never thrown into request or worker paths.
  for (const client of [publisher, subscriber])
    client.on('error', (error) => console.error('Redis error', error.message));
  subscriber.on('ready', subscribeNeeded);

  subscriber.on('message', (receivedChannel, raw) => {
    if (receivedChannel !== notificationChannel && receivedChannel !== trackingChannel) return;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (receivedChannel === trackingChannel) {
      if (isTrackingLocation(message))
        for (const handler of [...locationHandlers]) handler(message);
    } else for (const handler of handlers) handler(message as NotificationPush);
  });

  return {
    async publish(message) {
      await publisher.publish(notificationChannel, JSON.stringify(message));
    },
    subscribe(handler) {
      handlers.push(handler);
      subscribeNeeded();
    },
    async publishLocation(message, ttlSeconds) {
      if (!isTrackingLocation(message) || !Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0)
        throw new Error('Invalid tracking location or TTL');
      const raw = JSON.stringify(message);
      const result = await publisher.eval(
        `
        local existing = redis.call('GET', KEYS[1])
        if existing then
          local ok, previous = pcall(cjson.decode, existing)
          if ok and type(previous) == 'table' and type(previous.receivedAt) == 'string' and type(previous.version) == 'number' then
            if previous.receivedAt > ARGV[2] or (previous.receivedAt == ARGV[2] and previous.version >= tonumber(ARGV[3])) then return 0 end
          end
        end
        redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[4])
        redis.call('PUBLISH', KEYS[2], ARGV[1])
        return 1`,
        2,
        keyFor(message.driverId),
        trackingChannel,
        raw,
        message.receivedAt,
        message.version,
        ttlSeconds,
      );
      return result === 1;
    },
    async readLocation(driverId) {
      const raw = await publisher.get(keyFor(driverId));
      if (!raw) return null;
      try {
        const message: unknown = JSON.parse(raw);
        return isTrackingLocation(message) && message.driverId === driverId ? message : null;
      } catch {
        return null;
      }
    },
    subscribeLocations(handler) {
      locationHandlers.push(handler);
      subscribeNeeded();
      return () => {
        const index = locationHandlers.indexOf(handler);
        if (index !== -1) locationHandlers.splice(index, 1);
      };
    },
    trackingReady() {
      return publisher.status === 'ready' && subscriber.status === 'ready';
    },
    async close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      publisher.disconnect();
      subscriber.disconnect();
    },
  };
}
