import { z } from 'zod';

const startTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const endTime = z.string().regex(/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/);
const interval = z
  .object({ start: startTime, end: endTime })
  .strict()
  .refine((value) => value.start < value.end, 'End must be after start.');
export const openingScheduleSchema = z
  .array(
    z.object({ day: z.number().int().min(0).max(6), intervals: z.array(interval).max(4) }).strict(),
  )
  .length(7)
  .superRefine((days, ctx) => {
    if (new Set(days.map((entry) => entry.day)).size !== 7)
      ctx.addIssue({ code: 'custom', message: 'Supply each day exactly once.' });
    for (const day of days) {
      const sorted = [...day.intervals].sort((a, b) => a.start.localeCompare(b.start));
      if (sorted.some((entry, index) => index > 0 && sorted[index - 1].end > entry.start))
        ctx.addIssue({ code: 'custom', message: 'Opening intervals cannot overlap.' });
    }
  });
export type OpeningSchedule = z.infer<typeof openingScheduleSchema>;
const localClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Ho_Chi_Minh',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** NULL is the legacy policy. Invalid persisted data fails closed. */
export function isOpenAt(schedule: unknown, now: Date): boolean {
  if (schedule === null) return true;
  const result = openingScheduleSchema.safeParse(schedule);
  if (!result.success || Number.isNaN(now.getTime())) return false;
  const parts = Object.fromEntries(
    localClock.formatToParts(now).map((part) => [part.type, part.value]),
  );
  const time = `${parts.hour}:${parts.minute}`;
  return (
    result.data
      .find((day) => day.day === weekdays[parts.weekday])
      ?.intervals.some((slot) => slot.start <= time && time < slot.end) ?? false
  );
}
