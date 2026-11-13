import { prisma } from '../../shared/db.js';

/**
 * Read-only view over the durable work queues of several modules (projection
 * exception). Each row: how many items wait, how old the oldest is, when the
 * next retry is due and the last recorded error. Nothing here writes.
 */
export async function backlogRows() {
  const rows = await prisma.$queryRaw<
    Array<{
      queue: string;
      pending: number;
      failed: number;
      oldest_at: Date | null;
      next_run_at: Date | null;
      last_error: string | null;
    }>
  >`
    SELECT 'notifications' AS queue,
      count(*) FILTER (WHERE processed_at IS NULL)::int AS pending,
      count(*) FILTER (WHERE processed_at IS NULL AND attempts >= 5)::int AS failed,
      min(available_at) FILTER (WHERE processed_at IS NULL) AS oldest_at,
      min(available_at) FILTER (WHERE processed_at IS NULL AND attempts < 5) AS next_run_at,
      (SELECT last_error FROM outbox WHERE processed_at IS NULL AND last_error IS NOT NULL
        ORDER BY available_at DESC LIMIT 1) AS last_error
    FROM outbox
    UNION ALL
    SELECT 'refunds',
      count(*) FILTER (WHERE status IN ('APPROVED','PROCESSING'))::int,
      count(*) FILTER (WHERE status = 'FAILED')::int,
      min(created_at) FILTER (WHERE status IN ('APPROVED','PROCESSING','FAILED')),
      min(next_attempt_at) FILTER (WHERE status IN ('APPROVED','PROCESSING')),
      (SELECT last_error FROM refund_requests WHERE last_error IS NOT NULL
        AND status IN ('PROCESSING','FAILED') ORDER BY updated_at DESC LIMIT 1)
    FROM refund_requests
    UNION ALL
    SELECT 'assignment_searches',
      count(*) FILTER (WHERE status IN ('WAITING','SEARCHING','OFFERED'))::int,
      count(*) FILTER (WHERE status = 'EXHAUSTED' AND NOT EXISTS (
        SELECT 1 FROM operational_alert_acknowledgements a
        WHERE a.kind = 'EXHAUSTED' AND a.resource_id = s.id))::int,
      min(created_at) FILTER (WHERE status IN ('WAITING','SEARCHING','OFFERED')),
      min(next_run_at) FILTER (WHERE status IN ('WAITING','SEARCHING','OFFERED')),
      NULL
    FROM assignment_searches s
    UNION ALL
    SELECT 'driver_invalidation',
      count(*) FILTER (WHERE processed_at IS NULL)::int,
      0,
      min(created_at) FILTER (WHERE processed_at IS NULL),
      min(due_at) FILTER (WHERE processed_at IS NULL),
      NULL
    FROM driver_operational_changes
    UNION ALL
    SELECT 'payment_reconciliation',
      count(*) FILTER (WHERE status IN ('PENDING','REFUND_PENDING'))::int,
      count(*) FILTER (WHERE reconciliation_required)::int,
      min(created_at) FILTER (WHERE status IN ('PENDING','REFUND_PENDING')),
      min(next_reconcile_at) FILTER (WHERE status IN ('PENDING','REFUND_PENDING')),
      NULL
    FROM payments
    UNION ALL
    SELECT 'proof_upload_cleanup',
      count(*)::int,
      count(*) FILTER (WHERE attempts > 0)::int,
      min(created_at),
      min(next_attempt_at),
      (SELECT last_error FROM delivery_proof_uploads WHERE last_error IS NOT NULL
        ORDER BY next_attempt_at DESC LIMIT 1)
    FROM delivery_proof_uploads`;
  return rows.map((row) => ({
    queue: row.queue,
    pending: row.pending,
    failed: row.failed,
    oldestAt: row.oldest_at,
    nextRunAt: row.next_run_at,
    lastError: row.last_error,
  }));
}
