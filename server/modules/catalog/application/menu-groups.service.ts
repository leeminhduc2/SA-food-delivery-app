import { z } from 'zod';
import { id, prisma, transaction, uniqueViolation } from '../../../shared/db.js';
import { check } from '../../../shared/errors.js';
import type { User } from '../../../shared/types.js';
import * as audits from '../../../shared/audit.repository.js';
import { assertMember } from './authorization.service.js';

const nameSchema = z.object({ name: z.string().trim().min(1).max(60) }).strict();

export async function listGroups(actor: User, restaurantId: string) {
  if (actor.role !== 'ADMIN') await assertMember(undefined, actor, restaurantId);
  return prisma.menu.findMany({
    where: { restaurant_id: restaurantId },
    select: { id: true, restaurant_id: true, name: true, _count: { select: { items: true } } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
}

export async function createGroup(actor: User, restaurantId: string, raw: unknown) {
  const { name } = nameSchema.parse(raw);
  try {
    return await transaction(async (db) => {
      await assertMember(db, actor, restaurantId);
      const row = await db.menu.create({
        data: { id: id(), restaurant_id: restaurantId, name },
        select: { id: true, restaurant_id: true, name: true },
      });
      await audits.audit(actor.id, 'MENU_GROUP_CREATED', row.id, { restaurantId }, db);
      return row;
    });
  } catch (error) {
    if (uniqueViolation(error))
      check(false, 409, 'MENU_NAME_CONFLICT', 'A group with this name already exists.');
    throw error;
  }
}

export async function renameGroup(actor: User, menuId: string, raw: unknown) {
  const { name } = nameSchema.parse(raw);
  try {
    return await transaction(async (db) => {
      const rows = await db.$queryRaw<
        Array<{ id: string; restaurant_id: string; name: string }>
      >`SELECT id, restaurant_id, name FROM menus WHERE id = ${menuId} FOR UPDATE`;
      const old = rows[0];
      check(old, 404, 'NOT_FOUND', 'Menu group not found.');
      await assertMember(db, actor, old.restaurant_id);
      const row = await db.menu.update({
        where: { id: menuId },
        data: { name },
        select: { id: true, restaurant_id: true, name: true },
      });
      await audits.audit(actor.id, 'MENU_GROUP_RENAMED', menuId, { oldName: old.name, name }, db);
      return row;
    });
  } catch (error) {
    if (uniqueViolation(error))
      check(false, 409, 'MENU_NAME_CONFLICT', 'A group with this name already exists.');
    throw error;
  }
}

export async function deleteGroup(actor: User, menuId: string) {
  await transaction(async (db) => {
    const rows = await db.$queryRaw<
      Array<{ id: string; restaurant_id: string }>
    >`SELECT id, restaurant_id FROM menus WHERE id = ${menuId} FOR UPDATE`;
    const row = rows[0];
    check(row, 404, 'NOT_FOUND', 'Menu group not found.');
    await assertMember(db, actor, row.restaurant_id);
    check(
      !(await db.menuItem.count({ where: { menu_id: menuId } })),
      409,
      'MENU_NOT_EMPTY',
      'Move all dishes, including hidden dishes, before deleting this group.',
    );
    await db.menu.delete({ where: { id: menuId } });
    await audits.audit(
      actor.id,
      'MENU_GROUP_DELETED',
      menuId,
      { restaurantId: row.restaurant_id },
      db,
    );
  });
}
