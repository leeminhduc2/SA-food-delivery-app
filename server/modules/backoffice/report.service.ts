import type { User } from '../../shared/types.js';
import { parseTimeRange, REPORT_TIMEZONE, type TimeRange } from '../../shared/time-range.js';
import { assertMember, inventorySummary } from '../catalog/index.js';
import * as reports from './report.repository.js';
import { definitions, duration, successRate } from './domain/metrics.js';
import { operationalSummary } from './operational-monitoring.projection.js';

/** Legacy dashboard; field meanings unchanged (revenue = gross delivered value by creation date). */
export async function report(actor: User): Promise<any> {
  const summary = await reports.summary(actor.role, actor.id);
  const daily = await reports.daily(actor.role, actor.id);
  return {
    ...summary,
    daily,
    revenueBasis:
      'Gross order value including delivery fees, delivered orders only; grouped by order creation date (database UTC).',
  };
}

/** Shared cohort section used by the restaurant and admin reports. */
export async function cohortSection(restaurantId: string | null, range: TimeRange) {
  const {
    delivered: d,
    other,
    placed,
  } = await reports.cohortMetrics(restaurantId, range.from, range.to);
  const gross = Number(d.gross ?? 0);
  return {
    placedOrders: {
      basis: 'Order created_at in [from,to)',
      total: placed.reduce((sum, row) => sum + row.count, 0),
      byStatus: Object.fromEntries(placed.map((row) => [row.status, row.count])),
    },
    delivered: {
      basis: 'Delivery delivered_at in [from,to)',
      count: d.delivered,
      grossDeliveredValue: gross,
      merchandiseValue: Number(d.merchandise ?? 0),
      // Alias kept with the legacy meaning: gross, ship-inclusive, delivered only.
      revenue: gross,
    },
    failed: { basis: 'Delivery failed_at in [from,to)', count: other.failed },
    successRate: successRate(d.delivered, other.failed),
    refunded: {
      basis: 'Refund confirmed_at in [from,to); separate cohort from delivered value',
      count: other.refunded,
      amount: Number(other.refunded_amount ?? 0),
    },
    durations: {
      prep: duration(d.prep_avg, d.prep_n, d.delivered),
      assignmentWait: duration(d.wait_avg, d.wait_n, d.delivered),
      delivery: duration(d.trip_avg, d.trip_n, d.delivered),
    },
    coverage: {
      deliveredWithoutTimestamp: other.legacy_delivered,
      refundsWithoutConfirmationTime: other.legacy_refunds,
    },
  };
}

/** Restaurant members see only their restaurant; Admin may read any restaurant. */
export async function restaurantReport(actor: User, restaurantId: string, query: any) {
  if (actor.role !== 'ADMIN') await assertMember(undefined, actor, restaurantId);
  const range = parseTimeRange(query ?? {});
  return {
    restaurantId,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    timezone: REPORT_TIMEZONE,
    definitions,
    ...(await cohortSection(restaurantId, range)),
    inventory: await inventorySummary(restaurantId),
  };
}

/**
 * Platform KPIs. `live` is the current state (not filtered by time); cohort
 * sections use [from,to). Online means active account + online + fresh
 * heartbeat; ready is a subset; busy is an active assignment. Notification
 * counts are never used as business status.
 */
export async function adminReport(query: any) {
  const range = parseTimeRange(query ?? {});
  const [summary, inTransit] = await Promise.all([operationalSummary(), reports.inTransitCount()]);
  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    timezone: REPORT_TIMEZONE,
    definitions: {
      ...definitions,
      online: 'Active account, online and heartbeat within the allowed age.',
      ready: 'Online drivers who also accept new offers.',
      busy: 'Drivers holding an active assignment (independent of online/ready).',
      searching: 'Live assignment searches (waiting, searching or offered).',
    },
    live: {
      asOf: new Date().toISOString(),
      drivers: { online: summary.online, ready: summary.ready, busy: summary.busy },
      searching: summary.pendingSearches,
      inTransit,
      awaitingPayment: summary.pendingPayments,
    },
    ...(await cohortSection(null, range)),
  };
}
