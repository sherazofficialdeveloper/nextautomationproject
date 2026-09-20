'use strict';
require('dotenv').config();

const crypto = require('crypto');
const http = require('http');

async function run() {
  console.log('Testing live HTTP requests to http://127.0.0.1:3000/api/tools/restore ...');

  // Generate a large payload > 400KB to verify the 10MB limit
  const largeData = {
    irctc: Array.from({ length: 50 }, (_, i) => ({
      username: `testuser_${i}`,
      encrypted_password: 'x'.repeat(2000),
      iv: 'a'.repeat(32),
      auth_tag: 'b'.repeat(32),
    })),
    history: Array.from({ length: 200 }, (_, i) => ({
      ticket_name: `TICKET_${i}`,
      from_station: 'NDLS',
      to_station: 'HWH',
      journey_date: '2026-10-10',
      remarks: 'Long remarks field '.repeat(20),
    })),
  };

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync('CorrectPassword123', salt, 100000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let ciphertext = cipher.update(JSON.stringify(largeData), 'utf8', 'hex');
  ciphertext += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  const pkg = {
    magic: 'NETX_BACKUP_V1',
    version: 1,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag,
    ciphertext,
  };

  const bodyString = JSON.stringify({
    password: 'WrongPassword456',
    encryptedPackage: pkg,
  });

  const payloadSizeKb = (Buffer.byteLength(bodyString, 'utf8') / 1024).toFixed(1);
  console.log(`Generated payload size: ${payloadSizeKb} KB`);

  // Use authService to generate valid token directly
  const authService = require('../src/services/authService');
  const token = authService.generateToken({ id: 1, role_name: 'ADMIN', username: 'admin' });
  console.log('Generated auth token successfully.');

  // Test 1: Wrong Password with 400KB+ payload -> Must return 400 (NOT 413!)
  console.log('Sending restore request with WRONG password...');
  const res1 = await sendRestore(token, {
    password: 'WrongPassword456',
    encryptedPackage: pkg,
  });

  console.log(`Test 1 Response: Status ${res1.status}, Body:`, res1.body);
  if (res1.status === 400 && res1.body.error && res1.body.error.includes('Invalid backup password')) {
    console.log('PASS: Correctly returned 400 with Invalid backup password (NOT 413!)');
  } else {
    console.error('FAIL: Expected 400 Invalid backup password, got:', res1.status, res1.body);
    process.exit(1);
  }

  // Test 2: Correct Password with 400KB+ payload -> Must return 200 OK
  console.log('Sending restore request with CORRECT password...');
  const res2 = await sendRestore(token, {
    password: 'CorrectPassword123',
    encryptedPackage: pkg,
    append: true,
  });

  console.log(`Test 2 Response: Status ${res2.status}, Body:`, res2.body);
  if (res2.status === 200 && res2.body.ok) {
    console.log('PASS: Successfully restored large backup with 200 OK!');
  } else {
    console.error('FAIL: Expected 200 OK, got:', res2.status, res2.body);
    process.exit(1);
  }

  // Test 3: Tampered ciphertext -> Must return 400 (NOT 413!)
  console.log('Sending restore request with TAMPERED ciphertext...');
  const tamperedPkg = { ...pkg, ciphertext: 'deadbeef' + pkg.ciphertext.slice(8) };
  const res3 = await sendRestore(token, {
    password: 'CorrectPassword123',
    encryptedPackage: tamperedPkg,
  });

  console.log(`Test 3 Response: Status ${res3.status}, Body:`, res3.body);
  if (res3.status === 400) {
    console.log('PASS: Correctly rejected tampered backup with 400 (NOT 413!)');
  } else {
    console.error('FAIL: Expected 400 for tampered package, got:', res3.status, res3.body);
    process.exit(1);
  }

  console.log('ALL E2E RESTORE VERIFICATIONS PASSED!');
  process.exit(0);
}

function sendRestore(token, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      'http://127.0.0.1:3000/api/tools/restore',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        let resData = '';
        res.on('data', (c) => (resData += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(resData) });
          } catch (e) {
            resolve({ status: res.statusCode, body: resData });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  process.exit(1);
});
