'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parsePositiveInt,
  isValidId,
  isValidDateString,
  isValidEmail,
} = require('../src/utils/validation');

test('parsePositiveInt accepts numbers and numeric strings only', () => {
  assert.equal(parsePositiveInt(5), 5);
  assert.equal(parsePositiveInt('5'), 5);
  assert.equal(parsePositiveInt('005'), null); // leading zeros are rejected
  assert.equal(parsePositiveInt(0), null);
  assert.equal(parsePositiveInt(-3), null);
  assert.equal(parsePositiveInt('0'), null);
  assert.equal(parsePositiveInt('abc'), null);
  assert.equal(parsePositiveInt('1.5'), null);
  assert.equal(parsePositiveInt('5; DROP TABLE licenses'), null);
});

test('isValidId', () => {
  assert.equal(isValidId(1), true);
  assert.equal(isValidId('1'), true);
  assert.equal(isValidId('01'), false); // leading zeros are rejected
  assert.equal(isValidId('0'), false);
  assert.equal(isValidId('-1'), false);
  assert.equal(isValidId('1 OR 1=1'), false);
  assert.equal(isValidId(null), false);
  assert.equal(isValidId(undefined), false);
});

test('isValidDateString accepts only calendar dates', () => {
  assert.equal(isValidDateString('2026-09-12'), true);
  assert.equal(isValidDateString('2024-02-29'), true); // leap year
  assert.equal(isValidDateString('2026-02-29'), false); // 2026 is not a leap year
  assert.equal(isValidDateString('2026-13-01'), false);
  assert.equal(isValidDateString('2026/09/12'), false);
  assert.equal(isValidDateString('2026-9-2'), false);
});

test('existing email validation still works', () => {
  assert.equal(isValidEmail('a@b.co'), true);
  assert.equal(isValidEmail('not-an-email'), false);
});
