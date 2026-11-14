import 'dotenv/config';
import type { Prisma } from '@prisma/client';
import { id, prisma, transaction, type DB } from '../shared/db.js';
import { MOCK_MENU_NOTE, MOCK_RESTAURANTS } from './data/mock-catalog.js';
import { OFFICIAL_SOURCE } from './catalog-provision.js';

/**
 * Promote the existing MOCK catalog records to official, system-managed
 * business records **in place**.
 *
 * This is a metadata-only, transactional and idempotent promotion:
 *
 * - It updates only `mock`, `source` (when the row was classified as MOCK) and
 *   the mock/demo markers in `osm_tags`.
 * - Names, descriptions, addresses, coordinates, images, prices, availability,
 *   visibility, ownership and every relationship are left untouched.
 * - `verified` is never changed: promoting a record is not a human
 *   verification, and no restaurant owner is assigned.
 * - It does not insert, delete, truncate or reset anything. A second run
 *   reports zero promoted rows.
 * - If any of the ten expected restaurants or sixty expected menu items is
 *   missing, the run aborts before writing anything (unless `allowMissing` is
 *   explicitly requested).
 */

export const PROMOTION_ACTOR = 'system:catalog-promotion';

export type CatalogPromotionCounts = {
  restaurants: number;
  menuItems: number;
  visibleRestaurants: number;
  mockRestaurants: number;
  mockMenuItems: number;
  catalogRestaurants: number;
  catalogMenuItems: number;
};

export type CatalogPromotionReport = {
  dryRun: boolean;
  ok: boolean;
  before: CatalogPromotionCounts;
  after: CatalogPromotionCounts;
  promoted: { restaurants: number; menuItems: number };
  wouldPromote: { restaurants: number; menuItems: number };
  missing: { restaurants: string[]; menuItems: string[]; menus: string[] };
  relationshipMismatches: string[];
};

/** The canonical ids and relationships this script is allowed to promote. */
const expectedItems = new Map<string, { restaurantId: string; menuId: string }>();
const expectedMenus = new Map<string, string>();
for (const restaurant of MOCK_RESTAURANTS)
  for (const menu of restaurant.menus) {
    const menuId = `${restaurant.id}-${menu.key}`;
    expectedMenus.set(menuId, restaurant.id);
    for (const item of menu.items)
      expectedItems.set(item.id, { restaurantId: restaurant.id, menuId });
  }

export const EXPECTED_RESTAURANT_IDS = MOCK_RESTAURANTS.map((restaurant) => restaurant.id);
export const EXPECTED_MENU_ITEM_IDS = [...expectedItems.keys()];
export const EXPECTED_MENU_IDS = [...expectedMenus.keys()];

/**
 * Remove the demo/mock provenance markers and mark the row as belonging to the
 * system-managed catalog. Returns `changed=false` when the row is already
 * clean, which keeps repeated runs free of writes.
 */
function cleanCatalogTags(raw: Prisma.JsonValue): {
  tags: Record<string, unknown>;
  changed: boolean;
} {
  const source =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const tags = { ...source };
  let changed = false;
  if ('mock' in tags) {
    delete tags.mock;
    changed = true;
  }
  if ('demo' in tags) {
    delete tags.demo;
    changed = true;
  }
  if (tags.note === MOCK_MENU_NOTE) {
    delete tags.note;
    changed = true;
  }
  if (tags.catalog !== true) {
    tags.catalog = true;
    changed = true;
  }
  return { tags, changed };
}

async function counts(db: DB, mockRestaurantIds: string[], mockItemIds: string[]) {
  const [restaurants, menuItems, visibleRestaurants, mockRestaurants, mockMenuItems] =
    await Promise.all([
      db.restaurant.count(),
      db.menuItem.count(),
      db.restaurant.count({ where: { catalog_visible: true } }),
      db.restaurant.count({ where: { id: { in: mockRestaurantIds }, mock: true } }),
      db.menuItem.count({ where: { id: { in: mockItemIds }, mock: true } }),
    ]);
  const [catalogRestaurants, catalogMenuItems] = await Promise.all([
    db.restaurant.count({
      where: { id: { in: mockRestaurantIds }, source: OFFICIAL_SOURCE, mock: false },
    }),
    db.menuItem.count({ where: { id: { in: mockItemIds }, mock: false } }),
  ]);
  return {
    restaurants,
    menuItems,
    visibleRestaurants,
    mockRestaurants,
    mockMenuItems,
    catalogRestaurants,
    catalogMenuItems,
  };
}

