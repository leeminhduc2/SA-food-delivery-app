import { transaction } from '../db.js';
import {
  buildDemoMenu,
  coverImage,
  CURATED_BY_KEY,
  CURATED_HANOI_RESTAURANTS,
  demoDescription,
  demoTags,
  deliveryFeeFor,
  etaFor,
  formatCuisine,
  type CuratedRestaurant,
} from '../domain/hanoi.js';
import {
  normalizeOsmElements,
  type ImportFailure,
  type MissingFieldCounts,
  type NormalizedRestaurant,
} from '../domain/osm.js';
import * as menuRepository from '../repositories/menu.repository.js';
import * as importRepository from '../repositories/restaurant-import.repository.js';
import {
  fetchOsmRestaurants,
  overpassEndpoint,
  overpassMaxElements,
  overpassRetries,
  overpassTimeout,
  type OverpassDeps,
} from './overpass.service.js';
import { persistNormalizedRestaurants } from './restaurant-import.service.js';

export type HanoiImportOptions = {
  dryRun?: boolean;
  /** Restrict to curated keys such as `node/721836715`; defaults to all 30. */
  ids?: string[];
  requestedBy?: string;
  endpoint?: string;
  timeoutMs?: number;
  retries?: number;
  maxElements?: number;
  query?: string;
};

export type HanoiImportDeps = OverpassDeps;

export type ImportedRestaurantSummary = {
  key: string;
  name: string;
  cuisine: string;
  address: string | null;
  latitude: number;
  longitude: number;
  phone: string | null;
  website: string | null;
  openingHours: string | null;
  image: string;
  menuProfile: string;
  menuItems: number;
};

export type NameDrift = {
  key: string;
  expectedName: string;
  importedName: string;
};

export type MissingOsmRecord = {
  key: string;
  expectedName: string;
  reason: string;
};

export type HanoiImportReport = {
  dryRun: boolean;
  endpoint: string;
  selected: number;
  fetched: number;
  valid: number;
  duplicates: number;
  invalid: number;
  invalidReasons: Record<string, number>;
  missing: MissingOsmRecord[];
  nameDrift: NameDrift[];
  wouldCreate: number;
  wouldUpdate: number;
  wouldSkip: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  approved: number;
  protectedSkipped: number;
  menusEnsured: number;
  itemsCreated: number;
  missingFields: MissingFieldCounts;
  failures: ImportFailure[];
  restaurants: ImportedRestaurantSummary[];
  jobId: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
};

const keyOf = (record: { osmType: string; osmId: string }) => `${record.osmType}/${record.osmId}`;

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export function buildCuratedQuery(
  restaurants: Pick<CuratedRestaurant, 'osmType' | 'osmId'>[],
  timeoutMs = 30000,
): string {
  const timeout = Math.max(1, Math.ceil(timeoutMs / 1000));
  const byType = new Map<string, string[]>();
  for (const restaurant of restaurants) {
    const ids = byType.get(restaurant.osmType) ?? [];
    ids.push(restaurant.osmId);
    byType.set(restaurant.osmType, ids);
  }
  const parts = [...byType.entries()].map(([type, ids]) => `${type}(id:${ids.join(',')});`);
  return `[out:json][timeout:${timeout}];(${parts.join('')});out center tags;`;
}

export function selectCuratedRestaurants(ids?: string[]): CuratedRestaurant[] {
  if (!ids?.length) return CURATED_HANOI_RESTAURANTS;
  return ids.map((raw) => {
    const key = raw.includes('/') ? raw : `node/${raw}`;
    const curated = CURATED_BY_KEY.get(key);
    if (!curated) throw new Error(`Unknown curated OSM key: ${raw}`);
    return curated;
  });
}

function countReasons(invalid: ReturnType<typeof normalizeOsmElements>['invalid']) {
  const reasons: Record<string, number> = {};
  for (const record of invalid) reasons[record.reason] = (reasons[record.reason] ?? 0) + 1;
  return reasons;
}

