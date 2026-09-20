'use strict';

// Timezone-free calendar date helpers.
//
// Representation chosen and documented for the whole project:
// - All business dates (starts_at / expires_at) are stored as PostgreSQL DATE
//   columns and serialized as plain 'YYYY-MM-DD' strings.
// - "Today" is the application server's local calendar date. This is the single
//   source of truth for date comparisons and expiry derivation. The PostgreSQL
//   server is never consulted for the current date.
// - Durations are calendar based: a "month" adds one calendar month and clamps
//   to the last day of the target month (2026-01-31 + 1 month = 2026-02-28).
//   A "year" adds 12 calendar months (2024-02-29 + 1 year = 2025-02-28).
// - days are added as whole 24h calendar days via UTC arithmetic.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseDate(value) {
  if (typeof value !== 'string') return null;
  const match = DATE_RE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

function formatDate(parts) {
  const y = String(parts.year).padStart(4, '0');
  const m = String(parts.month).padStart(2, '0');
  const d = String(parts.day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Server-local calendar date (YYYY-MM-DD).
function today() {
  const now = new Date();
  return formatDate({
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
  });
}

function addMonths(parts, months) {
  let total = parts.year * 12 + (parts.month - 1) + months;
  let year = Math.floor(total / 12);
  let month = (total % 12) + 1;
  if (month < 1) {
    month = 12;
    year -= 1;
  }
  const day = Math.min(parts.day, daysInMonth(year, month));
  return { year, month, day };
}

function addYears(parts, years) {
  return addMonths(parts, years * 12);
}

function addDays(parts, days) {
  const dt = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: dt.getUTCFullYear(),
    month: dt.getUTCMonth() + 1,
    day: dt.getUTCDate(),
  };
}

function addDuration(dateString, value, unit) {
  const parts = parseDate(dateString);
  if (!parts) throw new Error(`Invalid date: ${dateString}`);
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new Error('Duration must be a positive whole number.');
  }
  let result;
  switch (unit) {
    case 'days':
      result = addDays(parts, amount);
      break;
    case 'months':
      result = addMonths(parts, amount);
      break;
    case 'years':
      result = addYears(parts, amount);
      break;
    default:
      throw new Error(`Unsupported unit: ${unit}`);
  }
  return formatDate(result);
}

const MONTH_NAME_MAP = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * Normalizes any valid journey date representation (PostgreSQL Date object, ISO string,
 * Date.prototype.toString() output, European DD/MM/YYYY, or canonical YYYY-MM-DD)
 * into a canonical YYYY-MM-DD string.
 * Strictly avoids timezone off-by-one errors and invalid date acceptance.
 *
 * @param {string|Date} input
 * @returns {string} YYYY-MM-DD
 */
