'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const {
  encryptCredential,
  decryptCredential,
  encryptCredentialLegacy,
  decryptCredentialLegacy,
  initCrypto,
  isSodiumInitialized,
} = require('../src/utils/credentialCrypto');

test('initCrypto initializes libsodium engine', async () => {
  const ready = await initCrypto();
  assert.equal(ready, true);
  assert.equal(isSodiumInitialized(), true);
});

test('encryptCredential with libsodium produces valid ciphertext, iv, and authTag', async () => {
  await initCrypto();
  const sample = 'Irctc_Secret_Password_999#';
  const { encryptedPassword, iv, authTag } = encryptCredential(sample);

  assert.ok(encryptedPassword, 'Ciphertext hex must be present');
  assert.ok(iv, 'Nonce/IV hex must be present');
  assert.equal(authTag, 'sodium:secretbox', 'AuthTag indicates libsodium secretbox');
  assert.notEqual(encryptedPassword, sample, 'Password must be encrypted');

  const decrypted = decryptCredential(encryptedPassword, iv, authTag);
  assert.equal(decrypted, sample, 'Decrypted credential matches original plaintext');
});

test('decryptCredential seamlessly decrypts legacy AES-256-GCM records (backward compatibility)', async () => {
  await initCrypto();
  const legacySecret = 'Legacy_AES_GCM_Password_456!';
  const legacy = encryptCredentialLegacy(legacySecret);

  assert.ok(legacy.encryptedPassword);
  assert.ok(legacy.iv);
  assert.equal(legacy.authTag.length, 32, 'Legacy authTag is 16-byte hex string (32 chars)');

  // Decrypt via main decryptCredential function
  const decrypted = decryptCredential(legacy.encryptedPassword, legacy.iv, legacy.authTag);
  assert.equal(decrypted, legacySecret, 'Legacy AES-256-GCM record must be decrypted cleanly');
});

test('libsodium encryption is non-deterministic (unique nonce per encryption)', async () => {
  await initCrypto();
  const secret = 'SamePasswordTwice';
  const first = encryptCredential(secret);
  const second = encryptCredential(secret);

  assert.notEqual(first.iv, second.iv, 'Nonces must differ per encryption');
  assert.notEqual(first.encryptedPassword, second.encryptedPassword, 'Ciphertexts must differ per encryption');
  assert.equal(decryptCredential(first.encryptedPassword, first.iv, first.authTag), secret);
  assert.equal(decryptCredential(second.encryptedPassword, second.iv, second.authTag), secret);
});

test('tampered ciphertext or invalid credentials reject safely', async () => {
  await initCrypto();
  const secret = 'TamperTestPassword';
  const { encryptedPassword, iv, authTag } = encryptCredential(secret);

  const tamperedCipher = (encryptedPassword.slice(0, -2) + (encryptedPassword.endsWith('00') ? 'ff' : '00'));
  assert.throws(() => {
    decryptCredential(tamperedCipher, iv, authTag);
  });

  assert.throws(() => {
    encryptCredential('');
  }, /non-empty string/i);
});

test('bcrypt is strictly preserved for one-way user login passwords', async () => {
  const loginPassword = 'UserLoginPassword@2026';
  const hash = await bcrypt.hash(loginPassword, 10);

  assert.ok(hash.startsWith('$2b$') || hash.startsWith('$2a$'), 'Bcrypt hash format preserved');
  const valid = await bcrypt.compare(loginPassword, hash);
  assert.equal(valid, true, 'Bcrypt compare matches');
  const invalid = await bcrypt.compare('WrongPassword', hash);
  assert.equal(invalid, false, 'Bcrypt compare rejects wrong password');
});

