import { id, prisma, type DB } from '../db.js';
import type { NormalizedRestaurant } from '../domain/osm.js';
import type { Prisma } from '@prisma/client';

export type OsmOwnershipRow = {
  osm_type: string;
  osm_id: string;
  source: string;
  verified: boolean;
  owner_managed: boolean;
};

export type ImportJobRow = {
  id: string;
  requested_by: string;
  endpoint: string;
  bbox: string;
  dry_run: boolean;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  stats: Record<string, unknown>;
  error: string | null;
  started_at: Date | string;
  finished_at: Date | string | null;
};

/**
 * Insert a new imported establishment as unverified/PENDING, or refresh the
 * OSM-owned fields of an existing imported row.
 *
 * This is an intentional raw-SQL exception: the protected update predicate,
 * partial unique index conflict target and `xmax = 0` insert detection have no
 * Prisma Client equivalent. All values are parameterised.
 */
export async function upsertImportedRestaurant(
  record: NormalizedRestaurant,
  db: DB = prisma,
): Promise<{ id: string; inserted: boolean } | undefined> {
  const rows = await db.$queryRaw<{ id: string; inserted: boolean }[]>`
    INSERT INTO restaurants(
      id,name,description,address,cuisine,image,status,delivery_fee,eta_minutes,
      osm_type,osm_id,source,verified,owner_managed,latitude,longitude,phone,website,
      opening_hours,address_tags,osm_tags,imported_at,last_synced_at
    ) VALUES(
      ${id()},${record.name},${''},${record.address ?? ''},${record.cuisine ?? ''},${''},
      ${'PENDING'},${0},${30},${record.osmType},${record.osmId},${'OSM'},${false},${false},
      ${record.latitude},${record.longitude},${record.phone},${record.website},
      ${record.openingHours},${JSON.stringify(record.addressTags)}::jsonb,
      ${JSON.stringify(record.tags)}::jsonb,now(),now()
    )
    ON CONFLICT (osm_type, osm_id) WHERE osm_type IS NOT NULL AND osm_id IS NOT NULL
    DO UPDATE SET
      name=CASE WHEN restaurants.source='OSM' AND NOT restaurants.verified AND NOT restaurants.owner_managed THEN EXCLUDED.name ELSE restaurants.name END,
      cuisine=CASE WHEN restaurants.source='OSM' AND NOT restaurants.verified AND NOT restaurants.owner_managed THEN EXCLUDED.cuisine ELSE restaurants.cuisine END,
      address=CASE WHEN restaurants.source='OSM' AND NOT restaurants.verified AND NOT restaurants.owner_managed THEN EXCLUDED.address ELSE restaurants.address END,
      latitude=CASE WHEN restaurants.source='OSM' AND NOT restaurants.verified AND NOT restaurants.owner_managed THEN EXCLUDED.latitude ELSE restaurants.latitude END,
      longitude=CASE WHEN restaurants.source='OSM' AND NOT restaurants.verified AND NOT restaurants.owner_managed THEN EXCLUDED.longitude ELSE restaurants.longitude END,
      phone=CASE WHEN restaurants.source='OSM' AND NOT restaurants.verified AND NOT restaurants.owner_managed THEN EXCLUDED.phone ELSE restaurants.phone END,
      website=CASE WHEN restaurants.source='OSM' AND NOT restaurants.verified AND NOT restaurants.owner_managed THEN EXCLUDED.website ELSE restaurants.website END,
      opening_hours=CASE WHEN restaurants.source='OSM' AND NOT restaurants.verified AND NOT restaurants.owner_managed THEN EXCLUDED.opening_hours ELSE restaurants.opening_hours END,
      address_tags=CASE WHEN restaurants.source='OSM' AND NOT restaurants.verified AND NOT restaurants.owner_managed THEN EXCLUDED.address_tags ELSE restaurants.address_tags END,
      osm_tags=EXCLUDED.osm_tags,
      last_synced_at=now()
    WHERE restaurants.source='OSM' AND NOT restaurants.verified AND NOT restaurants.owner_managed
    RETURNING id, (xmax = 0) AS inserted
  `;
  return rows[0];
}

/** Read-only ownership snapshot used to classify records in dry-run mode. */
export async function findOsmOwnership(
  records: Pick<NormalizedRestaurant, 'osmType' | 'osmId'>[],
  db: DB = prisma,
): Promise<Map<string, OsmOwnershipRow>> {
  const result = new Map<string, OsmOwnershipRow>();
  for (let offset = 0; offset < records.length; offset += 200) {
    const chunk = records.slice(offset, offset + 200);
    const rows = await db.restaurant.findMany({
      where: {
        OR: chunk.map((record) => ({ osm_type: record.osmType, osm_id: record.osmId })),
      },
      select: {
        osm_type: true,
        osm_id: true,
        source: true,
        verified: true,
        owner_managed: true,
      },
    });
    for (const row of rows)
      if (row.osm_type !== null && row.osm_id !== null)
        result.set(`${row.osm_type}/${row.osm_id}`, row as OsmOwnershipRow);
  }
  return result;
}

/** Recover jobs left RUNNING by a crashed process, then create a new job row. */
export async function createImportJob(
  input: { requestedBy: string; endpoint: string; bbox: string; dryRun: boolean },
  db: DB = prisma,
): Promise<ImportJobRow> {
  await db.restaurantImportJob.updateMany({
    where: {
      status: 'RUNNING',
      started_at: { lt: new Date(Date.now() - 15 * 60 * 1000) },
    },
    data: {
      status: 'FAILED',
      error: 'Import process stopped before completion.',
      finished_at: new Date(),
    },
  });
  const job = await db.restaurantImportJob.create({
    data: {
      id: id(),
      requested_by: input.requestedBy,
      endpoint: input.endpoint,
      bbox: input.bbox,
      dry_run: input.dryRun,
      status: 'RUNNING',
    },
  });
  return job as ImportJobRow;
}

export async function finishImportJob(
  jobId: string,
  status: 'SUCCEEDED' | 'FAILED',
  stats: Record<string, unknown>,
  error: string | null = null,
  db: DB = prisma,
): Promise<void> {
  await db.restaurantImportJob.updateMany({
    where: { id: jobId },
    data: {
      status,
      stats: stats as Prisma.InputJsonValue,
      error,
      finished_at: new Date(),
    },
  });
}

export async function listImportJobs(limit = 20, db: DB = prisma): Promise<ImportJobRow[]> {
  const rows = await db.restaurantImportJob.findMany({
    orderBy: { started_at: 'desc' },
    take: limit,
  });
  return rows as ImportJobRow[];
}

export async function findImportJob(
  jobId: string,
  db: DB = prisma,
): Promise<ImportJobRow | undefined> {
  return (
    ((await db.restaurantImportJob.findUnique({ where: { id: jobId } })) as ImportJobRow | null) ??
    undefined
  );
}
