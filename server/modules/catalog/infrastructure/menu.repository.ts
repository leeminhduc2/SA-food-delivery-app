import { id, lockRow, prisma, type DB } from '../../../shared/db.js';
import type { Prisma } from '@prisma/client';
import { inventoryConfig } from '../config.js';

export type MenuItemRow = {
  id: string;
  restaurant_id: string;
  menu_id: string;
  name: string;
  description: string;
  price: number;
  image: string;
  available: boolean;
  visible: boolean;
  stock: number;
  low_stock_threshold?: number | null;
  options: { id: string; name: string; extraPrice: number }[];
  category?: string;
};

function withOptions(
  row: {
    options: Prisma.JsonValue;
  } & Omit<MenuItemRow, 'options'>,
): MenuItemRow {
  return {
    ...row,
    options: row.options as MenuItemRow['options'],
  };
}

export async function listByRestaurant(
  restaurantId: string,
  options: { includeHidden?: boolean } = {},
  db: DB = prisma,
): Promise<any[]> {
  const rows = await db.menuItem.findMany({
    where: {
      restaurant_id: restaurantId,
      ...(options.includeHidden ? {} : { visible: true }),
    },
    include: { menu: { select: { name: true } } },
    orderBy: [{ menu: { name: 'asc' } }, { name: 'asc' }],
  });
  const thresholds = await db.$queryRaw<
    Array<{ id: string; low_stock_threshold: number }>
  >`SELECT id, COALESCE(low_stock_threshold, ${inventoryConfig.LOW_STOCK_THRESHOLD}::integer) AS low_stock_threshold FROM menu_items WHERE restaurant_id = ${restaurantId}`;
  const byId = new Map(thresholds.map((row) => [row.id, row.low_stock_threshold]));
  return rows.map(({ menu, ...item }) => ({
    ...withOptions(item),
    low_stock_threshold: byId.get(item.id) ?? inventoryConfig.LOW_STOCK_THRESHOLD,
    category: menu.name,
  }));
}

export async function findById(itemId: string, db: DB = prisma): Promise<MenuItemRow | undefined> {
  const row = await db.menuItem.findUnique({
    where: { id: itemId },
    include: { menu: { select: { name: true } } },
  });
  if (!row) return undefined;
  const { menu, ...item } = row;
  const thresholds = await db.$queryRaw<
    Array<{ low_stock_threshold: number }>
  >`SELECT COALESCE(low_stock_threshold, ${inventoryConfig.LOW_STOCK_THRESHOLD}::integer) AS low_stock_threshold FROM menu_items WHERE id = ${itemId}`;
  return {
    ...withOptions(item),
    low_stock_threshold: thresholds[0].low_stock_threshold,
    category: menu.name,
  };
}

export async function findForUpdate(
  itemId: string,
  db: DB = prisma,
): Promise<MenuItemRow | undefined> {
  await lockRow(db, 'menu_items', 'id', itemId);
  return findById(itemId, db);
}

export async function findRestaurantIdOfItem(
  itemId: string,
  db: DB = prisma,
): Promise<{ restaurant_id: string } | undefined> {
  return (
    (await db.menuItem.findUnique({
      where: { id: itemId },
      select: { restaurant_id: true },
    })) ?? undefined
  );
}

export async function upsertMenu(
  restaurantId: string,
  name: string,
  db: DB = prisma,
): Promise<{ id: string; name: string }> {
  const rows = await db.$queryRaw<Array<{ id: string; name: string }>>`
    INSERT INTO menus (id, restaurant_id, name) VALUES (${id()}, ${restaurantId}, ${name.trim()})
    ON CONFLICT (restaurant_id, (lower(btrim(name)))) DO UPDATE SET name = menus.name
    RETURNING id, name`;
  return rows[0];
}

export type SeededMenuGroup = {
  name: string;
  items: {
    id: string;
    name: string;
    description: string;
    price: number;
    image: string;
    available: boolean;
    stock: number;
    options: unknown;
  }[];
};

/**
 * Create missing menu groups and items without updating or deleting existing
 * rows. Deterministic item ids make repeated demo imports idempotent, and
 * `skipDuplicates` protects any item a user edited later.
 */
export async function ensureSeededMenus(
  restaurantId: string,
  groups: SeededMenuGroup[],
  db: DB = prisma,
): Promise<{ menus: number; itemsCreated: number }> {
  let itemsCreated = 0;
  for (const group of groups) {
    const menu = await upsertMenu(restaurantId, group.name, db);
    const result = await db.menuItem.createMany({
      data: group.items.map((item) => ({
        id: item.id,
        restaurant_id: restaurantId,
        menu_id: menu.id,
        name: item.name,
        description: item.description,
        price: item.price,
        image: item.image,
        available: item.available,
        stock: item.stock,
        options: item.options as Prisma.InputJsonValue,
      })),
      skipDuplicates: true,
    });
    itemsCreated += result.count;
  }
  return { menus: groups.length, itemsCreated };
}

export async function insert(
  item: {
    restaurantId: string;
    menuId: string;
    name: string;
    description: string;
    price: number;
    stock: number;
    available: boolean;
    visible: boolean;
    image: string;
    options: unknown;
  },
  db: DB = prisma,
): Promise<MenuItemRow> {
  const row = await db.menuItem.create({
    data: {
      id: id(),
      restaurant_id: item.restaurantId,
      menu_id: item.menuId,
      name: item.name,
      description: item.description,
      price: item.price,
      stock: item.stock,
      available: item.available,
      visible: item.visible,
      image: item.image,
      options: item.options as Prisma.InputJsonValue,
    },
  });
  return withOptions(row);
}

/** Partial update used by PATCH; only supplied fields are written. */
export async function updatePartial(
  itemId: string,
  fields: Omit<Prisma.MenuItemUncheckedUpdateInput, 'stock'>,
  db: DB = prisma,
): Promise<MenuItemRow> {
  const row = await db.menuItem.update({ where: { id: itemId }, data: fields });
  return withOptions(row);
}

export async function archive(itemId: string, db: DB = prisma): Promise<void> {
  await db.menuItem.updateMany({
    where: { id: itemId },
    data: { available: false, visible: false },
  });
}
