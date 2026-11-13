import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { transaction, type DB } from '../../../shared/db.js';
import { requireActor } from '../../../shared/authz.js';
import { check } from '../../../shared/errors.js';
import { imageSchema, linesSchema } from '../domain/catalog.schemas.js';
import { isOpenAt, openingScheduleSchema } from '../domain/opening-schedule.js';
import type { User } from '../../../shared/types.js';
import * as audits from '../../../shared/audit.repository.js';
import * as menu from '../infrastructure/menu.repository.js';
import * as restaurants from '../infrastructure/restaurant.repository.js';
import {
  deliveryAddressForActor,
  forgetRestaurantQuotes,
  noAddressInfo,
  type DeliveryInfo,
} from '../../location/index.js';
import { deliveryInfoForRestaurant } from './restaurant-location.js';
import * as listing from '../infrastructure/restaurant-listing.projection.js';
import { adjustLocked, ensureOpeningBalance, moveStock } from './inventory.service.js';
import { assertMember } from './authorization.service.js';
export { assertMember } from './authorization.service.js';

/**
 * Hide retired provider columns from public responses. The columns stay in the
 * database (no destructive migration), but no client should depend on them.
 */
function publicRestaurant(row: any): any {
  const {
    photo_name,
    photo_attribution,
    photo_verified_food,
    places_synced_at,
    google_place_id,
    google_maps_uri,
    google_primary_type,
    google_business_status,
    ...restaurant
  } = row;
  return restaurant;
}

export const restaurantSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().max(500),
  address: z.string().trim().min(8).max(300),
  cuisine: z.string().min(2).max(60),
  image: imageSchema.default(''),
  phone: z.string().trim().min(3).max(40).nullable().optional(),
  opening_schedule: openingScheduleSchema.nullable().optional(),
});

/** PATCH accepts any subset; coordinates must be supplied together. */
export const restaurantPatchSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    description: z.string().max(500),
    address: z.string().trim().min(8).max(300),
    cuisine: z.string().min(2).max(60),
    image: imageSchema,
    phone: z.string().trim().min(3).max(40).nullable(),
    opening_schedule: openingScheduleSchema.nullable(),
    accepting_orders: z.boolean(),
    catalog_visible: z.boolean(),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Supply at least one field to update.')
  .refine(
    (value) => (value.latitude === undefined) === (value.longitude === undefined),
    'Latitude and longitude must be supplied together.',
  );

const optionSchema = z.object({
  id: z.string().min(1).max(60),
  name: z.string().min(1).max(80),
  extraPrice: z.number().int().min(0).max(1000000),
});

const optionsSchema = z
  .array(optionSchema)
  .max(10)
  .refine(
    (options) => new Set(options.map((option) => option.id)).size === options.length,
    'Option identifiers must be unique.',
  );

export const itemSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().max(500).default(''),
  price: z.number().int().min(1000).max(10000000),
  stock: z.number().int().min(0).max(100000),
  available: z.boolean(),
  visible: z.boolean().default(true),
  image: imageSchema.default(''),
  category: z.string().trim().min(1).max(60).default('Main dishes'),
  options: optionsSchema.default([]),
});

export const itemPatchSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    description: z.string().max(500),
    price: z.number().int().min(1000).max(10000000),
    stock: z.number().int().min(0).max(100000),
    stockReason: z.string().trim().min(3).max(300),
    idempotencyKey: z.string().min(8).max(120),
    available: z.boolean(),
    visible: z.boolean(),
    image: imageSchema,
    category: z.string().trim().min(1).max(60),
    options: optionsSchema,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Supply at least one field to update.');

const listQuerySchema = z.object({
  q: z.string().max(100).default(''),
  cuisine: z.string().max(60).default(''),
  sort: z.enum(['recommended', 'fee', 'name']).default('recommended'),
});

const orderColumns = {
  recommended: 'created_at',
  fee: 'delivery_fee',
  name: 'name',
} as const;

function lookupBudgetMs(): number {
  return Math.max(1_000, Number(process.env.DELIVERY_LOOKUP_BUDGET_MS || 8_000));
}

/**
 * Catalog requests must never hang because an external router is slow. The
 * underlying cached call may finish later; this request degrades to an
 * explicit "unavailable" entry.
 */
