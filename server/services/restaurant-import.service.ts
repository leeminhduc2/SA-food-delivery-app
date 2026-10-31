import { z } from 'zod';
import { transaction, uniqueViolation, type DB } from '../db.js';
import { AppError } from '../domain/errors.js';
import {
  bboxToString,
  normalizeOsmElements,
  parseBBox,
  type BBox,
  type ImportFailure,
  type ImportReport,
  type NormalizedRestaurant,
} from '../domain/osm.js';
import type { User } from '../domain/types.js';
import * as importRepository from '../repositories/restaurant-import.repository.js';
import {
  fetchOsmRestaurants,
  overpassBBox,
  overpassEndpoint,
  overpassMaxElements,
  overpassRetries,
  overpassTimeout,
  type OverpassDeps,
  type OverpassFetch,
} from './overpass.service.js';

export type PersistenceResult = {
  created: number;
  updated: number;
  skipped: number;
  failures: ImportFailure[];
};

export type UpsertRecord = (
  record: NormalizedRestaurant,
  db: DB,
) => Promise<{ id: string; inserted: boolean } | undefined>;

export type ImportDeps = OverpassDeps & {
  persist?: (records: NormalizedRestaurant[]) => Promise<PersistenceResult>;
  upsert?: UpsertRecord;
};

export type ImportOptions = {
  bbox?: BBox;
  dryRun?: boolean;
  endpoint?: string;
  requestedBy?: string;
  jobId?: string;
  timeoutMs?: number;
  retries?: number;
  maxElements?: number;
  batchSize?: number;
};

const errorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 500);

export const importRequestSchema = z
  .object({
    bbox: z.array(z.number().finite()).length(4).optional(),
    dryRun: z.boolean().default(false),
  })
  .strict();

function classify(
  records: NormalizedRestaurant[],
  ownership: Map<string, importRepository.OsmOwnershipRow>,
): {
  newRecords: number;
  existingRecords: number;
  wouldCreate: number;
  wouldUpdate: number;
  wouldSkip: number;
} {
  let newRecords = 0;
  let existingRecords = 0;
  let wouldCreate = 0;
  let wouldUpdate = 0;
  let wouldSkip = 0;
  for (const record of records) {
    const row = ownership.get(`${record.osmType}/${record.osmId}`);
    if (!row) {
      newRecords++;
      wouldCreate++;
    } else {
      existingRecords++;
      if (row.source === 'OSM' && !row.verified && !row.owner_managed) wouldUpdate++;
      else wouldSkip++;
    }
  }
  return { newRecords, existingRecords, wouldCreate, wouldUpdate, wouldSkip };
}

/**
 * Persist in batches. Each record runs inside a SAVEPOINT so one bad row (for
 * example a constraint failure) cannot roll back the rest of the batch. A
 * transaction-level failure marks the whole batch as failed and is reported.
 */
export async function persistNormalizedRestaurants(
  records: NormalizedRestaurant[],
  batchSize = 50,
  upsert: UpsertRecord = importRepository.upsertImportedRestaurant,
): Promise<PersistenceResult> {
  const result: PersistenceResult = { created: 0, updated: 0, skipped: 0, failures: [] };
  for (let offset = 0; offset < records.length; offset += batchSize) {
    const batch = records.slice(offset, offset + batchSize);
    const outcomes: Array<{
      record: NormalizedRestaurant;
      outcome: 'created' | 'updated' | 'skipped' | 'failed';
      error?: string;
    }> = [];
    let committed = false;
    try {
      await transaction(async (db) => {
        for (const record of batch) {
          await db.$executeRawUnsafe('SAVEPOINT import_record');
          try {
            const row = await upsert(record, db);
            outcomes.push({
              record,
              outcome: !row ? 'skipped' : row.inserted ? 'created' : 'updated',
            });
            await db.$executeRawUnsafe('RELEASE SAVEPOINT import_record');
          } catch (error) {
            try {
              await db.$executeRawUnsafe('ROLLBACK TO SAVEPOINT import_record');
            } catch {
              // The transaction may already be aborted; the batch-level catch
              // below will report every record in it.
            }
            outcomes.push({ record, outcome: 'failed', error: errorMessage(error) });
          }
        }
      });
      committed = true;
    } catch (error) {
      result.failures.push(
        ...batch.map((record) => ({
          osmType: record.osmType,
          osmId: record.osmId,
          error: `Batch transaction failed: ${errorMessage(error)}`,
        })),
      );
    }
    if (!committed) continue;
    for (const item of outcomes) {
      if (item.outcome === 'created') result.created++;
      else if (item.outcome === 'updated') result.updated++;
      else if (item.outcome === 'skipped') result.skipped++;
      else
        result.failures.push({
          osmType: item.record.osmType,
          osmId: item.record.osmId,
          error: item.error ?? 'Unknown persistence error.',
        });
    }
  }
  return result;
}

