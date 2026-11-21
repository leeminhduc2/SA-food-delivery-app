/** Notification module public API. Other modules import only from this file. */
export { notificationRoutes } from './notification.routes.js';
export { deliverNotifications, notify, notifyOnce, outboxHealth } from './notification.service.js';
export {
  closeNotificationBus,
  initNotificationBus,
  redisHealth,
  trackingTransport,
  type TrackingTransport,
  type TrackingLocation,
} from './notification.bus.js';
export type { RedisConnectionStatus, RedisHealth } from './infrastructure/redis-bus.js';
export { closeAllStreams, dispatchPush } from './notification.stream.js';
