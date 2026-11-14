import type { Prisma } from '@prisma/client';
import { transaction } from '../shared/db.js';
import {
  LEGACY_DEMO_RESTAURANT_IDS,
  MOCK_MENU_NOTE,
  MOCK_RESTAURANTS,
  MOCK_SOURCE,
  itemImage,
  restaurantImage,
} from './data/mock-catalog.js';

/**
 * Provisioning for the application's business catalog.
 *
 * The same ten kitchens and sixty dishes are used in two modes:
 *
 * - `official` writes them as system-managed business records
 *   (`mock=false`, `source='CATALOG'`, `verified=false`). This is the normal
 *   initialization path and does not depend on `DEMO_MODE`.
 * - `mock` writes the identical dataset as demo/test fixtures
 *   (`mock=true`, `source='MOCK'`). It is used only by the demo seed and the
 *   automated tests that exercise the legacy fixture.
 *
 * Both modes are idempotent: restaurants and menus are upserted with an empty
 * `update`, and menu items use `skipDuplicates`. Operator edits are therefore
 * never overwritten on a re-run, and no duplicate rows are inserted.
 */

export const OFFICIAL_SOURCE = 'CATALOG';
export const OFFICIAL_MENU_NOTE =
  'System-managed catalog record. Business details have not been verified by a human.';
export const OFFICIAL_SEED_MARKER = 'official-catalog';
export const OFFICIAL_SEED_VERSION = 1;
export const MOCK_SEED_MARKER = 'mock-catalog';
export const MOCK_SEED_VERSION = 1;

export type CatalogProvisionMode = 'official' | 'mock';

export type CatalogProvisionReport = {
  mode: CatalogProvisionMode;
  restaurants: number;
  itemsCreated: number;
  legacyHidden: number;
  initialized: boolean;
};

export type CatalogProvisionOptions = {
  mode: CatalogProvisionMode;
  /** One-time marker name used to hide the legacy catalog exactly once. */
  marker: string;
  markerVersion: number;
  /** Add demo owner memberships for the two demo restaurant accounts. */
  demoMemberships: boolean;
  /**
   * Hide legacy OSM/demo rows on the first run. Rows are never deleted; the
   * flag is reversible with `npm run catalog:archive -- --restore`.
   */
  hideLegacyCatalog: boolean;
};

export async function provisionCatalog(
  options: CatalogProvisionOptions,
): Promise<CatalogProvisionReport> {
  const official = options.mode === 'official';
  let itemsCreated = 0;
  let legacyHidden = 0;
  let initialized = false;

  await transaction(async (db) => {
    const marker = await db.seedRun.findUnique({ where: { name: options.marker } });
    initialized = !marker;

    for (const restaurant of MOCK_RESTAURANTS) {
      await db.restaurant.upsert({
        where: { id: restaurant.id },
        // Preserve every field an operator may have edited after the first run.
        update: {},
        create: {
          id: restaurant.id,
          slug: restaurant.slug,
          name: restaurant.name,
          description: restaurant.description,
          cuisine: restaurant.cuisine,
          district: restaurant.district,
          address: restaurant.address,
          latitude: restaurant.latitude,
          longitude: restaurant.longitude,
          geocoded_address: restaurant.address,
          geocoded_at: new Date(),
          phone: restaurant.phone,
          opening_hours: restaurant.opening_hours,
          delivery_fee: restaurant.delivery_fee,
          eta_minutes: restaurant.eta_minutes,
          rating: restaurant.rating,
          review_count: restaurant.review_count,
          image: restaurantImage(restaurant.slug),
          status: 'APPROVED',
          approved_at: new Date(),
          source: official ? OFFICIAL_SOURCE : MOCK_SOURCE,
          // Neither mode claims human verification. Verification is a separate
          // operational action and must not be inferred from seeding.
          verified: false,
          owner_managed: false,
          catalog_visible: true,
          accepting_orders: true,
          mock: !official,
          osm_tags: (official
            ? { catalog: true, note: OFFICIAL_MENU_NOTE }
            : { demo: true, mock: true, note: MOCK_MENU_NOTE }) as Prisma.InputJsonValue,
        },
      });

      for (const menu of restaurant.menus) {
        await db.menu.upsert({
          where: { id: `${restaurant.id}-${menu.key}` },
          update: {},
          create: {
            id: `${restaurant.id}-${menu.key}`,
            restaurant_id: restaurant.id,
            name: menu.name,
          },
        });
        const created = await db.menuItem.createMany({
          data: menu.items.map((menuItem) => ({
            id: menuItem.id,
            restaurant_id: restaurant.id,
            menu_id: `${restaurant.id}-${menu.key}`,
            name: menuItem.name,
            description: menuItem.description,
            price: menuItem.price,
            image: itemImage(menuItem.id),
            available: menuItem.available,
            visible: true,
            stock: menuItem.stock,
            options: [] as Prisma.InputJsonValue,
            mock: !official,
          })),
          // A row that already exists (possibly edited by an operator) wins.
          skipDuplicates: true,
        });
        itemsCreated += created.count;
      }
    }

    // Retire earlier OSM/demo rows from public discovery without deleting
    // anything. Only the one-time initialization does this, so a row an
    // operator later restores stays visible.
    if (options.hideLegacyCatalog && initialized) {
      const hidden = await db.restaurant.updateMany({
        where: {
          mock: false,
          OR: [{ source: 'OSM' }, { id: { in: LEGACY_DEMO_RESTAURANT_IDS } }],
        },
        data: { catalog_visible: false },
      });
      legacyHidden = hidden.count;
      await db.seedRun.create({
        data: { name: options.marker, version: options.markerVersion },
      });
    }

    // Demo accounts can manage two kitchens when those accounts exist. This
    // adds missing membership rows only; it never assigns owners in official
    // provisioning, because a valid owner account may not exist.
    if (options.demoMemberships) {
      const demoUsers = await db.user.findMany({
        where: { id: { in: ['restaurant', 'restaurant2'] } },
        select: { id: true },
      });
      const membership: { user_id: string; restaurant_id: string }[] = [];
      if (demoUsers.some((user) => user.id === 'restaurant'))
        membership.push({ user_id: 'restaurant', restaurant_id: 'mock-restaurant-01' });
      if (demoUsers.some((user) => user.id === 'restaurant2'))
        membership.push({ user_id: 'restaurant2', restaurant_id: 'mock-restaurant-05' });
      if (membership.length)
        await db.restaurantMember.createMany({ data: membership, skipDuplicates: true });
    }
  });

  return {
    mode: options.mode,
    restaurants: MOCK_RESTAURANTS.length,
    itemsCreated,
    legacyHidden,
    initialized,
  };
}
