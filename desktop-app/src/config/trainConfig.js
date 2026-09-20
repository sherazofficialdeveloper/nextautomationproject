/**
 * Centralized Train Configuration for the Desktop Application.
 *
 * Defines the strict whitelist of supported Quotas (4) and Travel Classes (8)
 * shared between the New Ticket form and the Search Train & Availability window.
 */

export const SUPPORTED_QUOTAS = Object.freeze([
  { label: 'General', code: 'GN' },
  { label: 'Ladies', code: 'LD' },
  { label: 'Tatkal', code: 'TQ' },
  { label: 'Premium Tatkal', code: 'PT' },
]);

export const QUOTA_LABELS = Object.freeze(
  SUPPORTED_QUOTAS.map((q) => q.label)
);

export const QUOTA_CODE_MAP = Object.freeze({
  General: 'GN',
  GN: 'GN',
  Ladies: 'LD',
  LD: 'LD',
  Tatkal: 'TQ',
  TQ: 'TQ',
  'Premium Tatkal': 'PT',
  PT: 'PT',
});

export const SUPPORTED_CLASSES = Object.freeze([
  '1A',
  '2A',
  '3A',
  '3E',
  'SL',
  'CC',
  'EC',
  '2S',
]);

export const TICKET_CLASS_OPTIONS = Object.freeze([
  'Select Class',
  ...SUPPORTED_CLASSES,
]);

/**
 * Normalizes a quota string into one of the 4 supported labels or codes.
 * @param {string} quota
 * @param {'label' | 'code'} returnFormat
 * @returns {string}
 */
export function normalizeQuota(quota, returnFormat = 'label') {
  if (!quota) return returnFormat === 'code' ? 'GN' : 'General';
  const clean = String(quota).trim();
  const matched = SUPPORTED_QUOTAS.find(
    (q) =>
      q.label.toLowerCase() === clean.toLowerCase() ||
      q.code.toLowerCase() === clean.toLowerCase()
  );
  if (!matched) return returnFormat === 'code' ? 'GN' : 'General';
  return returnFormat === 'code' ? matched.code : matched.label;
}

/**
 * Validates whether a class string is one of the 8 supported classes.
 * @param {string} cls
 * @returns {boolean}
 */
export function isValidClass(cls) {
  if (!cls) return false;
  return SUPPORTED_CLASSES.includes(String(cls).trim().toUpperCase());
}

/**
 * Returns maximum allowed passengers for the given quota.
 * Tatkal and Premium Tatkal allow max 4 passengers.
 * General and Ladies allow max 6 passengers.
 * @param {string} quota
 * @returns {number}
 */
export function getMaxPassengersForQuota(quota) {
  const clean = String(quota || '').trim().toLowerCase();
  if (clean === 'tatkal' || clean === 'tq' || clean === 'premium tatkal' || clean === 'pt') {
    return 4;
  }
  return 6;
}

export default {
  SUPPORTED_QUOTAS,
  QUOTA_LABELS,
  QUOTA_CODE_MAP,
  SUPPORTED_CLASSES,
  TICKET_CLASS_OPTIONS,
  normalizeQuota,
  isValidClass,
  getMaxPassengersForQuota,
};

