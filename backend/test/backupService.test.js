'use strict';

require('dotenv').config({ path: './.env' });
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const backupService = require('../src/services/backupService');
const { getPool } = require('../src/config/database');

describe('Backup Service Tests', () => {
  let pool;
  let testUserId;

  before(async () => {
    pool = getPool();
    const userRes = await pool.query(`SELECT id FROM users LIMIT 1;`);
    testUserId = userRes.rows[0]?.id || 1;

    // Clean up test data
    await pool.query(`DELETE FROM booking_history WHERE ticket_name LIKE 'TEST_BAK_%';`);
  });

  after(async () => {
    if (pool) {
      await pool.query(`DELETE FROM booking_history WHERE ticket_name LIKE 'TEST_BAK_%';`);
    }
  });

  describe('Encryption & Decryption', () => {
    test('encrypts and decrypts payload accurately with matching password', () => {
      const payload = { sampleKey: 'secretValue123', numbers: [1, 2, 3] };
      const encrypted = backupService.encryptBackupData(payload, 'StrongPassword123');

      assert.equal(encrypted.magic, 'NETX_BACKUP_V1');
      assert.ok(encrypted.salt);
      assert.ok(encrypted.iv);
      assert.ok(encrypted.authTag);
      assert.ok(encrypted.ciphertext);

      const decrypted = backupService.decryptBackupData(encrypted, 'StrongPassword123');
      assert.deepEqual(decrypted, payload);
    });

    test('rejects decryption with wrong password', () => {
      const payload = { test: true };
      const encrypted = backupService.encryptBackupData(payload, 'CorrectPass');

      assert.throws(
        () => backupService.decryptBackupData(encrypted, 'WrongPass'),
        /Invalid backup password/
      );
    });

    test('rejects tampered or corrupted ciphertext', () => {
      const payload = { sensitive: 'data' };
      const encrypted = backupService.encryptBackupData(payload, 'MyPass');

      const tampered = { ...encrypted, ciphertext: 'deadbeef' + encrypted.ciphertext.slice(8) };
      assert.throws(
        () => backupService.decryptBackupData(tampered, 'MyPass'),
        /Invalid backup password/
      );
    });

    test('rejects corrupted package with missing fields', () => {
      assert.throws(
        () => backupService.decryptBackupData({ magic: 'NETX_BACKUP_V1' }, 'MyPass'),
        /missing required cryptographic components/
      );
    });

    test('rejects invalid magic header', () => {
      assert.throws(
        () => backupService.decryptBackupData({ magic: 'WRONG_MAGIC' }, 'MyPass'),
        /invalid magic header/
      );
    });
  });

  describe('createBackup & restoreBackup', () => {
    test('createBackup validates password presence and match', async () => {
      await assert.rejects(
        () => backupService.createBackup(testUserId, { password: '', confirmPassword: '' }),
        /Backup password is required/
      );

      await assert.rejects(
        () => backupService.createBackup(testUserId, { password: 'pass1', confirmPassword: 'pass2' }),
        /Backup password and confirm password do not match/
      );
    });

    test('creates real backup package and restores successfully', async () => {
      // 1. Insert a test booking record to back up
      await pool.query(
        `INSERT INTO booking_history (user_id, ticket_name, from_station, to_station, journey_date, remarks)
         VALUES ($1, 'TEST_BAK_TICKET_1', 'NDLS', 'CNB', '2026-10-10', 'Test Backup')`,
        [testUserId]
      );

      // 2. Create backup
      const backupRes = await backupService.createBackup(testUserId, {
        categories: ['history'],
        password: 'BackupTestPassword99',
        confirmPassword: 'BackupTestPassword99',
      });

      assert.ok(backupRes.ok);
      assert.ok(backupRes.filename.startsWith('NETX_BACKUP_'));
      assert.ok(backupRes.encryptedPackage);
      assert.ok(backupRes.summary.historyCount >= 1);

      // 3. Restore backup in append mode
      const restoreRes = await backupService.restoreBackup(testUserId, {
        encryptedPackage: backupRes.encryptedPackage,
        password: 'BackupTestPassword99',
        append: true,
      });

      assert.ok(restoreRes.ok);
      assert.ok(restoreRes.restoredCounts);
      assert.ok(restoreRes.restoredCounts.history >= 1);
    });
  });

  describe('deleteUserData & exportCategory', () => {
    test('deleteUserData deletes specified category', async () => {
      // Insert test history row
      await pool.query(
        `INSERT INTO booking_history (user_id, ticket_name, from_station, to_station, journey_date)
         VALUES ($1, 'TEST_BAK_DELETE_1', 'NDLS', 'CNB', '2026-10-10')`,
        [testUserId]
      );

      const delRes = await backupService.deleteUserData(testUserId, { target: 'history' });
      assert.ok(delRes.ok);
      assert.equal(delRes.target, 'history');
      assert.ok(delRes.deletedCount >= 1);

      // Verify records are gone for history
      const check = await pool.query(
        `SELECT COUNT(*) FROM booking_history WHERE user_id = $1`,
        [testUserId]
      );
      assert.equal(parseInt(check.rows[0].count, 10), 0);
    });

    test('exportCategory exports category records', async () => {
      const expRes = await backupService.exportCategory(testUserId, 'history');
      assert.ok(expRes.ok);
      assert.equal(expRes.category, 'history');
      assert.ok(Array.isArray(expRes.records));
    });
  });
});

