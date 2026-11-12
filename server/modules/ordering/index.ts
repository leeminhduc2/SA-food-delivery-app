/** Ordering module public API. Other modules import only from this file. */
export { orderRoutes } from './ordering.routes.js';
export { registerOrderingHandlers } from './ordering.handlers.js';
export { accessOrder } from './application/order-queries.js';
export { expireUnpaidOrders } from './application/expire-orders.js';
export { deliveryOrderGateway, paymentOrderGateway } from './application/order-gateways.js';
export { assignmentOrderGateway } from './application/assignment-order.gateway.js';
