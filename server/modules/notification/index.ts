/** Notification module public API. Other modules import only from this file. */
export { notificationRoutes } from './notification.routes.js';
export { deliverNotifications, notify, outboxHealth } from './notification.service.js';
