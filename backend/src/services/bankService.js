'use strict';

const { getPool } = require('../config/database');
const { encryptCredential, decryptCredential } = require('../utils/credentialCrypto');

/**
 * Bank & Card Service
 * Handles persistence and retrieval of user-owned banks, debit cards, and credit cards.
 * Strictly isolated per authenticated user (user_id).
 */

// ============================================================================
// BANK MANAGEMENT
// ============================================================================

async function listBanks(userId) {
  const pool = getPool();
  const query = `
    SELECT id, gateway, bank_name AS "bankName", user_name AS "userName",
           encrypted_password, iv, auth_tag, name_to_save AS "nameToSave",
           status, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM user_banks
    WHERE user_id = $1
    ORDER BY id ASC;
  `;
  const { rows } = await pool.query(query, [userId]);
  return rows.map((r) => {
    let plainPassword = '';
    if (r.encrypted_password && r.iv && r.auth_tag) {
      try {
        plainPassword = decryptCredential(r.encrypted_password, r.iv, r.auth_tag);
      } catch {
        plainPassword = '';
      }
    }
    const nameToSave = r.nameToSave || '';
    const displayName = nameToSave ? `${r.bankName}_${nameToSave}` : r.bankName;
    return {
      id: r.id,
      gateway: r.gateway || 'IRCTC',
      bankName: r.bankName,
      userName: r.userName || '',
      upiId: r.userName || '',
      password: plainPassword,
      nameToSave,
      displayName,
      status: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });
}

async function createBank(userId, { gateway, bankName, userName, upiId, password, nameToSave }) {
  const trimmed = typeof bankName === 'string' ? bankName.trim() : '';
  if (!trimmed) {
    const err = new Error('Bank name is required.');
    err.status = 400;
    throw err;
  }

  const pool = getPool();
  const gw = typeof gateway === 'string' && gateway.trim() ? gateway.trim() : 'IRCTC';
  const rawUser = userName !== undefined ? userName : upiId;
  const uName = typeof rawUser === 'string' ? rawUser.trim() : '';
  const nToSave = typeof nameToSave === 'string' ? nameToSave.trim() : '';

  // Check duplicate: check if same bank_name and name_to_save exist for this user
  const checkQuery = `
    SELECT id FROM user_banks
    WHERE user_id = $1 AND LOWER(bank_name) = LOWER($2) AND LOWER(COALESCE(name_to_save, '')) = LOWER($3);
  `;
  const existing = await pool.query(checkQuery, [userId, trimmed, nToSave]);
  if (existing.rows.length > 0) {
    const err = new Error(`Bank "${trimmed}${nToSave ? ` (${nToSave})` : ''}" already exists in your saved banks.`);
    err.status = 409;
    throw err;
  }

  let encPass = null;
  let iv = null;
  let authTag = null;
  if (typeof password === 'string' && password.trim()) {
    const enc = encryptCredential(password.trim());
    encPass = enc.encryptedPassword;
    iv = enc.iv;
    authTag = enc.authTag;
  }

  const insertQuery = `
    INSERT INTO user_banks (user_id, gateway, bank_name, user_name, encrypted_password, iv, auth_tag, name_to_save, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
    RETURNING id, gateway, bank_name AS "bankName", user_name AS "userName", name_to_save AS "nameToSave",
              status, created_at AS "createdAt", updated_at AS "updatedAt";
  `;
  const { rows } = await pool.query(insertQuery, [userId, gw, trimmed, uName, encPass, iv, authTag, nToSave]);
  const row = rows[0];
  const displayName = nToSave ? `${row.bankName}_${nToSave}` : row.bankName;

  return {
    ...row,
    upiId: row.userName || '',
    password: password || '',
    displayName,
  };
}

async function updateBank(userId, bankId, { gateway, bankName, userName, upiId, password, nameToSave }) {
  const idNum = parseInt(bankId, 10);
  if (isNaN(idNum) || idNum <= 0) {
    const err = new Error('Invalid bank ID.');
    err.status = 400;
    throw err;
  }

  const trimmed = typeof bankName === 'string' ? bankName.trim() : '';
  if (!trimmed) {
    const err = new Error('Bank name is required.');
    err.status = 400;
    throw err;
  }

  const nToSave = typeof nameToSave === 'string' ? nameToSave.trim() : '';
  const rawUser = userName !== undefined ? userName : upiId;
  const uName = rawUser !== undefined && typeof rawUser === 'string' ? rawUser.trim() : (rawUser !== undefined ? String(rawUser).trim() : null);
  const pool = getPool();

  // Check duplicate for other banks
  const checkQuery = `
    SELECT id FROM user_banks
    WHERE user_id = $1 AND LOWER(bank_name) = LOWER($2) AND LOWER(COALESCE(name_to_save, '')) = LOWER($3) AND id != $4;
  `;
  const existing = await pool.query(checkQuery, [userId, trimmed, nToSave, idNum]);
  if (existing.rows.length > 0) {
    const err = new Error(`Another bank named "${trimmed}${nToSave ? ` (${nToSave})` : ''}" already exists.`);
    err.status = 409;
    throw err;
  }

  let encPass = null;
  let iv = null;
  let authTag = null;
  if (typeof password === 'string' && password.trim()) {
    const enc = encryptCredential(password.trim());
    encPass = enc.encryptedPassword;
    iv = enc.iv;
    authTag = enc.authTag;
  }

  const updateQuery = `
    UPDATE user_banks
    SET
      gateway = COALESCE($1, gateway),
      bank_name = $2,
      user_name = COALESCE($3, user_name),
      encrypted_password = CASE WHEN $4::text IS NOT NULL THEN $4 ELSE encrypted_password END,
      iv = CASE WHEN $5::text IS NOT NULL THEN $5 ELSE iv END,
      auth_tag = CASE WHEN $6::text IS NOT NULL THEN $6 ELSE auth_tag END,
      name_to_save = $7,
      updated_at = now()
    WHERE id = $8 AND user_id = $9
    RETURNING id, gateway, bank_name AS "bankName", user_name AS "userName", name_to_save AS "nameToSave",
              status, created_at AS "createdAt", updated_at AS "updatedAt";
  `;
  const { rows } = await pool.query(updateQuery, [
    gateway || null,
    trimmed,
    uName,
    encPass,
    iv,
    authTag,
    nToSave,
    idNum,
    userId,
  ]);

  if (rows.length === 0) {
    const err = new Error('Bank not found or unauthorized.');
    err.status = 404;
    throw err;
  }

  const row = rows[0];
  const displayName = nToSave ? `${row.bankName}_${nToSave}` : row.bankName;

  return {
    ...row,
    upiId: row.userName || '',
    password: password || '',
    displayName,
  };
}

async function deleteBank(userId, bankId) {
  const idNum = parseInt(bankId, 10);
  if (isNaN(idNum) || idNum <= 0) {
    const err = new Error('Invalid bank ID.');
    err.status = 400;
    throw err;
  }

  const pool = getPool();
  const query = `
    DELETE FROM user_banks
    WHERE id = $1 AND user_id = $2
    RETURNING id;
  `;
  const { rows } = await pool.query(query, [idNum, userId]);
  if (rows.length === 0) {
    const err = new Error('Bank not found or unauthorized.');
    err.status = 404;
    throw err;
  }
  return true;
}

async function deleteAllBanks(userId) {
  const pool = getPool();
  const query = `
    DELETE FROM user_banks
    WHERE user_id = $1
    RETURNING id;
  `;
  const { rows } = await pool.query(query, [userId]);
  return rows.length;
}

// ============================================================================
// CARD MANAGEMENT (DEBIT / CREDIT)
// ============================================================================

function maskCardNumber(cleanNumber) {
  if (!cleanNumber || cleanNumber.length < 4) return '••••';
  const last4 = cleanNumber.slice(-4);
  return `•••• •••• •••• ${last4}`;
}

async function listCards(userId, cardType = null) {
  const pool = getPool();
  let query = `
    SELECT id, gateway, card_type AS "cardType", select_your_type AS "selectYourType",
           bank_name AS "bankName", card_network AS "cardNetwork", card_holder_name AS "cardHolderName",
           card_number_masked AS "cardNumberMasked", encrypted_card_number, pin,
           expiry_month AS "expiryMonth", expiry_year AS "expiryYear",
           name_to_save AS "nameToSave", iv, auth_tag, status, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM user_cards
    WHERE user_id = $1
  `;
  const params = [userId];

  if (cardType) {
    query += ` AND card_type = $2`;
    params.push(cardType.toUpperCase());
  }

  query += ` ORDER BY id ASC;`;

  const { rows } = await pool.query(query, params);
  return rows.map((row) => {
    let plainCardNumber = '';
    let plainCvv = '';
    let plain3d = '';
    try {
      if (row.encrypted_card_number && row.iv && row.auth_tag) {
        const decrypted = decryptCredential(row.encrypted_card_number, row.iv, row.auth_tag);
        if (decrypted.startsWith('{')) {
          try {
            const parsed = JSON.parse(decrypted);
            plainCardNumber = parsed.cardNumber || '';
            plainCvv = parsed.cvv || '';
            plain3d = parsed.card3dPassword || '';
          } catch {
            plainCardNumber = decrypted;
          }
        } else {
          plainCardNumber = decrypted;
        }
      }
    } catch {
      plainCardNumber = '';
      plainCvv = '';
      plain3d = '';
    }

    const nameToSave = row.nameToSave || '';
    const displayName = nameToSave ? `${row.bankName}_${nameToSave}` : row.bankName;

    return {
      id: row.id,
      gateway: row.gateway || 'IRCTC',
      cardType: row.cardType,
      selectYourType: row.selectYourType || 'Credit_Card',
      bankName: row.bankName,
      cardNetwork: row.cardNetwork || 'Visa',
      cardHolderName: row.cardHolderName,
      cardNumberMasked: row.cardNumberMasked,
      cardNumber: plainCardNumber,
      pin: row.pin || '',
      cvv: plainCvv,
      card3dPassword: plain3d,
      expiryMonth: row.expiryMonth,
      expiryYear: row.expiryYear,
      nameToSave,
      displayName,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });
}

async function createCard(userId, {
  gateway,
  cardType,
  selectYourType,
  bankName,
  cardNetwork,
  cardHolderName,
  cardNumber,
  pin,
  cvv,
  card3dPassword,
  expiryMonth,
  expiryYear,
  nameToSave,
}) {
  const type = (cardType || '').toUpperCase().trim();
  if (type !== 'DEBIT' && type !== 'CREDIT') {
    const err = new Error('cardType must be either DEBIT or CREDIT.');
    err.status = 400;
    throw err;
  }

  const trimmedBank = typeof bankName === 'string' ? bankName.trim() : '';
  if (!trimmedBank) {
    const err = new Error('Bank name is required for card.');
    err.status = 400;
    throw err;
  }

  const rawCardNumber = typeof cardNumber === 'string' ? cardNumber.replace(/\s+/g, '') : '';
  if (!rawCardNumber || rawCardNumber.length < 12 || rawCardNumber.length > 19) {
    const err = new Error('Valid card number is required (12-19 digits).');
    err.status = 400;
    throw err;
  }

  const masked = maskCardNumber(rawCardNumber);
  const cardPayload = JSON.stringify({
    cardNumber: rawCardNumber,
    cvv: typeof cvv === 'string' ? cvv.trim() : '',
    card3dPassword: typeof card3dPassword === 'string' ? card3dPassword.trim() : '',
  });
  const { encryptedPassword: encCard, iv, authTag } = encryptCredential(cardPayload);

  const gw = typeof gateway === 'string' && gateway.trim() ? gateway.trim() : 'IRCTC';
  const selType = typeof selectYourType === 'string' && selectYourType.trim() ? selectYourType.trim() : 'Credit_Card';
  const network = typeof cardNetwork === 'string' && cardNetwork.trim() ? cardNetwork.trim() : 'Visa';
  const holder = typeof cardHolderName === 'string' ? cardHolderName.trim() : '';
  const cardPin = typeof pin === 'string' ? pin.trim() : '';
  const expM = typeof expiryMonth === 'string' ? expiryMonth.trim() : '';
  const expY = typeof expiryYear === 'string' ? expiryYear.trim() : '';
  const nToSave = typeof nameToSave === 'string' ? nameToSave.trim() : '';

  const pool = getPool();
  const query = `
    INSERT INTO user_cards (
      user_id, gateway, card_type, select_your_type, bank_name, card_network,
      card_holder_name, card_number_masked, encrypted_card_number, pin,
      expiry_month, expiry_year, name_to_save, iv, auth_tag, status
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'active')
    RETURNING id, gateway, card_type AS "cardType", select_your_type AS "selectYourType",
              bank_name AS "bankName", card_network AS "cardNetwork", card_holder_name AS "cardHolderName",
              card_number_masked AS "cardNumberMasked", pin, expiry_month AS "expiryMonth",
              expiry_year AS "expiryYear", name_to_save AS "nameToSave",
              status, created_at AS "createdAt", updated_at AS "updatedAt";
  `;

  const { rows } = await pool.query(query, [
    userId, gw, type, selType, trimmedBank, network,
    holder, masked, encCard, cardPin,
    expM, expY, nToSave, iv, authTag,
  ]);

  const displayName = nToSave ? `${trimmedBank}_${nToSave}` : trimmedBank;

  return {
    ...rows[0],
    cardNumber: rawCardNumber,
    cvv: cvv || '',
    card3dPassword: card3dPassword || '',
    displayName,
  };
}

async function updateCard(userId, cardId, {
  gateway,
  cardType,
  selectYourType,
  bankName,
  cardNetwork,
  cardHolderName,
  cardNumber,
  pin,
  cvv,
  card3dPassword,
  expiryMonth,
  expiryYear,
  nameToSave,
}) {
  const idNum = parseInt(cardId, 10);
  if (isNaN(idNum) || idNum <= 0) {
    const err = new Error('Invalid card ID.');
    err.status = 400;
    throw err;
  }

  const type = cardType ? cardType.toUpperCase().trim() : undefined;
  if (type && type !== 'DEBIT' && type !== 'CREDIT') {
    const err = new Error('cardType must be either DEBIT or CREDIT.');
    err.status = 400;
    throw err;
  }

  const pool = getPool();

  let encCard = null;
  let masked = null;
  let iv = null;
  let authTag = null;

  if (typeof cardNumber === 'string' && cardNumber.replace(/\s+/g, '').length >= 12) {
    const cleanNumber = cardNumber.replace(/\s+/g, '');
    masked = maskCardNumber(cleanNumber);
    const cardPayload = JSON.stringify({
      cardNumber: cleanNumber,
      cvv: typeof cvv === 'string' ? cvv.trim() : '',
      card3dPassword: typeof card3dPassword === 'string' ? card3dPassword.trim() : '',
    });
    const enc = encryptCredential(cardPayload);
    encCard = enc.encryptedPassword;
    iv = enc.iv;
    authTag = enc.authTag;
  }

  const query = `
    UPDATE user_cards
    SET
      gateway = COALESCE($1, gateway),
      card_type = COALESCE($2, card_type),
      select_your_type = COALESCE($3, select_your_type),
      bank_name = COALESCE($4, bank_name),
      card_network = COALESCE($5, card_network),
      card_holder_name = COALESCE($6, card_holder_name),
      card_number_masked = COALESCE($7, card_number_masked),
      encrypted_card_number = COALESCE($8, encrypted_card_number),
      pin = COALESCE($9, pin),
      expiry_month = COALESCE($10, expiry_month),
      expiry_year = COALESCE($11, expiry_year),
      name_to_save = COALESCE($12, name_to_save),
      iv = COALESCE($13, iv),
      auth_tag = COALESCE($14, auth_tag),
      updated_at = now()
    WHERE id = $15 AND user_id = $16
    RETURNING id, gateway, card_type AS "cardType", select_your_type AS "selectYourType",
              bank_name AS "bankName", card_network AS "cardNetwork", card_holder_name AS "cardHolderName",
              card_number_masked AS "cardNumberMasked", pin, expiry_month AS "expiryMonth",
              expiry_year AS "expiryYear", name_to_save AS "nameToSave",
              status, created_at AS "createdAt", updated_at AS "updatedAt";
  `;

  const { rows } = await pool.query(query, [
    gateway ? gateway.trim() : null,
    type || null,
    selectYourType ? selectYourType.trim() : null,
    bankName ? bankName.trim() : null,
    cardNetwork ? cardNetwork.trim() : null,
    cardHolderName !== undefined ? cardHolderName.trim() : null,
    masked,
    encCard,
    pin !== undefined ? pin.trim() : null,
    expiryMonth !== undefined ? expiryMonth.trim() : null,
    expiryYear !== undefined ? expiryYear.trim() : null,
    nameToSave !== undefined ? nameToSave.trim() : null,
    iv,
    authTag,
    idNum,
    userId,
  ]);

  if (rows.length === 0) {
    const err = new Error('Card not found or unauthorized.');
    err.status = 404;
    throw err;
  }

  const row = rows[0];
  const displayName = row.nameToSave ? `${row.bankName}_${row.nameToSave}` : row.bankName;

  return {
    ...row,
    displayName,
  };
}

async function deleteCard(userId, cardId) {
  const idNum = parseInt(cardId, 10);
  if (isNaN(idNum) || idNum <= 0) {
    const err = new Error('Invalid card ID.');
    err.status = 400;
    throw err;
  }

  const pool = getPool();
  const query = `
    DELETE FROM user_cards
    WHERE id = $1 AND user_id = $2
    RETURNING id;
  `;
  const { rows } = await pool.query(query, [idNum, userId]);
  if (rows.length === 0) {
    const err = new Error('Card not found or unauthorized.');
    err.status = 404;
    throw err;
  }
  return true;
}

async function deleteAllCards(userId, cardType = null) {
  const pool = getPool();
  let query = `
    DELETE FROM user_cards
    WHERE user_id = $1
  `;
  const params = [userId];

  if (cardType) {
    query += ` AND card_type = $2`;
    params.push(cardType.toUpperCase());
  }

  query += ` RETURNING id;`;

  const { rows } = await pool.query(query, params);
  return rows.length;
}

module.exports = {
  listBanks,
  createBank,
  updateBank,
  deleteBank,
  deleteAllBanks,
  listCards,
  createCard,
  updateCard,
  deleteCard,
  deleteAllCards,
  maskCardNumber,
};
