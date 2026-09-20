'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ghumoTrainSearchService = require('../src/services/ghumoTrainSearchService');

test('ghumoTrainSearchService exposes required constants and methods', () => {
  assert.equal(typeof ghumoTrainSearchService.searchTrains, 'function');
  assert.equal(typeof ghumoTrainSearchService.normalizeQuotaCode, 'function');
  assert.equal(typeof ghumoTrainSearchService.normalizeClass, 'function');
  assert.equal(typeof ghumoTrainSearchService.SUPPORTED_QUOTAS, 'object');
  assert.equal(Array.isArray(ghumoTrainSearchService.SUPPORTED_CLASSES), true);

  // Exactly 4 quotas
  const quotaKeys = Object.keys(ghumoTrainSearchService.SUPPORTED_QUOTAS);
  assert.deepEqual(quotaKeys.sort(), ['GN', 'LD', 'PT', 'TQ']);

  // Exactly 8 classes (FC and EV removed)
  assert.deepEqual(
    [...ghumoTrainSearchService.SUPPORTED_CLASSES].sort(),
    ['1A', '2A', '2S', '3A', '3E', 'CC', 'EC', 'SL'].sort()
  );
  assert.equal(ghumoTrainSearchService.SUPPORTED_CLASSES.includes('FC'), false);
  assert.equal(ghumoTrainSearchService.SUPPORTED_CLASSES.includes('EV'), false);
});

test('normalizeQuotaCode maps all 4 supported quotas and variants to 2-letter codes', () => {
  assert.equal(ghumoTrainSearchService.normalizeQuotaCode('General'), 'GN');
  assert.equal(ghumoTrainSearchService.normalizeQuotaCode('general'), 'GN');
  assert.equal(ghumoTrainSearchService.normalizeQuotaCode('GN'), 'GN');

  assert.equal(ghumoTrainSearchService.normalizeQuotaCode('Ladies'), 'LD');
  assert.equal(ghumoTrainSearchService.normalizeQuotaCode('ladies'), 'LD');
  assert.equal(ghumoTrainSearchService.normalizeQuotaCode('LD'), 'LD');

  assert.equal(ghumoTrainSearchService.normalizeQuotaCode('Tatkal'), 'TQ');
  assert.equal(ghumoTrainSearchService.normalizeQuotaCode('tatkal'), 'TQ');
  assert.equal(ghumoTrainSearchService.normalizeQuotaCode('TQ'), 'TQ');

  assert.equal(ghumoTrainSearchService.normalizeQuotaCode('Premium Tatkal'), 'PT');
  assert.equal(ghumoTrainSearchService.normalizeQuotaCode('premium tatkal'), 'PT');
  assert.equal(ghumoTrainSearchService.normalizeQuotaCode('PREMIUM_TATKAL'), 'PT');
  assert.equal(ghumoTrainSearchService.normalizeQuotaCode('PT'), 'PT');

  // Fallback for null or unknown quota
  assert.equal(ghumoTrainSearchService.normalizeQuotaCode(null), 'GN');
  assert.equal(ghumoTrainSearchService.normalizeQuotaCode(''), 'GN');
  assert.equal(ghumoTrainSearchService.normalizeQuotaCode('INVALID'), 'GN');
});

test('normalizeClass accepts only the 8 supported classes', () => {
  for (const cls of ['1A', '2A', '3A', '3E', 'SL', 'CC', 'EC', '2S']) {
    assert.equal(ghumoTrainSearchService.normalizeClass(cls), cls);
    assert.equal(ghumoTrainSearchService.normalizeClass(cls.toLowerCase()), cls);
  }

  assert.equal(ghumoTrainSearchService.normalizeClass('FC'), null);
  assert.equal(ghumoTrainSearchService.normalizeClass('EV'), null);
  assert.equal(ghumoTrainSearchService.normalizeClass('3B'), null);
  assert.equal(ghumoTrainSearchService.normalizeClass(null), null);
});

test('searchTrains validates required parameters', async () => {
  await assert.rejects(
    async () => {
      await ghumoTrainSearchService.searchTrains({ fromStation: '', toStation: 'HWH', journeyDate: '2026-07-24' });
    },
    { message: 'From Station and To Station are required.' }
  );

  await assert.rejects(
    async () => {
      await ghumoTrainSearchService.searchTrains({ fromStation: 'NDLS', toStation: '', journeyDate: '2026-07-24' });
    },
    { message: 'From Station and To Station are required.' }
  );

  await assert.rejects(
    async () => {
      await ghumoTrainSearchService.searchTrains({ fromStation: 'NDLS', toStation: 'HWH', journeyDate: '' });
    },
    { message: 'A valid journey date (YYYY-MM-DD) is required.' }
  );
});

test('searchTrains fetches real live train data from Ghumo.Live', async () => {
  // Compute tomorrow date YYYY-MM-DD
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dateStr = tomorrow.toISOString().split('T')[0];

  const results = await ghumoTrainSearchService.searchTrains({
    fromStation: 'NDLS',
    toStation: 'HWH',
    journeyDate: dateStr,
    quota: 'General',
    travelClass: '3A',
  });

  assert.equal(Array.isArray(results), true);
  assert.ok(results.length > 0, 'Expected at least 1 train between NDLS and HWH');

  const first = results[0];
  assert.ok(first.trainNumber, 'Train number should be present');
  assert.ok(first.trainName, 'Train name should be present');
  assert.ok(first.departureTime, 'Departure time should be present');
  assert.ok(first.arrivalTime, 'Arrival time should be present');
  assert.ok(first.duration, 'Duration should be present');
  assert.ok(Array.isArray(first.classes), 'Classes should be an array');
  assert.ok(first.availability, 'Availability status should be populated');

  // Verify none of the classes returned are FC or EV
  for (const cls of first.classes) {
    assert.notEqual(cls, 'FC');
    assert.notEqual(cls, 'EV');
  }
});

test('checkAvailability returns structured object and handles missing params safely', async () => {
  assert.equal(typeof ghumoTrainSearchService.checkAvailability, 'function');

  // Missing params returns fallback
  const fallback = await ghumoTrainSearchService.checkAvailability({
    trainNumber: '',
    fromStation: 'NDLS',
    toStation: 'CSMT',
    journeyDate: '2026-07-24',
  });
  assert.equal(fallback.availability, 'Unable to Check');
  assert.ok(fallback.lastChecked);

  // Valid params returns real availability structure
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dateStr = tomorrow.toISOString().split('T')[0];

  const result = await ghumoTrainSearchService.checkAvailability({
    trainNumber: '12301',
    fromStation: 'HWH',
    toStation: 'NDLS',
    journeyDate: dateStr,
    travelClass: '3A',
    quota: 'General',
  });

  assert.ok(result.availability, 'Availability must be defined');
  assert.equal(typeof result.availability, 'string');
  assert.equal(result.trainNumber, '12301');
  assert.equal(result.selectedClass, '3A');
  assert.equal(result.quota, 'General');
  assert.ok(result.lastChecked);
});

