import { createHash } from 'node:crypto';
import { z } from 'zod';
import { id, transaction, type DB } from '../../../shared/db.js';
import { AppError, check } from '../../../shared/errors.js';
import type { User } from '../../../shared/types.js';
import * as audits from '../../../shared/audit.repository.js';
import { deliveryConfig } from '../config.js';
import { orderGateway, proofStorage } from '../delivery.ports.js';
import * as deliveries from '../infrastructure/delivery.repository.js';
import * as proofs from '../infrastructure/proof.repository.js';

export const photoTypes = ['image/jpeg', 'image/png'] as const;
type PhotoType = (typeof photoTypes)[number];
const keySchema = z.string().min(8).max(120);
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const proofStatus = ['PICKED_UP', 'IN_TRANSIT'];

/** Magic bytes decide the type; the declared Content-Type must agree with them. */
export function detectPhotoType(bytes: Buffer): PhotoType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= png.length && png.every((byte, index) => bytes[index] === byte))
    return 'image/png';
  return null;
}

export type PhotoUpload = {
  contentType: string | undefined;
  idempotencyKey: unknown;
  body: unknown;
};
type PhotoResult = { proofId: string; method: 'PHOTO'; status: 'VERIFIED' };

async function lockCurrentAssignment(db: DB, actor: User, deliveryId: string) {
  const found = await deliveries.findOrderId(deliveryId, db);
  check(found, 404, 'NOT_FOUND', 'Delivery not found.');
  const order = await orderGateway().lockOrder(db, found.order_id);
  const delivery = await deliveries.findForUpdate(deliveryId, db);
  check(order && delivery, 404, 'NOT_FOUND', 'Delivery not found.');
  check(delivery.driver_id === actor.id, 403, 'FORBIDDEN', 'This delivery is not assigned to you.');
  const assignment = await deliveries.findActiveAssignment(delivery.id, actor.id, db);
  check(assignment, 403, 'FORBIDDEN', 'This delivery is not assigned to you.');
  check(
    proofStatus.includes(delivery.status),
    409,
    'PROOF_NOT_AVAILABLE',
    'Proof is available during delivery.',
  );
  return { order, delivery, assignment };
}

function replay(existing: { id: string; sha256: string | null }, sha256: string): PhotoResult {
  check(
    existing.sha256 === sha256,
    409,
    'IDEMPOTENCY_CONFLICT',
    'This key was used for a different photo.',
  );
  return { proofId: existing.id, method: 'PHOTO', status: 'VERIFIED' };
}

/**
 * Staged write: record the storage key, write the bytes, then attach them to the
 * proof in one transaction that also removes the staging row. A failure after
 * the write deletes the file or leaves the staging row for the cleanup job, so no
 * VERIFIED proof can point at bytes that were never stored.
 */
