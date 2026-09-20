'use strict';

require('dotenv').config({ path: './.env' });
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bankService = require('../src/services/bankService');
const { getPool } = require('../src/config/database');

describe('Bank & Card Service Tests', () => {
  let pool;
  let testUserId1;
  let testUserId2;

  before(async () => {
    pool = getPool();
    // Fetch or create test users
    const userRes = await pool.query(`SELECT id FROM users LIMIT 2;`);
    if (userRes.rows.length >= 2) {
      testUserId1 = userRes.rows[0].id;
      testUserId2 = userRes.rows[1].id;
    } else {
      // Fallback: use id from first user
      testUserId1 = userRes.rows[0]?.id || 1;
      testUserId2 = 999999;
    }

    // Clean up any test banks created in previous runs
    await pool.query(`DELETE FROM user_banks WHERE bank_name LIKE 'TEST_BANK_%';`);
    await pool.query(`DELETE FROM user_cards WHERE bank_name LIKE 'TEST_BANK_%';`);
  });

  after(async () => {
    if (pool) {
      await pool.query(`DELETE FROM user_banks WHERE bank_name LIKE 'TEST_BANK_%';`);
      await pool.query(`DELETE FROM user_cards WHERE bank_name LIKE 'TEST_BANK_%';`);
    }
  });

  test('maskCardNumber properly masks card digits', () => {
    assert.equal(bankService.maskCardNumber('1234567812345678'), '•••• •••• •••• 5678');
    assert.equal(bankService.maskCardNumber('123'), '••••');
    assert.equal(bankService.maskCardNumber(''), '••••');
  });

  test('createBank validates bank name', async () => {
    await assert.rejects(
      async () => {
        await bankService.createBank(testUserId1, { bankName: '' });
      },
      (err) => {
        assert.equal(err.status, 400);
        assert.match(err.message, /Bank name is required/);
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await bankService.createBank(testUserId1, { bankName: '   ' });
      },
      (err) => {
        assert.equal(err.status, 400);
        return true;
      }
    );
  });

  test('createBank saves bank and prevents case-insensitive duplicate per user', async () => {
    const bank = await bankService.createBank(testUserId1, { bankName: 'TEST_BANK_HBL' });
    assert.ok(bank.id);
    assert.equal(bank.bankName, 'TEST_BANK_HBL');

    // Duplicate creation must reject with 409
    await assert.rejects(
      async () => {
        await bankService.createBank(testUserId1, { bankName: 'test_bank_hbl' });
      },
      (err) => {
        assert.equal(err.status, 409);
        assert.match(err.message, /already exists/);
        return true;
      }
    );
  });

  test('listBanks returns banks strictly scoped to authenticated user', async () => {
    const banks = await bankService.listBanks(testUserId1);
    assert.ok(Array.isArray(banks));
    const found = banks.find((b) => b.bankName === 'TEST_BANK_HBL');
    assert.ok(found, 'Created bank must appear in user list');

    // User 2 cannot see User 1's bank
    const banksUser2 = await bankService.listBanks(testUserId2);
    const leaked = banksUser2.find((b) => b.bankName === 'TEST_BANK_HBL');
    assert.equal(leaked, undefined, 'User 2 must not see User 1 banks');
  });

  test('updateBank modifies bank name and rejects duplicates', async () => {
    const bank = await bankService.createBank(testUserId1, { bankName: 'TEST_BANK_UBL' });
    const updated = await bankService.updateBank(testUserId1, bank.id, { bankName: 'TEST_BANK_UBL_RENAMED' });
    assert.equal(updated.bankName, 'TEST_BANK_UBL_RENAMED');

    // Reject duplicate with existing bank
    await assert.rejects(
      async () => {
        await bankService.updateBank(testUserId1, bank.id, { bankName: 'TEST_BANK_HBL' });
      },
      (err) => {
        assert.equal(err.status, 409);
        return true;
      }
    );
  });

  test('createBank and updateBank support upiId as alias for userName', async () => {
    const bank = await bankService.createBank(testUserId1, {
      gateway: 'IRCTC',
      bankName: 'TEST_BANK_UPI',
      upiId: 'ipay@qr',
      nameToSave: 'iPay-QR_ipay@qr',
    });
    assert.ok(bank.id);
    assert.equal(bank.upiId, 'ipay@qr');
    assert.equal(bank.userName, 'ipay@qr');

    const list = await bankService.listBanks(testUserId1);
    const found = list.find((b) => b.id === bank.id);
    assert.ok(found);
    assert.equal(found.upiId, 'ipay@qr');
    assert.equal(found.userName, 'ipay@qr');

    const updated = await bankService.updateBank(testUserId1, bank.id, {
      bankName: 'TEST_BANK_UPI',
      upiId: 'paytm@qr',
      nameToSave: 'PayTM-QR_paytm@qr',
    });
    assert.equal(updated.upiId, 'paytm@qr');
    assert.equal(updated.userName, 'paytm@qr');

    await bankService.deleteBank(testUserId1, bank.id);
  });

  test('deleteBank removes bank and enforces user ownership', async () => {
    const bank = await bankService.createBank(testUserId1, { bankName: 'TEST_BANK_MCB' });

    // User 2 cannot delete User 1's bank
    await assert.rejects(
      async () => {
        await bankService.deleteBank(testUserId2, bank.id);
      },
      (err) => {
        assert.equal(err.status, 404);
        return true;
      }
    );

    // User 1 deletes successfully
    const success = await bankService.deleteBank(testUserId1, bank.id);
    assert.equal(success, true);

    const banksAfter = await bankService.listBanks(testUserId1);
    assert.equal(banksAfter.some((b) => b.id === bank.id), false);
  });

  test('createCard validates card type and card number', async () => {
    await assert.rejects(
      async () => {
        await bankService.createCard(testUserId1, {
          cardType: 'INVALID_TYPE',
          bankName: 'TEST_BANK_HBL',
          cardNumber: '1234567812345678',
        });
      },
      (err) => {
        assert.equal(err.status, 400);
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await bankService.createCard(testUserId1, {
          cardType: 'DEBIT',
          bankName: 'TEST_BANK_HBL',
          cardNumber: '123', // too short
        });
      },
      (err) => {
        assert.equal(err.status, 400);
        return true;
      }
    );
  });

  test('createCard encrypts card number and returns masked version', async () => {
    const card = await bankService.createCard(testUserId1, {
      cardType: 'DEBIT',
      bankName: 'TEST_BANK_HBL',
      cardHolderName: 'Sheraz Rai',
      cardNumber: '4111 2222 3333 4444',
      cvv: '123',
      expiryMonth: '12',
      expiryYear: '28',
    });

    assert.ok(card.id);
    assert.equal(card.cardType, 'DEBIT');
    assert.equal(card.cardNumberMasked, '•••• •••• •••• 4444');
    assert.equal(card.cardNumber, '4111222233334444');

    // Check directly in database that ciphertext is NOT plaintext
    const dbRow = await pool.query(`SELECT encrypted_card_number FROM user_cards WHERE id = $1;`, [card.id]);
    assert.notEqual(dbRow.rows[0].encrypted_card_number, '4111222233334444');

    // List cards
    const cards = await bankService.listCards(testUserId1, 'DEBIT');
    const found = cards.find((c) => c.id === card.id);
    assert.ok(found);
    assert.equal(found.cardNumber, '4111222233334444');
    assert.equal(found.cvv, '123');

    // Delete card
    await bankService.deleteCard(testUserId1, card.id);
  });
});
