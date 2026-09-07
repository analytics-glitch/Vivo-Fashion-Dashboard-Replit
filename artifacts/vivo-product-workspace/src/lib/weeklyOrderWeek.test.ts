import assert from 'node:assert/strict';
import test from 'node:test';
import { adjacentIsoWeek, currentNairobiIsoWeek, isoWeekForCalendarDate } from './weeklyOrderWeek';

test('7 September 2026 is Nairobi ISO week 37', () => {
  assert.deepEqual(
    currentNairobiIsoWeek(new Date('2026-09-07T00:15:00+03:00')),
    { isoYear: 2026, isoWeek: 37 },
  );
});

test('Nairobi Monday boundary does not remain on the prior UTC Sunday', () => {
  assert.deepEqual(
    currentNairobiIsoWeek(new Date('2026-09-06T21:15:00Z')),
    { isoYear: 2026, isoWeek: 37 },
  );
  assert.deepEqual(isoWeekForCalendarDate(2026, 9, 6), { isoYear: 2026, isoWeek: 36 });
});

test('week arrows cross ISO-year boundaries correctly', () => {
  assert.deepEqual(adjacentIsoWeek({ isoYear: 2026, isoWeek: 1 }, -1), { isoYear: 2025, isoWeek: 52 });
  assert.deepEqual(adjacentIsoWeek({ isoYear: 2026, isoWeek: 53 }, 1), { isoYear: 2027, isoWeek: 1 });
});