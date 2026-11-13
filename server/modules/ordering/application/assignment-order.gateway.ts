import type { AssignmentOrderGateway } from '../../assignment/index.js';
import { assignmentContext } from '../infrastructure/assignment-order.projection.js';
import * as orders from '../infrastructure/order.repository.js';
import { notifyOnce } from '../../notification/index.js';
import { restaurantRecipients } from './notification-recipients.js';
export const assignmentOrderGateway: AssignmentOrderGateway = {
  context: assignmentContext,
  async lockOrder(orderId, db) {
    return orders.findById(orderId, db, true);
  },
  async notifyAssigned(orderId, assignmentId, db) {
    const order = await orders.findById(orderId, db);
    if (!order) throw new Error('Order missing during assignment');
    await notifyOnce(db, order.customer_id, 'ORDER_DRIVER_ASSIGNED', { orderId }, assignmentId);
    for (const memberId of await restaurantRecipients(order.restaurant_id, db))
      await notifyOnce(db, memberId, 'RESTAURANT_DRIVER_ASSIGNED', { orderId }, assignmentId);
  },
  async notifyRevoked(orderId, workId, db) {
    const order = await orders.findById(orderId, db);
    if (!order) throw new Error('Order missing during assignment revocation');
    await notifyOnce(db, order.customer_id, 'ORDER_DRIVER_REVOKED', { orderId }, workId);
    for (const memberId of await restaurantRecipients(order.restaurant_id, db))
      await notifyOnce(db, memberId, 'RESTAURANT_DRIVER_REVOKED', { orderId }, workId);
  },
};
