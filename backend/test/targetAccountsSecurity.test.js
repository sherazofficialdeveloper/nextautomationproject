'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');
const { encryptCredential, decryptCredential } = require('../src/utils/credentialCrypto');

async function withServer(fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.on('listening', resolve);
    server.on('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

async function request(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

test('target account routes reject unauthenticated requests with 401', async () => {
  await withServer(async (base) => {
    const cases = [
      ['GET', '/api/target-accounts', undefined],
      ['POST', '/api/target-accounts', { username: 'test', password: 'pw' }],
      ['PATCH', '/api/target-accounts/1', { username: 'test' }],
      ['DELETE', '/api/target-accounts/1', undefined],
      ['GET', '/api/irctc-accounts', undefined],
      ['POST', '/api/irctc-accounts', { irctcUserId: 'test', password: 'pw' }],
      ['PATCH', '/api/irctc-accounts/1', { irctcUserId: 'test' }],
      ['DELETE', '/api/irctc-accounts/1', undefined],
    ];

    for (const [method, path, body] of cases) {
      const res = await request(base, method, path, body);
      assert.equal(
        res.status,
        401,
        `Expected ${method} ${path} to be 401, got ${res.status}`
      );
      assert.match(
        res.data?.error || '',
        /Authentication required/i
      );
    }
  });
});

test('credential crypto encrypts with AES-256-GCM and decrypts accurately', () => {
  const samplePassword = 'SuperSecretPassword@987!#';
  const { encryptedPassword, iv, authTag } = encryptCredential(samplePassword);

  assert.ok(encryptedPassword, 'Ciphertext should be present');
  assert.ok(iv, 'IV should be present');
  assert.ok(authTag, 'Auth tag should be present');
  assert.notEqual(encryptedPassword, samplePassword, 'Ciphertext must not be plaintext');

  const decrypted = decryptCredential(encryptedPassword, iv, authTag);
  assert.equal(decrypted, samplePassword, 'Decrypted value should match original plaintext');

  // Verify non-deterministic encryption (different IVs produce different ciphertexts)
  const enc2 = encryptCredential(samplePassword);
  assert.notEqual(enc2.iv, iv, 'Different calls must produce different IVs');
  assert.notEqual(enc2.encryptedPassword, encryptedPassword, 'Different calls must produce different ciphertexts');
});

