import { id, lockRow, prisma, type DB } from '../shared/db.js';
import type { Prisma } from '@prisma/client';

export type RestaurantRow = {
  id: string;
  name: string;
  description: string;
  address: string;
  cuisine: string;
  image: string;
  status: string;
  delivery_fee: number;
  eta_minutes: number;
  approved_at: Date | string | null;
  created_at: Date | string;
  source: string;
  verified: boolean;
  owner_managed: boolean;
  osm_type: string | null;
  osm_id: string | null;
  latitude: number | null;
  longitude: number | null;
  phone: string | null;
  website: string | null;
  opening_hours: string | null;
  address_tags: Prisma.JsonValue;
  osm_tags: Prisma.JsonValue;
  imported_at: Date | string | null;
  last_synced_at: Date | string | null;
  catalog_visible: boolean;
  geocoded_address: string | null;
  geocoded_at: Date | string | null;
  slug: string | null;
  district: string | null;
  mock: boolean;
  rating: number | null;
  review_count: number;
  google_place_id: string | null;
  google_maps_uri: string | null;
  google_primary_type: string | null;
  google_business_status: string | null;
  photo_name: string | null;
  photo_attribution: Prisma.JsonValue;
  photo_verified_food: boolean;
  places_synced_at: Date | string | null;
};

export async function search(
  query: { q: string; cuisine: string },
  orderColumn: string,
  db: DB = prisma,
): Promise<any[]> {
  const where: Prisma.RestaurantWhereInput = { status: 'APPROVED', catalog_visible: true };
  if (query.cuisine) where.cuisine = query.cuisine;
  if (query.q)
    where.OR = [
      { name: { contains: query.q, mode: 'insensitive' } },
      { cuisine: { contains: query.q, mode: 'insensitive' } },
      {
        items: {
          some: { available: true, name: { contains: query.q, mode: 'insensitive' } },
        },
      },
    ];
  const orderBy: Prisma.RestaurantOrderByWithRelationInput =
    orderColumn === 'delivery_fee'
      ? { delivery_fee: 'asc' }
      : orderColumn === 'name'
        ? { name: 'asc' }
        : { created_at: 'asc' };
  const rows = await db.restaurant.findMany({
    where,
    orderBy,
    take: 100,
    include: { reviews: { where: { hidden: false }, select: { rating: true } } },
  });
  return rows.map(({ reviews, ...restaurant }) => {
    // Real reviews always win. Mock listings carry a simulated rating only
    // because their review count is part of the demo dataset.
    const realRating =
      reviews.length > 0
        ? Math.round(
            (reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length) * 10,
          ) / 10
        : null;
    return {
      ...restaurant,
      rating: realRating ?? restaurant.rating ?? null,
      review_count: reviews.length || restaurant.review_count,
    };
  });
}

export async function findById(
  restaurantId: string,
  db: DB = prisma,
): Promise<RestaurantRow | undefined> {
  return (
    ((await db.restaurant.findUnique({ where: { id: restaurantId } })) as RestaurantRow | null) ??
    undefined
  );
}

export async function findForShare(
  restaurantId: string,
  db: DB = prisma,
): Promise<RestaurantRow | undefined> {
  await lockRow(db, 'restaurants', 'id', restaurantId, 'SHARE');
  return findById(restaurantId, db);
}

export async function listForManager(
  role: string,
  userId: string,
  db: DB = prisma,
): Promise<RestaurantRow[]> {
  const rows = await db.restaurant.findMany({
    where: role === 'ADMIN' ? {} : { members: { some: { user_id: userId } } },
    orderBy: { name: 'asc' },
  });
  return rows as RestaurantRow[];
}

export async function listAll(db: DB = prisma): Promise<RestaurantRow[]> {
  const rows = await db.restaurant.findMany({ orderBy: { created_at: 'desc' } });
  return rows as RestaurantRow[];
}

export async function insert(
  input: {
    name: string;
    description: string;
    address: string;
    cuisine: string;
    image: string;
  },
  db: DB = prisma,
): Promise<RestaurantRow> {
  const row = await db.restaurant.create({
    data: {
      id: id(),
      name: input.name,
      description: input.description,
      address: input.address,
      cuisine: input.cuisine,
      image: input.image,
    },
  });
  return row as RestaurantRow;
}

export async function update(
  restaurantId: string,
  input: {
    name: string;
    description: string;
    address: string;
    cuisine: string;
    image: string;
  },
  db: DB = prisma,
): Promise<RestaurantRow | undefined> {
  const existing = await findById(restaurantId, db);
  if (!existing) return undefined;
  const addressChanged = existing.address.trim() !== input.address.trim();
  const updated = await db.restaurant.updateMany({
    where: { id: restaurantId },
    data: {
      ...input,
      owner_managed: true,
      // A changed address invalidates the previous route origin. Coordinates
      // are resolved lazily from the new address; the address itself is never
      // overwritten by a failed lookup.
      ...(addressChanged
        ? { latitude: null, longitude: null, geocoded_address: null, geocoded_at: null }
        : {}),
    },
  });
  if (!updated.count) return undefined;
  return findById(restaurantId, db);
}

export async function setCoordinates(
  restaurantId: string,
  address: string,
  latitude: number,
  longitude: number,
  db: DB = prisma,
): Promise<void> {
  await db.restaurant.updateMany({
    where: { id: restaurantId, address },
    data: {
      latitude,
      longitude,
      geocoded_address: address,
      geocoded_at: new Date(),
    },
  });
}

export async function setStatus(
  restaurantId: string,
  status: 'APPROVED' | 'REJECTED',
  db: DB = prisma,
): Promise<{ id: string } | undefined> {
  const updated = await db.restaurant.updateMany({
    where: { id: restaurantId },
    data: {
      status,
      approved_at: status === 'APPROVED' ? new Date() : null,
      ...(status === 'APPROVED' ? { verified: true } : {}),
    },
  });
  return updated.count ? { id: restaurantId } : undefined;
}

export async function isMember(
  userId: string,
  restaurantId: string,
  db: DB = prisma,
): Promise<{ user_id: string } | undefined> {
  return (
    (await db.restaurantMember.findUnique({
      where: { user_id_restaurant_id: { user_id: userId, restaurant_id: restaurantId } },
      select: { user_id: true },
    })) ?? undefined
  );
}

export async function addMember(
  userId: string,
  restaurantId: string,
  db: DB = prisma,
): Promise<void> {
  await db.restaurantMember.create({
    data: { user_id: userId, restaurant_id: restaurantId },
  });
}

export async function listVisibleReviews(restaurantId: string, db: DB = prisma): Promise<any[]> {
  const rows = await db.review.findMany({
    where: { restaurant_id: restaurantId, hidden: false },
    orderBy: { created_at: 'desc' },
    take: 20,
    select: {
      rating: true,
      content: true,
      created_at: true,
      customer: { select: { name: true } },
    },
  });
  return rows.map(({ customer, ...review }) => ({ ...review, name: customer.name }));
}
