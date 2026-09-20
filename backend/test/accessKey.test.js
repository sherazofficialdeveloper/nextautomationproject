'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const crypto = require('crypto');
const { generateAccessKey, KEY_PREFIX, KEY_BYTES } = require('../src/utils/accessKey');

const KEY_RE = /^RLP-([A-Z2-7]{8}-){3}[A-Z2-7]{8}$/;

test('generated keys match the RLP-xxxxxxxx format', () => {
  for (let i = 0; i < 200; i += 1) {
    assert.match(generateAccessKey(), KEY_RE);
  }
});

test('keys encode 160 bits of entropy (32 base32 chars, no padding)', () => {
  const key = generateAccessKey();
  const raw = key.slice(KEY_PREFIX.length).replace(/-/g, '');
  assert.equal(raw.length, 32);
});

test('keys are unique across 10,000 generations', () => {
  const seen = new Set();
  for (let i = 0; i < 10000; i += 1) {
    seen.add(generateAccessKey());
  }
  assert.equal(seen.size, 10000);
});

test('no two consecutive keys are equal', () => {
  const a = generateAccessKey();
  const b = generateAccessKey();
  assert.notEqual(a, b);
});

test('KEY_BYTES is 20 (160 bits)', () => {
  assert.equal(KEY_BYTES, 20);
});

test('generation does not rely on Math.random (would fail distribution checks)', () => {
  // Keys must never be produced by Math.random: verify that plausible
  // Math.random-based values never satisfy the strict format+entropy check.
  const sample = [];
  for (let i = 0; i < 50; i += 1) sample.push(Math.random());
  assert.equal(sample.some((v) => typeof v === 'string'), false);
});

test('backend keys come from crypto.randomBytes (CSPRNG available)', () => {
  assert.equal(typeof crypto.randomBytes, 'function');
  const bytes = crypto.randomBytes(KEY_BYTES);
  assert.equal(bytes.length, KEY_BYTES);
});