async function boundedDelivery(work: Promise<DeliveryInfo>): Promise<DeliveryInfo> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<DeliveryInfo>((resolve) => {
        timer = setTimeout(
          () => resolve({ ...noAddressInfo(), status: 'UNAVAILABLE', reason: 'LOOKUP_BUDGET' }),
          lookupBudgetMs(),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withDeliveryInfo(
  rows: any[],
  userId: string | undefined,
  includeGeometry: boolean,
): Promise<any[]> {
  const address = await deliveryAddressForActor(userId);
  if (!address) return rows.map((row) => ({ ...row, deliveryInfo: noAddressInfo() }));
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      deliveryInfo: await boundedDelivery(
        deliveryInfoForRestaurant(row, address, { includeGeometry }),
      ),
    })),
  );
}

export async function listRestaurants(raw: unknown, user?: User): Promise<any[]> {
  const query = listQuerySchema.parse(raw);
  const rows = (await listing.search(query, orderColumns[query.sort])).map(publicRestaurant);
  const enriched = await withDeliveryInfo(rows, user?.id, false);
  if (query.sort !== 'recommended') return enriched;
  // The default "recommended" order becomes nearest-first once the customer
  // has a routable address. Unsupported or failed routes stay visible last.
  const indexed = enriched.map((row, index) => ({ row, index }));
  indexed.sort((a, b) => {
    const aInfo = a.row.deliveryInfo as DeliveryInfo;
    const bInfo = b.row.deliveryInfo as DeliveryInfo;
    const aDistance = aInfo.supported ? (aInfo.distanceMeters as number) : Number.POSITIVE_INFINITY;
    const bDistance = bInfo.supported ? (bInfo.distanceMeters as number) : Number.POSITIVE_INFINITY;
    return aDistance - bDistance || a.index - b.index;
  });
  return indexed.map((entry) => entry.row);
}

export async function shippingQuoteForRestaurant(actor: User, restaurantId: string): Promise<any> {
  const restaurant = await restaurants.findById(restaurantId);
  check(restaurant, 404, 'NOT_FOUND', 'Restaurant not found.');
  const address = await deliveryAddressForActor(actor.id);
  check(address, 400, 'ADDRESS_REQUIRED', 'Add a delivery address in Settings first.');
  return boundedDelivery(deliveryInfoForRestaurant(restaurant, address, { includeGeometry: true }));
}

export async function getRestaurant(actor: User | undefined, restaurantId: string): Promise<any> {
  const restaurant = await restaurants.findById(restaurantId);
  check(restaurant, 404, 'NOT_FOUND', 'Restaurant not found.');
  if (restaurant.status !== 'APPROVED') {
    const privileged = requireActor(actor, 'RESTAURANT', 'ADMIN');
    if (privileged.role !== 'ADMIN') await assertMember(undefined, privileged, restaurant.id);
  }
  const privilegedViewer =
    actor?.role === 'ADMIN' ||
    Boolean(actor && (await restaurants.isMember(actor.id, restaurant.id)));
  if (!restaurant.catalog_visible) {
    check(privilegedViewer, 404, 'NOT_FOUND', 'Restaurant not found.');
  }
  const items = await menu.listByRestaurant(restaurant.id, {
    includeHidden: privilegedViewer,
  });
  const reviews = await listing.listVisibleReviews(restaurant.id);
  const address = await deliveryAddressForActor(actor?.id);
  const deliveryInfo = await boundedDelivery(
    deliveryInfoForRestaurant(restaurant, address, { includeGeometry: true }),
  );
  return { ...publicRestaurant(restaurant), items, reviews, deliveryInfo };
}

/** Public menu for one restaurant; hidden dishes never leave the server. */
export async function listPublicItems(
  actor: User | undefined,
  restaurantId: string,
): Promise<any[]> {
  const restaurant = await restaurants.findById(restaurantId);
  check(restaurant, 404, 'NOT_FOUND', 'Restaurant not found.');
  const privileged =
    actor?.role === 'ADMIN' ||
    Boolean(actor && (await restaurants.isMember(actor.id, restaurantId)));
  if (restaurant.status !== 'APPROVED' || !restaurant.catalog_visible)
    check(privileged, 404, 'NOT_FOUND', 'Restaurant not found.');
  return menu.listByRestaurant(restaurantId, { includeHidden: privileged });
}

