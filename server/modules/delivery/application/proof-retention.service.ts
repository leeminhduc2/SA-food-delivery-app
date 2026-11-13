import { dbNow, transaction } from '../../../shared/db.js';
import * as audits from '../../../shared/audit.repository.js';
import { deliveryConfig } from '../config.js';
import { proofHolds, proofStorage } from '../delivery.ports.js';
import * as proofs from '../infrastructure/proof.repository.js';

/**
 * Deletes photo bytes after the retention window. Open complaints (Support) and
 * open delivery incidents hold the file. Metadata and audit stay; a failed
 * delete leaves the proof PURGING so it is retried and never served.
 */
export async function purgeExpiredProofPhotos(
  options: { now?: Date; retentionDays?: number; limit?: number } = {},
): Promise<{ purged: number; held: number; failed: number }> {
  const now = options.now ?? (await dbNow());
  const candidates = await proofs.purgeCandidates(
    now,
    options.retentionDays ?? deliveryConfig.DELIVERY_PROOF_RETENTION_DAYS,
    options.limit ?? 50,
  );
  let purged = 0,
    held = 0,
    failed = 0;
  for (const candidate of candidates) {
    if (await proofHolds().hasOpenComplaint(candidate.order_id)) {
      held++;
      continue;
    }
    if (!(await proofs.markPurging(candidate.id))) continue;
    try {
      await proofStorage().remove(candidate.storage_key);
    } catch {
      failed++;
      continue;
    }
    await transaction(async (db) => {
      if (await proofs.markPurged(candidate.id, now, db))
        await audits.audit(
          'system',
          'DELIVERY_PHOTO_PURGED',
          candidate.delivery_id,
          { proofId: candidate.id },
          db,
          { resourceType: 'DELIVERY', outcome: 'SUCCESS' },
        );
    });
    purged++;
  }
  return { purged, held, failed };
}
