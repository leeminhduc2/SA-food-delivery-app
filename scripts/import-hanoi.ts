import 'dotenv/config';
import { prisma } from '../server/db.js';
import { CURATED_HANOI_RESTAURANTS } from '../server/domain/hanoi.js';
import { runHanoiDemoImport } from '../server/services/hanoi-import.service.js';
import {
  overpassEndpoint,
  overpassMaxElements,
  overpassTimeout,
} from '../server/services/overpass.service.js';

type CliOptions = {
  dryRun: boolean;
  json: boolean;
  help: boolean;
  ids: string[];
  endpoint?: string;
  timeoutMs?: number;
  maxElements?: number;
};

function usage(): string {
  return `Curated Hanoi restaurant import from OpenStreetMap (Overpass API)

Usage:
  npm run import:hanoi -- [options]

Options:
  --dry-run                 Fetch/validate/classify only; no database writes.
  --only=<type>/<id>        Import only one curated record (repeatable).
  --endpoint=<url>          Overpass interpreter URL.
  --timeout=<ms>            Overpass request timeout.
  --max-elements=<number>   Reject responses above this element count.
  --json                    Print the full report as JSON.
  --help                    Show this help.

The curated selection contains ${CURATED_HANOI_RESTAURANTS.length} real Hanoi OSM
records. Location/contact fields always come from the live Overpass response.
Menus are demo data and are marked as such in restaurants.osm_tags._bep.menu.
`;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { dryRun: false, json: false, help: false, ids: [] };
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
    else if (flag === '--only') options.ids.push(value());
    else if (flag === '--endpoint') {
      const endpoint = value();
      const parsed = new URL(endpoint);
      if (!['http:', 'https:'].includes(parsed.protocol))
        throw new Error('Overpass endpoint must use http or https.');
      options.endpoint = endpoint;
    } else if (flag === '--timeout') {
      const timeout = Number(value());
      if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('--timeout must be positive.');
      options.timeoutMs = timeout;
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
    const report = await runHanoiDemoImport({
      dryRun: options.dryRun,
      ids: options.ids.length ? options.ids : undefined,
      endpoint: options.endpoint ?? overpassEndpoint(),
      timeoutMs: options.timeoutMs ?? overpassTimeout(),
      maxElements: options.maxElements ?? overpassMaxElements(),
      requestedBy: 'cli',
    });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Hanoi restaurant import${report.dryRun ? ' (dry run)' : ''}`);
      console.log(`  Endpoint:        ${report.endpoint}`);
      console.log(`  Selected:        ${report.selected}`);
      console.log(`  Fetched:         ${report.fetched}`);
      console.log(`  Valid:           ${report.valid}`);
      console.log(`  Missing OSM:     ${report.missing.length}`);
      console.log(`  Name drift:      ${report.nameDrift.length}`);
      console.log(`  Missing address: ${report.missingFields.address}`);
      console.log(`  Missing cuisine: ${report.missingFields.cuisine}`);
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
      if (!report.dryRun) {
        console.log(`  Approved:        ${report.approved}`);
        console.log(`  Protected skip:  ${report.protectedSkipped}`);
        console.log(`  Menus ensured:   ${report.menusEnsured}`);
        console.log(`  Items created:   ${report.itemsCreated}`);
      }
      console.log(`  Failed:          ${report.failed}`);
      console.log(`  Job:             ${report.jobId ?? 'none (dry run)'}`);
      console.log(`  Duration:        ${report.durationMs}ms`);
      if (report.missing.length)
        for (const item of report.missing)
          console.error(`  ! ${item.key} (${item.expectedName}): ${item.reason}`);
      if (report.nameDrift.length)
        for (const item of report.nameDrift)
          console.error(
            `  ! ${item.key}: expected "${item.expectedName}", OSM returned "${item.importedName}"`,
          );
      if (report.failures.length)
        for (const failure of report.failures.slice(0, 20))
          console.error(`  ! ${failure.osmType}/${failure.osmId}: ${failure.error}`);
      if (report.dryRun) console.log('  No restaurant or menu data was written.');
    }
    if (report.failed > 0 && report.created + report.updated === 0) process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
