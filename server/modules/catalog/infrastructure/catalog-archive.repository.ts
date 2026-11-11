/**
 * Read and reversible write helpers for retiring the legacy OSM/demo rows from
 * the public listing. Nothing here deletes a row. Orders, order items, cart
 * lines, reviews, menus and menu items stay untouched so history remains
 * readable. Rows created by real users after the demo seed are not touched.
 */
import { id, prisma, type DB } from '../../../shared/db.js';

// Kept here rather than imported from the seed dataset: runtime code must not
// depend on demo fixtures (see tests/mock-catalog.test.ts).
const LEGACY_DEMO_RESTAURANT_IDS = ['saigon', 'pizza', 'green'] as const;

export type LegacyImpact = {
  total: number;
  osm: number;
  manual: number;
  visible: number;
  hidden: number;
  withOrders: number;
  withReviews: number;
  withMembers: number;
  withMenus: number;
  withMenuItems: number;
  cartLines: number;
};

const legacyIds = LEGACY_DEMO_RESTAURANT_IDS.map((value) => `'${value}'`).join(',');
const legacyPredicate = `
  restaurants.mock = false
  AND (restaurants.source = 'OSM' OR restaurants.id IN (${legacyIds}))
`;

async function scalar(db: DB, sql: string, ...values: unknown[]): Promise<number> {
  const rows = await db.$queryRawUnsafe<{ n: number }[]>(sql, ...values);
  return Number(rows[0]?.n ?? 0);
}

export async function legacyImpact(db: DB = prisma): Promise<LegacyImpact> {
  const total = await scalar(
    db,
    `SELECT count(*)::int AS n FROM restaurants WHERE ${legacyPredicate}`,
  );
  const visible = await scalar(
    db,
    `SELECT count(*)::int AS n FROM restaurants WHERE ${legacyPredicate} AND catalog_visible`,
  );
  const osm = await scalar(
    db,
    `SELECT count(*)::int AS n FROM restaurants WHERE ${legacyPredicate} AND source='OSM'`,
  );
  const withOrders = await scalar(
    db,
    `SELECT count(DISTINCT orders.restaurant_id)::int AS n
       FROM orders JOIN restaurants ON restaurants.id=orders.restaurant_id
      WHERE ${legacyPredicate}`,
  );
  const withReviews = await scalar(
    db,
    `SELECT count(DISTINCT reviews.restaurant_id)::int AS n
       FROM reviews JOIN restaurants ON restaurants.id=reviews.restaurant_id
      WHERE ${legacyPredicate}`,
  );
  const withMembers = await scalar(
    db,
    `SELECT count(DISTINCT restaurant_members.restaurant_id)::int AS n
       FROM restaurant_members JOIN restaurants ON restaurants.id=restaurant_members.restaurant_id
      WHERE ${legacyPredicate}`,
  );
  const withMenus = await scalar(
    db,
    `SELECT count(DISTINCT menus.restaurant_id)::int AS n
       FROM menus JOIN restaurants ON restaurants.id=menus.restaurant_id
      WHERE ${legacyPredicate}`,
  );
  const withMenuItems = await scalar(
    db,
    `SELECT count(DISTINCT menu_items.restaurant_id)::int AS n
       FROM menu_items JOIN restaurants ON restaurants.id=menu_items.restaurant_id
      WHERE ${legacyPredicate}`,
  );
  const cartLines = await scalar(
    db,
    `SELECT count(*)::int AS n
       FROM carts, jsonb_array_elements(carts.items) AS line
       JOIN menu_items ON menu_items.id = line->>'itemId'
       JOIN restaurants ON restaurants.id = menu_items.restaurant_id
      WHERE ${legacyPredicate}`,
  );
  return {
    total,
    osm,
    manual: total - osm,
    visible,
    hidden: total - visible,
    withOrders,
    withReviews,
    withMembers,
    withMenus,
    withMenuItems,
    cartLines,
  };
}

/** Soft-hide every legacy catalog row. Reversible with `restoreLegacy`. */
export async function hideLegacy(db: DB = prisma): Promise<number> {
  const result = await db.$executeRawUnsafe(
    `UPDATE restaurants SET catalog_visible=false
      WHERE ${legacyPredicate} AND catalog_visible`,
  );
  return Number(result);
}

/** Re-show every legacy catalog row. */
export async function restoreLegacy(db: DB = prisma): Promise<number> {
  const result = await db.$executeRawUnsafe(
    `UPDATE restaurants SET catalog_visible=true
      WHERE ${legacyPredicate} AND NOT catalog_visible`,
  );
  return Number(result);
}

export async function auditLegacyChange(
  actor: string,
  action: 'LEGACY_CATALOG_HIDDEN' | 'LEGACY_CATALOG_RESTORED',
  affected: number,
  db: DB = prisma,
): Promise<void> {
  await db.auditLog.create({
    data: {
      id: id(),
      actor,
      action,
      resource_id: 'catalog',
      detail: { affected, reversible: true, deleted: 0 },
    },
  });
}
