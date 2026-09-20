'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rules = require('../src/services/accountRules');

test('only ADMIN and SELLER roles are supported', () => {
  assert.deepEqual(rules.ACCOUNT_ROLES, ['ADMIN', 'SELLER']);
});

test('account statuses are exactly active/inactive/blocked', () => {
  assert.deepEqual(rules.ACCOUNT_STATUSES, ['active', 'inactive', 'blocked']);
  assert.equal(rules.isValidStatus('active'), true);
  assert.equal(rules.isValidStatus('inactive'), true);
  assert.equal(rules.isValidStatus('blocked'), true);
  assert.equal(rules.isValidStatus('suspended'), false);
  assert.equal(rules.isValidStatus('ACTIVE'), false);
  assert.equal(rules.isValidStatus(''), false);
  assert.equal(rules.isValidStatus(undefined), false);
});

test('name validation', () => {
  assert.equal(rules.validateName('Acme Traders'), null);
  assert.equal(rules.validateName('  Acme  '), null);
  assert.equal(rules.validateName(''), 'Name is required.');
  assert.equal(rules.validateName('   '), 'Name is required.');
  assert.equal(rules.validateName(undefined), 'Name is required.');
  assert.equal(rules.validateName(42), 'Name is required.');
  assert.match(rules.validateName('x'.repeat(101)), /at most 100/);
  assert.equal(rules.validateName('x'.repeat(100)), null);
});

test('email validation and normalization', () => {
  assert.equal(rules.validateEmail('seller@example.com'), null);
  assert.equal(rules.validateEmail(' bad@x.com '), null);
  assert.match(rules.validateEmail('not-an-email'), /valid email/);
  assert.match(rules.validateEmail('a@b'), /valid email/);
  assert.match(rules.validateEmail(''), /valid email/);
  assert.match(rules.validateEmail('x'.repeat(95) + '@x.com'), /at most 100/);

  assert.equal(rules.normalizeEmail('  Seller@Example.COM '), 'seller@example.com');
  assert.equal(rules.normalizeEmail('nope'), null);
});

test('contact validation', () => {
  assert.equal(rules.validateContact(undefined), null);
  assert.equal(rules.validateContact(''), null);
  assert.equal(rules.validateContact('+1 555 0100'), null);
  assert.match(rules.validateContact('x'.repeat(201)), /at most 200/);
  assert.equal(rules.validateContact('x'.repeat(200)), null);
});

test('password policy (authoritative on the backend)', () => {
  assert.equal(rules.validatePassword('longenough1'), null);
  assert.match(rules.validatePassword('short1'), /at least 8/);
  assert.match(rules.validatePassword(undefined), /at least 8/);
  assert.match(rules.validatePassword('x'.repeat(129)), /at most 128/);
  assert.equal(rules.validatePassword('x'.repeat(128)), null);
});

test('username candidates derived from email are login-safe', () => {
  assert.equal(rules.usernameCandidateFromEmail('John.Doe@Example.com'), 'john_doe');
  assert.equal(rules.usernameCandidateFromEmail('SELLER+tag@x.io'), 'seller_tag');
  assert.equal(rules.usernameCandidateFromEmail('...@x.io'), 'seller');
  assert.equal(rules.usernameCandidateFromEmail('x'.repeat(50) + '@x.com').length, 30);
  assert.match(rules.usernameCandidateFromEmail('valid.name@x.com'), /^[a-z0-9_]+$/);
});

test('username candidate lists: base then numbered suffixes', () => {
  const list = rules.usernameCandidates('acme', 3);
  assert.deepEqual(list, ['acme', 'acme_2', 'acme_3']);
});

test('serialized accounts never contain password hashes or usernames', () => {
  const row = {
    id: 7,
    username: 'secret_handle',
    email: 'seller@example.com',
    name: 'Acme Traders',
    contact: '+1 555 0100',
    status: 'active',
    password_hash: '$2b$10$supersecret anticiphashvalue00000000000000000000000000',
    created_at: new Date('2026-09-13T08:00:00Z'),
    updated_at: new Date('2026-09-13T08:00:00Z'),
    role_name: 'SELLER',
  };
  const dto = rules.serializeAccount(row);
  assert.equal(dto.id, 7);
  assert.equal(dto.name, 'Acme Traders');
  assert.equal(dto.email, 'seller@example.com');
  assert.equal(dto.role, 'SELLER');
  assert.equal(dto.status, 'active');
  assert.equal(dto.createdAt, '2026-09-13T08:00:00.000Z');
  assert.equal(dto.contact, '+1 555 0100');
  assert.equal(dto.password_hash, undefined);
  assert.equal(dto.passwordHash, undefined);
  assert.equal(dto.username, undefined);
  assert.equal(JSON.stringify(dto).includes('anticiphash'), false);
});

test('allow-list rejects privileged client fields', () => {
  assert.throws(() => rules.pickAllowed({ name: 'x', role: 'ADMIN' }, ['name']), /role/);
  assert.throws(() => rules.pickAllowed({ name: 'x', status: 'active' }, ['name']), /status/);
  assert.throws(() => rules.pickAllowed({ password_hash: 'x' }, []), /password_hash/);
  assert.deepEqual(rules.pickAllowed({ name: 'x' }, ['name']), { name: 'x' });
});
