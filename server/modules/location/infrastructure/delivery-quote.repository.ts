import type { Prisma } from '@prisma/client';
import { id, prisma, type DB } from '../../../shared/db.js';

export type DeliveryQuoteRow = {
  id: string;
  address_id: string;
  restaurant_id: string;
  status: string;
  reason: string | null;
  distance_meters: number | null;
  duration_seconds: number | null;
  shipping_fee: number | null;
  currency: string;
  route_geometry: Prisma.JsonValue | null;
  address_latitude: number;
  address_longitude: number;
  restaurant_latitude: number;
  restaurant_longitude: number;
  pricing_key: string;
  computed_at: Date | string;
  expires_at: Date | string;
};

export type DeliveryQuoteInput = {
  addressId: string;
  restaurantId: string;
  status: 'AVAILABLE' | 'UNSUPPORTED';
  reason: string | null;
  distanceMeters: number | null;
  durationSeconds: number | null;
  shippingFee: number | null;
  currency: string;
  routeGeometry: Prisma.InputJsonValue | null;
  addressLatitude: number;
  addressLongitude: number;
  restaurantLatitude: number;
  restaurantLongitude: number;
  pricingKey: string;
  expiresAt: Date;
};

export async function findOne(
  addressId: string,
  restaurantId: string,
  db: DB = prisma,
): Promise<DeliveryQuoteRow | undefined> {
  return (
    ((await db.deliveryQuote.findUnique({
      where: { address_id_restaurant_id: { address_id: addressId, restaurant_id: restaurantId } },
    })) as DeliveryQuoteRow | null) ?? undefined
  );
}

export async function upsert(input: DeliveryQuoteInput, db: DB = prisma): Promise<void> {
  const data = {
    status: input.status,
    reason: input.reason,
    distance_meters: input.distanceMeters,
    duration_seconds: input.durationSeconds,
    shipping_fee: input.shippingFee,
    currency: input.currency,
    route_geometry: input.routeGeometry as Prisma.InputJsonValue,
    address_latitude: input.addressLatitude,
    address_longitude: input.addressLongitude,
    restaurant_latitude: input.restaurantLatitude,
    restaurant_longitude: input.restaurantLongitude,
    pricing_key: input.pricingKey,
    computed_at: new Date(),
    expires_at: input.expiresAt,
  };
  await db.deliveryQuote.upsert({
    where: {
      address_id_restaurant_id: {
        address_id: input.addressId,
        restaurant_id: input.restaurantId,
      },
    },
    create: {
      id: id(),
      address_id: input.addressId,
      restaurant_id: input.restaurantId,
      ...data,
    },
    update: data,
  });
}

export async function deleteForRestaurant(restaurantId: string, db: DB = prisma): Promise<number> {
  const result = await db.deliveryQuote.deleteMany({ where: { restaurant_id: restaurantId } });
  return result.count;
}

export async function deleteForAddress(addressId: string, db: DB = prisma): Promise<number> {
  const result = await db.deliveryQuote.deleteMany({ where: { address_id: addressId } });
  return result.count;
}
