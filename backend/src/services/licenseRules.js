'use strict';

// Pure License / Access Key business rules. No I/O.
// All date arithmetic is calendar based and timezone-free (see utils/dateUtils).
// The service layer (licenseService) applies these rules and enforces
// authorization before any database mutation.

const { addDuration } = require('../utils/dateUtils');
const { pickAllowed } = require('../utils/bodyUtils');

const LICENSE_STATUSES = ['ACTIVE', 'EXPIRED', 'REVOKED', 'SUSPENDED'];

const DURATION_UNITS = ['days', 'months', 'years'];

// Sanity caps. Real business limits (e.g. for Sellers) are defined below.
const DURATION_LIMITS = { days: 3660, months: 120, years: 100 };

// Approved Seller duration options (mirrors admin-panel/src/config/durations.js).
// The backend is authoritative and re-validates whatever the frontend sends.
const SELLER_DURATION_OPTIONS = [
  { value: 1, unit: 'months' },
  { value: 3, unit: 'months' },
  { value: 6, unit: 'months' },
  { value: 12, unit: 'months' },
];

// Effective status: a stored ACTIVE license whose expiry date has passed is
// reported as EXPIRED. Reads never mutate the stored status; only explicit
// Admin actions (extend / renew / revoke / suspend) change the stored value.
function buildEffectiveStatus(status, expiresAt, today) {
  if (status === 'ACTIVE' && typeof expiresAt === 'string' && typeof today === 'string' && expiresAt < today) {
    return 'EXPIRED';
  }
  return status;
}

// Allowed stored-status transitions for Admin-only actions.
// - extend / renew : not possible on REVOKED or SUSPENDED licenses.
// - revoke         : not possible twice (already REVOKED).
// - suspend        : not possible on REVOKED or SUSPENDED licenses.
function isTransitionAllowed(currentStatus, action) {
  switch (action) {
    case 'extend':
    case 'renew':
      return currentStatus !== 'REVOKED' && currentStatus !== 'SUSPENDED';
    case 'revoke':
      return currentStatus !== 'REVOKED';
    case 'suspend':
      return currentStatus !== 'REVOKED' && currentStatus !== 'SUSPENDED';
    default:
      return false;
  }
}

// Returns an error message string, or null when valid.
function validateDuration(value, unit) {
  let v;
  if (typeof value === 'number') {
    v = value;
  } else if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    v = Number(value);
  } else {
    return 'Duration must be a positive whole number.';
  }
  if (!Number.isSafeInteger(v) || v < 1) return 'Duration must be a positive whole number.';
  if (typeof unit !== 'string' || !DURATION_UNITS.includes(unit)) return 'Unsupported duration unit.';
  if (v > DURATION_LIMITS[unit]) return `Duration exceeds the maximum allowed for ${unit}.`;
  return null;
}

function isSellerAllowedDuration(value, unit) {
  const v = typeof value === 'string' ? Number(value) : value;
  return SELLER_DURATION_OPTIONS.some((opt) => opt.value === v && opt.unit === unit);
}

function formatDurationLabel(value, unit) {
  const label = value === 1 ? unit.replace(/s$/, '') : unit;
  return `${value} ${label}`;
}

function calculateExpiry(startDate, value, unit) {
  return addDuration(startDate, Number(value), unit);
}

// Resolves the authoritative start date. startDate is optional; when omitted
// (or empty) the server "today" is used. Backdating is rejected.
// Returns { ok: true, date } or { ok: false, error }.
function resolveStartDate(startDate, today) {
  if (startDate === undefined || startDate === null || startDate === '') {
    return { ok: true, date: today };
  }
  if (typeof startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return { ok: false, error: 'startDate must be a valid YYYY-MM-DD date.' };
  }
  const { isValidDateString } = require('../utils/validation');
  if (!isValidDateString(startDate)) {
    return { ok: false, error: 'startDate must be a valid calendar date.' };
  }
  if (startDate < today) {
    return { ok: false, error: 'startDate cannot be in the past.' };
  }
  return { ok: true, date: startDate };
}

// Field allow-listing. Any field outside the allow-list is rejected.
// Delegated to the shared bodyUtils implementation.
// (pickAllowed is re-exported below for API stability.)

// Pagination resolution. Returns { ok: true, value } or { ok: false, error }.
function resolvePage(raw, fallback, max) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: fallback };
  const { parsePositiveInt } = require('../utils/validation');
  const n = parsePositiveInt(raw);
  if (n === null || n > max) return { ok: false, error: 'Invalid pagination value.' };
  return { ok: true, value: n };
}

// Response serialization (Admin and Seller share it; authorization is applied
// before the row ever reaches this function).
function serializeLicense(row, today) {
  return {
    id: row.id,
    key: row.access_key,
    status: buildEffectiveStatus(row.status, row.expires_at, today),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    startDate: row.starts_at,
    expiresAt: row.expires_at,
    duration: formatDurationLabel(row.duration_value, row.duration_unit),
    durationValue: row.duration_value,
    durationUnit: row.duration_unit,
    sellerId: row.seller_id,
    sellerName: row.seller_name,
    seller: { id: row.seller_id, name: row.seller_name },
    userId: row.user_id,
    userName: row.user_name,
    user: row.user_id ? { id: row.user_id, name: row.user_name } : null,
  };
}

module.exports = {
  LICENSE_STATUSES,
  DURATION_UNITS,
  SELLER_DURATION_OPTIONS,
  buildEffectiveStatus,
  isTransitionAllowed,
  validateDuration,
  isSellerAllowedDuration,
  formatDurationLabel,
  calculateExpiry,
  resolveStartDate,
  pickAllowed,
  resolvePage,
  serializeLicense,
};
