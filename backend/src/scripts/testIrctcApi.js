'use strict';

require('dotenv').config();
const { getPool } = require('../config/database');
const { decryptCredential } = require('../utils/credentialCrypto');

async function testLiveIrctcApi() {
  console.log('Testing live IRCTC accounts API...');

  // 1. Authenticate as development user Rai Sheraz
  const loginRes = await fetch('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'Rai Sheraz', password: 'Rai@1234' }),
  });
  const loginData = await loginRes.json();
  if (!loginRes.ok || !loginData.token) {
    throw new Error('Login failed');
  }
  const token = loginData.token;
  console.log('1. Authenticated successfully. User:', loginData.user.name);

  // 2. POST /api/irctc-accounts
  const initialPassword = 'InitialSecretPass!#123';
  const createRes = await fetch('http://localhost:3000/api/irctc-accounts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      irctcUserId: 'TEST_IRCTC_USER_01',
      password: initialPassword,
    }),
  });
  const createData = await createRes.json();
  if (!createRes.ok || !createData.success) {
    throw new Error('Create IRCTC account failed: ' + JSON.stringify(createData));
  }
  const accountId = createData.data.id;
  console.log('2. Created IRCTC account:', createData.data);
  if (createData.data.password || createData.data.encrypted_password) {
    throw new Error('SECURITY VIOLATION: Password returned in create response!');
  }

  // 3. Verify in PostgreSQL
  const pool = getPool();
  const { rows: initialRows } = await pool.query('SELECT * FROM target_accounts WHERE id = $1', [accountId]);
  const initialRow = initialRows[0];
  const initialDecrypted = decryptCredential(initialRow.encrypted_password, initialRow.iv, initialRow.auth_tag);
  if (initialDecrypted !== initialPassword) {
    throw new Error('Initial decryption failed');
  }
  console.log('3. Verified encrypted storage in PostgreSQL.');

  // 4. PATCH /api/irctc-accounts/:id — update ID only, leave password blank (must PRESERVE encrypted password)
  const patchRes1 = await fetch(`http://localhost:3000/api/irctc-accounts/${accountId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      irctcUserId: 'TEST_IRCTC_USER_01_EDITED',
      password: '', // Blank should preserve existing password!
    }),
  });
  const patchData1 = await patchRes1.json();
  if (!patchRes1.ok || !patchData1.success) {
    throw new Error('Patch 1 failed: ' + JSON.stringify(patchData1));
  }
  console.log('4. Updated IRCTC User ID with blank password:', patchData1.data);

  // Verify DB row: username changed, but encrypted password remained identical!
  const { rows: preservedRows } = await pool.query('SELECT * FROM target_accounts WHERE id = $1', [accountId]);
  const preservedRow = preservedRows[0];
  if (preservedRow.username !== 'TEST_IRCTC_USER_01_EDITED') {
    throw new Error('Username not updated in DB');
  }
  if (preservedRow.encrypted_password !== initialRow.encrypted_password) {
    throw new Error('SECURITY VIOLATION: Existing encrypted password was not preserved!');
  }
  const preservedDecrypted = decryptCredential(preservedRow.encrypted_password, preservedRow.iv, preservedRow.auth_tag);
  if (preservedDecrypted !== initialPassword) {
    throw new Error('Preserved password decryption mismatch');
  }
  console.log('5. Verified existing encrypted password preserved in PostgreSQL.');

  // 5. PATCH /api/irctc-accounts/:id — update password
  const newPassword = 'NewSecretPassword!#456';
  const patchRes2 = await fetch(`http://localhost:3000/api/irctc-accounts/${accountId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      irctcUserId: 'TEST_IRCTC_USER_FINAL',
      password: newPassword,
    }),
  });
  const patchData2 = await patchRes2.json();
  if (!patchRes2.ok || !patchData2.success) {
    throw new Error('Patch 2 failed: ' + JSON.stringify(patchData2));
  }
  console.log('6. Updated IRCTC account with new password:', patchData2.data);

  // Verify DB row with new password
  const { rows: newPassRows } = await pool.query('SELECT * FROM target_accounts WHERE id = $1', [accountId]);
  const newPassRow = newPassRows[0];
  const newDecrypted = decryptCredential(newPassRow.encrypted_password, newPassRow.iv, newPassRow.auth_tag);
  if (newDecrypted !== newPassword) {
    throw new Error('New password decryption mismatch');
  }
  console.log('7. Verified new encrypted password in PostgreSQL.');

  // 6. DELETE /api/irctc-accounts/:id
  const deleteRes = await fetch(`http://localhost:3000/api/irctc-accounts/${accountId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const deleteData = await deleteRes.json();
  if (!deleteRes.ok || !deleteData.success) {
    throw new Error('Delete failed');
  }
  console.log('8. Deleted IRCTC account successfully.');

  // Verify deletion in DB
  const { rows: afterDel } = await pool.query('SELECT * FROM target_accounts WHERE id = $1', [accountId]);
  if (afterDel.length !== 0) throw new Error('Record not deleted from PostgreSQL');
  console.log('9. Verified deletion from PostgreSQL.');

  console.log('ALL IRCTC BACKEND API TESTS PASSED SUCCESSFULLY!');
  pool.end();
}

testLiveIrctcApi().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

