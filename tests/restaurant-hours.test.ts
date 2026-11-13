import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isOpenAt,
  openingScheduleSchema,
} from '../server/modules/catalog/domain/opening-schedule.js';

const schedule = Array.from({ length: 7 }, (_, day) => ({
  day,
  intervals: [] as Array<{ start: string; end: string }>,
}));

test('schedule uses Vietnam local day and half-open boundaries including midnight', () => {
  const hours = structuredClone(schedule);
  hours[1].intervals = [
    { start: '09:00', end: '12:00' },
    { start: '22:00', end: '24:00' },
  ];
  hours[2].intervals = [{ start: '00:00', end: '02:00' }];
  assert.equal(isOpenAt(hours, new Date('2026-01-05T01:59:59Z')), false);
  assert.equal(isOpenAt(hours, new Date('2026-01-05T02:00:00Z')), true);
  assert.equal(isOpenAt(hours, new Date('2026-01-05T04:59:59Z')), true);
  assert.equal(isOpenAt(hours, new Date('2026-01-05T05:00:00Z')), false);
  assert.equal(isOpenAt(hours, new Date('2026-01-05T16:59:59Z')), true);
  assert.equal(isOpenAt(hours, new Date('2026-01-05T17:00:00Z')), true);
  assert.equal(isOpenAt(hours, new Date('2026-01-05T19:00:00Z')), false);
  assert.equal(isOpenAt(null, new Date()), true);
  assert.equal(isOpenAt([], new Date()), false);
});

test('schedule requires seven unique days and valid non-overlapping intervals', () => {
  const cases: unknown[] = [
    schedule.slice(1),
    schedule.map((day) => ({ ...day, day: 1 })),
    schedule.map((day, i) => ({
      ...day,
      intervals: i === 0 ? [{ start: '24:00', end: '24:00' }] : [],
    })),
    schedule.map((day, i) => ({
      ...day,
      intervals: i === 0 ? [{ start: '22:00', end: '02:00' }] : [],
    })),
    schedule.map((day, i) => ({
      ...day,
      intervals:
        i === 0
          ? [
              { start: '09:00', end: '11:00' },
              { start: '10:59', end: '12:00' },
            ]
          : [],
    })),
    schedule.map((day, i) => ({
      ...day,
      intervals: i === 0 ? Array(5).fill({ start: '09:00', end: '10:00' }) : [],
    })),
  ];
  for (const invalid of cases)
    assert.equal(openingScheduleSchema.safeParse(invalid).success, false);
  const touching = structuredClone(schedule);
  touching[0].intervals = [
    { start: '09:00', end: '11:00' },
    { start: '11:00', end: '24:00' },
  ];
  assert.equal(openingScheduleSchema.safeParse(touching).success, true);
});
