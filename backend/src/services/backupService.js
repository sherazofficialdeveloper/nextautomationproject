'use strict';

const crypto = require('crypto');
const { getPool } = require('../config/database');
const { encryptCredential } = require('../utils/credentialCrypto');

const BACKUP_MAGIC = 'NETX_BACKUP_V1';
const PBKDF2_ITERATIONS = 100000;
const KEY_LENGTH = 32;
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 16;

/**
 * Derives a 256-bit encryption key using PBKDF2.
 */
function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

/**
 * Encrypts arbitrary serializable data using AES-256-GCM and user password.
 */
function encryptBackupData(payloadObj, password) {
  if (!password || typeof password !== 'string' || password.length === 0) {
    const err = new Error('Backup password is required');
    err.status = 400;
    throw err;
  }

  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(password, salt);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const jsonStr = JSON.stringify(payloadObj);
  let ciphertext = cipher.update(jsonStr, 'utf8', 'hex');
  ciphertext += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return {
    magic: BACKUP_MAGIC,
    version: 1,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag,
    ciphertext,
  };
}

/**
 * Decrypts a backup package using the provided password.
 */
function decryptBackupData(backupPkg, password) {
  if (!backupPkg || typeof backupPkg !== 'object') {
    const err = new Error('Invalid backup file structure: expected JSON object');
    err.status = 400;
    err.code = 'INVALID_BACKUP_STRUCTURE';
    throw err;
  }

  if (backupPkg.magic !== BACKUP_MAGIC) {
    const err = new Error('Unsupported or corrupted backup file: invalid magic header');
    err.status = 400;
    err.code = 'INVALID_BACKUP_MAGIC';
    throw err;
  }

  if (!backupPkg.salt || !backupPkg.iv || !backupPkg.authTag || !backupPkg.ciphertext) {
    const err = new Error('Corrupted backup file: missing required cryptographic components');
    err.status = 400;
    err.code = 'CORRUPTED_BACKUP_COMPONENTS';
    throw err;
  }

  if (!password || typeof password !== 'string' || password.trim().length === 0) {
    const err = new Error('Backup password is required');
    err.status = 400;
    err.code = 'MISSING_BACKUP_PASSWORD';
    throw err;
  }

  let salt, iv, authTag;
  try {
    salt = Buffer.from(backupPkg.salt, 'hex');
    iv = Buffer.from(backupPkg.iv, 'hex');
    authTag = Buffer.from(backupPkg.authTag, 'hex');
    if (salt.length !== SALT_LENGTH || iv.length !== IV_LENGTH || authTag.length !== 16) {
      throw new Error('Invalid byte lengths for cryptographic fields');
    }
  } catch (hexErr) {
    const err = new Error('Corrupted backup file: invalid cryptographic encoding or length');
    err.status = 400;
    err.code = 'CORRUPTED_BACKUP_ENCODING';
    throw err;
  }

  const key = deriveKey(password, salt);
  let decrypted;
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    decrypted = decipher.update(backupPkg.ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
  } catch (decErr) {
    const err = new Error('Invalid backup password. Please verify the password and try again.');
    err.status = 400;
    err.code = 'INVALID_BACKUP_PASSWORD';
    throw err;
  }

  try {
    return JSON.parse(decrypted);
  } catch (parseErr) {
    const err = new Error('Corrupted backup file: decrypted contents are not valid JSON.');
    err.status = 400;
    err.code = 'CORRUPTED_BACKUP_JSON';
    throw err;
  }
}

/**
 * Create a full-stack encrypted backup package for authenticated user.
 */
