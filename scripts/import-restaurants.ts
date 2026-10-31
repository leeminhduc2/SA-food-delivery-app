import 'dotenv/config';
import { prisma } from '../server/db.js';
import { parseBBox, type BBox } from '../server/domain/osm.js';
import {
  overpassBBox,
  overpassEndpoint,
  overpassMaxElements,
} from '../server/services/overpass.service.js';
import { runRestaurantImport } from '../server/services/restaurant-import.service.js';

type CliOptions = {
  dryRun: boolean;
  json: boolean;
  help: boolean;
  bbox?: BBox;
  endpoint?: string;
  maxElements?: number;
};

function usage(): string {
  return `Restaurant import from OpenStreetMap (Overpass API)

Usage:
  npm run import:restaurants -- [options]

Options:
  --dry-run                 Fetch/validate/classify only; no restaurant writes.
  --bbox=s,w,n,e            Bounding box (default: OVERPASS_HANOI_BBOX or Hanoi).
  --endpoint=<url>          Overpass interpreter URL.
  --max-elements=<number>   Reject responses above this element count.
  --json                    Print the full report as JSON.
  --help                    Show this help.

Environment:
  OVERPASS_ENDPOINT, OVERPASS_HANOI_BBOX, OVERPASS_TIMEOUT_MS,
  OVERPASS_RETRIES, OVERPASS_MAX_ELEMENTS, IMPORT_BATCH_SIZE
`;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { dryRun: false, json: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const [flag, inline] = argument.split(/=(.*)/s);
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[++index];
      if (!next || next.startsWith('--')) throw new Error(`${flag} requires a value.`);
      return next;
    };
    if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--json') options.json = true;
    else if (flag === '--help' || flag === '-h') options.help = true;
    else if (flag === '--bbox') options.bbox = parseBBox(value());
    else if (flag === '--endpoint') {
      const endpoint = value();
      const parsed = new URL(endpoint);
      if (!['http:', 'https:'].includes(parsed.protocol))
        throw new Error('Overpass endpoint must use http or https.');
      options.endpoint = endpoint;
    } else if (flag === '--max-elements') {
      const max = Number(value());
      if (!Number.isInteger(max) || max <= 0) throw new Error('--max-elements must be positive.');
      options.maxElements = max;
    } else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
  } else {
    const batchSize = Number(process.env.IMPORT_BATCH_SIZE || 50);
    const report = await runRestaurantImport({
      dryRun: options.dryRun,
      bbox: options.bbox ?? overpassBBox(),
      endpoint: options.endpoint ?? overpassEndpoint(),
      maxElements: options.maxElements ?? overpassMaxElements(),
      requestedBy: 'cli',
      batchSize: Number.isInteger(batchSize) && batchSize > 0 ? batchSize : 50,
    });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Restaurant import${report.dryRun ? ' (dry run)' : ''}`);
      console.log(`  Endpoint:        ${report.endpoint}`);
      console.log(`  Bounding box:    ${report.bbox.join(',')}`);
      console.log(`  Fetched:         ${report.fetched}`);
      console.log(`  Valid:           ${report.valid}`);
      console.log(`  Duplicates:      ${report.duplicates}`);
      console.log(
        `  Invalid:         ${report.invalid}${report.invalid > 0 ? ' ' + JSON.stringify(report.invalidReasons) : ''}`,
      );
      console.log(
        report.dryRun
          ? `  Would create:    ${report.wouldCreate}`
          : `  Created:         ${report.created}`,
      );
      console.log(
        report.dryRun
          ? `  Would update:    ${report.wouldUpdate}`
          : `  Updated:         ${report.updated}`,
      );
      console.log(
        report.dryRun
          ? `  Would skip:      ${report.wouldSkip}`
          : `  Skipped:         ${report.skipped}`,
      );
      console.log(`  Failed:          ${report.failed}`);
      if (report.failures.length)
        for (const failure of report.failures.slice(0, 20))
          console.error(`  ! ${failure.osmType}/${failure.osmId}: ${failure.error}`);
      console.log(`  Duration:        ${report.durationMs}ms`);
      if (report.dryRun) console.log('  No restaurant data was written.');
    }
    if (report.failed > 0 && report.created + report.updated === 0) process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
