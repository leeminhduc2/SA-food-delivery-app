import { prisma, type DB } from '../../../shared/db.js';
/** Named read-only projection: Ordering supplies pickup details without customer data. */
export async function assignmentContext(deliveryId: string, db: DB = prisma) {
  const order = await db.order.findFirst({
    where: { delivery: { is: { id: deliveryId } } },
    select: {
      id: true,
      delivery_fee: true,
      restaurant: { select: { name: true, address: true, latitude: true, longitude: true } },
    },
  });
  if (!order) return null;
  const place = order.restaurant;
  return {
    orderId: order.id,
    deliveryFee: order.delivery_fee,
    pickup:
      place.latitude === null || place.longitude === null
        ? null
        : {
            name: place.name,
            address: place.address,
            latitude: place.latitude,
            longitude: place.longitude,
          },
  };
}
