'use strict';

/**
 * Centralized IRCTC Destination & Automation Configuration.
 * Single Source of Truth — do not scatter or hardcode IRCTC URLs across files.
 */
const irctcConfig = Object.freeze({
  // Primary and Secondary Web URLs with controlled failover support
  PRIMARY_WEB_URL: process.env.IRCTC_PRIMARY_WEB_URL || 'https://www.irctc.co.in/nget/train-search',
  SECONDARY_WEB_URL: process.env.IRCTC_SECONDARY_WEB_URL || 'https://www.irctc.co.in/nget/train-search',

  // Intended IRCTC train-search destination (defaults to primary)
  TARGET_TRAIN_SEARCH_URL: process.env.IRCTC_PRIMARY_WEB_URL || 'https://www.irctc.co.in/nget/train-search',

  // IRCTC Portal Base & Entry URLs
  BASE_URL: 'https://www.irctc.co.in',
  LOGIN_URL: process.env.IRCTC_PRIMARY_WEB_URL || 'https://www.irctc.co.in/nget/train-search',

  // Network & Stage timeouts (configurable via environment)
  NAVIGATION_TIMEOUT_MS: Number(process.env.IRCTC_NAV_TIMEOUT_MS || 35000),
  RESULT_WAIT_TIMEOUT_MS: Number(process.env.IRCTC_RESULT_TIMEOUT_MS || 45000),
  ACTION_TIMEOUT_MS: Number(process.env.IRCTC_ACTION_TIMEOUT_MS || 10000),
  LOGIN_TIMEOUT_MS: Number(process.env.IRCTC_LOGIN_TIMEOUT_MS || 20000),

  // In-memory Session TTL (15 minutes)
  SESSION_TTL_MS: 15 * 60 * 1000,

  // Selected Automation Engine Specification
  AUTOMATION_ENGINE: 'patchright-core',
});

module.exports = irctcConfig;
