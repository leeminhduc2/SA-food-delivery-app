import { transaction, type DB } from '../../../shared/db.js';
import { check } from '../../../shared/errors.js';
import type { User } from '../../../shared/types.js';
import { assertMember, deliveryInfoForRestaurantId, priceCart } from '../../catalog/index.js';
import { isDriverAssigned } from '../../delivery/index.js';
import { defaultAddressFor, noAddressInfo } from '../../location/index.js';
import * as orders from '../infrastructure/order.repository.js';
import * as projection from '../infrastructure/order-detail.projection.js';

/** Loads an order and checks that the actor may see it. Also used by Review and Support. */
export async function accessOrder(
  db: DB | undefined,
  actor: User,
  orderId: string,
  lock = false,
): Promise<orders.OrderRow> {
  const order = await orders.findById(orderId, db, lock);
  check(order, 404, 'NOT_FOUND', 'Order not found.');
  if (actor.role === 'CUSTOMER')
    check(order.customer_id === actor.id, 403, 'FORBIDDEN', 'You cannot access this order.');
  else if (actor.role === 'RESTAURANT') await assertMember(db, actor, order.restaurant_id);
  else if (actor.role === 'DRIVER')
    check(
      await isDriverAssigned(orderId, actor.id, db),
      403,
      'FORBIDDEN',
      'This delivery is not assigned to you.',
    );
  return order;
}

export async function orderDetail(orderId: string, db?: DB): Promise<any> {
  const row = await projection.detailRow(orderId, db);
  return {
    ...row,
    items: await projection.detailItems(orderId, db),
    payment: await projection.detailPayment(orderId, db),
    delivery: await projection.detailDelivery(orderId, db),
    history: await projection.detailHistory(orderId, db),
    review: await projection.detailReview(orderId, db),
  };
}

export async function list(actor: User): Promise<any[]> {
  const rows = await projection.listVisibleIds(actor.role, actor.id);
  return Promise.all(
    rows.map(async (order) =>
      actor.role === 'DRIVER' ? driverView(await orderDetail(order.id)) : orderDetail(order.id),
    ),
  );
}

export async function detail(actor: User, orderId: string): Promise<any> {
  await accessOrder(undefined, actor, orderId);
  const order = await orderDetail(orderId);
  return actor.role === 'DRIVER' ? driverView(order) : order;
}

function driverView(order: any): any {
  return {
    id: order.id,
    status: order.status,
    restaurant_name: order.restaurant_name,
    pickup: order.pickup,
    created_at: order.created_at,
    delivery_fee: order.delivery_fee,
    total: order.total,
    address: order.address,
    note: order.note,
    items: order.items,
    delivery: order.delivery,
    history: order.history,
    review: null,
  };
}

export async function quote(actor: User, items: unknown): Promise<any> {
  const base = await transaction((db) => priceCart(db, items));
  const address = await defaultAddressFor(actor.id);
  if (!address)
    return {
      ...base,
      deliveryFee: 0,
      total: base.subtotal,
      deliveryInfo: noAddressInfo(),
    };
  const info = await deliveryInfoForRestaurantId(base.restaurantId, address, {
    includeGeometry: true,
  });
  if (!info.supported)
    return {
      ...base,
      deliveryFee: 0,
      total: base.subtotal,
      deliveryInfo: info,
    };
  return {
    ...base,
    deliveryFee: info.shippingFee,
    total: base.subtotal + (info.shippingFee as number),
    deliveryInfo: info,
  };
}
