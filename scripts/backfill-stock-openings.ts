import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { backfillOpeningBatch } from '../server/modules/catalog/index.js';
import { prisma } from '../server/shared/db.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  let stalledSince = Date.now();
  try {
    for (;;) {
      const result = await backfillOpeningBatch();
      console.log(JSON.stringify(result));
      if (!result.remaining) break;
      if (result.initialized) stalledSince = Date.now();
      else if (Date.now() - stalledSince > 30000)
        throw new Error('Backfill stalled on locked rows');
      else await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    await prisma.$disconnect();
  }
}
