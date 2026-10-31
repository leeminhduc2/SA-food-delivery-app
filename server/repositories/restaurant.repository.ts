import { id, lockRow, prisma, type DB } from '../db.js';
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
};

export async function search(
  query: { q: string; cuisine: string },
  orderColumn: string,
  db: DB = prisma,
): Promise<any[]> {
  const where: Prisma.RestaurantWhereInput = { status: 'APPROVED' };
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
  return rows.map(({ reviews, ...restaurant }) => ({
    ...restaurant,
    rating: reviews.length
      ? Math.round(
          (reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length) * 10,
        ) / 10
      : null,
    review_count: reviews.length,
  }));
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
  const updated = await db.restaurant.updateMany({
    where: { id: restaurantId },
    data: { ...input, owner_managed: true },
  });
  if (!updated.count) return undefined;
  return findById(restaurantId, db);
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
