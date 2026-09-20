/**
 * Centralized Quota display mapping utility.
 *
 * Client Requirements:
 * General        -> GN
 * Ladies         -> LD
 * Tatkal         -> CK (explicitly requested)
 * Premium Tatkal -> PT
 *
 * Full quota values remain the authoritative representation internally and in the database.
 * This utility only transforms values for user-facing UI displays.
 */

export const QUOTA_SHORT_CODES = {
  'general': 'GN',
  'gn': 'GN',
  'ladies': 'LD',
  'ld': 'LD',
  'tatkal': 'CK',
  'tq': 'CK',
  'ck': 'CK',
  'tk': 'CK',
  'premium tatkal': 'PT',
  'premium_tatkal': 'PT',
  'pt': 'PT',
};

export function formatQuotaDisplay(rawQuota) {
  if (!rawQuota) return 'GN';
  const clean = String(rawQuota).trim().toLowerCase();
  return QUOTA_SHORT_CODES[clean] || String(rawQuota).toUpperCase();
}

export default formatQuotaDisplay;