export async function promoteCatalog(
  options: { dryRun?: boolean; allowMissing?: boolean } = {},
): Promise<CatalogPromotionReport> {
  const dryRun = options.dryRun === true;

  return transaction(async (db) => {
    const restaurantRows = await db.restaurant.findMany({
      where: { id: { in: EXPECTED_RESTAURANT_IDS } },
      select: { id: true, mock: true, source: true, osm_tags: true },
    });
    const itemRows = await db.menuItem.findMany({
      where: { id: { in: EXPECTED_MENU_ITEM_IDS } },
      select: { id: true, restaurant_id: true, menu_id: true, mock: true },
    });
    const menuRows = await db.menu.findMany({
      where: { id: { in: EXPECTED_MENU_IDS } },
      select: { id: true, restaurant_id: true },
    });

    const foundRestaurants = new Set(restaurantRows.map((row) => row.id));
    const foundItems = new Set(itemRows.map((row) => row.id));
    const foundMenus = new Set(menuRows.map((row) => row.id));

    const missing = {
      restaurants: EXPECTED_RESTAURANT_IDS.filter((id) => !foundRestaurants.has(id)),
      menuItems: EXPECTED_MENU_ITEM_IDS.filter((id) => !foundItems.has(id)),
      menus: EXPECTED_MENU_IDS.filter((id) => !foundMenus.has(id)),
    };
    const missingAny =
      missing.restaurants.length || missing.menuItems.length || missing.menus.length;
    if (missingAny && !options.allowMissing)
      throw new Error(
        'Catalog promotion aborted: expected catalog rows are missing. ' +
          `restaurants=[${missing.restaurants.join(', ')}] ` +
          `menuItems=[${missing.menuItems.join(', ')}] ` +
          `menus=[${missing.menus.join(', ')}]. ` +
          'Run `npm run db:seed:catalog` first, or pass --allow-missing to promote present rows only.',
      );

    const before = await counts(db, EXPECTED_RESTAURANT_IDS, EXPECTED_MENU_ITEM_IDS);

    let promotedRestaurants = 0;
    let wouldPromoteRestaurants = 0;
    for (const row of restaurantRows) {
      const { tags, changed: tagsChanged } = cleanCatalogTags(row.osm_tags);
      const sourceNeedsPromotion = row.source === 'MOCK' || row.mock;
      const needsWork = sourceNeedsPromotion || tagsChanged;
      if (!needsWork) continue;
      wouldPromoteRestaurants++;
      if (dryRun) continue;
      await db.restaurant.update({
        where: { id: row.id },
        data: {
          mock: false,
          ...(sourceNeedsPromotion ? { source: OFFICIAL_SOURCE } : {}),
          ...(tagsChanged ? { osm_tags: tags as Prisma.InputJsonValue } : {}),
        },
      });
      promotedRestaurants++;
    }

    const mockItems = itemRows.filter((row) => row.mock);
    let promotedItems = 0;
    if (!dryRun && mockItems.length) {
      const result = await db.menuItem.updateMany({
        where: { id: { in: mockItems.map((row) => row.id) }, mock: true },
        data: { mock: false },
      });
      promotedItems = result.count;
    }

    const relationshipMismatches: string[] = [];
    for (const row of itemRows) {
      const expected = expectedItems.get(row.id);
      if (!expected) continue;
      if (row.restaurant_id !== expected.restaurantId)
        relationshipMismatches.push(
          `${row.id}: restaurant_id=${row.restaurant_id}, expected ${expected.restaurantId}`,
        );
      if (row.menu_id !== expected.menuId)
        relationshipMismatches.push(
          `${row.id}: menu_id=${row.menu_id}, expected ${expected.menuId}`,
        );
    }
    for (const row of menuRows) {
      const expectedRestaurant = expectedMenus.get(row.id);
      if (expectedRestaurant && row.restaurant_id !== expectedRestaurant)
        relationshipMismatches.push(
          `${row.id}: menu restaurant_id=${row.restaurant_id}, expected ${expectedRestaurant}`,
        );
    }

    const after = dryRun
      ? before
      : await counts(db, EXPECTED_RESTAURANT_IDS, EXPECTED_MENU_ITEM_IDS);

    if (!dryRun) {
      // No row may appear or disappear as a side effect of promotion.
      if (after.restaurants !== before.restaurants || after.menuItems !== before.menuItems)
        throw new Error(
          'Catalog promotion verification failed: row counts changed during promotion. ' +
            `restaurants ${before.restaurants} -> ${after.restaurants}, ` +
            `menu items ${before.menuItems} -> ${after.menuItems}.`,
        );
      if (after.mockRestaurants !== 0 || after.mockMenuItems !== 0)
        throw new Error(
          'Catalog promotion verification failed: MOCK metadata remains on the expected rows.',
        );
      if (promotedRestaurants)
        await db.auditLog.create({
          data: {
            id: id(),
            actor: PROMOTION_ACTOR,
            action: 'CATALOG_PROMOTED',
            resource_id: 'catalog',
            detail: {
              restaurantsPromoted: promotedRestaurants,
              menuItemsPromoted: promotedItems,
              source: OFFICIAL_SOURCE,
              deleted: 0,
            },
          },
        });
    }

    return {
      dryRun,
      ok: !missingAny && relationshipMismatches.length === 0,
      before,
      after,
      promoted: { restaurants: promotedRestaurants, menuItems: promotedItems },
      wouldPromote: {
        restaurants: wouldPromoteRestaurants,
        menuItems: mockItems.length,
      },
      missing,
      relationshipMismatches,
    };
  });
}