export async function getItem(actor: User | undefined, itemId: string): Promise<any> {
  const item = await menu.findById(itemId);
  check(item, 404, 'NOT_FOUND', 'Item not found.');
  if (!item.visible) {
    const privileged =
      actor?.role === 'ADMIN' ||
      Boolean(actor && (await restaurants.isMember(actor.id, item.restaurant_id)));
    check(privileged, 404, 'NOT_FOUND', 'Item not found.');
  }
  return item;
}

export async function createRestaurant(actor: User, raw: unknown): Promise<any> {
  requireActor(actor, 'RESTAURANT');
  const input = restaurantSchema.parse(raw);
  return transaction(async (db) => {
    const row = await restaurants.insert(input, db);
    await restaurants.addMember(actor.id, row.id, db);
    await audits.audit(actor.id, 'RESTAURANT_REGISTERED', row.id, {}, db);
    return row;
  });
}

export async function suspendRestaurant(
  actor: User,
  restaurantId: string,
  raw: unknown,
  correlationId?: string,
): Promise<void> {
  requireActor(actor, 'ADMIN');
  const input = z
    .object({
      reason: z.string().trim().min(3).max(300),
      idempotencyKey: z.string().min(8).max(120),
    })
    .parse(raw);
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const keyHash = digest(input.idempotencyKey);
  const fingerprint = digest(input.reason);
  await transaction(async (db) => {
    const lockKey = `restaurant-suspend:${actor.id}:${restaurantId}:${keyHash}`;
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    const old = await audits.findCommandReceipt(
      actor.id,
      'RESTAURANT_SUSPENDED',
      restaurantId,
      keyHash,
      db,
    );
    if (old) {
      check(
        old.fingerprint === fingerprint,
        409,
        'IDEMPOTENCY_CONFLICT',
        'This key was already used with different details.',
      );
      return;
    }
    const row = await restaurants.archive(restaurantId, db);
    check(row, 404, 'NOT_FOUND', 'Restaurant not found.');
    await audits.audit(
      actor.id,
      'RESTAURANT_SUSPENDED',
      restaurantId,
      { reason: input.reason, keyHash, fingerprint },
      db,
      { resourceType: 'RESTAURANT', outcome: 'SUCCESS', correlationId },
    );
  });
  await forgetRestaurantQuotes(restaurantId);
}

export async function updateRestaurant(
  actor: User,
  restaurantId: string,
  raw: unknown,
): Promise<any> {
  const input = restaurantPatchSchema.parse(raw);
  const row = await transaction(async (db) => {
    await assertMember(db, actor, restaurantId);
    const updated = await restaurants.updatePartial(restaurantId, input, db);
    check(updated, 404, 'NOT_FOUND', 'Restaurant not found.');
    await audits.audit(
      actor.id,
      'RESTAURANT_UPDATED',
      restaurantId,
      {
        fields: Object.keys(input),
      },
      db,
    );
    return updated;
  });
  // A profile write may move the kitchen or change what it sells; its price
  // snapshots can no longer be trusted.
  await forgetRestaurantQuotes(restaurantId);
  return publicRestaurant(row);
}

/** Soft archive: hides the kitchen and stops orders without deleting history. */
export async function archiveRestaurant(actor: User, restaurantId: string): Promise<void> {
  await transaction(async (db) => {
    const row = await restaurants.findById(restaurantId, db);
    check(row, 404, 'NOT_FOUND', 'Restaurant not found.');
    await assertMember(db, actor, restaurantId);
    await restaurants.archive(restaurantId, db);
    await audits.audit(actor.id, 'RESTAURANT_ARCHIVED', restaurantId, {}, db);
  });
  await forgetRestaurantQuotes(restaurantId);
}

export async function listManaged(actor: User): Promise<any[]> {
  return restaurants.listForManager(actor.role, actor.id);
}

