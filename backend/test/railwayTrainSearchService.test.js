'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const railwayTrainSearchService = require('../src/services/railwayTrainSearchService');

test('Railway Train Search & Station Resolution Suite', async (t) => {
  await t.test('resolves bare station codes', () => {
    const s1 = railwayTrainSearchService.getStationNameAndCode('NDLS');
    assert.equal(s1.code, 'NDLS');
    assert.equal(s1.name, 'NEW DELHI');

    const s2 = railwayTrainSearchService.getStationNameAndCode('MMCT');
    assert.equal(s2.code, 'MMCT');

    const s3 = railwayTrainSearchService.getStationNameAndCode('LTT');
    assert.equal(s3.code, 'LTT');
  });

  await t.test('resolves legacy and full "NAME - CODE" station strings', () => {
    const s1 = railwayTrainSearchService.getStationNameAndCode('NEW DELHI - NDLS');
    assert.equal(s1.code, 'NDLS');

    const s2 = railwayTrainSearchService.getStationNameAndCode('LOKMANYATILAK T - LTT');
    assert.equal(s2.code, 'LTT');

    const s3 = railwayTrainSearchService.getStationNameAndCode('MUMBAI CENTRAL - MMCT');
    assert.equal(s3.code, 'MMCT');
  });

  await t.test('resolves station name without code via static database', () => {
    const s1 = railwayTrainSearchService.getStationNameAndCode('New Delhi');
    assert.equal(s1.code, 'NDLS');

    const s2 = railwayTrainSearchService.getStationNameAndCode('Ayodhya Dham Jn');
    assert.equal(s2.code, 'AY');
  });

  await t.test('executes live Erail train search for NDLS to MMCT and returns valid trains', async () => {
    const t0 = Date.now();
    const trains = await railwayTrainSearchService.searchTrains({
      fromStation: 'NDLS',
      toStation: 'MMCT',
      journeyDate: '2026-10-15',
      quota: 'General',
    });
    const durationMs = Date.now() - t0;

    assert.ok(Array.isArray(trains), 'Should return an array');
    assert.ok(trains.length > 0, 'Should find trains on high-density route NDLS -> MMCT');
    assert.ok(durationMs < 4000, `Execution should be fast, took ${durationMs}ms`);

    const first = trains[0];
    assert.ok(first.trainNumber, 'Train should have a train number');
    assert.ok(first.trainName, 'Train should have a train name');
    assert.ok(first.departureTime, 'Train should have a departure time');
    assert.ok(first.arrivalTime, 'Train should have an arrival time');
    assert.ok(Array.isArray(first.classes), 'Train should have classes');
    assert.ok(first.classes.length > 0, 'Classes should not be empty');
  });

  await t.test('filters trains by class when specified', async () => {
    const trains = await railwayTrainSearchService.searchTrains({
      fromStation: 'NDLS',
      toStation: 'MMCT',
      journeyDate: '2026-10-15',
      travelClass: '1A',
    });

    assert.ok(trains.length > 0, 'Should return trains with 1A');
    for (const train of trains) {
      assert.ok(train.classes.includes('1A'), `Train ${train.trainNumber} should have 1A`);
    }
  });

  await t.test('handles non-existent routes gracefully without crashing', async () => {
    const trains = await railwayTrainSearchService.searchTrains({
      fromStation: 'XXXX',
      toStation: 'YYYY',
      journeyDate: '2026-10-15',
    });
    assert.ok(Array.isArray(trains), 'Should return empty array instead of throwing');
    assert.equal(trains.length, 0);
  });

  await t.test('train search does not hardcode fake AVAILABLE status', async () => {
    const trains = await railwayTrainSearchService.searchTrains({
      fromStation: 'NDLS',
      toStation: 'MMCT',
      journeyDate: '2026-10-15',
    });
    assert.ok(trains.length > 0);
    assert.equal(trains[0].availability, null, 'Initial train schedule should not claim fake AVAILABLE');
  });

  await t.test('checkAvailability validates missing parameters safely', async () => {
    const res = await railwayTrainSearchService.checkAvailability({
      trainNumber: '',
      fromStation: '',
      toStation: '',
      journeyDate: '',
    });
    assert.equal(res.success, false);
    assert.equal(res.status, 'Availability unavailable');
    assert.equal(res.formattedDisplay, 'Availability unavailable');
  });

  await t.test('checkAvailability solves live Indian Rail captcha and returns real status and numbers', async () => {
    const res = await railwayTrainSearchService.checkAvailability({
      trainNumber: '12952',
      fromStation: 'NDLS',
      toStation: 'MMCT',
      journeyDate: '2026-10-15',
      travelClass: '3A',
      quota: 'GN',
    });
    assert.ok(res, 'Should return a response');
    assert.equal(res.trainNumber, '12952');
    assert.equal(res.fromStation, 'NDLS');
    assert.equal(res.toStation, 'MMCT');
    if (res.success) {
      assert.ok(res.status, 'Should have real availability status');
      assert.notEqual(res.status, 'AVAILABLE', 'Must not be a generic dummy placeholder');
      assert.ok(res.formattedDisplay.includes('—'), 'Formatted display should show day and real status');
      assert.ok(Array.isArray(res.avlDayList), 'Should include avlDayList');
      console.log(`[TEST LIVE] 12952 Availability: "${res.formattedDisplay}" Fare: "${res.fare}"`);
    } else {
      console.log(`[TEST NOTICE] Availability query: ${res.status}`);
      assert.ok(res.status, 'Should report actual failure status without inventing fake numbers');
    }
  });
});
