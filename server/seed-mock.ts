import 'dotenv/config';
import type { Prisma } from '@prisma/client';
import { prisma, transaction } from './db.js';
import {
  LEGACY_DEMO_RESTAURANT_IDS,
  MOCK_MENU_NOTE,
  MOCK_RESTAURANTS,
  MOCK_SOURCE,
  itemImage,
  restaurantImage,
} from './domain/mock-catalog.js';

/**
 * Idempotent seed for the fictional Hanoi demo catalog.
 *
 * - Upserts the 10 mock restaurants and their menus/items by stable id.
 * - `update: {}`-style writes never overwrite values an operator edited.
 * - New menu items use `skipDuplicates`, so a user's edits survive re-runs.
 * - Legacy OSM/demo rows are hidden with the existing `catalog_visible` flag;
 *   nothing is deleted, and orders, order items, carts, reviews and users are
 *   left untouched.
 * - No Google Places (or any external) request is made.
 */
export async function seedMockCatalog(): Promise<{
  restaurants: number;
  itemsCreated: number;
  legacyHidden: number;
}> {
  if (process.env.DEMO_MODE !== 'true')
    throw new Error('Mock catalog seeding is only available with DEMO_MODE=true.');

  let itemsCreated = 0;
  let legacyHidden = 0;

  await transaction(async (db) => {
    for (const restaurant of MOCK_RESTAURANTS) {
      await db.restaurant.upsert({
        where: { id: restaurant.id },
        // Preserve edits made after the first seed; only re-assert demo flags.
        update: { catalog_visible: true, mock: true, source: MOCK_SOURCE },
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
          source: MOCK_SOURCE,
          verified: false,
          owner_managed: false,
          catalog_visible: true,
          mock: true,
          osm_tags: {
            demo: true,
            mock: true,
            note: MOCK_MENU_NOTE,
          } as Prisma.InputJsonValue,
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
            stock: menuItem.stock,
            options: [] as Prisma.InputJsonValue,
            mock: true,
          })),
          skipDuplicates: true,
        });
        itemsCreated += created.count;
      }
    }

    // Retire the earlier OSM/demo catalog from the public list without deleting
    // anything. Only known legacy sources are touched; rows created later by
    // real users keep their visibility.
    const hidden = await db.restaurant.updateMany({
      where: {
        mock: false,
        OR: [{ source: 'OSM' }, { id: { in: LEGACY_DEMO_RESTAURANT_IDS } }],
      },
      data: { catalog_visible: false },
    });
    legacyHidden = hidden.count;

    // Demo accounts can manage two mock kitchens when they exist. This adds
    // missing membership rows only; it never removes or rewrites memberships.
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
  });

  return {
    restaurants: MOCK_RESTAURANTS.length,
    itemsCreated,
    legacyHidden,
  };
}

if (process.argv[1]?.endsWith('seed-mock.ts')) {
  await seedMockCatalog().then((report) => {
    console.log(
      `Mock catalog ready: ${report.restaurants} restaurants, ` +
        `${report.itemsCreated} new menu items, ${report.legacyHidden} legacy rows hidden.`,
    );
  });
  await prisma.$disconnect();
}
