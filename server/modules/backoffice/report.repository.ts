import { prisma, type DB } from '../../shared/db.js';
import type { Prisma } from '@prisma/client';

function accessWhere(role: string, userId: string): Prisma.OrderWhereInput {
  return role === 'ADMIN' ? {} : { restaurant: { members: { some: { user_id: userId } } } };
}

export async function summary(role: string, userId: string, db: DB = prisma): Promise<any> {
  const groups = await db.order.groupBy({
    by: ['status'],
    where: accessWhere(role, userId),
    _count: { _all: true },
    _sum: { total: true },
  });
  let orders = 0;
  let delivered = 0;
  let delivery_failed = 0;
  let revenue = 0;
  let pending = 0;
  for (const group of groups) {
    const count = group._count._all;
    orders += count;
    if (group.status === 'DELIVERED') {
      delivered += count;
      revenue += group._sum.total ?? 0;
    }
    if (group.status === 'DELIVERY_FAILED') delivery_failed += count;
    if (group.status === 'PENDING_PAYMENT') pending += count;
  }
  return { orders, delivered, delivery_failed, revenue, pending };
}

export async function daily(role: string, userId: string, db: DB = prisma): Promise<any[]> {
  const rows = await db.order.findMany({
    where: {
      ...accessWhere(role, userId),
      created_at: { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
    },
    select: { created_at: true, status: true, total: true },
  });
  const days = new Map<string, { day: string; orders: number; revenue: number }>();
  for (const row of rows) {
    const day = row.created_at.toISOString().slice(0, 10);
    const entry = days.get(day) ?? { day, orders: 0, revenue: 0 };
    entry.orders++;
    if (row.status === 'DELIVERED') entry.revenue += row.total;
    days.set(day, entry);
  }
  return [...days.values()].sort((a, b) => b.day.localeCompare(a.day)).slice(0, 14);
}

/**
 * Cohort metrics for one restaurant, or every restaurant when `restaurantId` is
 * null. Each cohort uses its own business timestamp in [from,to); rows missing
 * that timestamp are counted as coverage gaps instead of being placed by
 * created_at.
 */
export async function cohortMetrics(restaurantId: string | null, from: Date, to: Date) {
  const scope = restaurantId;
  const [delivered] = await prisma.$queryRaw<
    Array<{
      delivered: number;
      gross: bigint | null;
      merchandise: bigint | null;
      prep_avg: number | null;
      prep_n: number;
      wait_avg: number | null;
      wait_n: number;
      trip_avg: number | null;
      trip_n: number;
    }>
  >`
    WITH cohort AS (
      SELECT o.id, o.total, o.subtotal, d.id AS delivery_id, d.picked_up_at, d.delivered_at
      FROM orders o JOIN deliveries d ON d.order_id = o.id
      WHERE o.status = 'DELIVERED' AND d.delivered_at >= ${from} AND d.delivered_at < ${to}
        AND (${scope}::text IS NULL OR o.restaurant_id = ${scope})
    ), marks AS (
      SELECT c.*,
        (SELECT min(h.created_at) FROM state_history h WHERE h.order_id = c.id AND h.entity = 'ORDER' AND h.to_state = 'ACCEPTED') AS accepted_at,
        (SELECT min(h.created_at) FROM state_history h WHERE h.order_id = c.id AND h.entity = 'ORDER' AND h.to_state = 'READY_FOR_PICKUP') AS ready_at,
        (SELECT min(a.assigned_at) FROM driver_assignments a WHERE a.delivery_id = c.delivery_id) AS assigned_at
      FROM cohort c
    )
    SELECT count(*)::int AS delivered, sum(total)::bigint AS gross, sum(subtotal)::bigint AS merchandise,
      avg(extract(epoch FROM ready_at - accepted_at)) FILTER (WHERE ready_at IS NOT NULL AND accepted_at IS NOT NULL AND ready_at >= accepted_at)::float AS prep_avg,
      count(*) FILTER (WHERE ready_at IS NOT NULL AND accepted_at IS NOT NULL AND ready_at >= accepted_at)::int AS prep_n,
      avg(extract(epoch FROM assigned_at - accepted_at)) FILTER (WHERE assigned_at IS NOT NULL AND accepted_at IS NOT NULL AND assigned_at >= accepted_at)::float AS wait_avg,
      count(*) FILTER (WHERE assigned_at IS NOT NULL AND accepted_at IS NOT NULL AND assigned_at >= accepted_at)::int AS wait_n,
      avg(extract(epoch FROM delivered_at - picked_up_at)) FILTER (WHERE picked_up_at IS NOT NULL AND delivered_at >= picked_up_at)::float AS trip_avg,
      count(*) FILTER (WHERE picked_up_at IS NOT NULL AND delivered_at >= picked_up_at)::int AS trip_n
    FROM marks`;
  const [other] = await prisma.$queryRaw<
    Array<{
      failed: number;
      refunded: number;
      refunded_amount: bigint | null;
      legacy_delivered: number;
      legacy_refunds: number;
    }>
  >`
    SELECT
      (SELECT count(*)::int FROM deliveries d JOIN orders o ON o.id = d.order_id
        WHERE d.status = 'FAILED' AND d.failed_at >= ${from} AND d.failed_at < ${to}
          AND (${scope}::text IS NULL OR o.restaurant_id = ${scope})) AS failed,
      (SELECT count(*)::int FROM refund_requests r JOIN orders o ON o.id = r.order_id
        WHERE r.status = 'SUCCEEDED' AND r.confirmed_at >= ${from} AND r.confirmed_at < ${to}
          AND (${scope}::text IS NULL OR o.restaurant_id = ${scope})) AS refunded,
      (SELECT sum(r.amount)::bigint FROM refund_requests r JOIN orders o ON o.id = r.order_id
        WHERE r.status = 'SUCCEEDED' AND r.confirmed_at >= ${from} AND r.confirmed_at < ${to}
          AND (${scope}::text IS NULL OR o.restaurant_id = ${scope})) AS refunded_amount,
      (SELECT count(*)::int FROM orders o JOIN deliveries d ON d.order_id = o.id
        WHERE o.status = 'DELIVERED' AND d.delivered_at IS NULL
          AND (${scope}::text IS NULL OR o.restaurant_id = ${scope})) AS legacy_delivered,
      (SELECT count(*)::int FROM refund_requests r JOIN orders o ON o.id = r.order_id
        WHERE r.status = 'SUCCEEDED' AND r.confirmed_at IS NULL
          AND (${scope}::text IS NULL OR o.restaurant_id = ${scope})) AS legacy_refunds`;
  const placed = await prisma.$queryRaw<Array<{ status: string; count: number }>>`
    SELECT status, count(*)::int AS count FROM orders
    WHERE created_at >= ${from} AND created_at < ${to}
      AND (${scope}::text IS NULL OR restaurant_id = ${scope})
    GROUP BY status ORDER BY status`;
  return { delivered, other, placed };
}

export async function inTransitCount(): Promise<number> {
  const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM deliveries WHERE status IN ('PICKED_UP', 'IN_TRANSIT')`;
  return row.n;
}
