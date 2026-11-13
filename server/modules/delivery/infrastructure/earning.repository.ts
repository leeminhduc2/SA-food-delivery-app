import { id, prisma, type DB } from '../../../shared/db.js';

/** One estimate per delivery; a repeated call is a no-op. */
export async function insertEstimate(
  estimate: {
    deliveryId: string;
    orderId: string;
    driverId: string;
    amount: number;
    deliveredAt: Date;
    source: 'DELIVERY_COMPLETED' | 'BACKFILL';
  },
  db: DB,
): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    INSERT INTO driver_earning_estimates (id, delivery_id, order_id, driver_id, amount, delivered_at, source)
    VALUES (${id()}, ${estimate.deliveryId}, ${estimate.orderId}, ${estimate.driverId},
      ${estimate.amount}, ${estimate.deliveredAt}, ${estimate.source})
    ON CONFLICT (delivery_id) DO NOTHING RETURNING id`;
  return rows.length === 1;
}

/** DELIVERED trips without an estimate, in stable id order for resumable batches. */
export async function backfillCandidates(after: string | undefined, limit: number) {
  return prisma.$queryRaw<
    Array<{
      id: string;
      order_id: string;
      driver_id: string | null;
      delivered_at: Date | null;
      final_driver: boolean;
    }>
  >`
    SELECT d.id, d.order_id, d.driver_id, d.delivered_at,
      EXISTS (
        SELECT 1 FROM driver_assignments a
        WHERE a.delivery_id = d.id AND a.driver_id = d.driver_id
          AND a.end_reason IN ('DELIVERED', 'MIGRATION_TERMINAL')
      ) AS final_driver
    FROM deliveries d
    WHERE d.status = 'DELIVERED'
      AND NOT EXISTS (SELECT 1 FROM driver_earning_estimates e WHERE e.delivery_id = d.id)
      AND (${after ?? null}::text IS NULL OR d.id > ${after ?? null})
    ORDER BY d.id LIMIT ${limit}`;
}

export async function driverSummary(driverId: string, from: Date, to: Date) {
  const [row] = await prisma.$queryRaw<
    Array<{
      delivered: number;
      failed: number;
      trip_avg: number | null;
      trip_n: number;
      estimated: bigint | null;
      estimated_n: number;
      without_estimate: number;
    }>
  >`
    SELECT
      (SELECT count(*)::int FROM deliveries WHERE driver_id = ${driverId} AND status = 'DELIVERED'
        AND delivered_at >= ${from} AND delivered_at < ${to}) AS delivered,
      (SELECT count(*)::int FROM deliveries WHERE driver_id = ${driverId} AND status = 'FAILED'
        AND failed_at >= ${from} AND failed_at < ${to}) AS failed,
      (SELECT avg(extract(epoch FROM delivered_at - picked_up_at))::float FROM deliveries
        WHERE driver_id = ${driverId} AND status = 'DELIVERED' AND delivered_at >= ${from}
          AND delivered_at < ${to} AND picked_up_at IS NOT NULL AND delivered_at >= picked_up_at) AS trip_avg,
      (SELECT count(*)::int FROM deliveries
        WHERE driver_id = ${driverId} AND status = 'DELIVERED' AND delivered_at >= ${from}
          AND delivered_at < ${to} AND picked_up_at IS NOT NULL AND delivered_at >= picked_up_at) AS trip_n,
      (SELECT sum(amount)::bigint FROM driver_earning_estimates
        WHERE driver_id = ${driverId} AND delivered_at >= ${from} AND delivered_at < ${to}) AS estimated,
      (SELECT count(*)::int FROM driver_earning_estimates
        WHERE driver_id = ${driverId} AND delivered_at >= ${from} AND delivered_at < ${to}) AS estimated_n,
      (SELECT count(*)::int FROM deliveries d WHERE d.driver_id = ${driverId} AND d.status = 'DELIVERED'
        AND d.delivered_at >= ${from} AND d.delivered_at < ${to}
        AND NOT EXISTS (SELECT 1 FROM driver_earning_estimates e WHERE e.delivery_id = d.id)) AS without_estimate`;
  return row;
}

export async function listEstimates(
  driverId: string,
  from: Date,
  to: Date,
  after: { deliveredAt: Date; id: string } | undefined,
  limit: number,
) {
  return prisma.driverEarningEstimate.findMany({
    where: {
      driver_id: driverId,
      delivered_at: { gte: from, lt: to },
      ...(after
        ? {
            OR: [
              { delivered_at: { lt: after.deliveredAt } },
              { delivered_at: after.deliveredAt, id: { lt: after.id } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      delivery_id: true,
      order_id: true,
      amount: true,
      currency: true,
      delivered_at: true,
      basis: true,
    },
    orderBy: [{ delivered_at: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
}
