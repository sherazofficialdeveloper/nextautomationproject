'use strict';

// Access key generation.
//
// CRITICAL: Production access keys are generated HERE — server side only.
// - Keys use crypto.randomBytes (a cryptographically secure PRNG). Plain
//   Math.random() and browser-generated UUIDs are never used.
// - 20 random bytes = 160 bits of entropy, base32 (RFC 4648, no padding) encoded
//   into 32 characters, formatted as RLP-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX.
// - Uniqueness is additionally enforced by a UNIQUE database constraint and by
//   application-level retry on collision (see licenseService).
// - Internal generation details are never logged and never exposed.

const crypto = require('crypto');

const KEY_PREFIX = 'RLP-';
const KEY_BYTES = 20; // 160 bits of entropy
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648 base32

function base32Encode(bytes) {
  let result = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += ALPHABET[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    result += ALPHABET[(buffer << (5 - bits)) & 31];
  }
  return result;
}

function formatKey(raw) {
  const groups = [];
  for (let i = 0; i < raw.length; i += 8) {
    groups.push(raw.substr(i, 8));
  }
  return `${KEY_PREFIX}${groups.join('-')}`;
}

function generateAccessKey() {
  return formatKey(base32Encode(crypto.randomBytes(KEY_BYTES)));
}

module.exports = {
  generateAccessKey,
  KEY_PREFIX,
  KEY_BYTES,
};