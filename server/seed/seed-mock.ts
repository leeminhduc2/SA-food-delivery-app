import 'dotenv/config';
import { prisma } from '../shared/db.js';
import { MOCK_SEED_MARKER, MOCK_SEED_VERSION, provisionCatalog } from './catalog-provision.js';
import type { CatalogProvisionReport } from './catalog-provision.js';

/**
 * Idempotent seed for the fictional Hanoi demo/test catalog.
 *
 * This is a demo fixture and therefore remains gated by `DEMO_MODE=true`. The
 * official business catalog is provisioned by `seed-catalog.ts`, which does not
 * depend on demo mode, and an already-provisioned catalog can be promoted in
 * place with `promote-catalog.ts`.
 *
 * - Upserts the 10 demo restaurants and their menus/items by stable id.
 * - `update: {}`-style writes never overwrite values an operator edited.
 * - New menu items use `skipDuplicates`, so a user's edits survive re-runs.
 * - Legacy OSM/demo rows are hidden with the existing `catalog_visible` flag;
 *   nothing is deleted, and orders, order items, carts, reviews and users are
 *   left untouched.
 * - No Google Places (or any external) request is made.
 */
export async function seedMockCatalog(): Promise<CatalogProvisionReport> {
  if (process.env.DEMO_MODE !== 'true')
    throw new Error('Mock catalog seeding is only available with DEMO_MODE=true.');

  return provisionCatalog({
    mode: 'mock',
    marker: MOCK_SEED_MARKER,
    markerVersion: MOCK_SEED_VERSION,
    demoMemberships: true,
    hideLegacyCatalog: true,
  });
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
