import 'dotenv/config';
import { prisma } from '../server/shared/db.js';
import {
  auditLegacyChange,
  hideLegacy,
  legacyImpact,
  restoreLegacy,
} from '../server/modules/catalog/infrastructure/catalog-archive.repository.js';

type CliOptions = {
  apply: boolean;
  restore: boolean;
  confirm?: string;
  json: boolean;
  help: boolean;
};

const HIDE_CONFIRMATION = 'HIDE_LEGACY_CATALOG';
const RESTORE_CONFIRMATION = 'RESTORE_LEGACY_CATALOG';

function usage(): string {
  return `Retire legacy OSM/MANUAL catalog rows without deleting anything

Usage:
  npm run catalog:archive -- [--json]
  npm run catalog:archive -- --apply --confirm=${HIDE_CONFIRMATION}
  npm run catalog:archive -- --restore --confirm=${RESTORE_CONFIRMATION}

What it does:
  Hides legacy rows from the public catalog by setting catalog_visible=false.
  Rows, menus, items, orders, order items, carts, reviews and members are kept.
  Existing order history therefore remains readable. The change is reversible.

What it never does:
  No DELETE, TRUNCATE, schema reset or applied-migration change. Rows created
  by real users are outside the legacy predicate and are never hidden.`;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { apply: false, restore: false, json: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const [flag, inline] = argument.split(/=(.*)/s);
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[++index];
      if (!next || next.startsWith('--')) throw new Error(`${flag} requires a value.`);
      return next;
    };
    if (flag === '--apply') options.apply = true;
    else if (flag === '--restore') options.restore = true;
    else if (flag === '--json') options.json = true;
    else if (flag === '--help' || flag === '-h') options.help = true;
    else if (flag === '--confirm') options.confirm = value();
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (options.apply && options.restore) throw new Error('Choose --apply or --restore, not both.');
  if (options.apply && options.confirm !== HIDE_CONFIRMATION)
    throw new Error(`--apply requires --confirm=${HIDE_CONFIRMATION}.`);
  if (options.restore && options.confirm !== RESTORE_CONFIRMATION)
    throw new Error(`--restore requires --confirm=${RESTORE_CONFIRMATION}.`);
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
  } else {
    const before = await legacyImpact();
    let affected = 0;
    let action = 'DRY_RUN';
    if (options.apply) {
      affected = await hideLegacy();
      await auditLegacyChange('cli', 'LEGACY_CATALOG_HIDDEN', affected);
      action = 'HIDDEN';
    } else if (options.restore) {
      affected = await restoreLegacy();
      await auditLegacyChange('cli', 'LEGACY_CATALOG_RESTORED', affected);
      action = 'RESTORED';
    }
    const after = await legacyImpact();
    if (options.json) {
      console.log(JSON.stringify({ action, affected, before, after }, null, 2));
    } else {
      console.log(`Legacy catalog archive (${action})`);
      console.log(
        `  Legacy rows:              ${before.total} (${before.osm} OSM, ${before.manual} manual/seed)`,
      );
      console.log(`  Currently visible:        ${before.visible}`);
      console.log(`  Currently hidden:         ${before.hidden}`);
      console.log(`  Rows with orders:         ${before.withOrders}`);
      console.log(`  Rows with reviews:        ${before.withReviews}`);
      console.log(`  Rows with members:        ${before.withMembers}`);
      console.log(`  Rows with menus:          ${before.withMenus}`);
      console.log(`  Rows with menu items:     ${before.withMenuItems}`);
      console.log(`  Cart lines referencing:   ${before.cartLines}`);
      console.log(`  Affected now:             ${affected}`);
      console.log(`  Visible after:            ${after.visible}`);
      console.log(`  Hidden after:             ${after.hidden}`);
      if (action === 'DRY_RUN') {
        console.log('');
        console.log('Dry run only. No rows changed.');
        console.log(`To hide legacy rows: --apply --confirm=${HIDE_CONFIRMATION}`);
        console.log('Order history is preserved; no DELETE is executed.');
      } else {
        console.log('');
        console.log('No rows were deleted. This change is reversible with --restore.');
      }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