function emptyMissing(): MissingFieldCounts {
  return { address: 0, cuisine: 0, phone: 0, website: 0, openingHours: 0 };
}

function planRecords(
  records: NormalizedRestaurant[],
  selected: CuratedRestaurant[],
  missing: MissingOsmRecord[],
  nameDrift: NameDrift[],
): {
  matched: { record: NormalizedRestaurant; curated: CuratedRestaurant }[];
  invalid: NormalizedRestaurant[];
} {
  const byKey = new Map(records.map((record) => [keyOf(record), record]));
  const matched: { record: NormalizedRestaurant; curated: CuratedRestaurant }[] = [];
  const invalid: NormalizedRestaurant[] = [];
  for (const curated of selected) {
    const record = byKey.get(keyOf(curated));
    if (!record) {
      missing.push({
        key: keyOf(curated),
        expectedName: curated.expectedName,
        reason: 'not_returned_by_overpass',
      });
      continue;
    }
    if (record.name !== curated.expectedName) {
      nameDrift.push({
        key: keyOf(curated),
        expectedName: curated.expectedName,
        importedName: record.name,
      });
    }
    matched.push({ record, curated });
  }
  // Records returned by the query but outside the curated selection are not
  // imported; they are only counted for diagnostics.
  const selectedKeys = new Set(selected.map(keyOf));
  for (const record of records) if (!selectedKeys.has(keyOf(record))) invalid.push(record);
  return { matched, invalid };
}

/**
 * Import the curated Hanoi list from Overpass and attach a clearly-labelled
 * demo menu.
 *
 * The existing protected OSM upsert is reused first (so a verified or
 * owner-managed row can never be replaced). A second guarded update adds
 * presentation fields and `_bep` metadata. Re-running is idempotent: restaurant
 * rows are matched by OSM identity, menus by `(restaurant, name)`, and items by
 * deterministic ids with `skipDuplicates`.
 */
