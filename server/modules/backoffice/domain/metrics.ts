/**
 * Pure metric definitions shared by restaurant, driver and admin reports.
 * Missing data is reported as null plus coverage, never as zero.
 */
export type Coverage = { withData: number; total: number };
export type DurationMetric = { averageMinutes: number | null; coverage: Coverage };

/** null when the denominator is zero; never NaN or Infinity. */
export function rate(numerator: number, denominator: number): number | null {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

export function duration(
  averageSeconds: number | null | undefined,
  withData: number,
  total: number,
): DurationMetric {
  return {
    averageMinutes:
      withData > 0 && averageSeconds !== null && averageSeconds !== undefined
        ? Math.round((averageSeconds / 60) * 10) / 10
        : null,
    coverage: { withData, total },
  };
}

/** Success rate over the terminal cohort: delivered / (delivered + failed). */
export function successRate(delivered: number, failed: number): number | null {
  return rate(delivered, delivered + failed);
}

export const definitions = {
  grossDeliveredValue:
    'Sum of order total (merchandise plus delivery fee) for orders whose delivery was completed in [from,to). Not the amount a restaurant receives.',
  merchandiseValue:
    'Sum of order subtotal (items only) for the same delivered cohort. Not a payout.',
  refundedAmount:
    'Sum of refunds confirmed by the payment simulator in [from,to), by confirmation time. A separate cohort; do not subtract from delivered value.',
  prepDuration: 'Ready for pickup minus accepted, from order history, for the delivered cohort.',
  assignmentWait: 'First driver assignment minus accepted, for the delivered cohort.',
  deliveryDuration: 'Delivered minus picked up, for the delivered cohort.',
  successRate:
    'Delivered / (delivered + failed) for deliveries that reached a terminal state in [from,to).',
  estimatedEarnings:
    'Simulated estimate: 100% of the delivery fee snapshot of each delivered trip. Not a payout; customer refunds do not change it.',
} as const;