export async function uploadPhotoProof(
  actor: User,
  deliveryId: string,
  upload: PhotoUpload,
): Promise<PhotoResult> {
  check(actor.role === 'DRIVER', 403, 'FORBIDDEN', 'Driver access required.');
  const key = keySchema.safeParse(upload.idempotencyKey);
  check(key.success, 400, 'VALIDATION', 'X-Idempotency-Key must be 8-120 characters.');
  const declared = upload.contentType?.split(';')[0].trim().toLowerCase();
  check(
    photoTypes.includes(declared as PhotoType) && Buffer.isBuffer(upload.body),
    415,
    'UNSUPPORTED_MEDIA_TYPE',
    'Upload a JPEG or PNG image as the raw request body.',
  );
  const bytes = upload.body as Buffer;
  check(bytes.length > 0, 400, 'VALIDATION', 'The photo is empty.');
  check(
    bytes.length <= deliveryConfig.DELIVERY_PROOF_MAX_BYTES,
    413,
    'PAYLOAD_TOO_LARGE',
    'The photo is too large.',
  );
  check(
    detectPhotoType(bytes) === declared,
    415,
    'UNSUPPORTED_MEDIA_TYPE',
    'The file content is not a valid JPEG or PNG image.',
  );
  const keyHash = digest(key.data),
    sha256 = digest(bytes);

  // Authorize and short-circuit replays before any bytes are written.
  const before = await transaction(async (db) => {
    await lockCurrentAssignment(db, actor, deliveryId);
    return proofs.findPhotoReceipt(deliveryId, actor.id, keyHash, db);
  });
  if (before) return replay(before, sha256);

  const storage = proofStorage();
  const storageKey = storage.newKey();
  await proofs.stageUpload(storageKey, deliveryId);
  try {
    await storage.put(storageKey, bytes);
  } catch {
    await discard(storageKey);
    throw new AppError(503, 'PROOF_STORAGE_UNAVAILABLE', 'The photo could not be stored.');
  }
  let result: PhotoResult | { replayOf: { id: string; sha256: string | null } };
  try {
    result = await transaction(async (db) => {
      const { order, assignment } = await lockCurrentAssignment(db, actor, deliveryId);
      const existing = await proofs.findPhotoReceipt(deliveryId, actor.id, keyHash, db);
      if (existing) return { replayOf: existing };
      check(
        !(await proofs.findVerified(deliveryId, assignment.id, db)),
        409,
        'PROOF_ALREADY_VERIFIED',
        'Delivery proof is already verified.',
      );
      const proofId = id();
      await proofs.insertPhoto(
        {
          id: proofId,
          deliveryId,
          assignmentId: assignment.id,
          driverId: actor.id,
          storageKey,
          contentType: declared!,
          byteSize: bytes.length,
          sha256,
          keyHash,
        },
        db,
      );
      await proofs.unstage(storageKey, db);
      await audits.audit(
        actor.id,
        'DELIVERY_PHOTO_VERIFIED',
        deliveryId,
        { proofId, orderId: order.id, byteSize: bytes.length, contentType: declared },
        db,
        { resourceType: 'DELIVERY', outcome: 'SUCCESS' },
      );
      return { proofId, method: 'PHOTO' as const, status: 'VERIFIED' as const };
    });
  } catch (error) {
    await discard(storageKey);
    throw error;
  }
  if ('replayOf' in result) {
    await discard(storageKey);
    return replay(result.replayOf, sha256);
  }
  return result;
}

/** Best effort; on failure the staging row stays and the cleanup job retries. */
async function discard(storageKey: string): Promise<void> {
  try {
    await proofStorage().remove(storageKey);
    await proofs.unstage(storageKey);
  } catch (error) {
    await proofs
      .recordCleanupFailure(storageKey, error instanceof Error ? error.message : 'unknown')
      .catch(() => undefined);
  }
}

/** Re-authorizes on every read; content is never served from a public path. */
export async function readPhotoProof(actor: User, deliveryId: string, proofId: string) {
  const delivery = await deliveries.findById(deliveryId);
  check(delivery, 404, 'NOT_FOUND', 'Delivery not found.');
  await orderGateway().authorizeViewer(actor, delivery.order_id);
  const proof = await proofs.findById(proofId);
  check(
    proof && proof.delivery_id === deliveryId && proof.method === 'PHOTO',
    404,
    'NOT_FOUND',
    'Proof not found.',
  );
  if (actor.role === 'DRIVER')
    check(
      proof.driver_id === actor.id && delivery.driver_id === actor.id,
      403,
      'FORBIDDEN',
      'This proof belongs to another trip.',
    );
  check(proof.status === 'VERIFIED', 410, 'PROOF_PURGED', 'This photo is no longer retained.');
  const bytes = await proofStorage().read(proof.storage_key!);
  check(bytes, 410, 'PROOF_CONTENT_UNAVAILABLE', 'The photo content is unavailable.');
  return { contentType: proof.content_type!, bytes };
}

/** Removes files whose proof never committed. */
export async function cleanupStagedUploads(
  options: { olderThanSeconds?: number; limit?: number } = {},
): Promise<{ removed: number; failed: number }> {
  const due = await proofs.dueStagedUploads(options.olderThanSeconds ?? 600, options.limit ?? 50);
  let removed = 0,
    failed = 0;
  for (const row of due) {
    try {
      if (!(await proofs.isAttached(row.storage_key))) await proofStorage().remove(row.storage_key);
      await proofs.unstage(row.storage_key);
      removed++;
    } catch (error) {
      failed++;
      await proofs.recordCleanupFailure(
        row.storage_key,
        error instanceof Error ? error.message : 'unknown',
      );
    }
  }
  return { removed, failed };
}
