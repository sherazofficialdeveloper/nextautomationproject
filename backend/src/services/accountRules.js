'use strict';

// Pure account management rules. No I/O.
// Roles are strictly ADMIN and SELLER — nothing else is accepted anywhere.

const { badRequest } = require('../utils/httpError');
const { pickAllowed } = require('../utils/bodyUtils');

const ACCOUNT_ROLES = ['ADMIN', 'SELLER'];

// Seller account statuses (application-enforced; matches the approved UI).
const ACCOUNT_STATUSES = ['active', 'inactive', 'blocked'];

const NAME_MAX = 100;
const CONTACT_MAX = 200;
const EMAIL_MAX = 100;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
const USERNAME_MAX = 100;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Returns an error message string, or null when valid.
function validateName(name) {
  if (typeof name !== 'string') return 'Name is required.';
  const trimmed = name.trim();
  if (trimmed.length < 1) return 'Name is required.';
  if (trimmed.length > NAME_MAX) return `Name must be at most ${NAME_MAX} characters.`;
  return null;
}

function validateContact(contact) {
  if (contact === undefined || contact === null || contact === '') return null;
  if (typeof contact !== 'string') return 'Contact must be a string.';
  if (contact.trim().length > CONTACT_MAX) return `Contact must be at most ${CONTACT_MAX} characters.`;
  return null;
}

function validateEmail(email) {
  if (typeof email !== 'string') return 'A valid email is required.';
  const trimmed = email.trim();
  if (trimmed.length < 1) return 'A valid email is required.';
  if (trimmed.length > EMAIL_MAX) return `Email must be at most ${EMAIL_MAX} characters.`;
  if (!EMAIL_RE.test(trimmed)) return 'Enter a valid email address.';
  return null;
}

// Returns an error message string, or null when valid.
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    return `Password must be at least ${PASSWORD_MIN} characters long.`;
  }
  if (password.length > PASSWORD_MAX) {
    return `Password must be at most ${PASSWORD_MAX} characters long.`;
  }
  return null;
}

function isValidStatus(status) {
  return ACCOUNT_STATUSES.includes(status);
}

// Normalized (trimmed/lowercased) email or null when invalid.
function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  if (!EMAIL_RE.test(trimmed) || trimmed.length > EMAIL_MAX) return null;
  return trimmed;
}

// Derives a login-safe username candidate from an email address.
// Usernames must match the login identifier pattern [A-Za-z0-9_]+ and stay
// within the schema limit.
function usernameCandidateFromEmail(email) {
  const normalized = normalizeEmail(email);
  const localPart = normalized ? normalized.split('@')[0] : '';
  let base = localPart
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);
  if (!base) base = 'seller';
  return base;
}

// Builds the ordered username candidate list: base, base_2, base_3, ...
function usernameCandidates(base, max) {
  const candidates = [base];
  for (let i = 2; i <= max; i += 1) {
    candidates.push(`${base}_${i}`);
  }
  return candidates;
}

// Safe account representation. NEVER includes password hashes or secrets.
function serializeAccount(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role_name,
    status: row.status,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : (row.created_at || null),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : (row.updated_at || null),
    contact: row.contact === undefined ? undefined : (row.contact || null),
  };
}

// Admin seller list item: same safe shape, contact included for the edit form.
// Admin seller list item: same safe shape, contact and username included.
function serializeSeller(row) {
  return serializeAccount(row);
  const base = serializeAccount(row);
  return {
    ...base,
    username: row.username,
  };
}

function requireObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object.');
  }
  return body;
}

module.exports = {
  ACCOUNT_ROLES,
  ACCOUNT_STATUSES,
  NAME_MAX,
  CONTACT_MAX,
  EMAIL_MAX,
  PASSWORD_MIN,
  PASSWORD_MAX,
  USERNAME_MAX,
  validateName,
  validateContact,
  validateEmail,
  validatePassword,
  isValidStatus,
  normalizeEmail,
  usernameCandidateFromEmail,
  usernameCandidates,
  serializeAccount,
  serializeSeller,
  pickAllowed,
  requireObject,
};
