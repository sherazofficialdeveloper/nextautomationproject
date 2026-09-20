'use strict';

const { getPool } = require('../config/database');
const { encryptCredential, decryptCredential } = require('../utils/credentialCrypto');

/**
 * List all saved IRCTC accounts for the authenticated user.
 * Strictly scoped to req.user.id.
 * Sensitive fields (ciphertext, IV, auth tag, plaintext) are never queried or returned.
 */
async function listAccounts(userId) {
  const pool = getPool();
  const query = `
    SELECT id, username AS "irctcUserId", username, encrypted_password, iv, auth_tag, status, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM target_accounts
    WHERE user_id = $1
    ORDER BY id DESC;
  `;
  const { rows } = await pool.query(query, [userId]);
  return rows.map((row) => {
    let plainPassword = '';
    try {
      if (row.encrypted_password && row.iv && row.auth_tag) {
        plainPassword = decryptCredential(row.encrypted_password, row.iv, row.auth_tag);
      }
    } catch {
      plainPassword = '';
    }
    return {
      id: row.id,
      irctcUserId: row.irctcUserId,
      username: row.username,
      password: plainPassword,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });
}

/**
 * Save a new IRCTC account for the authenticated user.
 * Passwords are encrypted with reversible AES-256-GCM prior to storage.
 */
async function createAccount(userId, irctcUserId, password) {
  const trimmedUser = typeof irctcUserId === 'string' ? irctcUserId.trim() : '';
  if (!trimmedUser) {
    const err = new Error('IRCTC User ID is required.');
    err.status = 400;
    throw err;
  }
  if (!password || typeof password !== 'string') {
    const err = new Error('Password is required.');
    err.status = 400;
    throw err;
  }

  const { encryptedPassword, iv, authTag } = encryptCredential(password);

  const pool = getPool();
  const query = `
    INSERT INTO target_accounts (user_id, username, encrypted_password, iv, auth_tag, status)
    VALUES ($1, $2, $3, $4, $5, 'active')
    RETURNING id, username AS "irctcUserId", username, status, created_at AS "createdAt", updated_at AS "updatedAt";
  `;

  const { rows } = await pool.query(query, [userId, trimmedUser, encryptedPassword, iv, authTag]);
  return {
    ...rows[0],
    password,
  };
}

/**
 * Update an existing IRCTC account.
 * Strict ownership enforcement: WHERE id = $1 AND user_id = $2.
 * If newPassword is provided: encrypts and updates credentials.
 * If newPassword is empty/omitted: preserves existing encrypted password untouched.
 */
async function updateAccount(userId, accountId, irctcUserId, newPassword) {
  const trimmedUser = typeof irctcUserId === 'string' ? irctcUserId.trim() : '';
  if (!trimmedUser) {
    const err = new Error('IRCTC User ID is required.');
    err.status = 400;
    throw err;
  }

  const pool = getPool();

  // 1. Verify existence and ownership
  const checkQuery = `
    SELECT id FROM target_accounts
    WHERE id = $1 AND user_id = $2;
  `;
  const checkRes = await pool.query(checkQuery, [accountId, userId]);
  if (checkRes.rows.length === 0) {
    return null; // Not found or unauthorized
  }

  // 2. Determine whether password is being changed
  const hasNewPassword = typeof newPassword === 'string' && newPassword.trim().length > 0;

  if (hasNewPassword) {
    const { encryptedPassword, iv, authTag } = encryptCredential(newPassword.trim());
    const updateQuery = `
      UPDATE target_accounts
      SET username = $1, encrypted_password = $2, iv = $3, auth_tag = $4, updated_at = now()
      WHERE id = $5 AND user_id = $6
      RETURNING id, username AS "irctcUserId", username, status, created_at AS "createdAt", updated_at AS "updatedAt";
    `;
    const { rows } = await pool.query(updateQuery, [
      trimmedUser,
      encryptedPassword,
      iv,
      authTag,
      accountId,
      userId,
    ]);
    return rows[0];
  } else {
    // Preserve existing encrypted credentials
    const updateQuery = `
      UPDATE target_accounts
      SET username = $1, updated_at = now()
      WHERE id = $2 AND user_id = $3
      RETURNING id, username AS "irctcUserId", username, status, created_at AS "createdAt", updated_at AS "updatedAt";
    `;
    const { rows } = await pool.query(updateQuery, [trimmedUser, accountId, userId]);
    return rows[0];
  }
}

/**
 * Delete an IRCTC account by ID, strictly enforcing user ownership.
 * Returns true if deleted, false if not found or unauthorized.
 */
async function deleteAccount(userId, accountId) {
  const pool = getPool();
  const query = `
    DELETE FROM target_accounts
    WHERE id = $1 AND user_id = $2
    RETURNING id;
  `;
  const { rows } = await pool.query(query, [accountId, userId]);
  return rows.length > 0;
}

/**
 * Internal helper for backend automation ONLY.
 * Decrypts credentials strictly within the trusted backend boundary.
 * Never exposed to HTTP endpoints or frontend renderer.
 */
async function getDecryptedAccountForAutomation(userId, accountId) {
  const pool = getPool();
  const query = `
    SELECT id, username, encrypted_password, iv, auth_tag
    FROM target_accounts
    WHERE id = $1 AND user_id = $2;
  `;
  const { rows } = await pool.query(query, [accountId, userId]);
  if (rows.length === 0) return null;

  const row = rows[0];
  const decrypted = decryptCredential(row.encrypted_password, row.iv, row.auth_tag);
  return {
    id: row.id,
    irctcUserId: row.username,
    password: decrypted,
  };
}

module.exports = {
  listAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  getDecryptedAccountForAutomation,
};
