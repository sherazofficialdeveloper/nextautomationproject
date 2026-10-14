'use strict';

const crypto = require('crypto');
const sodium = require('libsodium-wrappers');

// Reversible AES-256-GCM encryption utility for external website credentials.
// Node's built-in crypto module only — zero third-party dependencies.
//
// Key derivation:
// Derives a 256-bit (32-byte) key from the environment secret using SHA-256.
//
// GCM Mode:
// - Provides authenticated encryption with associated data (AEAD).
// - Generates a 16-byte cryptographic authentication tag to detect any tampering.
// - Uses a fresh 16-byte random IV for every encryption call.
//
// SECURITY:
// - Credentials and secrets are never logged or exposed.
// - Decryption is available for future automation flows only.
/**
 * Reversible credential encryption utility with libsodium (authenticated encryption)
 * and seamless backward-compatible fallback to AES-256-GCM for legacy records.
 *
 * One-way password hashing for user accounts strictly uses bcrypt (authService.js).
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // 128-bit IV for AES-GCM

let isSodiumReady = false;
const sodiumReadyPromise = sodium.ready.then(() => {
  isSodiumReady = true;
});

async function initCrypto() {
  await sodiumReadyPromise;
  isSodiumReady = true;
  return true;
}

function isSodiumInitialized() {
  return isSodiumReady && typeof sodium.crypto_secretbox_easy === 'function';
}

function getEncryptionKey() {
  const secret = process.env.CREDENTIAL_SECRET || process.env.JWT_SECRET || 'netx-production-fallback-key-32b';
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypts a plaintext password using AES-256-GCM.
 * Encrypts a credential using libsodium crypto_secretbox_easy when initialized,
 * or AES-256-GCM fallback during early initialization.
 * @param {string} plaintext - The plaintext credential to encrypt
 * @returns {{ encryptedPassword: string, iv: string, authTag: string }}
 */
function encryptCredential(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('Credential must be a non-empty string');
  }

  const key = getEncryptionKey();

  if (isSodiumInitialized()) {
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, key);
    return {
      encryptedPassword: sodium.to_hex(ciphertext),
      iv: sodium.to_hex(nonce),
      authTag: 'sodium:secretbox',
    };
  }

  // Fallback to AES-256-GCM if sodium is still loading
  return encryptCredentialLegacy(plaintext);
}

/**
 * Encrypts explicitly using legacy AES-256-GCM.
 */
function encryptCredentialLegacy(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag().toString('hex');

  return {
    encryptedPassword: encrypted,
    iv: iv.toString('hex'),
    authTag,
  };
}

/**
 * Decrypts a ciphertext using AES-256-GCM with the corresponding IV and auth tag.
 * (Preserved for future automated login workers).
 * Decrypts a ciphertext with automatic algorithm detection and backward compatibility.
 * Supports both libsodium crypto_secretbox and legacy AES-256-GCM.
 * @param {string} ciphertextHex - The hex-encoded encrypted credential
 * @param {string} ivHex - The hex-encoded 16-byte initialization vector
 * @param {string} authTagHex - The hex-encoded 16-byte authentication tag
 * @param {string} ivHex - The hex-encoded nonce/IV
 * @param {string} authTagHex - The auth tag (e.g. 'sodium:secretbox' or 16-byte hex)
 * @returns {string} - The decrypted plaintext credential
 */
function decryptCredential(ciphertextHex, ivHex, authTagHex) {
  if (!ciphertextHex || !ivHex || !authTagHex) {
    throw new Error('Ciphertext, IV, and auth tag are all required for decryption');
  }

  const key = getEncryptionKey();

  // If tagged as libsodium and sodium is ready
  if (authTagHex.startsWith('sodium:')) {
    if (isSodiumInitialized() || typeof sodium.crypto_secretbox_open_easy === 'function') {
      try {
        const nonce = sodium.from_hex(ivHex);
        const ciphertext = sodium.from_hex(ciphertextHex);
        const decryptedBytes = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
        return sodium.to_string(decryptedBytes);
      } catch (sodiumErr) {
        // Fallback try legacy in case of mismatched tag
        try {
          return decryptCredentialLegacy(ciphertextHex, ivHex, authTagHex);
        } catch {
          throw new Error(`Failed to decrypt libsodium credential: ${sodiumErr.message}`);
        }
      }
    } else {
      throw new Error('Sodium crypto engine is still initializing; await initCrypto() before decrypting.');
    }
  }

  // Attempt AES-256-GCM decryption for legacy records
  try {
    return decryptCredentialLegacy(ciphertextHex, ivHex, authTagHex);
  } catch (gcmErr) {
    // If AES-256-GCM failed, try libsodium as secondary fallback
    if (isSodiumInitialized()) {
      try {
        const nonce = sodium.from_hex(ivHex);
        const ciphertext = sodium.from_hex(ciphertextHex);
        const decryptedBytes = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
        return sodium.to_string(decryptedBytes);
      } catch {
        // preserve original error
      }
    }
    throw gcmErr;
  }
}

/**
 * Decrypts explicitly using legacy AES-256-GCM.
 */
function decryptCredentialLegacy(ciphertextHex, ivHex, authTagHex) {
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertextHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

async function decryptCredentialAsync(ciphertextHex, ivHex, authTagHex) {
  if (authTagHex && authTagHex.startsWith('sodium:') && !isSodiumInitialized()) {
    await initCrypto();
  }
  return decryptCredential(ciphertextHex, ivHex, authTagHex);
}

module.exports = {
  encryptCredential,
  decryptCredential,
  decryptCredentialAsync,
  encryptCredentialLegacy,
  decryptCredentialLegacy,
  initCrypto,
  isSodiumInitialized,
};

