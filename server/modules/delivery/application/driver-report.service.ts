import { z } from 'zod';
import { transaction, type DB } from '../../../shared/db.js';
import { AppError, check } from '../../../shared/errors.js';
import { subscribe } from '../../../shared/events.js';
import { parseTimeRange, REPORT_TIMEZONE } from '../../../shared/time-range.js';
import type { User } from '../../../shared/types.js';
import { orderGateway } from '../delivery.ports.js';
import * as deliveries from '../infrastructure/delivery.repository.js';
import * as earnings from '../infrastructure/earning.repository.js';

export const ESTIMATE_LABEL =
  'Simulated estimate: 100% of each delivered trip’s delivery fee. Not a payout; customer refunds do not change it.';

/**
 * Creates the estimate in the DeliveryCompleted transaction. The fee comes
 * from the order's checkout snapshot through the Ordering gateway; a repeated
 * event finds the existing row and writes nothing.
 */
export async function recordEstimateOnCompletion(db: DB, orderId: string): Promise<boolean> {
  const order = await orderGateway().lockOrder(db, orderId);
  const delivery = await deliveries.findByOrderForUpdate(orderId, db);
  if (!order || !delivery || delivery.status !== 'DELIVERED' || !delivery.driver_id) return false;
  const row = await db.delivery.findUnique({
    where: { id: delivery.id },
    select: { delivered_at: true },
  });
  if (!row?.delivered_at) return false;
  return earnings.insertEstimate(
    {
      deliveryId: delivery.id,
      orderId,
      driverId: delivery.driver_id,
      amount: order.deliveryFee,
      deliveredAt: row.delivered_at,
      source: 'DELIVERY_COMPLETED',
    },
    db,
  );
}

let registered = false;
export function registerDeliveryHandlers(): void {
  if (registered) return;
  registered = true;
  subscribe('DeliveryCompleted', async (db, event) => {
    await recordEstimateOnCompletion(db, event.orderId);
  });
}

/**
 * Legacy backfill. Creates an estimate only when the final driver, delivery
 * time and fee snapshot are known; everything else is reported, never guessed.
 * Idempotent and resumable by delivery id.
 */
export async function backfillEarningEstimates(options: { batch?: number } = {}) {
  const report = { inspected: 0, created: 0, missingDeliveredAt: 0, missingFinalDriver: 0 };
  let after: string | undefined;
  for (;;) {
    const rows = await earnings.backfillCandidates(after, options.batch ?? 100);
    if (!rows.length) break;
    for (const row of rows) {
      report.inspected++;
      if (!row.delivered_at) {
        report.missingDeliveredAt++;
        continue;
      }
      if (!row.driver_id || !row.final_driver) {
        report.missingFinalDriver++;
        continue;
      }
      const created = await transaction(async (db) => {
        const order = await orderGateway().lockOrder(db, row.order_id);
        if (!order) return false;
        return earnings.insertEstimate(
          {
            deliveryId: row.id,
            orderId: row.order_id,
            driverId: row.driver_id!,
            amount: order.deliveryFee,
            deliveredAt: row.delivered_at!,
            source: 'BACKFILL',
          },
          db,
        );
      });
      if (created) report.created++;
    }
    after = rows.at(-1)!.id;
  }
  return report;
}

const round = (seconds: number | null, n: number) =>
  n > 0 && seconds !== null ? Math.round((seconds / 60) * 10) / 10 : null;

/** The driver's own performance; another driver's trips are never included. */
export async function driverReport(actor: User, query: unknown) {
  check(actor.role === 'DRIVER', 403, 'FORBIDDEN', 'Driver access required.');
  const range = parseTimeRange((query ?? {}) as any);
  const row = await earnings.driverSummary(actor.id, range.from, range.to);
  const terminal = row.delivered + row.failed;
  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    timezone: REPORT_TIMEZONE,
    delivered: row.delivered,
    failed: row.failed,
    successRate: terminal ? Math.round((row.delivered / terminal) * 10000) / 10000 : null,
    averageDeliveryMinutes: round(row.trip_avg, row.trip_n),
    durationCoverage: { withData: row.trip_n, total: row.delivered },
    estimatedEarnings: {
      amount: Number(row.estimated ?? 0),
      trips: row.estimated_n,
      currency: 'VND',
      basis: 'SIMULATED_ESTIMATE',
      label: ESTIMATE_LABEL,
      deliveredWithoutEstimate: row.without_estimate,
    },
  };
}

export async function driverEarnings(actor: User, query: unknown) {
  check(actor.role === 'DRIVER', 403, 'FORBIDDEN', 'Driver access required.');
  const input = z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(25),
      cursor: z.string().max(400).optional(),
      from: z.string().optional(),
      to: z.string().optional(),
    })
    .parse(query ?? {});
  const range = parseTimeRange(input, { maxDays: 3660, defaultDays: 3650 });
  let after: { deliveredAt: Date; id: string } | undefined;
  if (input.cursor) {
    try {
      const [time, cursorId] = JSON.parse(Buffer.from(input.cursor, 'base64url').toString());
      after = { deliveredAt: new Date(time), id: String(cursorId) };
      if (Number.isNaN(after.deliveredAt.getTime())) throw new Error('bad');
    } catch {
      throw new AppError(400, 'INVALID_CURSOR', 'Invalid cursor.');
    }
  }
  const rows = await earnings.listEstimates(actor.id, range.from, range.to, after, input.limit);
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    label: ESTIMATE_LABEL,
    items: page.map((row) => ({
      deliveryId: row.delivery_id,
      orderId: row.order_id,
      amount: row.amount,
      currency: row.currency,
      deliveredAt: row.delivered_at,
      basis: row.basis,
    })),
    nextCursor:
      rows.length > input.limit && last
        ? Buffer.from(JSON.stringify([last.delivered_at.toISOString(), last.id])).toString(
            'base64url',
          )
        : null,
  };
}
