'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rules = require('../src/services/licenseRules');

test('effective status turns a past-ACTIVE license EXPIRED', () => {
  assert.equal(rules.buildEffectiveStatus('ACTIVE', '2026-09-12', '2026-10-01'), 'EXPIRED');
  assert.equal(rules.buildEffectiveStatus('ACTIVE', '2026-10-12', '2026-10-01'), 'ACTIVE');
  assert.equal(rules.buildEffectiveStatus('REVOKED', '2026-09-12', '2026-10-01'), 'REVOKED');
  assert.equal(rules.buildEffectiveStatus('SUSPENDED', '2026-09-12', '2026-10-01'), 'SUSPENDED');
});

test('only the four approved statuses are supported', () => {
  assert.deepEqual(rules.LICENSE_STATUSES, ['ACTIVE', 'EXPIRED', 'REVOKED', 'SUSPENDED']);
});

test('extend/renew transitions are rejected for REVOKED and SUSPENDED', () => {
  assert.equal(rules.isTransitionAllowed('ACTIVE', 'extend'), true);
  assert.equal(rules.isTransitionAllowed('EXPIRED', 'extend'), true);
  assert.equal(rules.isTransitionAllowed('REVOKED', 'extend'), false);
  assert.equal(rules.isTransitionAllowed('SUSPENDED', 'extend'), false);
  assert.equal(rules.isTransitionAllowed('ACTIVE', 'renew'), true);
  assert.equal(rules.isTransitionAllowed('REVOKED', 'renew'), false);
  assert.equal(rules.isTransitionAllowed('SUSPENDED', 'renew'), false);
});

test('revoke is only impossible on an already-REVOKED license', () => {
  assert.equal(rules.isTransitionAllowed('ACTIVE', 'revoke'), true);
  assert.equal(rules.isTransitionAllowed('EXPIRED', 'revoke'), true);
  assert.equal(rules.isTransitionAllowed('SUSPENDED', 'revoke'), true);
  assert.equal(rules.isTransitionAllowed('REVOKED', 'revoke'), false);
});

test('suspend is impossible on REVOKED and SUSPENDED licenses', () => {
  assert.equal(rules.isTransitionAllowed('ACTIVE', 'suspend'), true);
  assert.equal(rules.isTransitionAllowed('EXPIRED', 'suspend'), true);
  assert.equal(rules.isTransitionAllowed('REVOKED', 'suspend'), false);
  assert.equal(rules.isTransitionAllowed('SUSPENDED', 'suspend'), false);
  assert.equal(rules.isTransitionAllowed('ACTIVE', 'transfer'), false);
});

test('duration validation', () => {
  assert.equal(rules.validateDuration(1, 'months'), null);
  assert.equal(rules.validateDuration('3', 'months'), null);
  assert.equal(rules.validateDuration(0, 'months'), 'Duration must be a positive whole number.');
  assert.equal(rules.validateDuration(-1, 'months'), 'Duration must be a positive whole number.');
  assert.equal(rules.validateDuration(1.5, 'months'), 'Duration must be a positive whole number.');
  assert.equal(rules.validateDuration('abc', 'months'), 'Duration must be a positive whole number.');
  assert.equal(rules.validateDuration(1, 'fortnights'), 'Unsupported duration unit.');
  assert.equal(rules.validateDuration(121, 'months'), 'Duration exceeds the maximum allowed for months.');
});

test('Seller durations are limited to the approved 1/3/6/12 month options', () => {
  assert.deepEqual(
    rules.SELLER_DURATION_OPTIONS.map((o) => `${o.value} ${o.unit}`),
    ['1 months', '3 months', '6 months', '12 months']
  );
  for (const opt of rules.SELLER_DURATION_OPTIONS) {
    assert.equal(rules.isSellerAllowedDuration(opt.value, opt.unit), true);
  }
  assert.equal(rules.isSellerAllowedDuration(2, 'months'), false);
  assert.equal(rules.isSellerAllowedDuration(1, 'years'), false);
  assert.equal(rules.isSellerAllowedDuration(1, 'days'), false);
});