export async function createItem(actor: User, restaurantId: string, raw: unknown): Promise<any> {
  const input = itemSchema.parse(raw);
  return transaction(async (db) => {
    await assertMember(db, actor, restaurantId);
    const category = await menu.upsertMenu(restaurantId, input.category, db);
    const row = await menu.insert(
      {
        restaurantId,
        menuId: category.id,
        name: input.name,
        description: input.description,
        price: input.price,
        stock: input.stock,
        available: input.available,
        visible: input.visible,
        image: input.image,
        options: input.options,
      },
      db,
    );
    await ensureOpeningBalance(db, row.id);
    await audits.audit(actor.id, 'ITEM_CREATED', row.id, {}, db);
    return { ...row, category: category.name };
  });
}

export async function updateItem(actor: User, itemId: string, raw: unknown): Promise<any> {
  const input = itemPatchSchema.parse(raw);
  return transaction(async (db) => {
    const old = await menu.findForUpdate(itemId, db);
    check(old, 404, 'NOT_FOUND', 'Item not found.');
    await assertMember(db, actor, old.restaurant_id);
    check(
      input.stock !== undefined || (!input.stockReason && !input.idempotencyKey),
      400,
      'STOCK_ADJUSTMENT_REQUIRED',
      'Stock metadata requires a stock value.',
    );
    if (
      input.stock !== undefined &&
      (input.stock !== old.stock || input.stockReason || input.idempotencyKey)
    ) {
      check(
        input.stockReason && input.idempotencyKey,
        400,
        'STOCK_ADJUSTMENT_REQUIRED',
        'Changing stock requires a reason and idempotency key.',
      );
      const { stockReason, idempotencyKey, ...fingerprintExtra } = input;
      const result = await adjustLocked(db, actor, old.id, old.stock, {
        target: input.stock,
        reason: stockReason,
        key: idempotencyKey,
        fingerprintExtra,
      });
      if (result.replayed) return old;
    }
    const fields: Omit<Prisma.MenuItemUncheckedUpdateInput, 'stock'> = {};
    for (const key of ['name', 'description', 'price', 'available', 'visible', 'image'])
      if (input[key as keyof typeof input] !== undefined)
        (fields as any)[key] = input[key as keyof typeof input];
    if (input.options !== undefined) fields.options = input.options as Prisma.InputJsonValue;
    let categoryName = old.category;
    if (input.category !== undefined) {
      const category = await menu.upsertMenu(old.restaurant_id, input.category, db);
      fields.menu_id = category.id;
      categoryName = category.name;
    }
    const row = await menu.updatePartial(old.id, fields, db);
    await audits.audit(
      actor.id,
      'ITEM_UPDATED',
      old.id,
      {
        ...(input.price !== undefined ? { oldPrice: old.price, newPrice: input.price } : {}),
        fields: Object.keys(input),
      },
      db,
    );
    return { ...row, category: categoryName };
  });
}

export async function archiveItem(actor: User, itemId: string): Promise<void> {
  await transaction(async (db) => {
    const item = await menu.findForUpdate(itemId, db);
    check(item, 404, 'NOT_FOUND', 'Item not found.');
    await assertMember(db, actor, item.restaurant_id);
    await menu.archive(item.id, db);
    await audits.audit(actor.id, 'ITEM_ARCHIVED', item.id, {}, db);
  });
}

export async function setApproval(
  actor: User,
  restaurantId: string,
  raw: unknown,
  correlationId?: string,
): Promise<void> {
  const { status, reason } = z
    .object({
      status: z.enum(['APPROVED', 'REJECTED']),
      reason: z.string().trim().min(3).max(300).optional(),
    })
    .refine((value) => value.status !== 'REJECTED' || Boolean(value.reason), {
      message: 'Reason is required when rejecting.',
    })
    .parse(raw);
  await transaction(async (db) => {
    const row = await restaurants.setStatus(restaurantId, status, db);
    check(row, 404, 'NOT_FOUND', 'Restaurant not found.');
    await audits.audit(actor.id, 'RESTAURANT_' + status, row.id, reason ? { reason } : {}, db, {
      resourceType: 'RESTAURANT',
      outcome: 'SUCCESS',
      correlationId,
    });
  });
}