async function createBackup(userId, options = {}) {
  const pool = getPool();
  const password = String(options.password || '').trim();
  const confirmPassword = String(options.confirmPassword || options.confirm_password || '').trim();

  if (!password) {
    const err = new Error('Backup password is required');
    err.status = 400;
    throw err;
  }

  if (confirmPassword && password !== confirmPassword) {
    const err = new Error('Backup password and confirm password do not match');
    err.status = 400;
    throw err;
  }

  const allSelected = Boolean(options.all || options.allBackup);
  const rawCategories = Array.isArray(options.categories) ? options.categories : [];
  const includeIrctc = allSelected || rawCategories.includes('irctc');
  const includeBank = allSelected || rawCategories.includes('bank');
  const includeTicket = allSelected || rawCategories.includes('ticket');
  const includeHistory = allSelected || rawCategories.includes('history');

  const selectedCategories = [];
  if (includeIrctc) selectedCategories.push('irctc');
  if (includeBank) selectedCategories.push('bank');
  if (includeTicket) selectedCategories.push('ticket');
  if (includeHistory) selectedCategories.push('history');

  if (selectedCategories.length === 0) {
    const err = new Error('Please select at least one category to backup');
    err.status = 400;
    throw err;
  }

  const dataPayload = {};

  // 1. IRCTC Accounts
  if (includeIrctc) {
    const res = await pool.query(
      `SELECT username, encrypted_password, iv, auth_tag, status
       FROM target_accounts
       WHERE user_id = $1
       ORDER BY id ASC`,
      [userId]
    );
    dataPayload.target_accounts = res.rows;
  }

  // 2. Bank & Cards
  if (includeBank) {
    const banksRes = await pool.query(
      `SELECT bank_name, gateway, user_name, encrypted_password, iv, auth_tag, name_to_save, status
       FROM user_banks
       WHERE user_id = $1
       ORDER BY id ASC`,
      [userId]
    );
    const cardsRes = await pool.query(
      `SELECT gateway, card_type, select_your_type, bank_name, card_network, card_holder_name,
              card_number_masked, encrypted_card_number, pin, expiry_month, expiry_year,
              name_to_save, iv, auth_tag, status
       FROM user_cards
       WHERE user_id = $1
       ORDER BY id ASC`,
      [userId]
    );
    dataPayload.user_banks = banksRes.rows;
    dataPayload.user_cards = cardsRes.rows;
  }

  // 3. Saved Tickets
  if (includeTicket) {
    const res = await pool.query(
      `SELECT ticket_name, from_station, to_station, journey_date, quota,
              selected_class, train_number, train_name, boarding_point,
              journey_time, slot_time, passengers, mobile_number, email, payment_method, status
       FROM tickets
       WHERE user_id = $1
       ORDER BY id ASC`,
      [userId]
    );
    dataPayload.tickets = res.rows;
  }

  // 4. Booking History
  if (includeHistory) {
    const res = await pool.query(
      `SELECT ticket_name, irctc_id, from_station, to_station, journey_date,
              bank_name, pnr, fare, booking_date, remarks
       FROM booking_history
       WHERE user_id = $1
       ORDER BY id ASC`,
      [userId]
    );
    dataPayload.booking_history = res.rows;
  }

  // 5. Proxies & Preferences (included when All Backup is selected)
  if (allSelected) {
    const proxiesRes = await pool.query(
      `SELECT ip, port, username, encrypted_password, password_iv, password_auth_tag, check_irctc, status
       FROM proxies
       WHERE user_id = $1
       ORDER BY id ASC`,
      [userId]
    );
    dataPayload.proxies = proxiesRes.rows;

    const prefsRes = await pool.query(
      `SELECT history_retention_days, proxy_pair_limit
       FROM user_preferences
       WHERE user_id = $1`,
      [userId]
    );
    dataPayload.user_preferences = prefsRes.rows[0] || null;
  }

  const envelope = {
    app: 'NETX_RAIL',
    version: 1,
    exportedAt: new Date().toISOString(),
    categories: selectedCategories,
    allSelected,
    data: dataPayload,
  };

  const encryptedPackage = encryptBackupData(envelope, password);
  const filename = `NETX_BACKUP_${new Date().toISOString().replace(/[:.]/g, '-')}.netxbak`;

  return {
    ok: true,
    filename,
    encryptedPackage,
    summary: {
      categories: selectedCategories,
      targetAccountsCount: dataPayload.target_accounts?.length || 0,
      banksCount: dataPayload.user_banks?.length || 0,
      cardsCount: dataPayload.user_cards?.length || 0,
      ticketsCount: dataPayload.tickets?.length || 0,
      historyCount: dataPayload.booking_history?.length || 0,
    },
  };
}

