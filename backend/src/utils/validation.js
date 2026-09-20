// Basic validation utilities (can be expanded with a library like 'zod' if needed)
// Validation utilities powered by Zod schemas
const { z } = require('zod');
const { parseDate } = require('./dateUtils');

const zodEmailSchema = z.string().email();

function isValidString(value, minLength = 1, maxLength = 255) {
  return typeof value === 'string' &&
         value.trim().length >= minLength &&
         value.trim().length <= maxLength;
}

function isValidEmail(email) {
  // Basic email regex, can be improved
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return isValidString(email) && emailRegex.test(email);
  if (!isValidString(email)) return false;
  return zodEmailSchema.safeParse(email).success;
}

function isValidPassword(password, minLength = 8) {
  return isValidString(password, minLength);
}

// Positive integer parsing for ids / pagination.
// Accepts a JS number or a numeric string (frontend forms send numeric strings).
function parsePositiveInt(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

function isValidId(value) {
  return parsePositiveInt(value) !== null;
}

// Strict 'YYYY-MM-DD' calendar date string.
function isValidDateString(value) {
  return typeof value === 'string' && parseDate(value) !== null;
}

module.exports = {
  isValidString,
  isValidEmail,
  isValidPassword,
  parsePositiveInt,
  isValidId,
  isValidDateString,
};