test('duration labels are human readable', () => {
  assert.equal(rules.formatDurationLabel(1, 'months'), '1 month');
  assert.equal(rules.formatDurationLabel(3, 'months'), '3 months');
  assert.equal(rules.formatDurationLabel(2, 'days'), '2 days');
  assert.equal(rules.formatDurationLabel(1, 'years'), '1 year');
});

test('expiry calculation is server-authoritative', () => {
  assert.equal(rules.calculateExpiry('2026-09-12', 1, 'months'), '2026-10-12');
  assert.equal(rules.calculateExpiry('2026-10-12', 1, 'months'), '2026-11-12');
});

test('start date resolution defaults to today and rejects backdating', () => {
  const today = '2026-09-12';
  assert.deepEqual(rules.resolveStartDate(undefined, today), { ok: true, date: today });
  assert.deepEqual(rules.resolveStartDate('', today), { ok: true, date: today });
  assert.deepEqual(rules.resolveStartDate('2026-09-12', today), { ok: true, date: today });
  assert.deepEqual(rules.resolveStartDate('2026-10-01', today), { ok: true, date: '2026-10-01' });
  assert.equal(rules.resolveStartDate('2026-09-11', today).ok, false);
  assert.equal(rules.resolveStartDate('09/12/2026', today).ok, false);
  assert.equal(rules.resolveStartDate('2026-13-01', today).ok, false);
});

test('unknown fields are rejected during body picking', () => {
  const got = rules.pickAllowed({ durationValue: 1, durationUnit: 'months' }, ['durationValue', 'durationUnit']);
  assert.deepEqual(got, { durationValue: 1, durationUnit: 'months' });

  const err = (() => {
    try {
      rules.pickAllowed({ sellerId: 5, durationValue: 1 }, ['durationValue']);
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.ok(err);
  assert.equal(err.statusCode, 400);
  assert.match(err.message, /sellerId/);

  const invalidBody = (() => {
    try {
      rules.pickAllowed('nope', ['durationValue']);
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.ok(invalidBody);
  assert.equal(invalidBody.statusCode, 400);
});

test('pagination resolution', () => {
  assert.deepEqual(rules.resolvePage(undefined, 20, 100), { ok: true, value: 20 });
  assert.deepEqual(rules.resolvePage('', 20, 100), { ok: true, value: 20 });
  assert.deepEqual(rules.resolvePage(2, 1, 100), { ok: true, value: 2 });
  assert.equal(rules.resolvePage('abc', 1, 100).ok, false);
  assert.equal(rules.resolvePage(0, 1, 100).ok, false);
  assert.equal(rules.resolvePage(101, 1, 100).ok, false);
});

test('serializeLicense maps database rows to the frontend contract', () => {
  const row = {
    id: 7,
    access_key: 'RLP-TEST',
    status: 'ACTIVE',
    duration_value: 3,
    duration_unit: 'months',
    starts_at: '2026-09-12',
    expires_at: '2026-12-12',
    created_at: new Date('2026-09-12T10:00:00Z'),
    updated_at: new Date('2026-09-12T10:00:00Z'),
    seller_id: 2,
    seller_name: 'sellerTwo',
    user_id: null,
    user_name: null,
  };
  const dto = rules.serializeLicense(row, '2026-10-01');
  assert.equal(dto.id, 7);
  assert.equal(dto.key, 'RLP-TEST');
  assert.equal(dto.status, 'ACTIVE');
  assert.equal(dto.duration, '3 months');
  assert.equal(dto.createdAt, '2026-09-12T10:00:00.000Z');
  assert.equal(dto.startDate, '2026-09-12');
  assert.equal(dto.expiresAt, '2026-12-12');
  assert.equal(dto.sellerName, 'sellerTwo');
  assert.equal(dto.seller.name, 'sellerTwo');
  assert.equal(dto.user, null);
});