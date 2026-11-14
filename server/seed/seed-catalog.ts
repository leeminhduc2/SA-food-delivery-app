import 'dotenv/config';
import { prisma } from '../shared/db.js';
import {
  OFFICIAL_SEED_MARKER,
  OFFICIAL_SEED_VERSION,
  provisionCatalog,
  type CatalogProvisionReport,
} from './catalog-provision.js';

/**
 * Provision the official business catalog.
 *
 * This is the normal first-run initialization path. It does **not** require
 * `DEMO_MODE=true` and creates no demo accounts, no demo memberships and no
 * mock/demo metadata. The same ten restaurants and sixty menu items are used,
 * so an existing deployment can either run this on a fresh database or promote
 * an already-seeded catalog in place with `npm run catalog:promote`.
 *
 * The run is idempotent and never overwrites operator-edited business fields.
 */
export async function seedCatalog(): Promise<CatalogProvisionReport> {
  return provisionCatalog({
    mode: 'official',
    marker: OFFICIAL_SEED_MARKER,
    markerVersion: OFFICIAL_SEED_VERSION,
    demoMemberships: false,
    hideLegacyCatalog: true,
  });
}

if (process.argv[1]?.endsWith('seed-catalog.ts')) {
  await seedCatalog().then((report) => {
    console.log(
      `Official catalog ready: ${report.restaurants} restaurants, ` +
        `${report.itemsCreated} new menu items, ${report.legacyHidden} legacy rows hidden.`,
    );
  });
  await prisma.$disconnect();
}
