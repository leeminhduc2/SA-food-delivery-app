import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isOpenAt,
  openingScheduleSchema,
} from '../server/modules/catalog/domain/opening-schedule.js';
import { sellability } from '../server/modules/catalog/domain/sellability.js';
import { parseInventoryConfig } from '../server/modules/catalog/config.js';

const schedule = Array.from({ length: 7 }, (_, day) => ({
  day,
  intervals: [] as Array<{ start: string; end: string }>,
}));

test('inventory default threshold is configurable and invalid values fail validation', () => {
  assert.equal(parseInventoryConfig({}).LOW_STOCK_THRESHOLD, 5);
  assert.equal(parseInventoryConfig({ LOW_STOCK_THRESHOLD: '9' }).LOW_STOCK_THRESHOLD, 9);
  for (const value of ['', '-1', '1.5', '100001', 'abc'])
    assert.throws(() => parseInventoryConfig({ LOW_STOCK_THRESHOLD: value }));
});

test('sellability combines restaurant policy, hours, manual flags and stock', () => {
  const now = new Date('2026-01-05T02:00:00Z');
  const restaurant = {
    status: 'APPROVED',
    catalog_visible: true,
    accepting_orders: true,
    opening_schedule: null,
  };
  const item = { visible: true, available: true, stock: 1 };
  assert.deepEqual(sellability(item, restaurant, now), { sellable: true, unavailableReason: null });
  assert.equal(
    sellability({ ...item, stock: 0 }, restaurant, now).unavailableReason,
    'OUT_OF_STOCK',
  );
  assert.equal(
    sellability({ ...item, available: false }, restaurant, now).unavailableReason,
    'ITEM_UNAVAILABLE',
  );
  assert.equal(
    sellability({ ...item, visible: false }, restaurant, now).unavailableReason,
    'ITEM_HIDDEN',
  );
  assert.equal(
    sellability(item, { ...restaurant, accepting_orders: false }, now).unavailableReason,
    'RESTAURANT_UNAVAILABLE',
  );
  assert.equal(
    sellability(item, { ...restaurant, opening_schedule: schedule }, now).unavailableReason,
    'RESTAURANT_CLOSED',
  );
});

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
