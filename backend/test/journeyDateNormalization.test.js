'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeJourneyDate, formatJourneyDateForIrctc } = require('../src/utils/dateUtils');

test('Journey Date Normalization Suite', async (t) => {
  await t.test('accepts already-canonical YYYY-MM-DD for 2026-09-20', () => {
    assert.equal(normalizeJourneyDate('2026-09-20'), '2026-09-20');
    assert.equal(formatJourneyDateForIrctc('2026-09-20'), '20/09/2026');
  });

  await t.test('accepts already-canonical YYYY-MM-DD for 2026-09-21', () => {
    assert.equal(normalizeJourneyDate('2026-09-21'), '2026-09-21');
    assert.equal(formatJourneyDateForIrctc('2026-09-21'), '21/09/2026');
  });

  await t.test('normalizes ISO 8601 string', () => {
    assert.equal(normalizeJourneyDate('2026-09-20T00:00:00.000Z'), '2026-09-20');
    assert.equal(normalizeJourneyDate('2026-09-21T18:30:00.000Z'), '2026-09-21');
    assert.equal(normalizeJourneyDate('2026-09-20 12:00:00'), '2026-09-20');
  });

  await t.test('normalizes JavaScript Date instance from node-pg (local midnight)', () => {
    const d = new Date(2026, 8, 20, 0, 0, 0); // Sept is month 8
    assert.equal(normalizeJourneyDate(d), '2026-09-20');
    assert.equal(formatJourneyDateForIrctc(d), '20/09/2026');
  });

  await t.test('normalizes JavaScript Date instance (UTC midnight)', () => {
    const d = new Date('2026-09-21T00:00:00.000Z');
    assert.equal(normalizeJourneyDate(d), '2026-09-21');
    assert.equal(formatJourneyDateForIrctc(d), '21/09/2026');
  });

  await t.test('normalizes Date.prototype.toString() output matching Ticket 56 error', () => {
    const str = 'Sun Sep 20 2026 00:00:00 GMT+0530 (India Standard Time)';
    assert.equal(normalizeJourneyDate(str), '2026-09-20');
    assert.equal(formatJourneyDateForIrctc(str), '20/09/2026');
  });

  await t.test('normalizes Date.prototype.toString() output matching Ticket 57 error', () => {
    const str = 'Mon Sep 21 2026 00:00:00 GMT+0530 (India Standard Time)';
    assert.equal(normalizeJourneyDate(str), '2026-09-21');
    assert.equal(formatJourneyDateForIrctc(str), '21/09/2026');
  });

  await t.test('normalizes exact user reported GM string without timezone shift', () => {
    const str = 'Mon Sep 21 2026 00:00:00 GM';
    assert.equal(normalizeJourneyDate(str), '2026-09-21');
    assert.equal(formatJourneyDateForIrctc(str), '21/09/2026');
  });

  await t.test('normalizes day-first and month-first word formats', () => {
    assert.equal(normalizeJourneyDate('21 Sep 2026'), '2026-09-21');
    assert.equal(normalizeJourneyDate('21-Sep-2026'), '2026-09-21');
    assert.equal(normalizeJourneyDate('21 September 2026'), '2026-09-21');
    assert.equal(normalizeJourneyDate('September 21, 2026'), '2026-09-21');
    assert.equal(formatJourneyDateForIrctc('21 Sep 2026'), '21/09/2026');
  });

  await t.test('normalizes DD/MM/YYYY and DD-MM-YYYY', () => {
    assert.equal(normalizeJourneyDate('20/09/2026'), '2026-09-20');
    assert.equal(normalizeJourneyDate('21-09-2026'), '2026-09-21');
    assert.equal(formatJourneyDateForIrctc('20/09/2026'), '20/09/2026');
    assert.equal(formatJourneyDateForIrctc('21-09-2026'), '21/09/2026');
  });

  await t.test('ensures calendar date 2026-09-21 never converts to 2026-09-20 or 2026-09-22', () => {
    const inputs = [
      '2026-09-21',
      new Date('2026-09-21T00:00:00.000Z'),
      new Date(2026, 8, 21, 0, 0, 0),
      'Mon Sep 21 2026 00:00:00 GMT+0530 (India Standard Time)',
      'Mon Sep 21 2026 00:00:00 GM',
      '21/09/2026',
      '21-09-2026',
      '21 Sep 2026',
    ];
    for (const input of inputs) {
      assert.equal(normalizeJourneyDate(input), '2026-09-21');
      assert.equal(formatJourneyDateForIrctc(input), '21/09/2026');
      assert.notEqual(normalizeJourneyDate(input), '2026-09-20');
      assert.notEqual(normalizeJourneyDate(input), '2026-09-22');
      assert.notEqual(formatJourneyDateForIrctc(input), '20/09/2026');
      assert.notEqual(formatJourneyDateForIrctc(input), '22/09/2026');
    }
  });

  await t.test('rejects null, undefined, empty, or whitespace', () => {
    assert.throws(() => normalizeJourneyDate(null), /Journey date is required/);
    assert.throws(() => normalizeJourneyDate(undefined), /Journey date is required/);
    assert.throws(() => normalizeJourneyDate(''), /cannot be empty/);
    assert.throws(() => normalizeJourneyDate('   '), /cannot be empty/);
    assert.throws(() => formatJourneyDateForIrctc(null), /Journey date is required/);
  });

  await t.test('rejects invalid/malformed date formats and days out of range', () => {
    assert.throws(() => normalizeJourneyDate('invalid-date'), /Invalid journey date format/);
    assert.throws(() => normalizeJourneyDate('2026-02-30'), /Month 2 only has 28 days/);
    assert.throws(() => normalizeJourneyDate('2026-13-01'), /Expected month between 01 and 12/);
    assert.throws(() => normalizeJourneyDate(new Date('invalid')), /Invalid journey date/);
  });
});