function countReasons(invalid: ReturnType<typeof normalizeOsmElements>['invalid']) {
  const reasons: Record<string, number> = {};
  for (const record of invalid) reasons[record.reason] = (reasons[record.reason] ?? 0) + 1;
  return reasons;
}

/**
 * Run the complete fetch → normalize → validate → persist pipeline.
 *
 * In dry-run mode the database is only read (to classify new/existing rows);
 * no restaurant data or job rows are written.
 */
export async function runRestaurantImport(
  options: ImportOptions = {},
  deps: ImportDeps = {},
): Promise<ImportReport> {
  const startedAt = new Date();
  const bbox = options.bbox ?? overpassBBox();
  const endpoint = options.endpoint ?? overpassEndpoint();
  const dryRun = Boolean(options.dryRun);
  let jobId = options.jobId;

  if (!dryRun && !jobId) {
    const job = await importRepository.createImportJob({
      requestedBy: options.requestedBy ?? 'cli',
      endpoint,
      bbox: bboxToString(bbox),
      dryRun: false,
    });
    jobId = job.id;
  }

  try {
    const fetched = await fetchOsmRestaurants(
      {
        bbox,
        endpoint,
        timeoutMs: options.timeoutMs ?? overpassTimeout(),
        retries: options.retries ?? overpassRetries(),
        maxElements: options.maxElements ?? overpassMaxElements(),
      },
      { fetchImpl: deps.fetchImpl as OverpassFetch | undefined, sleep: deps.sleep },
    );
    const normalized = normalizeOsmElements(fetched.elements);
    const ownership = await importRepository.findOsmOwnership(normalized.valid);
    const predicted = classify(normalized.valid, ownership);

    let persistence: PersistenceResult = { created: 0, updated: 0, skipped: 0, failures: [] };
    if (!dryRun) {
      persistence = deps.persist
        ? await deps.persist(normalized.valid)
        : await persistNormalizedRestaurants(normalized.valid, options.batchSize, deps.upsert);
    }

    const finishedAt = new Date();
    const report: ImportReport = {
      dryRun,
      endpoint,
      bbox,
      fetched: fetched.elements.length,
      valid: normalized.valid.length,
      duplicates: normalized.duplicates,
      invalid: normalized.invalid.length,
      created: persistence.created,
      updated: persistence.updated,
      skipped: persistence.skipped,
      failed: persistence.failures.length,
      wouldCreate: predicted.wouldCreate,
      wouldUpdate: predicted.wouldUpdate,
      wouldSkip: predicted.wouldSkip,
      newRecords: predicted.newRecords,
      existingRecords: predicted.existingRecords,
      invalidReasons: countReasons(normalized.invalid),
      missingFields: normalized.missing,
      failures: persistence.failures,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
    if (jobId)
      await importRepository.finishImportJob(
        jobId,
        'SUCCEEDED',
        report as unknown as Record<string, unknown>,
      );
    return report;
  } catch (error) {
    if (jobId)
      await importRepository
        .finishImportJob(jobId, 'FAILED', {}, errorMessage(error))
        .catch(() => undefined);
    throw error;
  }
}

/** Queue an admin import and return immediately; the job runs in-process. */
export async function queueRestaurantImport(actor: User, raw: unknown) {
  if (actor.role !== 'ADMIN')
    throw new AppError(403, 'FORBIDDEN', 'Administrator access required.');
  const input = importRequestSchema.parse(raw ?? {});
  let bbox: BBox;
  try {
    bbox = input.bbox ? parseBBox(input.bbox) : overpassBBox();
  } catch (error) {
    throw new AppError(400, 'INVALID_BBOX', errorMessage(error));
  }
  let job: importRepository.ImportJobRow;
  try {
    job = await importRepository.createImportJob({
      requestedBy: actor.id,
      endpoint: overpassEndpoint(),
      bbox: bboxToString(bbox),
      dryRun: input.dryRun,
    });
  } catch (error) {
    if (uniqueViolation(error))
      throw new AppError(409, 'IMPORT_IN_PROGRESS', 'Another restaurant import is running.');
    throw error;
  }
  setImmediate(() => {
    void runRestaurantImport({
      jobId: job.id,
      bbox,
      dryRun: input.dryRun,
      requestedBy: actor.id,
    }).catch((error) => {
      console.error(
        JSON.stringify({
          event: 'restaurant_import_failed',
          jobId: job.id,
          message: errorMessage(error),
        }),
      );
    });
  });
  return job;
}

export async function importHistory(rawLimit: unknown) {
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .parse(rawLimit ?? 20);
  return importRepository.listImportJobs(limit);
}
