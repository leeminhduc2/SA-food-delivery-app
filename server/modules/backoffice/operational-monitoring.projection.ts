import { prisma, type DB } from '../../shared/db.js';
import { assignmentConfig } from '../assignment/index.js';

export async function alertExists(kind: string, resourceId: string, db: DB) {
  const rows =
    kind === 'EXHAUSTED'
      ? await db.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM assignment_searches WHERE id = ${resourceId} AND status = 'EXHAUSTED'`
      : await db.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM delivery_incidents WHERE id = ${resourceId} AND status = 'OPEN'`;
  return rows.length > 0;
}

export async function operationalSummary() {
  const [drivers] = await prisma.$queryRaw<Array<{ online: bigint; ready: bigint; busy: bigint }>>`
    SELECT
      count(*) FILTER (WHERE u.active AND a.online AND a.heartbeat_at >= now() - ${assignmentConfig.DRIVER_HEARTBEAT_MAX_AGE_SECONDS} * interval '1 second') AS online,
      count(*) FILTER (WHERE u.active AND a.online AND a.ready AND a.heartbeat_at >= now() - ${assignmentConfig.DRIVER_HEARTBEAT_MAX_AGE_SECONDS} * interval '1 second') AS ready,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM driver_assignments da WHERE da.driver_id = u.id AND da.active)) AS busy
    FROM users u LEFT JOIN driver_availability a ON a.driver_id = u.id
    WHERE u.role = 'DRIVER'`;
  const [counts] = await prisma.$queryRaw<Array<{ searches: bigint; payments: bigint }>>`
    SELECT (SELECT count(*) FROM assignment_searches WHERE status IN ('WAITING', 'SEARCHING', 'OFFERED')) AS searches,
      (SELECT count(*) FROM orders WHERE status = 'PENDING_PAYMENT') AS payments`;
  return {
    online: Number(drivers.online),
    ready: Number(drivers.ready),
    busy: Number(drivers.busy),
    pendingSearches: Number(counts.searches),
    pendingPayments: Number(counts.payments),
    heartbeatMaxAgeSeconds: assignmentConfig.DRIVER_HEARTBEAT_MAX_AGE_SECONDS,
  };
}

export async function operationalAlerts() {
  return prisma.$queryRaw<
    Array<{
      kind: string;
      resourceId: string;
      deliveryId: string;
      reason: string | null;
      createdAt: Date;
      acknowledgedAt: Date | null;
      acknowledgedBy: string | null;
    }>
  >`
    SELECT 'EXHAUSTED' AS kind, s.id AS "resourceId", s.delivery_id AS "deliveryId",
      e.reason, s.updated_at AS "createdAt", a.acknowledged_at AS "acknowledgedAt", a.actor_id AS "acknowledgedBy"
    FROM assignment_searches s
    LEFT JOIN LATERAL (SELECT reason FROM assignment_search_events WHERE search_id = s.id AND event = 'EXHAUSTED' ORDER BY created_at DESC, id DESC LIMIT 1) e ON true
    LEFT JOIN operational_alert_acknowledgements a ON a.kind = 'EXHAUSTED' AND a.resource_id = s.id
    WHERE s.status = 'EXHAUSTED'
    UNION ALL
    SELECT 'INCIDENT', i.id, i.delivery_id, i.reason, i.created_at, a.acknowledged_at, a.actor_id
    FROM delivery_incidents i
    LEFT JOIN operational_alert_acknowledgements a ON a.kind = 'INCIDENT' AND a.resource_id = i.id
    WHERE i.status = 'OPEN'
    ORDER BY "createdAt" DESC, "resourceId" DESC LIMIT 100`;
}