/**
 * Restore an encrypted backup package into PostgreSQL for authenticated user.
 */
async function restoreBackup(userId, options = {}) {
  const pool = getPool();
  const password = String(options.password || '').trim();
  const append = Boolean(options.append);
  const backupPkg = options.encryptedPackage || options.package || options.data;

  if (!backupPkg) {
    const err = new Error('No backup package provided');
    err.status = 400;
    throw err;
  }

  const decryptedPayload = decryptBackupData(backupPkg, password);
  const { categories = [], data = {} } = decryptedPayload;

  const client = await pool.connect();
  const restoredCounts = {
    targetAccounts: 0,
    banks: 0,
    cards: 0,
    tickets: 0,
    history: 0,
    proxies: 0,
  };

  try {
    await client.query('BEGIN');

    // If append is false, clear the existing records for the restored categories
    if (!append) {
      if (categories.includes('irctc') || decryptedPayload.allSelected) {
        await client.query('DELETE FROM target_accounts WHERE user_id = $1', [userId]);
      }
      if (categories.includes('bank') || decryptedPayload.allSelected) {
        await client.query('DELETE FROM user_banks WHERE user_id = $1', [userId]);
        await client.query('DELETE FROM user_cards WHERE user_id = $1', [userId]);
      }
      if (categories.includes('ticket') || decryptedPayload.allSelected) {
        await client.query('DELETE FROM tickets WHERE user_id = $1', [userId]);
      }
      if (categories.includes('history') || decryptedPayload.allSelected) {
        await client.query('DELETE FROM booking_history WHERE user_id = $1', [userId]);
      }
      if (decryptedPayload.allSelected && data.proxies) {
        await client.query('DELETE FROM proxies WHERE user_id = $1', [userId]);
      }
    }

    // 1. Insert target_accounts
    const accountIdMap = new Map();
    if (Array.isArray(data.target_accounts)) {
      for (const acc of data.target_accounts) {
        if (append) {
          const existing = await client.query(
            'SELECT id FROM target_accounts WHERE user_id = $1 AND username = $2',
            [userId, acc.username]
          );
          if (existing.rows.length > 0) {
            accountIdMap.set(acc.username, existing.rows[0].id);
            continue;
          }
        }
        const ins = await client.query(
          `INSERT INTO target_accounts (user_id, username, encrypted_password, iv, auth_tag, status)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [
            userId,
            acc.username,
            acc.encrypted_password,
            acc.iv,
            acc.auth_tag,
            acc.status || 'active',
          ]
        );
        restoredCounts.targetAccounts++;
        accountIdMap.set(acc.username, ins.rows[0].id);
      }
    }

    // 2. Insert user_banks
    if (Array.isArray(data.user_banks)) {
      for (const b of data.user_banks) {
        await client.query(
          `INSERT INTO user_banks (user_id, bank_name, gateway, user_name, encrypted_password, iv, auth_tag, name_to_save, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            userId,
            b.bank_name,
            b.gateway || 'IRCTC',
            b.user_name || null,
            b.encrypted_password || null,
            b.iv || null,
            b.auth_tag || null,
            b.name_to_save || null,
            b.status || 'active',
          ]
        );
        restoredCounts.banks++;
      }
    }

    // 3. Insert user_cards
    if (Array.isArray(data.user_cards)) {
      for (const c of data.user_cards) {
        await client.query(
          `INSERT INTO user_cards (user_id, gateway, card_type, select_your_type, bank_name, card_network,
                                   card_holder_name, card_number_masked, encrypted_card_number, pin,
                                   expiry_month, expiry_year, name_to_save, iv, auth_tag, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [
            userId,
            c.gateway || 'IRCTC',
            c.card_type || 'DEBIT',
            c.select_your_type || 'Credit_Card',
            c.bank_name,
            c.card_network || 'Visa',
            c.card_holder_name || null,
            c.card_number_masked || '****',
            c.encrypted_card_number || 'stub',
            c.pin || null,
            c.expiry_month || null,
            c.expiry_year || null,
            c.name_to_save || null,
            c.iv || 'stub',
            c.auth_tag || 'stub',
            c.status || 'active',
          ]
        );
        restoredCounts.cards++;
      }
    }

    // 4. Insert tickets (needs a valid target_account reference)
    if (Array.isArray(data.tickets)) {
      // Find an account id to satisfy foreign key
      let fallbackAccountId = null;
      const accCheck = await client.query(
        'SELECT id FROM target_accounts WHERE user_id = $1 LIMIT 1',
        [userId]
      );
      if (accCheck.rows.length > 0) {
        fallbackAccountId = accCheck.rows[0].id;
      } else {
        // Create a default target account stub if none exists
        const stub = await client.query(
          `INSERT INTO target_accounts (user_id, username, encrypted_password, iv, auth_tag, status)
           VALUES ($1, 'RestoredAccount', 'stub', 'stub', 'stub', 'active')
           RETURNING id`,
          [userId]
        );
        fallbackAccountId = stub.rows[0].id;
      }

      for (const t of data.tickets) {
        await client.query(
          `INSERT INTO tickets (user_id, irctc_account_id, ticket_name, from_station, to_station,
                               journey_date, quota, selected_class, train_number, train_name,
                               boarding_point, journey_time, slot_time, passengers, mobile_number, email, payment_method, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
          [
            userId,
            fallbackAccountId,
            t.ticket_name,
            t.from_station,
            t.to_station,
            t.journey_date,
            t.quota || 'General',
            t.selected_class || null,
            t.train_number || null,
            t.train_name || null,
            t.boarding_point || null,
            t.journey_time || null,
            t.slot_time || null,
            JSON.stringify(t.passengers || []),
            t.mobile_number || '',
            t.email || null,
            t.payment_method || 'Default Payment (Auto)',
            t.status || 'saved',
          ]
        );
        restoredCounts.tickets++;
      }
    }

    // 5. Insert booking_history
    if (Array.isArray(data.booking_history)) {
      for (const h of data.booking_history) {
        await client.query(
          `INSERT INTO booking_history (user_id, ticket_name, irctc_id, from_station, to_station,
                                       journey_date, bank_name, pnr, fare, booking_date, remarks)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            userId,
            h.ticket_name,
            h.irctc_id || null,
            h.from_station,
            h.to_station,
            h.journey_date,
            h.bank_name || null,
            h.pnr || null,
            h.fare || 0,
            h.booking_date || new Date().toISOString().split('T')[0],
            h.remarks || 'Booking Success',
          ]
        );
        restoredCounts.history++;
      }
    }

    // 6. Proxies (if provided)
    if (Array.isArray(data.proxies)) {
      for (const p of data.proxies) {
        const legacyProxyCredential = p.password && !p.encrypted_password
          ? encryptCredential(p.password)
          : null;
        await client.query(
          `INSERT INTO proxies (user_id, ip, port, username, encrypted_password, password_iv, password_auth_tag, password, check_irctc, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9)`,
          [
            userId,
            p.ip,
            p.port,
            p.username || null,
            p.encrypted_password || legacyProxyCredential?.encryptedPassword || null,
            p.password_iv || legacyProxyCredential?.iv || null,
            p.password_auth_tag || legacyProxyCredential?.authTag || null,
            Boolean(p.check_irctc),
            p.status || 'untested',
          ]
        );
        restoredCounts.proxies++;
      }
    }

    // 7. Preferences
    if (data.user_preferences) {
      await client.query(
        `INSERT INTO user_preferences (user_id, history_retention_days, proxy_pair_limit, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id) DO UPDATE
         SET history_retention_days = EXCLUDED.history_retention_days,
             proxy_pair_limit = EXCLUDED.proxy_pair_limit,
             updated_at = now()`,
        [
          userId,
          data.user_preferences.history_retention_days || 30,
          data.user_preferences.proxy_pair_limit || 4,
        ]
      );
    }

    await client.query('COMMIT');

    return {
      ok: true,
      message: 'Backup restored successfully.',
      append,
      restoredCounts,
    };
  } catch (txErr) {
    await client.query('ROLLBACK');
    throw txErr;
  } finally {
    client.release();
  }
}

/**
 * Delete user records by target category.
 * Supported targets: 'irctc', 'bank', 'ticket', 'history', 'all'.
 */
async function deleteUserData(userId, options = {}) {
  const pool = getPool();
  const target = String(options.target || '').trim().toLowerCase();

  const VALID_TARGETS = ['irctc', 'bank', 'ticket', 'history', 'all'];
  if (!VALID_TARGETS.includes(target)) {
    const err = new Error(`Invalid delete target "${target}". Must be one of: ${VALID_TARGETS.join(', ')}`);
    err.status = 400;
    throw err;
  }

  const client = await pool.connect();
  let deletedCount = 0;

  try {
    await client.query('BEGIN');

    if (target === 'irctc' || target === 'all') {
      const res = await client.query('DELETE FROM target_accounts WHERE user_id = $1', [userId]);
      deletedCount += res.rowCount;
    }

    if (target === 'bank' || target === 'all') {
      const bRes = await client.query('DELETE FROM user_banks WHERE user_id = $1', [userId]);
      const cRes = await client.query('DELETE FROM user_cards WHERE user_id = $1', [userId]);
      deletedCount += bRes.rowCount + cRes.rowCount;
    }

    if (target === 'ticket' || target === 'all') {
      const res = await client.query('DELETE FROM tickets WHERE user_id = $1', [userId]);
      deletedCount += res.rowCount;
    }

    if (target === 'history' || target === 'all') {
      const res = await client.query('DELETE FROM booking_history WHERE user_id = $1', [userId]);
      deletedCount += res.rowCount;
    }

    if (target === 'all') {
      const res = await client.query('DELETE FROM proxies WHERE user_id = $1', [userId]);
      deletedCount += res.rowCount;
    }

    await client.query('COMMIT');

    return {
      ok: true,
      target,
      deletedCount,
      message: `Successfully deleted records for ${target}.`,
    };
  } catch (txErr) {
    await client.query('ROLLBACK');
    throw txErr;
  } finally {
    client.release();
  }
}

/**
 * Quick export of single category data as JSON.
 */
async function exportCategory(userId, category) {
  const pool = getPool();
  const cat = String(category || '').trim().toLowerCase();

  let data = null;
  if (cat === 'irctc') {
    const res = await pool.query('SELECT username, status, created_at FROM target_accounts WHERE user_id = $1', [userId]);
    data = res.rows;
  } else if (cat === 'bank') {
    const b = await pool.query('SELECT bank_name, gateway, user_name, name_to_save FROM user_banks WHERE user_id = $1', [userId]);
    const c = await pool.query('SELECT bank_name, gateway, select_your_type, card_network, name_to_save FROM user_cards WHERE user_id = $1', [userId]);
    data = { banks: b.rows, cards: c.rows };
  } else if (cat === 'ticket') {
    const res = await pool.query('SELECT ticket_name, from_station, to_station, journey_date, train_number, status FROM tickets WHERE user_id = $1', [userId]);
    data = res.rows;
  } else if (cat === 'history') {
    const res = await pool.query('SELECT ticket_name, irctc_id, from_station, to_station, journey_date, pnr, fare, booking_date FROM booking_history WHERE user_id = $1', [userId]);
    data = res.rows;
  } else {
    const err = new Error(`Unknown category: ${category}`);
    err.status = 400;
    throw err;
  }

  return {
    ok: true,
    category: cat,
    exportedAt: new Date().toISOString(),
    records: data,
  };
}

module.exports = {
  createBackup,
  restoreBackup,
  deleteUserData,
  exportCategory,
  encryptBackupData,
  decryptBackupData,
};
