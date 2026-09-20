'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { generateInitialPassword, PASSWORD_LENGTH, ALPHABET } = require('../src/utils/passwordUtils');

const ALPHA_SET = new Set(ALPHABET.split(''));

function assertValidPassword(pw) {
  assert.equal(typeof pw, 'string');
  assert.equal(pw.length, PASSWORD_LENGTH);
  for (const ch of pw) {
    assert.ok(ALPHA_SET.has(ch), `character ${ch} must come from the safe alphabet`);
  }
}

test('generated initial passwords are 16 chars from the safe alphabet', () => {
  for (let i = 0; i < 200; i += 1) {
    assertValidPassword(generateInitialPassword());
  }
});

test('generated passwords satisfy the account password policy', () => {
  const rules = require('../src/services/accountRules');
  for (let i = 0; i < 50; i += 1) {
    assert.equal(rules.validatePassword(generateInitialPassword()), null);
  }
});

test('generated passwords are unique across 10,000 generations', () => {
  const seen = new Set();
  for (let i = 0; i < 10000; i += 1) {
    seen.add(generateInitialPassword());
  }
  assert.equal(seen.size, 10000);
});

test('generated passwords mix character classes (no single-class keys)', () => {
  for (let i = 0; i < 100; i += 1) {
    const pw = generateInitialPassword();
    const hasLower = /[a-z]/.test(pw);
    const hasUpper = /[A-Z]/.test(pw);
    const hasDigit = /[0-9]/.test(pw);
    assert.ok(hasLower && hasUpper && hasDigit, `password should mix classes: ${pw}`);
  }
});
