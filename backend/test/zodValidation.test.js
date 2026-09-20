'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  loginSchema,
  profileUpdateSchema,
  changePasswordSchema,
  createSellerSchema,
  updateSellerSchema,
  saveTicketSchema,
  targetAccountSchema,
  bankSchema,
} = require('../src/validation/schemas');
const { validate } = require('../src/validation/validate');

test('Zod loginSchema validates credentials', () => {
  const valid = validate(loginSchema, { identifier: 'admin_user', password: 'Password123!' });
  assert.equal(valid.success, true);
  assert.equal(valid.data.identifier, 'admin_user');

  const shortPassword = validate(loginSchema, { identifier: 'admin_user', password: 'short' });
  assert.equal(shortPassword.success, false);
  assert.equal(shortPassword.error, 'Password must be at least 8 characters long.');

  const missingUser = validate(loginSchema, { identifier: '', password: 'Password123!' });
  assert.equal(missingUser.success, false);
});

test('Zod profileUpdateSchema validates name', () => {
  const valid = validate(profileUpdateSchema, { name: 'Super Admin' });
  assert.equal(valid.success, true);
  assert.equal(valid.data.name, 'Super Admin');

  const empty = validate(profileUpdateSchema, { name: '   ' });
  assert.equal(empty.success, false);
});

test('Zod changePasswordSchema validates passwords', () => {
  const valid = validate(changePasswordSchema, {
    currentPassword: 'OldPassword123!',
    newPassword: 'NewPassword123!',
  });
  assert.equal(valid.success, true);

  const tooShort = validate(changePasswordSchema, {
    currentPassword: 'OldPassword123!',
    newPassword: 'short',
  });
  assert.equal(tooShort.success, false);
});

test('Zod createSellerSchema validates seller creation', () => {
  const valid = validate(createSellerSchema, {
    name: 'Authorized Seller',
    email: 'seller@example.com',
    password: 'InitialPassword123!',
    contact: '+91 9876543210',
  });
  assert.equal(valid.success, true);

  const invalidEmail = validate(createSellerSchema, {
    name: 'Authorized Seller',
    email: 'invalid-email-address',
  });
  assert.equal(invalidEmail.success, false);
});

test('Zod saveTicketSchema validates booking parameters and passengers', () => {
  const valid = validate(saveTicketSchema, {
    irctcAccountId: 1,
    name: 'Varanasi Express',
    trainNumber: '12559',
    fromStation: 'BSB',
    toStation: 'NDLS',
    journeyDate: '2026-10-15',
    quota: 'General',
    travelClass: '3A',
    passengers: [
      { name: 'Rahul Sharma', age: 32, gender: 'M', berthPreference: 'LB' },
    ],
  });
  assert.equal(valid.success, true);

  const invalidPassengerName = validate(saveTicketSchema, {
    irctcAccountId: 1,
    name: 'Varanasi Express',
    trainNumber: '12559',
    fromStation: 'BSB',
    toStation: 'NDLS',
    journeyDate: '2026-10-15',
    passengers: [
      { name: 'Rahul123', age: 32 },
    ],
  });
  assert.equal(invalidPassengerName.success, false);
});

test('Zod targetAccountSchema validates IRCTC accounts', () => {
  const valid = validate(targetAccountSchema, {
    irctcUserId: 'irctc_user_01',
    password: 'SecurePassword123',
  });
  assert.equal(valid.success, true);

  const emptyUser = validate(targetAccountSchema, {
    irctcUserId: '   ',
    password: 'SecurePassword123',
  });
  assert.equal(emptyUser.success, false);
});

test('Zod bankSchema validates bank registration', () => {
  const valid = validate(bankSchema, {
    bankName: 'PHONEPE',
    nameToSave: 'Primary PhonePe',
    gateway: 'IRCTC',
  });
  assert.equal(valid.success, true);

  const emptyBank = validate(bankSchema, {
    bankName: '',
  });
  assert.equal(emptyBank.success, false);
});