export async function priceCart(
  db: DB,
  raw: unknown,
  reserve = false,
  reservation?: { orderId: string; actorId: string },
): Promise<any> {
  check(
    !reserve || reservation,
    500,
    'INVENTORY_CONTEXT_REQUIRED',
    'Reservation context is required.',
  );
  const lines = linesSchema
    .parse(raw)
    .map((line) => ({ ...line, optionIds: [...new Set(line.optionIds)].sort() }))
    .sort(
      (a, b) =>
        a.itemId.localeCompare(b.itemId) || a.optionIds.join().localeCompare(b.optionIds.join()),
    );
  const items: any[] = [];
  let subtotal = 0;
  // Lock restaurant before items; all item locks have a consistent order.
  const first = await menu.findRestaurantIdOfItem(lines[0].itemId, db);
  check(first, 404, 'NOT_FOUND', 'Item not found.');
  const restaurant = reserve
    ? await restaurants.findForShare(first.restaurant_id, db)
    : await restaurants.findById(first.restaurant_id, db);
  check(
    restaurant?.status === 'APPROVED' && restaurant.catalog_visible && restaurant.accepting_orders,
    409,
    'UNAVAILABLE',
    'This restaurant is not accepting orders.',
  );
  const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  check(
    isOpenAt(restaurant.opening_schedule, now),
    409,
    'RESTAURANT_CLOSED',
    'This restaurant is closed at this time.',
  );
  const quantities = new Map<string, number>();
  for (const line of lines)
    quantities.set(line.itemId, (quantities.get(line.itemId) || 0) + line.quantity);
  for (const [itemId, quantity] of quantities) {
    const item = reserve ? await menu.findForUpdate(itemId, db) : await menu.findById(itemId, db);
    check(
      item && item.restaurant_id === restaurant.id,
      409,
      'SINGLE_RESTAURANT',
      'Your basket must contain items from one restaurant.',
    );
    check(item.visible, 409, 'UNAVAILABLE', `${item.name} is no longer available.`);
    check(item.available, 409, 'UNAVAILABLE', `${item.name} is no longer available.`);
    if (!reserve)
      check(
        item.stock >= quantity,
        409,
        'OUT_OF_STOCK',
        `${item.name} has only ${item.stock} servings left.`,
      );
    if (reserve) {
      await moveStock(db, {
        itemId: item.id,
        kind: 'RESERVE',
        delta: -quantity,
        actor: reservation!.actorId,
        reason: 'Order reservation',
        operationKey: `reserve:${reservation!.orderId}`,
        orderId: reservation!.orderId,
      });
    }
    for (const line of lines.filter((candidate) => candidate.itemId === itemId)) {
      const options = line.optionIds.map((optionId) => {
        const option = item.options.find((candidate) => candidate.id === optionId);
        check(option, 409, 'INVALID_OPTION', 'An option is no longer available.');
        return option;
      });
      const price = item.price + options.reduce((sum, option) => sum + option.extraPrice, 0);
      items.push({
        itemId: item.id,
        name: item.name,
        quantity: line.quantity,
        price,
        options,
        image: item.image,
      });
      subtotal += price * line.quantity;
    }
  }
  check(
    subtotal + restaurant.delivery_fee <= 2_000_000_000,
    400,
    'TOTAL_TOO_LARGE',
    'Order total exceeds the supported limit.',
  );
  return {
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    items,
    subtotal,
    deliveryFee: restaurant.delivery_fee,
    total: subtotal + restaurant.delivery_fee,
    currency: 'VND',
  };
}

export async function releaseStock(
  db: DB,
  items: { menu_item_id: string; quantity: number }[],
  orderId: string,
): Promise<void> {
  const quantities = new Map<string, number>();
  for (const item of items)
    quantities.set(item.menu_item_id, (quantities.get(item.menu_item_id) ?? 0) + item.quantity);
  for (const [itemId, quantity] of [...quantities.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    await moveStock(db, {
      itemId,
      kind: 'RELEASE',
      delta: quantity,
      actor: 'system',
      reason: 'Order reservation released',
      operationKey: `release:${orderId}`,
      orderId,
    });
  }
}

/** Back-office view of every restaurant, whatever its approval status. */
export async function listAllRestaurants(): Promise<restaurants.RestaurantRow[]> {
  return restaurants.listAll();
}

export async function restaurantMemberIds(restaurantId: string, db: DB): Promise<string[]> {
  return restaurants.memberUserIds(restaurantId, db);
}
