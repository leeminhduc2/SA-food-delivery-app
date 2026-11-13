/**
 * Creates simulated earning estimates for DELIVERED trips that predate P12.
 * Only trips with a known final driver, delivery time and fee snapshot get an
 * estimate; the report counts the rest. Safe to rerun.
 *
 *   npx tsx scripts/backfill-earnings.ts
 */
import 'dotenv/config';
import { registerModules } from '../server/modules/index.js';
import { backfillEarningEstimates } from '../server/modules/delivery/index.js';
import { prisma } from '../server/shared/db.js';

registerModules();
try {
  console.log(JSON.stringify(await backfillEarningEstimates()));
} finally {
  await prisma.$disconnect();
}
