'use strict';

require('dotenv').config();
const { getPool } = require('../config/database');
const { decryptCredential } = require('../utils/credentialCrypto');

async function testEndToEndTargetAccounts() {
  console.log('Testing live target-accounts API...');

  // 1. Authenticate as Rai Sheraz
  const loginRes = await fetch('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'Rai Sheraz', password: 'Rai@1234' }),
  });

  const loginData = await loginRes.json();
  if (!loginRes.ok || !loginData.token) {
    throw new Error(`Login failed: ${JSON.stringify(loginData)}`);
  }
  const token = loginData.token;
  console.log('1. Authenticated successfully. User:', loginData.user.name);

  // 2. Create a target account
  const testPlainPassword = 'MySecretBankPass!#2026';
  const createRes = await fetch('http://localhost:3000/api/target-accounts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      username: 'target_user_1@irctc.co.in',
      password: testPlainPassword,
    }),
  });

  const createData = await createRes.json();
  if (!createRes.ok || !createData.success) {
    throw new Error(`Create failed: ${JSON.stringify(createData)}`);
  }
  console.log('2. Created target account:', createData.data);
  const accountId = createData.data.id;

  // Verify response does not leak password
  if (createData.data.password || createData.data.encrypted_password || createData.data.iv) {
    throw new Error('SECURITY VIOLATION: Password fields leaked in create response!');
  }

  // 3. List target accounts
  const listRes = await fetch('http://localhost:3000/api/target-accounts', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const listData = await listRes.json();
  if (!listRes.ok || !listData.success) {
    throw new Error(`List failed: ${JSON.stringify(listData)}`);
  }
  console.log(`3. Listed ${listData.data.length} account(s). First:`, listData.data[0]);

  const found = listData.data.find((a) => a.id === accountId);
  if (!found) throw new Error('Created account not found in list');
  if (found.password || found.encrypted_password || found.iv || found.auth_tag) {
    throw new Error('SECURITY VIOLATION: Sensitive fields leaked in list response!');
  }

  // 4. Inspect PostgreSQL directly
  const pool = getPool();
  const { rows } = await pool.query('SELECT * FROM target_accounts WHERE id = $1', [accountId]);
  const row = rows[0];
  if (!row) throw new Error('Account row missing from database');

  if (row.encrypted_password === testPlainPassword) {
    throw new Error('SECURITY VIOLATION: Password stored in plaintext!');
  }

  // Verify reversible decryption works
  const recovered = decryptCredential(row.encrypted_password, row.iv, row.auth_tag);
  if (recovered !== testPlainPassword) {
    throw new Error('Decryption mismatch: ' + recovered);
  }
  console.log('4. PostgreSQL record verified: stored ciphertext with IV + AuthTag, successfully decryptable for future automation.');

  // 5. Delete the target account
  const delRes = await fetch(`http://localhost:3000/api/target-accounts/${accountId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const delData = await delRes.json();
  if (!delRes.ok || !delData.success) {
    throw new Error(`Delete failed: ${JSON.stringify(delData)}`);
  }
  console.log('5. Deleted target account successfully.');

  // Verify it is gone
  const { rows: afterDel } = await pool.query('SELECT * FROM target_accounts WHERE id = $1', [accountId]);
  if (afterDel.length !== 0) throw new Error('Account still exists in database after delete');
  console.log('6. Verified deletion in PostgreSQL.');

  console.log('ALL TARGET ACCOUNTS END-TO-END TESTS PASSED!');
  pool.end();
}

testEndToEndTargetAccounts().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

