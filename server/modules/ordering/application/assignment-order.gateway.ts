import type { AssignmentOrderGateway } from '../../assignment/index.js';
import { assignmentContext } from '../infrastructure/assignment-order.projection.js';
import * as orders from '../infrastructure/order.repository.js';
export const assignmentOrderGateway: AssignmentOrderGateway = {
  context: assignmentContext,
  async lockOrder(orderId, db) {
    return orders.findById(orderId, db, true);
  },
};
