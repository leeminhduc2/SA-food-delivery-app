import { id, lockRow, prisma, type DB } from '../../../shared/db.js';
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
  accepting_orders: boolean;
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

/**
 * Restaurants whose delivery price is worth prefetching for a saved address.
 * Paused kitchens stay visible, so they are included; hidden or unapproved
 * rows are not.
 */
export async function listQuotable(db: DB = prisma): Promise<RestaurantRow[]> {
  const rows = await db.restaurant.findMany({
    where: { status: 'APPROVED', catalog_visible: true },
    orderBy: { id: 'asc' },
  });
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

export type RestaurantPatch = {
  name?: string;
  description?: string;
  address?: string;
  cuisine?: string;
  image?: string;
  accepting_orders?: boolean;
  catalog_visible?: boolean;
  latitude?: number;
  longitude?: number;
};

export async function updatePartial(
  restaurantId: string,
  input: RestaurantPatch,
  db: DB = prisma,
): Promise<RestaurantRow | undefined> {
  const existing = await findById(restaurantId, db);
  if (!existing) return undefined;
  const { latitude, longitude, ...fields } = input;
  const addressChanged =
    fields.address !== undefined && existing.address.trim() !== fields.address.trim();
  const coordinatesGiven = latitude !== undefined || longitude !== undefined;
  const updated = await db.restaurant.updateMany({
    where: { id: restaurantId },
    data: {
      ...fields,
      owner_managed: true,
      ...(coordinatesGiven
        ? {
            latitude: latitude ?? null,
            longitude: longitude ?? null,
            geocoded_address: fields.address ?? existing.address,
            geocoded_at: new Date(),
          }
        : addressChanged
          ? { latitude: null, longitude: null, geocoded_address: null, geocoded_at: null }
          : {}),
    },
  });
  if (!updated.count) return undefined;
  return findById(restaurantId, db);
}

/** Soft archive: the row and its order history survive; discovery stops. */
export async function archive(
  restaurantId: string,
  db: DB = prisma,
): Promise<{ id: string } | undefined> {
  const updated = await db.restaurant.updateMany({
    where: { id: restaurantId },
    data: { catalog_visible: false, accepting_orders: false },
  });
  return updated.count ? { id: restaurantId } : undefined;
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

export async function memberUserIds(restaurantId: string, db: DB = prisma): Promise<string[]> {
  const rows = await db.restaurantMember.findMany({
    where: { restaurant_id: restaurantId },
    select: { user_id: true },
  });
  return rows.map((row) => row.user_id);
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