function normalizeJourneyDate(input) {
  if (input === null || input === undefined) {
    throw new Error('Journey date is required.');
  }

  // 1. Handle JavaScript Date objects (e.g. returned by node-pg or Date constructor)
  if (input instanceof Date) {
    if (isNaN(input.getTime())) {
      throw new Error('Invalid journey date.');
    }
    // Case A: Constructed in local timezone with 00:00:00 local time
    if (input.getHours() === 0 && input.getMinutes() === 0 && input.getSeconds() === 0) {
      const y = String(input.getFullYear()).padStart(4, '0');
      const m = String(input.getMonth() + 1).padStart(2, '0');
      const d = String(input.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    // Case B: Constructed in UTC with 00:00:00 UTC time
    if (input.getUTCHours() === 0 && input.getUTCMinutes() === 0 && input.getUTCSeconds() === 0) {
      const y = String(input.getUTCFullYear()).padStart(4, '0');
      const m = String(input.getUTCMonth() + 1).padStart(2, '0');
      const d = String(input.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    // Case C: Neither local nor UTC is 00:00:00. Extract from local toString representation
    const str = input.toString();
    const wordDateMatch = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})\s+(\d{4})\b/i.exec(str);
    if (wordDateMatch) {
      const monthStr = MONTH_NAME_MAP[wordDateMatch[1].toLowerCase().slice(0, 3)];
      const dayNum = Number(wordDateMatch[2]);
      const yearNum = Number(wordDateMatch[3]);
      const monthNum = Number(monthStr);
      if (dayNum >= 1 && dayNum <= daysInMonth(yearNum, monthNum)) {
        const d = String(dayNum).padStart(2, '0');
        return `${yearNum}-${monthStr}-${d}`;
      }
    }
    // Fallback: local calendar date
    const y = String(input.getFullYear()).padStart(4, '0');
    const m = String(input.getMonth() + 1).padStart(2, '0');
    const d = String(input.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  if (typeof input !== 'string') {
    throw new Error(`Invalid journey date type: ${typeof input}. Expected YYYY-MM-DD.`);
  }

  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Journey date cannot be empty.');
  }

  // 2. Canonical 'YYYY-MM-DD'
  const canonicalMatch = DATE_RE.exec(trimmed);
  if (canonicalMatch) {
    const year = Number(canonicalMatch[1]);
    const month = Number(canonicalMatch[2]);
    const day = Number(canonicalMatch[3]);
    if (month < 1 || month > 12) {
      throw new Error(`Invalid journey date month: ${trimmed}. Expected month between 01 and 12.`);
    }
    if (day < 1 || day > daysInMonth(year, month)) {
      throw new Error(`Invalid journey date day: ${trimmed}. Month ${month} only has ${daysInMonth(year, month)} days.`);
    }
    return trimmed;
  }

  // 3. ISO format 'YYYY-MM-DDTHH:mm:ss...' or 'YYYY-MM-DD HH:mm:ss...'
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})[T\s]/.exec(trimmed);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
      throw new Error(`Invalid journey date: ${trimmed}.`);
    }
    const y = String(year).padStart(4, '0');
    const m = String(month).padStart(2, '0');
    const d = String(day).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // 4. Formatted string with month name first: 'Sun Sep 20 2026 00:00:00 GMT...', 'Mon Sep 21 2026 00:00:00 GM', 'Sep 21, 2026'
  const monthFirstMatch = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s+(\d{4})\b/i.exec(trimmed);
  if (monthFirstMatch) {
    const monthStr = MONTH_NAME_MAP[monthFirstMatch[1].toLowerCase().slice(0, 3)];
    const dayNum = Number(monthFirstMatch[2]);
    const yearNum = Number(monthFirstMatch[3]);
    const monthNum = Number(monthStr);
    if (dayNum < 1 || dayNum > daysInMonth(yearNum, monthNum)) {
      throw new Error(`Invalid journey date day in "${trimmed}".`);
    }
    const d = String(dayNum).padStart(2, '0');
    return `${yearNum}-${monthStr}-${d}`;
  }

  // 5. Formatted string with day first: '21 Sep 2026', '21-Sep-2026', '21 September 2026'
  const dayFirstMatch = /\b(\d{1,2})(?:st|nd|rd|th)?[-/\s]+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[-/\s]+(\d{4})\b/i.exec(trimmed);
  if (dayFirstMatch) {
    const dayNum = Number(dayFirstMatch[1]);
    const monthStr = MONTH_NAME_MAP[dayFirstMatch[2].toLowerCase().slice(0, 3)];
    const yearNum = Number(dayFirstMatch[3]);
    const monthNum = Number(monthStr);
    if (dayNum < 1 || dayNum > daysInMonth(yearNum, monthNum)) {
      throw new Error(`Invalid journey date day in "${trimmed}".`);
    }
    const d = String(dayNum).padStart(2, '0');
    return `${yearNum}-${monthStr}-${d}`;
  }

  // 6. 'DD/MM/YYYY' or 'DD-MM-YYYY'
  const ddmmyyyyMatch = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
  if (ddmmyyyyMatch) {
    const dayNum = Number(ddmmyyyyMatch[1]);
    const monthNum = Number(ddmmyyyyMatch[2]);
    const yearNum = Number(ddmmyyyyMatch[3]);
    if (monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > daysInMonth(yearNum, monthNum)) {
      throw new Error(`Invalid journey date: ${trimmed}.`);
    }
    const m = String(monthNum).padStart(2, '0');
    const d = String(dayNum).padStart(2, '0');
    return `${yearNum}-${m}-${d}`;
  }

  throw new Error(`Invalid journey date format on ticket: ${trimmed}. Expected YYYY-MM-DD.`);
}

/**
 * Converts a valid journey date input into the DD/MM/YYYY format required by IRCTC input fields.
 * Example: '2026-09-21' -> '21/09/2026'
 *
 * @param {string|Date} input
 * @returns {string} DD/MM/YYYY
 */
function formatJourneyDateForIrctc(input) {
  const canonical = normalizeJourneyDate(input);
  const [year, month, day] = canonical.split('-');
  return `${day}/${month}/${year}`;
}

module.exports = {
  parseDate,
  formatDate,
  today,
  addDuration,
  normalizeJourneyDate,
  formatJourneyDateForIrctc,
};