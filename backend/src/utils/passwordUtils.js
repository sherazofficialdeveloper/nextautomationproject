'use strict';

// Server-side temporary/initial password generation (CSPRNG only).
// Used when an account is created without a client-provided password.
// The generated value is returned ONCE in the creation response and must be
// changed by the account holder afterwards. It is never logged.
// Character-class mixing is guaranteed (lower + upper + digit).

const crypto = require('crypto');

const PASSWORD_LENGTH = 16;
const LOWER = 'abcdefghijkmnpqrstuvwxyz'; // no l
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I, O
const DIGITS = '23456789'; // no 0, 1
const ALPHABET = LOWER + UPPER + DIGITS;

function randomFrom(set) {
  return set[crypto.randomInt(set.length)];
}

function generateInitialPassword() {
  const chars = [randomFrom(LOWER), randomFrom(UPPER), randomFrom(DIGITS)];
  while (chars.length < PASSWORD_LENGTH) {
    chars.push(randomFrom(ALPHABET));
  }
  // Fisher-Yates shuffle using the CSPRNG so required classes are not
  // always in predictable positions.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    const tmp = chars[i];
    chars[i] = chars[j];
    chars[j] = tmp;
  }
  return chars.join('');
}

module.exports = { generateInitialPassword, PASSWORD_LENGTH, ALPHABET };
