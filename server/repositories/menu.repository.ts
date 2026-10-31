import { id, lockRow, prisma, type DB } from '../db.js';
import type { Prisma } from '@prisma/client';

export type MenuItemRow = {
  id: string;
  restaurant_id: string;
  menu_id: string;
  name: string;
  description: string;
  price: number;
  image: string;
  available: boolean;
  stock: number;
  options: { id: string; name: string; extraPrice: number }[];
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

export async function listByRestaurant(restaurantId: string, db: DB = prisma): Promise<any[]> {
  const rows = await db.menuItem.findMany({
    where: { restaurant_id: restaurantId },
    include: { menu: { select: { name: true } } },
    orderBy: [{ menu: { name: 'asc' } }, { name: 'asc' }],
  });
  return rows.map(({ menu, ...item }) => ({
    ...withOptions(item),
    category: menu.name,
  }));
}

export async function findById(itemId: string, db: DB = prisma): Promise<MenuItemRow | undefined> {
  const row = await db.menuItem.findUnique({ where: { id: itemId } });
  return row ? withOptions(row) : undefined;
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
): Promise<{ id: string }> {
  return db.menu.upsert({
    where: { restaurant_id_name: { restaurant_id: restaurantId, name } },
    update: { name },
    create: { id: id(), restaurant_id: restaurantId, name },
    select: { id: true },
  });
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
      image: item.image,
      options: item.options as Prisma.InputJsonValue,
    },
  });
  return withOptions(row);
}

export async function update(
  itemId: string,
  item: {
    name: string;
    description: string;
    price: number;
    stock: number;
    available: boolean;
    image: string;
    options: unknown;
    menuId: string;
  },
  db: DB = prisma,
): Promise<MenuItemRow> {
  const row = await db.menuItem.update({
    where: { id: itemId },
    data: {
      name: item.name,
      description: item.description,
      price: item.price,
      stock: item.stock,
      available: item.available,
      image: item.image,
      options: item.options as Prisma.InputJsonValue,
      menu_id: item.menuId,
    },
  });
  return withOptions(row);
}

export async function archive(itemId: string, db: DB = prisma): Promise<void> {
  await db.menuItem.updateMany({ where: { id: itemId }, data: { available: false } });
}

export async function reserve(itemId: string, quantity: number, db: DB = prisma): Promise<void> {
  await db.menuItem.update({
    where: { id: itemId },
    data: { stock: { decrement: quantity } },
  });
}

export async function release(itemId: string, quantity: number, db: DB = prisma): Promise<void> {
  await db.menuItem.update({
    where: { id: itemId },
    data: { stock: { increment: quantity } },
  });
}