type CliOptions = { dryRun: boolean; allowMissing: boolean; json: boolean; help: boolean };

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dryRun: false,
    allowMissing: false,
    json: false,
    help: false,
  };
  for (const argument of argv) {
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--allow-missing') options.allowMissing = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function usage(): string {
  return `Promote the existing 10 MOCK restaurants and 60 MOCK menu items to
official, system-managed business records in place.

Usage:
  npm run catalog:promote                 # apply (safe to run repeatedly)
  npm run catalog:promote -- --dry-run    # report only, no writes
  npm run catalog:promote -- --json

What it changes:
  mock=false; source='CATALOG' (only for rows classified as MOCK); removes
  demo/mock markers from osm_tags. No business field is overwritten.

What it never does:
  No insert, delete, truncate, reset, schema change, verification flag change
  or owner assignment.`;
}

if (process.argv[1]?.endsWith('promote-catalog.ts')) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
    } else {
      const report = await promoteCatalog(options);
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`Catalog promotion (${report.dryRun ? 'DRY RUN' : 'APPLIED'})`);
        console.log(
          `  Restaurants: ${report.before.restaurants} (` +
            `${report.before.mockRestaurants} MOCK before, ${report.after.mockRestaurants} after)`,
        );
        console.log(
          `  Menu items:  ${report.before.menuItems} (` +
            `${report.before.mockMenuItems} MOCK before, ${report.after.mockMenuItems} after)`,
        );
        if (report.dryRun) {
          console.log(
            `  Would promote: ${report.wouldPromote.restaurants} restaurants, ` +
              `${report.wouldPromote.menuItems} menu items`,
          );
          console.log('');
          console.log('Dry run only. No rows changed.');
        } else {
          console.log(
            `  Promoted: ${report.promoted.restaurants} restaurants, ` +
              `${report.promoted.menuItems} menu items`,
          );
          console.log(
            `  Official catalog rows: ${report.after.catalogRestaurants}/${EXPECTED_RESTAURANT_IDS.length} restaurants, ` +
              `${report.after.catalogMenuItems}/${EXPECTED_MENU_ITEM_IDS.length} menu items`,
          );
        }
        if (report.missing.restaurants.length || report.missing.menuItems.length)
          console.log(`  Missing rows: ${JSON.stringify(report.missing)}`);
        if (report.relationshipMismatches.length)
          console.log(
            `  Relationship mismatches: ${JSON.stringify(report.relationshipMismatches)}`,
          );
        if (!report.ok) process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
