import { AppError } from './errors.js';

/** ISO 8601 with an explicit zone (Z or ±hh:mm); local wall-clock strings are rejected. */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
export const REPORT_TIMEZONE = 'Asia/Saigon';

export type TimeRange = { from: Date; to: Date };

/**
 * Report filter `[from, to)`. Both bounds are absolute instants; the UI turns a
 * local Asia/Saigon day into `YYYY-MM-DDT00:00:00+07:00`. Missing bounds default
 * to the last `defaultDays` ending at `now`.
 */
export function parseTimeRange(
  query: { from?: unknown; to?: unknown },
  options: { now?: Date; defaultDays?: number; maxDays?: number } = {},
): TimeRange {
  const now = options.now ?? new Date();
  const parse = (value: unknown, name: string): Date | undefined => {
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string' || !ISO_WITH_ZONE.test(value))
      throw new AppError(
        400,
        'INVALID_TIME_RANGE',
        `${name} must be an ISO 8601 timestamp with a time zone.`,
      );
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
      throw new AppError(400, 'INVALID_TIME_RANGE', `${name} is not a valid date.`);
    return date;
  };
  const to = parse(query.to, 'to') ?? now;
  const from =
    parse(query.from, 'from') ?? new Date(to.getTime() - (options.defaultDays ?? 30) * 86400000);
  if (from >= to) throw new AppError(400, 'INVALID_TIME_RANGE', 'from must be earlier than to.');
  if (to.getTime() - from.getTime() > (options.maxDays ?? 366) * 86400000)
    throw new AppError(400, 'INVALID_TIME_RANGE', 'The time range is too long.');
  return { from, to };
}
