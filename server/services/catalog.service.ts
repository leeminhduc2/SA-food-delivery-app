import { z } from 'zod';
import { transaction, type DB } from '../db.js';
import { requireActor } from '../domain/authz.js';
import { check } from '../domain/errors.js';
import { imageSchema, linesSchema } from '../domain/schemas.js';
import type { User } from '../domain/types.js';
import * as audits from '../repositories/audit.repository.js';
import * as menu from '../repositories/menu.repository.js';
import * as restaurants from '../repositories/restaurant.repository.js';

export const restaurantSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().max(500),
  address: z.string().trim().min(8).max(300),
  cuisine: z.string().min(2).max(60),
  image: imageSchema.default(''),
});

export const itemSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().max(500).default(''),
  price: z.number().int().min(1000).max(10000000),
  stock: z.number().int().min(0).max(100000),
  available: z.boolean(),
  image: imageSchema.default(''),
  category: z.string().min(1).max(60).default('Main dishes'),
  options: z
    .array(
      z.object({
        id: z.string().min(1).max(60),
        name: z.string().min(1).max(80),
        extraPrice: z.number().int().min(0).max(1000000),
      }),
    )
    .max(10)
    .refine(
      (options) => new Set(options.map((option) => option.id)).size === options.length,
      'Option identifiers must be unique.',
    )
    .default([]),
});

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

export async function listRestaurants(raw: unknown): Promise<any[]> {
  const query = listQuerySchema.parse(raw);
  return restaurants.search(query, orderColumns[query.sort]);
}

export async function assertMember(
  db: DB | undefined,
  actor: User,
  restaurantId: string,
): Promise<void> {
  check(
    actor.role === 'ADMIN' || (await restaurants.isMember(actor.id, restaurantId, db)),
    403,
    'FORBIDDEN',
    'You do not manage this restaurant.',
  );
}

export async function getRestaurant(actor: User | undefined, restaurantId: string): Promise<any> {
  const restaurant = await restaurants.findById(restaurantId);
  check(restaurant, 404, 'NOT_FOUND', 'Restaurant not found.');
  if (restaurant.status !== 'APPROVED') {
    const privileged = requireActor(actor, 'RESTAURANT', 'ADMIN');
    await assertMember(undefined, privileged, restaurant.id);
  }
  const items = await menu.listByRestaurant(restaurant.id);
  const reviews = await restaurants.listVisibleReviews(restaurant.id);
  return { ...restaurant, items, reviews };
}

export async function createRestaurant(actor: User, raw: unknown): Promise<any> {
  const input = restaurantSchema.parse(raw);
  return transaction(async (db) => {
    const row = await restaurants.insert(input, db);
    await restaurants.addMember(actor.id, row.id, db);
    await audits.audit(actor.id, 'RESTAURANT_REGISTERED', row.id, {}, db);
    return row;
  });
}

export async function updateRestaurant(
  actor: User,
  restaurantId: string,
  raw: unknown,
): Promise<any> {
  const input = restaurantSchema.parse(raw);
  return transaction(async (db) => {
    await assertMember(db, actor, restaurantId);
    const row = await restaurants.update(restaurantId, input, db);
    await audits.audit(actor.id, 'RESTAURANT_UPDATED', restaurantId, {}, db);
    return row;
  });
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
        image: input.image,
        options: input.options,
      },
      db,
    );
    await audits.audit(actor.id, 'ITEM_CREATED', row.id, {}, db);
    return row;
  });
}

export async function updateItem(actor: User, itemId: string, raw: unknown): Promise<any> {
  const input = itemSchema.parse(raw);
  return transaction(async (db) => {
    const old = await menu.findForUpdate(itemId, db);
    check(old, 404, 'NOT_FOUND', 'Item not found.');
    await assertMember(db, actor, old.restaurant_id);
    const category = await menu.upsertMenu(old.restaurant_id, input.category, db);
    const row = await menu.update(
      old.id,
      {
        name: input.name,
        description: input.description,
        price: input.price,
        stock: input.stock,
        available: input.available,
        image: input.image,
        options: input.options,
        menuId: category.id,
      },
      db,
    );
    await audits.audit(
      actor.id,
      'ITEM_UPDATED',
      old.id,
      {
        oldPrice: old.price,
        newPrice: input.price,
      },
      db,
    );
    return row;
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

export async function setApproval(actor: User, restaurantId: string, raw: unknown): Promise<void> {
  const { status } = z.object({ status: z.enum(['APPROVED', 'REJECTED']) }).parse(raw);
  await transaction(async (db) => {
    const row = await restaurants.setStatus(restaurantId, status, db);
    check(row, 404, 'NOT_FOUND', 'Restaurant not found.');
    await audits.audit(actor.id, 'RESTAURANT_' + status, row.id, {}, db);
  });
}

export async function priceCart(db: DB, raw: unknown, reserve = false): Promise<any> {
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
    restaurant?.status === 'APPROVED',
    409,
    'UNAVAILABLE',
    'This restaurant is not accepting orders.',
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
    check(item.available, 409, 'UNAVAILABLE', `${item.name} is no longer available.`);
    check(
      item.stock >= quantity,
      409,
      'OUT_OF_STOCK',
      `${item.name} has only ${item.stock} servings left.`,
    );
    if (reserve) await menu.reserve(item.id, quantity, db);
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
): Promise<void> {
  for (const item of items) await menu.release(item.menu_item_id, item.quantity, db);
}
