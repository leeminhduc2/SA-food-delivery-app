import { prisma, type DB } from '../../../shared/db.js';

export type ProofRow = {
  id: string;
  delivery_id: string;
  assignment_id: string;
  method: string;
  status: string;
  driver_id: string | null;
  storage_key: string | null;
  content_type: string | null;
  sha256: string | null;
};

export async function findById(proofId: string, db: DB = prisma): Promise<ProofRow | undefined> {
  return (await db.deliveryProof.findUnique({ where: { id: proofId } })) ?? undefined;
}

export async function findPhotoReceipt(
  deliveryId: string,
  driverId: string,
  keyHash: string,
  db: DB,
): Promise<{ id: string; sha256: string | null } | undefined> {
  return (
    (await db.deliveryProof.findFirst({
      where: { delivery_id: deliveryId, driver_id: driverId, key_hash: keyHash, method: 'PHOTO' },
      select: { id: true, sha256: true },
    })) ?? undefined
  );
}

export async function findVerified(
  deliveryId: string,
  assignmentId: string,
  db: DB = prisma,
): Promise<{ id: string; method: string } | undefined> {
  return (
    (await db.deliveryProof.findFirst({
      where: { delivery_id: deliveryId, assignment_id: assignmentId, status: 'VERIFIED' },
      select: { id: true, method: true },
      orderBy: { created_at: 'asc' },
    })) ?? undefined
  );
}

export async function insertPhoto(
  proof: {
    id: string;
    deliveryId: string;
    assignmentId: string;
    driverId: string;
    storageKey: string;
    contentType: string;
    byteSize: number;
    sha256: string;
    keyHash: string;
  },
  db: DB,
): Promise<void> {
  await db.deliveryProof.create({
    data: {
      id: proof.id,
      delivery_id: proof.deliveryId,
      assignment_id: proof.assignmentId,
      method: 'PHOTO',
      status: 'VERIFIED',
      driver_id: proof.driverId,
      storage_key: proof.storageKey,
      content_type: proof.contentType,
      byte_size: proof.byteSize,
      sha256: proof.sha256,
      key_hash: proof.keyHash,
    },
  });
}

export async function stageUpload(storageKey: string, deliveryId: string): Promise<void> {
  await prisma.deliveryProofUpload.create({
    data: { storage_key: storageKey, delivery_id: deliveryId },
  });
}

export async function unstage(storageKey: string, db: DB = prisma): Promise<void> {
  await db.deliveryProofUpload.deleteMany({ where: { storage_key: storageKey } });
}

export async function isAttached(storageKey: string): Promise<boolean> {
  return Boolean(
    await prisma.deliveryProof.findUnique({
      where: { storage_key: storageKey },
      select: { id: true },
    }),
  );
}

export async function recordCleanupFailure(storageKey: string, message: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE delivery_proof_uploads
    SET attempts = attempts + 1, last_error = ${message.slice(0, 300)},
        next_attempt_at = clock_timestamp() + LEAST(3600, 30 * power(2, attempts)) * interval '1 second'
    WHERE storage_key = ${storageKey}`;
}

export async function dueStagedUploads(olderThanSeconds: number, limit: number) {
  return prisma.$queryRaw<Array<{ storage_key: string }>>`
    SELECT storage_key FROM delivery_proof_uploads
    WHERE created_at <= clock_timestamp() - ${olderThanSeconds} * interval '1 second'
      AND next_attempt_at <= clock_timestamp()
    ORDER BY created_at, storage_key LIMIT ${limit}`;
}

/** Photos past retention whose delivery is terminal and has no open incident. */
export async function purgeCandidates(now: Date, retentionDays: number, limit: number) {
  return prisma.$queryRaw<
    Array<{ id: string; delivery_id: string; order_id: string; storage_key: string }>
  >`
    SELECT p.id, p.delivery_id, d.order_id, p.storage_key
    FROM delivery_proofs p JOIN deliveries d ON d.id = p.delivery_id
    WHERE p.method = 'PHOTO' AND p.status IN ('VERIFIED','PURGING')
      AND d.status IN ('DELIVERED','FAILED','CANCELLED')
      AND COALESCE(d.delivered_at, d.failed_at, d.updated_at) <= ${now}::timestamptz - ${retentionDays} * interval '1 day'
      AND NOT EXISTS (SELECT 1 FROM delivery_incidents i WHERE i.delivery_id = d.id AND i.status = 'OPEN')
    ORDER BY p.created_at, p.id LIMIT ${limit}`;
}

export async function markPurging(proofId: string): Promise<boolean> {
  const result = await prisma.deliveryProof.updateMany({
    where: { id: proofId, status: { in: ['VERIFIED', 'PURGING'] } },
    data: { status: 'PURGING' },
  });
  return result.count === 1;
}

export async function markPurged(proofId: string, now: Date, db: DB): Promise<boolean> {
  const result = await db.deliveryProof.updateMany({
    where: { id: proofId, status: 'PURGING' },
    data: { status: 'PURGED', purged_at: now },
  });
  return result.count === 1;
}
