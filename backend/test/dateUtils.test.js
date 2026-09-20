'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseDate, addDuration, today } = require('../src/utils/dateUtils');

test('parseDate accepts valid calendar dates', () => {
  assert.deepEqual(parseDate('2026-09-12'), { year: 2026, month: 9, day: 12 });
});

test('parseDate rejects malformed and impossible dates', () => {
  assert.equal(parseDate('12-09-2026'), null);
  assert.equal(parseDate('2026-13-01'), null);
  assert.equal(parseDate('2026-02-30'), null);
  assert.equal(parseDate('2026-00-10'), null);
  assert.equal(parseDate('abcd-09-12'), null);
  assert.equal(parseDate(20260912), null);
});

test('approved example: 12 Sep 2026 + 1 month = 12 Oct 2026; +1 more = 12 Nov 2026', () => {
  assert.equal(addDuration('2026-09-12', 1, 'months'), '2026-10-12');
  assert.equal(addDuration('2026-10-12', 1, 'months'), '2026-11-12');
});

test('month addition clamps to the last day of the target month', () => {
  // 2026 is not a leap year
  assert.equal(addDuration('2026-01-31', 1, 'months'), '2026-02-28');
  // 2024 is a leap year
  assert.equal(addDuration('2024-01-31', 1, 'months'), '2024-02-29');
  assert.equal(addDuration('2024-08-31', 6, 'months'), '2025-02-28');
});

test('year addition handles leap-day clamping', () => {
  assert.equal(addDuration('2024-02-29', 1, 'years'), '2025-02-28');
  assert.equal(addDuration('2026-02-28', 4, 'years'), '2030-02-28');
});

test('day and year arithmetic', () => {
  assert.equal(addDuration('2026-12-30', 3, 'days'), '2027-01-02');
  assert.equal(addDuration('2026-09-12', 2, 'years'), '2028-09-12');
});

test('addDuration rejects invalid input', () => {
  assert.throws(() => addDuration('not-a-date', 1, 'months'), /Invalid date/);
  assert.throws(() => addDuration('2026-09-12', 0, 'months'), /positive whole number/);
  assert.throws(() => addDuration('2026-09-12', 1, 'fortnights'), /Unsupported unit/);
});

test('today returns a YYYY-MM-DD calendar string', () => {
  const value = today();
  assert.match(value, /^\d{4}-\d{2}-\d{2}$/);
});