export async function runHanoiDemoImport(
  options: HanoiImportOptions = {},
  deps: HanoiImportDeps = {},
): Promise<HanoiImportReport> {
  const startedAt = new Date();
  const dryRun = Boolean(options.dryRun);
  const selected = selectCuratedRestaurants(options.ids);
  const endpoint = options.endpoint ?? overpassEndpoint();
  const bboxText = `curated:hanoi:${selected.length}`;
  const timeoutMs = options.timeoutMs ?? overpassTimeout();
  const query = options.query ?? buildCuratedQuery(selected, timeoutMs);

  let jobId: string | null = null;
  if (!dryRun) {
    const job = await importRepository.createImportJob({
      requestedBy: options.requestedBy ?? 'cli',
      endpoint,
      bbox: bboxText,
      dryRun: false,
    });
    jobId = job.id;
  }

  try {
    const fetched = await fetchOsmRestaurants(
      {
        query,
        endpoint,
        timeoutMs,
        retries: options.retries ?? overpassRetries(),
        maxElements: options.maxElements ?? overpassMaxElements(),
      },
      { fetchImpl: deps.fetchImpl, sleep: deps.sleep },
    );
    const normalized = normalizeOsmElements(fetched.elements);
    const missing: MissingOsmRecord[] = [];
    const nameDrift: NameDrift[] = [];
    const { matched, invalid } = planRecords(normalized.valid, selected, missing, nameDrift);

    const ownership = await importRepository.findOsmOwnership(matched.map(({ record }) => record));
    let wouldCreate = 0;
    let wouldUpdate = 0;
    let wouldSkip = 0;
    for (const { record } of matched) {
      const row = ownership.get(keyOf(record));
      if (!row) wouldCreate++;
      else if (row.source === 'OSM' && !row.verified && !row.owner_managed) wouldUpdate++;
      else wouldSkip++;
    }

    const missingFields = emptyMissing();
    for (const { record } of matched) {
      if (!record.address) missingFields.address++;
      if (!record.cuisine) missingFields.cuisine++;
      if (!record.phone) missingFields.phone++;
      if (!record.website) missingFields.website++;
      if (!record.openingHours) missingFields.openingHours++;
    }

    const restaurants: ImportedRestaurantSummary[] = matched.map(({ record, curated }) => ({
      key: keyOf(record),
      name: record.name,
      cuisine: formatCuisine(record.cuisine),
      address: record.address,
      latitude: record.latitude,
      longitude: record.longitude,
      phone: record.phone,
      website: record.website,
      openingHours: record.openingHours,
      image: coverImage(record.osmId),
      menuProfile: curated.menuProfile,
      menuItems: buildDemoMenu(record.osmType, record.osmId, curated.menuProfile).itemCount,
    }));

    const report: HanoiImportReport = {
      dryRun,
      endpoint,
      selected: selected.length,
      fetched: fetched.elements.length,
      valid: normalized.valid.length,
      duplicates: normalized.duplicates,
      invalid: invalid.length + normalized.invalid.length,
      invalidReasons: countReasons(normalized.invalid),
      missing,
      nameDrift,
      wouldCreate,
      wouldUpdate,
      wouldSkip,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      approved: 0,
      protectedSkipped: 0,
      menusEnsured: 0,
      itemsCreated: 0,
      missingFields,
      failures: [],
      restaurants,
      jobId,
      startedAt: startedAt.toISOString(),
      finishedAt: startedAt.toISOString(),
      durationMs: 0,
    };

    if (!dryRun && matched.length) {
      const persistence = await persistNormalizedRestaurants(
        matched.map(({ record }) => record),
        50,
      );
      report.created = persistence.created;
      report.updated = persistence.updated;
      report.skipped = persistence.skipped;
      report.failed = persistence.failures.length;
      report.failures = persistence.failures;

      const rows = await importRepository.findByOsmIdentities(matched.map(({ record }) => record));
      const byOsm = new Map(
        rows
          .filter((row) => row.osm_type && row.osm_id)
          .map((row) => [`${row.osm_type}/${row.osm_id}`, row]),
      );
      for (const { record, curated } of matched) {
        const row = byOsm.get(keyOf(record));
        if (!row) continue;
        const menu = buildDemoMenu(record.osmType, record.osmId, curated.menuProfile);
        const presentation = {
          cuisine: formatCuisine(record.cuisine),
          description: demoDescription(),
          image: coverImage(record.osmId),
          deliveryFee: deliveryFeeFor(record.osmId),
          etaMinutes: etaFor(record.osmId),
          osmTags: demoTags(record.osmType, record.osmId, curated.menuProfile, menu),
        };
        const outcome = await transaction(async (db) => {
          const affected = await importRepository.applyCuratedPresentation(
            record,
            presentation,
            db,
          );
          if (!affected) return { approved: false, menus: 0, items: 0 };
          const seeded = await menuRepository.ensureSeededMenus(row.id, menu.categories, db);
          return { approved: true, menus: seeded.menus, items: seeded.itemsCreated };
        });
        if (!outcome.approved) {
          report.protectedSkipped++;
          continue;
        }
        report.approved++;
        report.menusEnsured += outcome.menus;
        report.itemsCreated += outcome.items;
      }
    }

    const finishedAt = new Date();
    report.finishedAt = finishedAt.toISOString();
    report.durationMs = finishedAt.getTime() - startedAt.getTime();
    if (!dryRun && jobId) {
      await importRepository.finishImportJob(
        jobId,
        'SUCCEEDED',
        report as unknown as Record<string, unknown>,
      );
    }
    return report;
  } catch (error) {
    if (jobId)
      await importRepository
        .finishImportJob(jobId, 'FAILED', {}, errorMessage(error))
        .catch(() => undefined);
    throw error;
  }
}
