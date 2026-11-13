import { transaction } from '../../shared/db.js';
import { check } from '../../shared/errors.js';
import * as audits from '../../shared/audit.repository.js';
import type { User } from '../../shared/types.js';
import { alertExists } from './operational-monitoring.projection.js';

export async function acknowledgeAlert(
  actor: User,
  kind: string,
  resourceId: string,
  correlationId?: string,
) {
  check(kind === 'EXHAUSTED' || kind === 'INCIDENT', 400, 'INVALID_ALERT', 'Invalid alert type.');
  check(
    resourceId.length > 0 && resourceId.length <= 128,
    400,
    'INVALID_ALERT',
    'Invalid alert ID.',
  );
  return transaction(async (db) => {
    check(await alertExists(kind, resourceId, db), 404, 'NOT_FOUND', 'Open alert not found.');
    const inserted = await db.$queryRaw<Array<{ acknowledged_at: Date; actor_id: string }>>`
      INSERT INTO operational_alert_acknowledgements (kind, resource_id, actor_id)
      VALUES (${kind}, ${resourceId}, ${actor.id}) ON CONFLICT (kind, resource_id) DO NOTHING
      RETURNING acknowledged_at, actor_id`;
    if (inserted.length)
      await audits.audit(actor.id, 'ALERT_ACKNOWLEDGED', resourceId, { kind }, db, {
        resourceType: 'OPERATIONAL_ALERT',
        outcome: 'SUCCESS',
        correlationId,
      });
    const rows = inserted.length
      ? inserted
      : await db.$queryRaw<
          Array<{ acknowledged_at: Date; actor_id: string }>
        >`SELECT acknowledged_at, actor_id FROM operational_alert_acknowledgements WHERE kind = ${kind} AND resource_id = ${resourceId}`;
    return { acknowledgedAt: rows[0].acknowledged_at, acknowledgedBy: rows[0].actor_id };
  });
}
