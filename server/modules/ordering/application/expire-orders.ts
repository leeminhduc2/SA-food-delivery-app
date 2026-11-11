import { transaction } from '../../../shared/db.js';
import { cancelPayment } from '../../payment/index.js';
import { isAwaitingPayment } from '../domain/order-status.js';
import * as orders from '../infrastructure/order.repository.js';
import { failUnpaidOrder } from './order-lifecycle.js';

/**
 * Worker step: releases reservations of orders whose payment window closed,
 * even when the provider is unreachable. A later success is reconciled to a refund.
 */
export async function expireUnpaidOrders(limit = 100): Promise<void> {
  const expired = await orders.listExpiredIds(limit);
  for (const entry of expired)
    await transaction(async (db) => {
      const order = await orders.findById(entry.id, db, true);
      if (order && isAwaitingPayment(order.status)) {
        await cancelPayment(db, order.id, 'worker');
        await failUnpaidOrder(db, order, 'worker', 'Payment window expired');
      }
    });
}
