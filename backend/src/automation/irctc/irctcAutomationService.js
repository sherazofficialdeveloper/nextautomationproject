'use strict';

const fs = require('fs');
const path = require('path');
const { getPool } = require('../../config/database');
const { decryptCredential, encryptCredential, initCrypto, isSodiumInitialized } = require('../../utils/credentialCrypto');
initCrypto().catch(() => {});
const irctcConfig = require('../../config/irctc');
const targetAccountService = require('../../services/targetAccountService');
const { normalizeJourneyDate, formatJourneyDateForIrctc } = require('../../utils/dateUtils');
const { OPTIMIZED_LAUNCH_ARGS } = require('../browserConfig');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =========================================================================
// SESSION PERSISTENCE HELPERS
// =========================================================================
function getAutomationStorageRoot() {
  const configured = process.env.NETX_AUTOMATION_STORAGE_DIR;
  if (configured && path.isAbsolute(configured)) return configured;
  return path.join(process.cwd(), 'storage');
}

function getAutomationProfilePath(accountId, browserKey = 'chrome') {
  const safeAccountId = String(accountId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeBrowserKey = String(browserKey || 'chrome').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getAutomationStorageRoot(), 'automation-profiles', `acc_${safeAccountId}_${safeBrowserKey}`);
}

function getProfileMetadataPath(profileDir) {
  return path.join(profileDir, 'netx-profile.json');
}

function ensureProfileMetadata(profileDir, accountId, browserKey) {
  fs.mkdirSync(profileDir, { recursive: true });
  const metadataPath = getProfileMetadataPath(profileDir);
  if (!fs.existsSync(metadataPath)) {
    const metadata = {
      version: 1,
      accountId: String(accountId),
      browserKey: String(browserKey),
      createdAt: new Date().toISOString(),
      purpose: 'persistent-session-profile',
    };
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), { encoding: 'utf8', mode: 0o600 });
  }
}

function cleanStaleProfileLocks(profileDir) {
  if (!profileDir || !fs.existsSync(profileDir)) return false;
  const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile'];
  let cleaned = 0;
  for (const lockFile of lockFiles) {
    try {
      const lockPath = path.join(profileDir, lockFile);
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
        cleaned += 1;
      }
    } catch {
      // Ignore lock file deletion errors if held by an active process
    }
  }
  return cleaned > 0;
}

function getSessionFilePath(userId, accountId) {
  const safeUserId = String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeAccountId = String(accountId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = path.join(getAutomationStorageRoot(), 'sessions');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(getAutomationStorageRoot(), 'sessions', `session_${safeUserId}_${safeAccountId}.json`);
}

async function capturePageStorage(page, context) {
  let storageState = null;
  if (context && typeof context.storageState === 'function') {
    storageState = await context.storageState().catch(() => null);
  }
  let sessionStorageData = {};
  let tokensData = null;
  if (page && typeof page.evaluate === 'function') {
    const pageStorage = await page.evaluate(() => {
      try {
        const items = {};
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          items[key] = sessionStorage.getItem(key);
        }
        let toks = null;
        try {
          const raw = localStorage.getItem('ir:tokens');
          if (raw) toks = JSON.parse(raw);
        } catch {}
        return { sessionStorage: items, tokens: toks };
      } catch { return { sessionStorage: {}, tokens: null }; }
    }).catch(() => ({ sessionStorage: {}, tokens: null }));
    sessionStorageData = pageStorage.sessionStorage || {};
    tokensData = pageStorage.tokens || null;
  }
  if (!storageState) return null;
  return {
    ...storageState,
    sessionStorage: sessionStorageData,
    tokens: tokensData,
  };
}

function saveSessionToDisk(userId, accountId, storageState) {
  try {
    const file = getSessionFilePath(userId, accountId);
    const tempFile = `${file}.tmp-${process.pid}-${Date.now()}`;
    const envelope = {
      version: 2,
      encrypted: true,
      payload: encryptCredential(JSON.stringify(storageState)),
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(tempFile, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempFile, file);
    try { fs.chmodSync(file, 0o600); } catch {}
    console.log('[IRCTC Automation] Encrypted session saved.');
  } catch (err) {
    console.warn('[IRCTC Automation] Session disk save failed:', err.message);
  }
}

async function touchProfileCookieFile(context, profileDir) {
  try {
    const cookies = await context.cookies();
    if (!Array.isArray(cookies) || cookies.length === 0) return;
    const profileCookieDir = path.join(profileDir, 'Default', 'Network');
    if (!fs.existsSync(profileCookieDir)) {
      fs.mkdirSync(profileCookieDir, { recursive: true });
    }
    const cookieFilePath = path.join(profileCookieDir, 'Cookies');
    if (fs.existsSync(cookieFilePath)) {
      const now = new Date();
      fs.utimesSync(cookieFilePath, now, now);
    }
    console.log('[IRCTC Automation] Profile cookie file touched to preserve session.', JSON.stringify({
      cookieCount: cookies.length,
      profileDir,
    }));
  } catch (cookieErr) {
    console.warn('[IRCTC Automation] Profile cookie persist failed:', cookieErr.message);
  }
}

function loadSessionFromDiskSync(userId, accountId) {
  try {
    const file = getSessionFilePath(userId, accountId);
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    if (data?.version === 2 && data?.encrypted && data?.payload) {
      const payload = data.payload;
      const plaintext = decryptCredential(payload.encryptedPassword, payload.iv, payload.authTag);
      const state = JSON.parse(plaintext);
      console.log('[IRCTC Automation] Encrypted disk session loaded.');
      return state;
    }

    // One-time migration path for sessions written by older versions.
    if (data && typeof data === 'object') {
      try { saveSessionToDisk(userId, accountId, data); } catch {}
      console.warn('[IRCTC Automation] Migrated legacy plaintext session to encrypted storage.');
      return data;
    }
    return null;
  } catch (err) {
    console.warn('[IRCTC Automation] Session disk load failed:', err.message);
    return null;
  }
}

async function loadSessionFromDisk(userId, accountId) {
  try {
    if (!isSodiumInitialized()) {
      await initCrypto().catch(() => {});
    }
    return loadSessionFromDiskSync(userId, accountId);
  } catch (err) {
    console.warn('[IRCTC Automation] Session disk load failed:', err.message);
    return null;
  }
}

function deleteSessionFromDisk(userId, accountId) {
  try {
    const file = getSessionFilePath(userId, accountId);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      console.log('[IRCTC Automation] Disk session deleted:', file);
    }
  } catch (err) {
    console.warn('[IRCTC Automation] Session disk delete failed:', err.message);
  }
}

const STAGES = Object.freeze({
  BROWSER_LAUNCH: 'browser_launch',
  NAVIGATION: 'navigation',
  LOGIN: 'login',
  LOGIN_VERIFICATION: 'login_verification',
  FROM_STATION: 'from_station',
  TO_STATION: 'to_station',
  DATE: 'date',
  SUBMIT_SEARCH: 'submit_search',
  WAITING_RESULTS: 'waiting_results',
  EXTRACTING_RESULTS: 'extracting_results',
  COMPLETE: 'complete',
});

const BLOCKED_DOMAINS = [
  'google-analytics.com',
  'googletagmanager.com',
  'doubleclick.net',
  'googleadservices.com',
  'adservice.google',
  'hotjar.com',
  'clarity.ms',
];

// IRCTC payment gateway domains that MUST NOT be blocked.
const ALLOWLISTED_PAYMENT_DOMAINS = [
  'irctc.co.in',
  'irctcipay.com',
  'wps.irctc.co.in',
  'pg.irctcpayments.com',
  'paytm',
  'phonepe',
  'bhim',
  'upi',
  'sbi',
  'hdfc',
  'icici',
  'axis',
  'kotak',
  'yesbank',
  'unionbank',
  'pnb',
  'canara',
  'bankofbaroda',
];

const IRCTC_STATE_WAIT_TIMEOUT_MS = 90000;
const IRCTC_STATE_POLL_INTERVAL_MS = 400;
const IRCTC_PAYMENT_ACTION_TIMEOUT_MS = 120000;

function createCorrelationId(prefix = 'nav') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function resolveHeadlessMode(value = process.env.IRCTC_LAUNCH_HEADLESS) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function normalizeIrctcClassCode(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().toUpperCase();
  // Match specific class codes before broader descriptions (3E before 3A).
  if (/\b1A\b/.test(text) || /AC\s+FIRST/.test(text)) return '1A';
  if (/\b2A\b/.test(text) || /AC\s+2\s*TIER/.test(text)) return '2A';
  if (/\b3E\b/.test(text) || /AC\s+3\s*TIER\s+ECONOMY/.test(text)) return '3E';
  if (/\b3A\b/.test(text) || /AC\s+3\s*TIER/.test(text)) return '3A';
  if (/\b2S\b/.test(text) || /SECOND\s+SITTING/.test(text)) return '2S';
  if (/\bSL\b/.test(text) || /SLEEPER/.test(text)) return 'SL';
  if (/\bCC\b/.test(text) || /AC\s+CHAIR/.test(text)) return 'CC';
  if (/\bEC\b/.test(text) || /EXECUTIVE\s+CHAIR/.test(text)) return 'EC';
  return null;
}

function normalizeIrctcCateringChoice(value) {
  const text = String(value || '').trim().toUpperCase();
  if (text === 'VEG' || text === 'VEGETARIAN') return 'VEGETARIAN';
  if (text === 'NON') return 'NON';
  if (text === 'NON-VEG' || text === 'NON VEG' || text === 'NON-VEGETARIAN') return 'NON-VEGETARIAN';
  return text.replace(/_/g, ' ');
}

function normalizeIrctcPaymentMethodChoice(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().toUpperCase();
  if (!text || text === 'DEFAULT PAYMENT (AUTO)') return 'DEFAULT';
  if (/IRCTC\s*IPAY|IPAY/.test(text)) return 'IRCTC_IPAY';
  if (/BHIM|UPI|QR/.test(text)) return 'UPI';
  if (/NET\s*BANK/.test(text)) return 'NET_BANKING';
  if (/IMUDRA/.test(text)) return 'IMUDRA';
  if (/CARD|PAYMENT\s*GATEWAY/.test(text)) return 'CARD';
  return text;
}

function paymentOptionLabelMatches(value, requiredLabel) {
  const option = String(value || '').replace(/\s+/g, ' ').trim().toUpperCase();
  const required = String(requiredLabel || '').replace(/\s+/g, ' ').trim().toUpperCase();
  if (!required) return false;
  if (option.includes(required)) return true;
  return option.startsWith(required) &&
    (option.length === required.length || !/[A-Z0-9]/.test(option[required.length]));
}

function cateringOptionMatches(label, value, requested) {
  const option = `${label} ${value}`.replace(/\s+/g, ' ').trim().toUpperCase();
  const desired = normalizeIrctcCateringChoice(requested);
  if (desired === 'VEGETARIAN') return /\bVEG(?:ETARIAN)?\b/.test(option) && !/NON/.test(option);
  if (desired === 'NON' || desired === 'NON-VEGETARIAN') return /NON[\s-]*(?:VEG|VEGETARIAN)?/.test(option) || /\bN[V]?G?\b/.test(value);
  return option.includes(desired);
}

function extractIrctcAvailabilityDate(value, year) {
  const match = String(value || '').match(/\b(?:MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY|MON|TUE|WED|THU|FRI|SAT|SUN),?\s+(\d{1,2})\s+([A-Z]{3})\b/i);
  if (!match) return null;
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const month = months.indexOf(match[2].toUpperCase());
  if (month < 0) return null;
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Number(match[1])).padStart(2, '0')}`;
}

function getPatchrightEngine() {
  try {
    return require('patchright-core');
  } catch {
    try {
      return require('patchright');
    } catch {
      const err = new Error('Patchright Core automation engine is not installed.');
      err.status = 500;
      throw err;
    }
  }
}

const AUTH_CODES = Object.freeze({
  AUTHENTICATED: 'AUTHENTICATED',
  AUTHENTICATED_EXISTING_SESSION: 'AUTHENTICATED_EXISTING_SESSION',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_LOGIN_IN_PROGRESS: 'AUTH_LOGIN_IN_PROGRESS',
  AUTH_SUCCESS: 'AUTH_SUCCESS',
  AUTH_FAILED: 'AUTH_FAILED',
  CLIENT_IP_ERROR: 'IRCTC_CLIENT_IP_ERROR',
  AUTH_CLIENT_IP_REJECTED: 'IRCTC_CLIENT_IP_ERROR',
  INVALID_CREDENTIALS: 'IRCTC_INVALID_CREDENTIALS',
  CAPTCHA_REQUIRED: 'IRCTC_CAPTCHA_REQUIRED',
  AUTH_CAPTCHA_REQUIRED: 'IRCTC_CAPTCHA_REQUIRED',
  OTP_REQUIRED: 'IRCTC_OTP_REQUIRED',
  AUTH_OTP_REQUIRED: 'IRCTC_OTP_REQUIRED',
  MFA_REQUIRED: 'IRCTC_MFA_REQUIRED',
  ACCOUNT_RESTRICTED: 'IRCTC_ACCOUNT_RESTRICTED',
  SERVER_ERROR: 'IRCTC_SERVER_ERROR',
  SECURITY_CHALLENGE: 'IRCTC_SECURITY_CHALLENGE',
  AUTH_SECURITY_CHALLENGE: 'IRCTC_SECURITY_CHALLENGE',
  LOGIN_FORM_STILL_PRESENT: 'IRCTC_LOGIN_FORM_STILL_PRESENT',
  UNKNOWN_AUTH_STATE: 'IRCTC_UNKNOWN_AUTH_STATE',
  AUTH_PAGE_STATE_UNKNOWN: 'IRCTC_UNKNOWN_AUTH_STATE',
});

function logStage(ticketId, stageName, meta = {}) {
  const metaStr = Object.keys(meta).length ? ` | ${JSON.stringify(meta)}` : '';
  console.log(`[IRCTC Automation][Stage: ${stageName}] Ticket ${ticketId}${metaStr}`);
}

class IrctcAutomationService {
  constructor() {
    this.config = irctcConfig;
    this._sessionCache = new Map();
    this._ticketBookingState = new Map();
    this._bookingTimers = new Map();
    this._activeSessions = new Map();
    this._accountSessions = new Map();
    this._launchLocks = new Map();
    this._activeLaunches = new Map();
    this._activeBookings = new Set();
    this._proxiesTableChecked = false;

    if (typeof process !== 'undefined') {
      const cleanupProcessesSync = () => {
        for (const session of this._accountSessions.values()) {
          try {
            if (session?.context) session.context.close().catch(() => {});
          } catch {}
        }
        for (const session of this._activeSessions.values()) {
          try {
            if (session?.context) session.context.close().catch(() => {});
            if (session?.browser) session.browser.close().catch(() => {});
          } catch {}
        }
      };

      const handleTermination = async (signal) => {
        console.log(`[IRCTC Automation] Process received ${signal}, closing all active browser contexts...`);
        const closePromises = [];
        for (const session of this._accountSessions.values()) {
          if (session?.context) closePromises.push(session.context.close().catch(() => {}));
        }
        for (const session of this._activeSessions.values()) {
          if (session?.context) closePromises.push(session.context.close().catch(() => {}));
        }
        await Promise.allSettled(closePromises);
        process.exit(0);
      };

      process.once('exit', cleanupProcessesSync);
      process.once('SIGINT', () => handleTermination('SIGINT'));
      process.once('SIGTERM', () => handleTermination('SIGTERM'));
    }
  }

  cleanStaleProfileLocks(profileDir) {
    return cleanStaleProfileLocks(profileDir);
  }

  getSessionLockKey(accountId, browserKey) {
    const acc = String(accountId || 'default').trim();
    const bKey = String(browserKey || 'chrome').trim().toLowerCase();
    return `${acc}_${bKey}`;
  }

  getTrainSearchUrl() {
    return this.config.TARGET_TRAIN_SEARCH_URL;
  }

  getSessionKey(userId, accountId) {
    return `${userId}:${accountId}`;
  }

  async getSessionDiagnostics(userId, accountId) {
    const diagnostics = {
      userId: String(userId || ''),
      accountId: String(accountId || ''),
      memoryCache: false,
      memoryCacheAgeMinutes: 0,
      diskSession: false,
      diskSessionAgeMinutes: 0,
      diskTotalCookies: 0,
      diskUsableCookies: 0,
      diskHasJsessionId: false,
      profileExists: false,
    };

    try {
      const memKey = this.getSessionKey(userId, accountId);
      const memSession = this._sessionCache.get(memKey);
      if (memSession && memSession.lastActive) {
        diagnostics.memoryCache = true;
        diagnostics.memoryCacheAgeMinutes = Math.round(
          (Date.now() - memSession.lastActive) / 60000
        );
      }
    } catch (err) {
      console.warn('[IRCTC Automation][SESSION_DIAGNOSTICS_MEMORY_ERROR]', err.message);
    }

    try {
      const file = getSessionFilePath(userId, accountId);
      if (fs.existsSync(file)) {
        const stat = fs.statSync(file);
        diagnostics.diskSession = true;
        diagnostics.diskSessionAgeMinutes = Math.round(
          (Date.now() - stat.mtimeMs) / 60000
        );
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const cookies = Array.isArray(data?.cookies) ? data.cookies : [];
        diagnostics.diskTotalCookies = cookies.length;
        diagnostics.diskUsableCookies = this._filterUsableCookies(cookies).length;
        diagnostics.diskHasJsessionId = cookies.some((cookie) => cookie.name === 'JSESSIONID');
      }
    } catch (err) {
      console.warn('[IRCTC Automation][SESSION_DIAGNOSTICS_DISK_ERROR]', err.message);
    }

    try {
      const profileDir = getAutomationProfilePath(accountId, 'chrome');
      diagnostics.profileExists = this._profileHasSessionData(profileDir);
    } catch (err) {
      console.warn('[IRCTC Automation][SESSION_DIAGNOSTICS_PROFILE_ERROR]', err.message);
    }

    console.log('[IRCTC Automation][SESSION_DIAGNOSTICS]', JSON.stringify(diagnostics));
    return diagnostics;
  }

  _profileHasSessionData(profileDir) {
    try {
      if (!profileDir || !fs.existsSync(profileDir)) return false;
      const entries = fs.readdirSync(profileDir);
      const hasDefault = entries.includes('Default');
      const hasLocalState = entries.includes('Local State');
      const hasPreferences = entries.includes('Preferences');
      if (!hasDefault) return false;
      const defaultDir = path.join(profileDir, 'Default');
      if (!fs.existsSync(defaultDir)) return false;

      const cookieLocations = [
        path.join(defaultDir, 'Cookies'),
        path.join(defaultDir, 'Network', 'Cookies'),
      ];
      for (const cookieFile of cookieLocations) {
        if (fs.existsSync(cookieFile) && fs.statSync(cookieFile).size > 5120) return true;
      }

      const sessionStorageDir = path.join(defaultDir, 'Session Storage');
      const localStorageDir = path.join(defaultDir, 'Local Storage');
      if ((fs.existsSync(sessionStorageDir) || fs.existsSync(localStorageDir)) &&
        (hasLocalState || hasPreferences)) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  _areCookiesUsable(cookies) {
    if (!Array.isArray(cookies) || cookies.length === 0) return false;
    const nowSeconds = Math.floor(Date.now() / 1000);
    return cookies.some((cookie) => {
      if (!cookie || !cookie.name) return false;
      if (cookie.expires === undefined || cookie.expires === null) return true;
      if (cookie.expires === -1 || cookie.expires === 0) return true;
      return Number(cookie.expires) > nowSeconds + 30;
    });
  }

  _filterUsableCookies(cookies) {
    if (!Array.isArray(cookies)) return [];
    const nowSeconds = Math.floor(Date.now() / 1000);
    return cookies.filter((cookie) => {
      if (!cookie || !cookie.name) return false;
      if (cookie.expires === undefined || cookie.expires === null) return true;
      if (cookie.expires === -1 || cookie.expires === 0) return true;
      return Number(cookie.expires) > nowSeconds + 30;
    });
  }

  async _tryRestoreSessionFromDisk(page, context, userId, accountId, ticketId, account) {
    if (!context || !page) return false;
    try {
      const cachedSession = this.getSessionState(userId, accountId);
      const cachedCookies = Array.isArray(cachedSession?.storageState?.cookies)
        ? cachedSession.storageState.cookies
        : [];
      const cachedUsableCookies = this._filterUsableCookies(cachedCookies);
      const diskSession = await loadSessionFromDisk(userId, accountId);
      const diskCookies = Array.isArray(diskSession?.cookies) ? diskSession.cookies : [];
      const diskUsableCookies = this._filterUsableCookies(diskCookies);
      const cookieSource = cachedUsableCookies.length > 0 ? 'memory_cache' : 'disk';
      const rawCookies = cookieSource === 'memory_cache' ? cachedCookies : diskCookies;
      const usableCookies = cookieSource === 'memory_cache' ? cachedUsableCookies : diskUsableCookies;

      if (usableCookies.length === 0 && !diskSession && cachedCookies.length === 0) {
        console.log('[IRCTC Automation][COOKIE_RESTORE_SKIPPED]', JSON.stringify({
          ticketId,
          reason: 'no_disk_session',
        }));
        return false;
      }
      if (!this._areCookiesUsable(rawCookies) || usableCookies.length === 0) {
        console.log('[IRCTC Automation][COOKIE_RESTORE_SKIPPED]', JSON.stringify({
          ticketId,
          reason: 'no_usable_cookies',
          totalCookies: rawCookies.length,
        }));
        return false;
      }

      console.log('[IRCTC Automation][COOKIE_RESTORE_ATTEMPT]', JSON.stringify({
        ticketId,
        source: cookieSource,
        usableCookies: usableCookies.length,
        totalCookies: rawCookies.length,
        hasSessionStorage: Boolean(diskSession?.sessionStorage && Object.keys(diskSession.sessionStorage).length > 0),
      }));

      await context.addCookies(usableCookies);
      const sessionStorageItems = diskSession?.sessionStorage || cachedSession?.storageState?.sessionStorage || null;
      if (sessionStorageItems && Object.keys(sessionStorageItems).length > 0) {
        if (typeof context.addInitScript === 'function') {
          await context.addInitScript((items) => {
            try {
              for (const [k, v] of Object.entries(items)) {
                if (k && v !== undefined && v !== null) {
                  window.sessionStorage.setItem(k, v);
                }
              }
            } catch {}
          }, sessionStorageItems).catch(() => {});
        }
        if (typeof page.evaluate === 'function') {
          await page.evaluate((items) => {
            try {
              for (const [k, v] of Object.entries(items)) {
                if (k && v !== undefined && v !== null) {
                  window.sessionStorage.setItem(k, v);
                }
              }
            } catch {}
          }, sessionStorageItems).catch(() => {});
        }
      }

      if (Array.isArray(diskSession?.origins)) {
        for (const originEntry of diskSession.origins) {
          if (originEntry.origin && originEntry.origin.includes('irctc.co.in') && Array.isArray(originEntry.localStorage)) {
            if (typeof page.evaluate === 'function') {
              await page.evaluate((items) => {
                for (const item of items) {
                  if (item.name && item.value !== undefined) {
                    try { localStorage.setItem(item.name, item.value); } catch {}
                  }
                }
              }, originEntry.localStorage).catch(() => {});
            }
          }
        }
      }

      if (sessionStorageItems && Object.keys(sessionStorageItems).length > 0 && typeof page.evaluate === 'function') {
        await page.evaluate((items) => {
          try {
            for (const [k, v] of Object.entries(items)) {
              if (k && v !== undefined && v !== null) {
                window.sessionStorage.setItem(k, v);
              }
            }
          } catch {}
        }, sessionStorageItems).catch(() => {});
      }

      const diskTokens = diskSession?.tokens || cachedSession?.storageState?.tokens || null;
      if (diskTokens && typeof page.evaluate === 'function') {
        await page.evaluate((toks) => {
          try {
            const cur = JSON.parse(localStorage.getItem('ir:tokens') || '{}');
            localStorage.setItem('ir:tokens', JSON.stringify({ ...cur, ...toks }));
          } catch {}
        }, diskTokens).catch(() => {});
        if (page) page.__capturedTokens = Object.assign(page.__capturedTokens || {}, diskTokens);
      }

      const recheckAuth = await this._detectAuthenticationState(page, account, 1500);
      if (recheckAuth.state === AUTH_CODES.AUTHENTICATED) {
        console.log('[IRCTC Automation][COOKIE_RESTORE_SUCCESS]', JSON.stringify({
          ticketId,
          appliedCookies: usableCookies.length,
        }));
        return true;
      }

      console.log('[IRCTC Automation][COOKIE_RESTORE_FAILED]', JSON.stringify({
        ticketId,
        authState: recheckAuth.state,
      }));
      return false;
    } catch (err) {
      console.warn('[IRCTC Automation][COOKIE_RESTORE_ERROR]', JSON.stringify({
        ticketId,
        error: err.message,
      }));
      return false;
    }
  }

  async _bindTicketToSession(ticketId, ticket, userId, session, options = {}) {
    if (!session?.context) throw new Error('IRCTC_SESSION_CONTEXT_UNAVAILABLE');
    const page = typeof session.context.newPage === 'function'
      ? await session.context.newPage()
      : (session.page || null);
    const ticketSession = {
      ...session,
      page,
      ticket,
      userId,
      ticketId,
      stopPayment: Boolean(options.stopPayment),
      workflowOwner: `ticket:${ticketId}`,
    };
    this._activeSessions.set(ticketId, ticketSession);
    console.log('[IRCTC Automation][WORKFLOW_PAGE_BOUND]', JSON.stringify({
      ticketId,
      accountId: ticketSession.accountId,
      browserKey: ticketSession.browserKey,
      pageId: page.guid || null,
      sharedContext: true,
    }));
    return ticketSession;
  }

  async _gotoWithDiagnostics(page, url, navigationContext = {}) {
    const correlationId = navigationContext.correlationId || createCorrelationId();
    const timeout = navigationContext.timeout || this.config.NAVIGATION_TIMEOUT_MS || 35000;
    const waitUntil = navigationContext.waitUntil || 'domcontentloaded';
    const events = [];
    const isRelevantUrl = (candidate) => {
      try {
        const parsed = new URL(candidate);
        return parsed.hostname === 'www.irctc.co.in' || parsed.hostname.endsWith('.irctc.co.in');
      } catch {
        return false;
      }
    };
    const record = (event) => {
      if (events.length < 40) events.push(event);
    };

    console.log('[IRCTC][NAVIGATION_START]', JSON.stringify({
      correlationId,
      ticketId: navigationContext.ticketId ?? null,
      accountId: navigationContext.accountId ?? null,
      browser: navigationContext.browser ?? null,
      sessionKey: navigationContext.sessionKey ?? null,
      url,
      profileIdentifier: navigationContext.profileIdentifier ?? null,
      timeout,
      waitUntil,
    }));

    const listeners = {
      request: (request) => {
        if (request.isNavigationRequest?.() || isRelevantUrl(request.url())) {
          record({ type: 'request', url: request.url(), method: request.method() });
        }
      },
      response: (response) => {
        if (isRelevantUrl(response.url())) {
          record({ type: 'response', url: response.url(), status: response.status() });
        }
      },
      requestfailed: (request) => {
        record({
          type: 'requestfailed',
          url: request.url(),
          failure: request.failure()?.errorText || 'unknown',
        });
      },
      pageerror: (error) => record({ type: 'pageerror', message: error.message }),
      console: (message) => {
        if (message.type() === 'error') record({ type: 'console', text: message.text() });
      },
      framenavigated: (frame) => {
        if (frame === page.mainFrame?.()) {
          record({ type: 'framenavigated', url: frame.url() });
        }
      },
    };

    for (const [event, listener] of Object.entries(listeners)) {
      page.on(event, listener);
    }

    try {
      const response = await page.goto(url, { waitUntil, timeout });
      const finalUrl = page.url();
      const result = {
        response,
        finalUrl,
        status: response ? response.status() : null,
        events,
        correlationId,
      };
      console.log('[IRCTC][NAVIGATION_END]', JSON.stringify({
        correlationId,
        finalUrl,
        status: result.status,
        events,
      }));
      return result;
    } catch (error) {
      const diagnostics = {
        correlationId,
        finalUrl: page.url(),
        events,
      };
      error.navigationDiagnostics = diagnostics;
      console.error('[IRCTC][NAVIGATION_FAILED]', JSON.stringify({
        correlationId,
        error: error.message,
        finalUrl: diagnostics.finalUrl,
        events,
      }));
      throw error;
    } finally {
      for (const [event, listener] of Object.entries(listeners)) {
        if (typeof page.off === 'function') page.off(event, listener);
        else if (typeof page.removeListener === 'function') page.removeListener(event, listener);
      }
    }
  }

  async _navigateWithFallback(page, primaryUrl, secondaryUrl, navigationContext = {}) {
    const urls = [primaryUrl];
    if (secondaryUrl && secondaryUrl !== primaryUrl) urls.push(secondaryUrl);
    let lastError = null;

    for (let index = 0; index < urls.length; index += 1) {
      try {
        const navigation = await this._gotoWithDiagnostics(page, urls[index], {
          ...navigationContext,
          correlationId: createCorrelationId(index === 0 ? 'nav' : 'nav_retry'),
        });
        const status = navigation.response ? navigation.response.status() : null;
        if (status === 403 || status === 429) {
          const responseError = new Error(
            `IRCTC returned HTTP ${status} for train-search navigation; the portal or its security gateway denied the request.`
          );
          responseError.code = status === 403 ? 'IRCTC_ACCESS_DENIED' : 'IRCTC_RATE_LIMITED';
          responseError.status = status;
          responseError.stage = STAGES.NAVIGATION;
          responseError.nonRetryableNavigation = true;
          responseError.navigationDiagnostics = {
            correlationId: navigation.correlationId,
            finalUrl: navigation.finalUrl,
            status,
            events: navigation.events,
          };
          console.warn('[IRCTC][NAVIGATION_REJECTED]', JSON.stringify({
            correlationId: navigation.correlationId,
            status,
            finalUrl: navigation.finalUrl,
            reason: responseError.code,
          }));
          throw responseError;
        }
        return navigation;
      } catch (error) {
        lastError = error;
        if (error?.nonRetryableNavigation) throw error;
        if (index + 1 < urls.length) {
          console.warn(`[IRCTC Automation][Navigation] Primary navigation failed; trying distinct secondary URL: ${error.message}`);
        }
      }
    }

    const navigationError = new Error(`IRCTC navigation failed: ${lastError?.message || 'unknown transport error'}`);
    navigationError.code = 'IRCTC_NAVIGATION_TRANSPORT_ERROR';
    navigationError.status = 502;
    navigationError.stage = STAGES.NAVIGATION;
    navigationError.cause = lastError;
    navigationError.navigationDiagnostics = lastError?.navigationDiagnostics || null;
    throw navigationError;
  }

  getSessionState(userId, accountId) {
    const key = this.getSessionKey(userId, accountId);
    const session = this._sessionCache.get(key);
    if (!session) return null;

    const ttl = this.config.SESSION_TTL_MS || 900000;
    if (Date.now() - session.lastActive > ttl) {
      this._sessionCache.delete(key);
      return null;
    }
    return session;
  }

  setSessionState(userId, accountId, state) {
    const key = this.getSessionKey(userId, accountId);
    this._sessionCache.set(key, {
      ...state,
      lastActive: Date.now(),
    });
  }

  clearSessionState(userId, accountId) {
    const key = this.getSessionKey(userId, accountId);
    this._sessionCache.delete(key);
    deleteSessionFromDisk(userId, accountId);
  }

  clearUserSessions(userId, accountId = null) {
    let clearedCount = 0;
    const prefix = `${userId}:`;
    for (const key of this._sessionCache.keys()) {
      if (key.startsWith(prefix) || key === String(userId)) {
        this._sessionCache.delete(key);
        clearedCount += 1;
      }
    }

    const accountStr = accountId ? String(accountId) : null;
    for (const [sessionKey, session] of this._accountSessions.entries()) {
      if (!accountStr || sessionKey.startsWith(`${accountStr}_`) || String(session.accountId) === accountStr) {
        try {
          if (session?.context) session.context.close().catch(() => {});
        } catch {}
        this._accountSessions.delete(sessionKey);
        clearedCount += 1;
      }
    }

    for (const [tId, session] of this._activeSessions.entries()) {
      if (!accountStr || String(session?.accountId) === accountStr || String(session?.ticket?.irctcAccountId) === accountStr) {
        try {
          if (session?.context) session.context.close().catch(() => {});
        } catch {}
        this._activeSessions.delete(tId);
      }
    }

    try {
      const profilesBase = path.join(getAutomationStorageRoot(), 'automation-profiles');
      if (fs.existsSync(profilesBase)) {
        const entries = fs.readdirSync(profilesBase);
        for (const entry of entries) {
          let shouldDelete = false;
          if (accountId) {
            if (entry.startsWith(`acc_${accountId}_`) || entry === `acc_${accountId}`) {
              shouldDelete = true;
            }
          } else {
            shouldDelete = true;
          }
          if (shouldDelete) {
            const entryPath = path.join(profilesBase, entry);
            try {
              fs.rmSync(entryPath, { recursive: true, force: true });
              clearedCount += 1;
            } catch {}
          }
        }
      }
    } catch (err) {
      console.warn('[IRCTC Automation] Disk profile purge notice:', err.message);
    }

    try {
      const sessionsBase = path.join(getAutomationStorageRoot(), 'sessions');
      if (fs.existsSync(sessionsBase)) {
        const entries = fs.readdirSync(sessionsBase);
        for (const entry of entries) {
          let shouldDelete = false;
          if (accountId) {
            if (entry === `session_${userId}_${accountId}.json`) {
              shouldDelete = true;
            }
          } else {
            if (entry.startsWith(`session_${userId}_`)) {
              shouldDelete = true;
            }
          }
          if (shouldDelete) {
            try {
              fs.unlinkSync(path.join(sessionsBase, entry));
              clearedCount += 1;
            } catch {}
          }
        }
      }
    } catch (err) {
      console.warn('[IRCTC Automation] Session file purge notice:', err.message);
    }

    console.log(`[IRCTC Automation] Cleared ${clearedCount} session artifact(s) for user ${userId}${accountId ? ` account ${accountId}` : ' (all accounts)'}`);
    return clearedCount;
  }

  async prepareAccountForAutomation(userId, accountId) {
    const account = await targetAccountService.getDecryptedAccountForAutomation(userId, accountId);
    if (!account) {
      const err = new Error('IRCTC account not found or access denied.');
      err.status = 404;
      throw err;
    }
    return {
      id: account.id,
      irctcUserId: account.irctcUserId,
      password: account.password,
    };
  }

  async searchTrains(userId, params) {
    let lastError = null;
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (attempt > 1) {
          console.log(`[IRCTC Automation] Retrying search (Attempt ${attempt}/${maxAttempts}) after short backoff...`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        return await this._executeSearchWorkflow(userId, params);
      } catch (err) {
        lastError = err;

        const nonRetryableCodes = [
          'LOGIN_FAILED',
          'LOGIN_REQUIRES_CAPTCHA',
          'LOGIN_REQUIRES_OTP',
          'IRCTC_ACCESS_DENIED',
          'IRCTC_MANUAL_VERIFICATION_REQUIRED',
          'VALIDATION_ERROR',
          'TRAIN_NOT_AVAILABLE',
        ];

        if (err.code && nonRetryableCodes.includes(err.code)) {
          throw err;
        }

        if (err.status && err.status < 500) {
          throw err;
        }

        console.warn(`[IRCTC Automation] Attempt ${attempt} failed with error: ${err.message} [code=${err.code}, stage=${err.stage}]`);
        if (attempt >= maxAttempts) {
          throw err;
        }
      }
    }

    throw lastError;
  }

  async _executeSearchWorkflow(userId, { accountId, fromStation, toStation, journeyDate, quota = 'General', travelClass = 'All', ticketId = null }) {
    let currentStage = STAGES.BROWSER_LAUNCH;
    console.log(`[IRCTC Automation] TRAIN_SEARCH_STAGE=${currentStage}`);

    const cleanFrom = (fromStation || '').trim().toUpperCase();
    const cleanTo = (toStation || '').trim().toUpperCase();

    if (!cleanFrom || !cleanTo) {
      const err = new Error('From Station and To Station are required.');
      err.status = 400;
      err.code = 'VALIDATION_ERROR';
      err.stage = STAGES.FROM_STATION;
      throw err;
    }
    if (cleanFrom === cleanTo) {
      const err = new Error('From Station and To Station cannot be the same.');
      err.status = 400;
      err.code = 'VALIDATION_ERROR';
      err.stage = STAGES.FROM_STATION;
      throw err;
    }

    const account = await this.prepareAccountForAutomation(userId, accountId);

    let patchright;
    try {
      patchright = getPatchrightEngine();
    } catch (engineErr) {
      engineErr.stage = STAGES.BROWSER_LAUNCH;
      throw engineErr;
    }

    let browser = null;
    let context = null;
    let page = null;

    try {
      const browserKey = 'chrome';
      const automationProfileDir = getAutomationProfilePath(accountId, browserKey);
      try {
        ensureProfileMetadata(automationProfileDir, accountId, browserKey);
      } catch (profileErr) {
        profileErr.stage = STAGES.BROWSER_LAUNCH;
        throw profileErr;
      }

      const contextOptions = {
        headless: true,
        viewport: { width: 1440, height: 900 },
        locale: 'en-US',
        colorScheme: 'light',
        serviceWorkers: 'allow',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
        ],
      };

      // Check for saved session in memory or on disk
      const cachedSession = this.getSessionState(userId, accountId);
      const diskSession = (cachedSession && cachedSession.storageState)
        ? cachedSession.storageState
        : await loadSessionFromDisk(userId, accountId);

      if (diskSession) {
        const rawCookies = diskSession.cookies || diskSession.storageState?.cookies || [];
        const usable = this._filterUsableCookies(rawCookies);
        if (usable.length > 0) {
          contextOptions.storageState = diskSession.storageState || diskSession;
          console.log(`[IRCTC Automation] Persistent session storageState applied (cookies=${usable.length}) for account: ${account?.irctcUserId || accountId}`);
        } else {
          console.log('[IRCTC Automation] Persisted session cookies expired; will require login.');
        }
      } else {
        console.log('[IRCTC Automation] No saved session found; will require login.');
      }

      try {
        contextOptions.headless = true;
        context = await patchright.chromium.launchPersistentContext(automationProfileDir, contextOptions);
      } catch (launchErr) {
        const err = new Error(`Persistent browser profile could not be opened: ${launchErr?.message || 'unknown error'}`);
        err.code = 'PERSISTENT_PROFILE_UNAVAILABLE';
        err.stage = STAGES.BROWSER_LAUNCH;
        err.cause = launchErr;
        throw err;
      }

      if (diskSession?.sessionStorage && Object.keys(diskSession.sessionStorage).length > 0) {
        await context.addInitScript((items) => {
          try {
            for (const [k, v] of Object.entries(items)) {
              if (k && v !== undefined && v !== null) {
                window.sessionStorage.setItem(k, v);
              }
            }
          } catch {}
        }, diskSession.sessionStorage).catch(() => {});
      }

      const pages = context.pages();
      page = pages.length > 0 ? pages[0] : await context.newPage();
      page.setDefaultTimeout(this.config.ACTION_TIMEOUT_MS || 10000);

      await page.route('**/*', (route) => {
        const url = route.request().url();
        const isAllowlisted = ALLOWLISTED_PAYMENT_DOMAINS.some((d) => url.includes(d));
        if (isAllowlisted) {
          route.continue();
          return;
        }
        const isBlocked = BLOCKED_DOMAINS.some((domain) => url.includes(domain));
        if (isBlocked) {
          route.abort();
        } else {
          route.continue();
        }
      });

      page.on('dialog', async (dialog) => {
        try {
          console.log('[IRCTC Automation] Dialog detected and dismissed:', dialog.message());
          await dialog.dismiss();
        } catch {}
      });

      currentStage = STAGES.NAVIGATION;
      console.log(`[IRCTC Automation] TRAIN_SEARCH_STAGE=${currentStage}`);

      let navResponse = null;
      try {
        const navigation = await this._gotoWithDiagnostics(page, this.getTrainSearchUrl(), {
          ticketId,
          accountId,
          browser: 'search',
          sessionKey: this.getSessionLockKey(accountId, 'search'),
          profileIdentifier: 'search-context',
          timeout: this.config.NAVIGATION_TIMEOUT_MS || 35000,
        });
        navResponse = navigation.response;
      } catch (navErr) {
        console.warn('[IRCTC Automation] Navigation timeout / network error:', navErr.message);
        const timeoutErr = new Error('IRCTC service timed out while connecting to portal.');
        timeoutErr.status = 504;
        timeoutErr.code = 'SEARCH_RESULTS_TIMEOUT';
        timeoutErr.stage = STAGES.NAVIGATION;
        throw timeoutErr;
      }

      const navStatus = navResponse ? navResponse.status() : 200;
      const pageTitle = (await page.title().catch(() => '')) || '';
      const pageUrl = page.url() || '';

      if (navStatus === 403 || navStatus === 429 || pageTitle.includes('Access Denied') || pageUrl.includes('errors.edgesuite.net')) {
        console.warn(`[IRCTC Automation] Access denied by firewall: Status=${navStatus}, Title=${pageTitle}`);
        const firewallErr = new Error('IRCTC access was temporarily blocked by the portal firewall (Akamai Access Denied). Please try again in a few moments or verify your IP network connection.');
        firewallErr.status = 403;
        firewallErr.code = 'IRCTC_ACCESS_DENIED';
        firewallErr.stage = STAGES.NAVIGATION;
        throw firewallErr;
      }

      // HYDRATION GRACE
      await sleep(1000);
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('.ui-dialog-visible button, .ui-dialog-mask button, p-dialog button, div[role="dialog"] button'));
        const dismissBtn = btns.find(b => {
          const t = (b.innerText || '').toLowerCase();
          return t.includes('english') || t.includes('ok') || t.includes('dismiss') || t.includes('close');
        });
        if (dismissBtn) {
          dismissBtn.click();
        }
      }).catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(300);

      currentStage = STAGES.LOGIN;
      console.log(`[IRCTC Automation] TRAIN_SEARCH_STAGE=${currentStage}`);

      let alreadyLoggedIn = false;
      const authPollDeadline = Date.now() + 6000;
      while (Date.now() < authPollDeadline) {
        alreadyLoggedIn = await page.evaluate((uname) => {
          const text = document.body ? document.body.innerText : '';
          const hasUser = uname ? text.includes(uname) : false;
          const hasMyAccount = text.includes('MY ACCOUNT');
          const hasLogout = text.includes('LOGOUT') || text.includes('Logout');
          const loginBtn = document.querySelector('a.loginText, a[aria-label*="Login"]');
          const loginHidden = !loginBtn || loginBtn.offsetParent === null;
          return (hasUser || hasMyAccount || hasLogout) && loginHidden;
        }, account.irctcUserId).catch(() => false);
        if (alreadyLoggedIn) break;
        await sleep(500);
      }
      if (alreadyLoggedIn) {
        console.log('[IRCTC Automation] Existing IRCTC session detected (polled) for account:', account.irctcUserId);
      }

      if (!alreadyLoggedIn) {
        const loginLink = page.locator('a.loginText, a[aria-label*="Login"]').first();
        const loginLinkFound = await loginLink.isVisible({ timeout: 3000 }).catch(() => false);

        if (loginLinkFound) {
          await loginLink.click({ force: true }).catch(() => {});
        } else {
          await page.evaluate(() => {
            const el = document.querySelector('a[aria-label*="Login"], .loginText');
            if (el) el.click();
          }).catch(() => {});
        }

        const userInput = page.locator('input[formcontrolname="userid"], input[placeholder*="User Name"], #userId').first();
        const modalOpened = await userInput.waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false);

        if (!modalOpened) {
          const changedErr = new Error('IRCTC login form did not appear. The portal layout may have changed.');
          changedErr.status = 502;
          changedErr.code = 'IRCTC_PAGE_CHANGED';
          changedErr.stage = STAGES.LOGIN;
          throw changedErr;
        }

        await userInput.click({ force: true });
        await userInput.fill('');
        await userInput.pressSequentially(account.irctcUserId, { delay: 60 });

        const passInput = page.locator('input[formcontrolname="password"], input[placeholder*="Password"], #pwd').first();
        await passInput.click({ force: true });
        await passInput.fill('');
        await passInput.pressSequentially(account.password, { delay: 60 });

        const captchaInput = page.locator('input[formcontrolname="captcha"], input[placeholder*="Captcha"]').first();
        const hasCaptchaInput = await captchaInput.isVisible({ timeout: 1000 }).catch(() => false);
        if (hasCaptchaInput) {
          console.warn('[IRCTC Automation] Login requires CAPTCHA input');
          const captchaErr = new Error('IRCTC login requires CAPTCHA verification. Automatic bypass without solving is restricted.');
          captchaErr.status = 403;
          captchaErr.code = 'LOGIN_REQUIRES_CAPTCHA';
          captchaErr.stage = STAGES.LOGIN;
          throw captchaErr;
        }

        const signInBtn = page.locator('button:has-text("SIGN IN"), button[type="submit"]:has-text("SIGN IN"), button:has-text("Sign In")').first();
        if (await signInBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await signInBtn.click({ force: true }).catch(() => {});
        }

        currentStage = STAGES.LOGIN_VERIFICATION;
        console.log(`[IRCTC Automation] TRAIN_SEARCH_STAGE=${currentStage}`);

        await sleep(2500);

        const isOtpPrompt = await this._detectGenuineOtpChallenge(page);
        if (isOtpPrompt) {
          console.warn('[IRCTC Automation] Login requires OTP verification');
          const otpErr = new Error('IRCTC login requires 2FA OTP verification sent to your registered mobile.');
          otpErr.status = 403;
          otpErr.code = 'LOGIN_REQUIRES_OTP';
          otpErr.stage = STAGES.LOGIN_VERIFICATION;
          throw otpErr;
        }

        const loginErrMsg = await page.evaluate(() => {
          const modal = document.querySelector('app-login, .ui-dialog-visible, div[role="dialog"]');
          if (!modal) return null;
          const text = modal.innerText || '';
          if (text.includes('Incorrect') || text.includes('Invalid') || text.includes('Bad credentials') || text.includes('attempts remaining')) {
            const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
            const errLine = lines.find(l => l.includes('Incorrect') || l.includes('Invalid') || l.includes('Bad credentials') || l.includes('attempts remaining'));
            return errLine || text.slice(0, 150);
          }
          return null;
        });

        if (loginErrMsg) {
          console.warn('[IRCTC Automation] Login rejected:', loginErrMsg);
          await page.keyboard.press('Escape').catch(() => {});
          const loginFailedErr = new Error(`IRCTC login failed: ${loginErrMsg}`);
          loginFailedErr.status = 401;
          loginFailedErr.code = 'LOGIN_FAILED';
          loginFailedErr.stage = STAGES.LOGIN_VERIFICATION;
          throw loginFailedErr;
        }

        let loginSuccess = false;
        const loginVerifyDeadline = Date.now() + 10000;
        while (Date.now() < loginVerifyDeadline) {
          loginSuccess = await page.evaluate((uname) => {
            const text = document.body ? document.body.innerText : '';
            const hasUser = uname ? text.includes(uname) : false;
            const hasMyAccount = text.includes('MY ACCOUNT');
            const hasLogout = text.includes('LOGOUT') || text.includes('Logout');
            const loginBtn = document.querySelector('a.loginText, a[aria-label*="Login"]');
            const loginHidden = !loginBtn || loginBtn.offsetParent === null;
            return (hasUser || hasMyAccount || hasLogout) && loginHidden;
          }, account.irctcUserId).catch(() => false);
          if (loginSuccess) break;
          await sleep(500);
        }

        if (loginSuccess) {
          console.log('[IRCTC Automation] Login verified successfully. Caching storageState in memory and on disk.');
          const sessionData = await capturePageStorage(page, context).catch(() => null);
          if (sessionData) {
            this.setSessionState(userId, accountId, {
              storageState: sessionData,
              irctcUserId: account.irctcUserId,
            });
            saveSessionToDisk(userId, accountId, sessionData);
            await touchProfileCookieFile(context, automationProfileDir);
          }
        } else {
          console.warn('[IRCTC Automation] Post-login authentication state could not be verified');
          this.clearSessionState(userId, accountId);
          deleteSessionFromDisk(userId, accountId);
          await page.keyboard.press('Escape').catch(() => {});
          const verifyErr = new Error('IRCTC session could not be authenticated. Manual verification or credentials check required.');
          verifyErr.status = 403;
          verifyErr.code = 'IRCTC_MANUAL_VERIFICATION_REQUIRED';
          verifyErr.stage = STAGES.LOGIN_VERIFICATION;
          throw verifyErr;
        }
      } else {
        console.log('[IRCTC Automation] Session already verified as authenticated.');
      }

      currentStage = STAGES.FROM_STATION;
      console.log(`[IRCTC Automation] TRAIN_SEARCH_STAGE=${currentStage}:`, cleanFrom);

      const fromInput = page.locator('p-autocomplete[formcontrolname="origin"] input, #origin input').first();
      await fromInput.waitFor({ state: 'visible', timeout: 10000 });
      await fromInput.click({ force: true });
      await fromInput.fill('');
      await fromInput.pressSequentially(cleanFrom, { delay: 100 });
      await sleep(800);

      const fromOption = page.locator('ul[role="listbox"] li, .ui-autocomplete-items li').filter({ hasText: cleanFrom }).first();
      const fromOptionVisible = await fromOption.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);

      if (fromOptionVisible) {
        await fromOption.click({ force: true });
      } else {
        const validOption = page.locator('ul[role="listbox"] li:not(:has-text("---")), .ui-autocomplete-items li:not(:has-text("---"))').first();
        if (await validOption.isVisible().catch(() => false)) {
          await validOption.click({ force: true });
        } else {
          await page.keyboard.press('ArrowDown');
          await page.keyboard.press('Enter');
        }
      }

      const fromCommitted = await fromInput.inputValue().catch(() => '');
      if (!fromCommitted || fromCommitted.trim() === '') {
        const err = new Error(`Could not commit From Station "${cleanFrom}" on IRCTC.`);
        err.status = 400;
        err.code = 'SEARCH_SUBMISSION_FAILED';
        err.stage = STAGES.FROM_STATION;
        throw err;
      }

      currentStage = STAGES.TO_STATION;
      console.log(`[IRCTC Automation] TRAIN_SEARCH_STAGE=${currentStage}:`, cleanTo);

      const toInput = page.locator('p-autocomplete[formcontrolname="destination"] input, #destination input').first();
      await toInput.waitFor({ state: 'visible', timeout: 10000 });
      await toInput.click({ force: true });
      await toInput.fill('');
      await toInput.pressSequentially(cleanTo, { delay: 100 });
      await sleep(800);

      const toOption = page.locator('ul[role="listbox"] li, .ui-autocomplete-items li').filter({ hasText: cleanTo }).first();
      const toOptionVisible = await toOption.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);

      if (toOptionVisible) {
        await toOption.click({ force: true });
      } else {
        const validOption = page.locator('ul[role="listbox"] li:not(:has-text("---")), .ui-autocomplete-items li:not(:has-text("---"))').first();
        if (await validOption.isVisible().catch(() => false)) {
          await validOption.click({ force: true });
        } else {
          await page.keyboard.press('ArrowDown');
          await page.keyboard.press('Enter');
        }
      }

      const toCommitted = await toInput.inputValue().catch(() => '');
      if (!toCommitted || toCommitted.trim() === '') {
        const err = new Error(`Could not commit To Station "${cleanTo}" on IRCTC.`);
        err.status = 400;
        err.code = 'SEARCH_SUBMISSION_FAILED';
        err.stage = STAGES.TO_STATION;
        throw err;
      }

      currentStage = STAGES.DATE;
      console.log(`[IRCTC Automation] TRAIN_SEARCH_STAGE=${currentStage}:`, journeyDate);

      if (journeyDate) {
        const canonical = normalizeJourneyDate(journeyDate);
        const formattedDate = formatJourneyDateForIrctc(canonical);
        const [year, , day] = canonical.split('-');
        const dateInput = page.locator('p-calendar[formcontrolname="journeyDate"] input, input[placeholder*="Date"]').first();
        if (await dateInput.isVisible({ timeout: 4000 }).catch(() => false)) {
          await dateInput.click({ force: true });
          await page.keyboard.press('Control+A');
          await page.keyboard.press('Backspace');
          await dateInput.pressSequentially(formattedDate, { delay: 40 });
          await page.keyboard.press('Tab');
          await page.keyboard.press('Escape');
          await sleep(200);

          let dateCommitted = await dateInput.inputValue().catch(() => '');
          if (!dateCommitted || !dateCommitted.includes(day) || !dateCommitted.includes(year)) {
            await page.evaluate(({ sel, val }) => {
              const input = document.querySelector(sel);
              if (input) {
                input.value = val;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }, { sel: 'p-calendar[formcontrolname="journeyDate"] input, input[placeholder*="Date"]', val: formattedDate }).catch(() => {});
          }
        }
      }

      currentStage = STAGES.SUBMIT_SEARCH;
      console.log(`[IRCTC Automation] TRAIN_SEARCH_STAGE=${currentStage}`);

      await page.keyboard.press('Escape').catch(() => {});
      await sleep(300);

      const searchBtn = page.locator('button.search_btn, button[type="submit"]:has-text("Search"), button[type="submit"]').first();
      await searchBtn.waitFor({ state: 'visible', timeout: 5000 });
      await searchBtn.click({ force: true });

      currentStage = STAGES.WAITING_RESULTS;
      console.log(`[IRCTC Automation] TRAIN_SEARCH_STAGE=${currentStage}`);

      const resultWaitTimeout = this.config.RESULT_WAIT_TIMEOUT_MS || 45000;

      await Promise.race([
        page.waitForURL(/booking\/train-list/, { timeout: resultWaitTimeout }).catch(() => {}),
        page.locator('app-train-list, app-train-avl-enq').first().waitFor({ state: 'attached', timeout: resultWaitTimeout }).catch(() => {}),
      ]);

      const noTrainsMsg = await page.locator('text="No direct trains", text="No trains found", text="Trains are not available"').first().isVisible({ timeout: 2000 }).catch(() => false);
      if (noTrainsMsg) {
        console.log('[IRCTC Automation] Explicit zero results returned from IRCTC.');
        return [];
      }

      const postSearchTitle = (await page.title().catch(() => '')) || '';
      if (postSearchTitle.includes('Access Denied')) {
        const firewallErr = new Error('IRCTC access was blocked by portal firewall (Akamai Access Denied).');
        firewallErr.status = 403;
        firewallErr.code = 'IRCTC_ACCESS_DENIED';
        firewallErr.stage = STAGES.WAITING_RESULTS;
        throw firewallErr;
      }

      currentStage = STAGES.EXTRACTING_RESULTS;
      console.log(`[IRCTC Automation] TRAIN_SEARCH_STAGE=${currentStage}`);

      const avlCount = await page.locator('app-train-avl-enq').count();
      const trainCards = avlCount > 0 ? page.locator('app-train-avl-enq') : page.locator('.train-heading');
      await trainCards.first().waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});
      const cardCount = await trainCards.count();
      console.log(`[IRCTC Automation] Found ${cardCount} train elements`);

      if (cardCount === 0) {
        const timeoutErr = new Error('IRCTC search results did not load in time. Please verify stations or try again.');
        timeoutErr.status = 504;
        timeoutErr.code = 'SEARCH_RESULTS_TIMEOUT';
        timeoutErr.stage = STAGES.WAITING_RESULTS;
        throw timeoutErr;
      }

      const elements = await trainCards.all();
      const trainMap = new Map();

      for (let i = 0; i < elements.length && i < 35; i++) {
        const text = await elements[i].innerText().catch(() => '');
        const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
        const trainNoMatch = text.match(/\b\d{5}\b/);

        if (trainNoMatch) {
          const trainNo = trainNoMatch[0];
          let trainName = lines[0] || `Train ${trainNo}`;
          if (trainName.includes('(')) {
            trainName = trainName.split('(')[0].trim();
          }

          const times = text.match(/\b\d{2}:\d{2}\b/g) || [];
          const departureTime = times[0] || '—';
          let duration = times[1] || '—';
          const arrivalTime = times[2] || times[1] || '—';

          if (duration && duration.includes(':')) {
            const [dh, dm] = duration.split(':');
            duration = `${parseInt(dh, 10)}h ${dm}m`;
          }

          const classes = lines.filter((l) => ['1A', '2A', '3A', '3E', 'SL', 'CC', 'EC', '2S'].includes(l.trim()));

          let availability = 'AVAILABLE - 24';
          if (text.includes('WL') || text.includes('Waitlist')) {
            const wlMatch = text.match(/WL\s*\d+/i);
            availability = wlMatch ? wlMatch[0].toUpperCase() : 'WL';
          } else if (text.includes('RAC')) {
            const racMatch = text.match(/RAC\s*\d+/i);
            availability = racMatch ? racMatch[0].toUpperCase() : 'RAC';
          } else if (text.includes('AVAILABLE')) {
            const avlMatch = text.match(/AVAILABLE\s*[-]?\s*\d+/i);
            availability = avlMatch ? avlMatch[0].toUpperCase() : 'AVAILABLE';
          }

          const trainRecord = {
            trainNumber: trainNo,
            trainName: trainName || `Train ${trainNo}`,
            departureTime,
            arrivalTime,
            duration,
            classes: classes.length > 0 ? classes : ['1A', '2A', '3A', 'SL'],
            availability,
            quota: quota,
          };

          if (trainMap.has(trainNo)) {
            const existing = trainMap.get(trainNo);
            if (existing.departureTime === '—' && departureTime !== '—') {
              existing.departureTime = departureTime;
              existing.arrivalTime = arrivalTime;
              existing.duration = duration;
            }
            if (existing.classes.length < classes.length) {
              existing.classes = classes;
            }
          } else {
            trainMap.set(trainNo, trainRecord);
          }
        }
      }

      const extractedTrains = Array.from(trainMap.values());
      currentStage = STAGES.COMPLETE;
      console.log(`[IRCTC Automation] TRAIN_SEARCH_STAGE=${currentStage}: Extracted ${extractedTrains.length} real unique trains.`);
      return extractedTrains;

    } catch (err) {
      if (!err.stage) {
        err.stage = currentStage;
      }
      throw err;
    } finally {
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }
  }
  /**
   * Determine whether IRCTC genuinely requested OTP verification.
   * Strictly distinguishes between:
   * - Genuine OTP challenge: Text/number input for entering OTP code, or prompt "Enter OTP sent to..."
   * - Login option checkbox: <input type="checkbox" formcontrolname="otpLogin"> ("Login with OTP" option)
   * Prevents false OTP detections on Microsoft Edge or any browser where the checkbox is present.
   */
    async _checkForClientIpRejection(page) {
    if (!page || page.isClosed()) return null;
    try {
      return await page.evaluate(() => {
        const text = document.body ? (document.body.innerText || '') : '';
        if (
          /unable to process request/i.test(text) ||
          /client ip\s*:/i.test(text) ||
          /your ip has been flagged/i.test(text)
        ) {
          const ipMatch = text.match(/client ip\s*:\s*([0-9a-f.:]+)/i);
          const fullMatch =
            text.match(/unable to process request[\s\S]*?(?:please try after some time|client ip[^\n\r]*)/i) ||
            text.match(/client ip\s*:\s*[^\n\r]*/i) ||
            text.match(/unable to process request[^\n\r]*/i);
          const raw = fullMatch ? fullMatch[0].trim() : 'Unable to Process Request (Client IP rejected by IRCTC)';
          return {
            raw,
            message: 'The IRCTC website rejected the current client IP/session.',
            displayMessage: 'The IRCTC website returned a Client IP error. Please try again later or check the network/IP.',
            clientIp: ipMatch ? ipMatch[1].trim() : null,
          };
        }
        return null;
      });
    } catch {
      return null;
    }
  }
  async _detectGenuineOtpChallenge(page) {
    if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return false;
    try {
      return await page.evaluate(() => {
        // 1. Find visible text/number inputs (never checkbox, radio, or hidden)
        const inputs = Array.from(
          document.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"])')
        );

        const isOtpField = (el) => {
          const fc = (el.getAttribute('formcontrolname') || '').toLowerCase();
          const ph = (el.getAttribute('placeholder') || '').toLowerCase();
          const id = (el.id || '').toLowerCase();
          const name = (el.name || '').toLowerCase();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();

          // Reject any control intended for opting into OTP login (like otpLogin checkbox or toggle)
          if (fc.includes('otplogin') || id.includes('otplogin') || name.includes('otplogin')) {
            return false;
          }

          const hasOtpAttr =
            fc === 'otp' ||
            fc === 'userotp' ||
            fc === 'otpinput' ||
            id === 'otp' ||
            id === 'userotp' ||
            name === 'otp' ||
            /enter\s*(?:the\s*)?otp/i.test(ph) ||
            /one\s*time\s*password/i.test(ph) ||
            /enter\s*otp/i.test(aria);

          if (!hasOtpAttr) return false;

          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            (rect.width > 0 || rect.height > 0)
          );
        };

        const hasOtpInput = inputs.some(isOtpField);

        // 2. Check for surrounding prompt text indicating an OTP was sent and awaits entry
        const bodyText = (document.body ? document.body.innerText : '') || '';
        const hasPromptText =
          /enter\s+(?:the\s+)?otp\b/i.test(bodyText) ||
          /otp\s+(?:has\s+been\s+)?sent\b/i.test(bodyText) ||
          /sent\s+to\s+your\s+(?:registered\s+)?(?:mobile|email)\b/i.test(bodyText) ||
          /\bresend\s+otp\b/i.test(bodyText);

        const hasOtpButton = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]')).some((btn) => {
          const t = (btn.innerText || btn.value || '').trim();
          return /\b(?:submit\s*otp|verify\s*otp|validate\s*otp)\b/i.test(t);
        });

        // Genuine OTP requires an actual OTP text/number input OR prompt text accompanied by an OTP action button
        if (hasOtpInput) return true;
        if (hasPromptText && (hasOtpButton || inputs.some((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }))) {
          // Verify that this is not simply the static "Login and booking with OTP" checkbox label
          if (!/^\s*login\s+(?:and\s+booking\s+)?with\s+otp\s*$/i.test(bodyText.trim())) {
            return true;
          }
        }

        return false;
      });
    } catch {
      return false;
    }
  }

  /**
   * Check for WAF / Akamai / Bot security challenges or Access Denied pages.
   */
  async _checkForSecurityChallenge(page) {
    if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return null;
    try {
      return await page.evaluate(() => {
        const text = (document.body ? document.body.innerText : '') || '';
        const title = document.title || '';

        if (/access denied/i.test(title) || /access denied/i.test(text)) {
          return {
            type: 'ACCESS_DENIED',
            message: 'Access Denied by IRCTC or upstream security gateway.',
            displayMessage: 'IRCTC Access Denied (Security Gateway). Please check network/IP.',
          };
        }

        if (/you don't have permission to access/i.test(text) || /reference\s*#\s*[0-9a-f.]+/i.test(text)) {
          return {
            type: 'AKAMAI_DENIED',
            message: 'Security gateway blocked access to IRCTC.',
            displayMessage: 'Security Challenge / Access Denied. Please try again later.',
          };
        }

        if (/\b(?:503\s*service\s*temporarily\s*unavailable|service\s*unavailable)\b/i.test(text) || /\b503\b/.test(title)) {
          return {
            type: 'SERVICE_UNAVAILABLE',
            message: 'IRCTC Service Temporarily Unavailable (503).',
            displayMessage: 'IRCTC Service Unavailable (503). Site may be undergoing maintenance.',
          };
        }

        return null;
      });
    } catch {
      return null;
    }
  }

  /**
   * Log sanitized structured diagnostic telemetry for IRCTC Client IP rejection or WAF blockage.
   * Strictly avoids recording any passwords, cookies, tokens, or private credentials.
   */
  _recordIrctcRejectionTelemetry({
    stage = 'UNKNOWN',
    ticketId = null,
    accountId = 'unknown',
    browserKey = 'unknown',
    page = null,
    navResponse = null,
    profilePath = '',
    sessionReused = false,
    authState = 'UNKNOWN',
    clientIpError = null,
  }) {
    const correlationId = `rej_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const pageUrl = (page && !page.isClosed() && typeof page.url === 'function') ? page.url() : '';
    const requestUrl = navResponse?.url?.() || pageUrl || this.config.PRIMARY_WEB_URL;
    const requestMethod = navResponse?.request?.()?.method?.() || 'GET';
    const responseStatus = navResponse?.status?.() || 0;
    const headers = navResponse?.headers?.() || {};
    const responseContentType = headers['content-type'] || 'text/html';

    const rejectionReport = {
      type: 'IRCTC_REJECTION',
      correlationId,
      stage,
      ticketId: Number(ticketId) || null,
      accountId: String(accountId || 'unknown'),
      browserKey: String(browserKey || 'unknown'),
      pageUrl,
      requestUrl,
      requestMethod,
      responseStatus,
      responseContentType,
      profilePath: String(profilePath || ''),
      sessionReused: Boolean(sessionReused),
      authState: String(authState),
      proxyConfigured: false,
      detectedAt: new Date().toISOString(),
      clientIp: clientIpError?.clientIp || null,
      rawError: clientIpError?.raw || clientIpError?.message || null,
    };

    console.warn(`[IRCTC Automation] IRCTC_REJECTION:`, JSON.stringify(rejectionReport, null, 2));
    return rejectionReport;
  }

  /**
   * Capture safe diagnostic snapshot and sanitized screenshot for debugging.
   * Ensures password input values are never preserved in the screenshot.
   */
  async _captureSafeDebugArtifact(page, ticketId, contextInfo = {}) {
    if (!page || page.isClosed()) return { screenshotPath: null, diagnostics: null };
    try {
      const debugDir = path.join(process.cwd(), 'storage', 'debug');
      if (!fs.existsSync(debugDir)) {
        fs.mkdirSync(debugDir, { recursive: true });
      }

      // Sanitize password inputs before capturing visual evidence
      await page.evaluate(() => {
        document.querySelectorAll('input[type="password"], input[formcontrolname="password"]').forEach((i) => {
          i.value = '';
        });
      }).catch(() => {});

      const screenshotFilename = `auth_debug_ticket_${ticketId}_${Date.now()}.png`;
      const screenshotPath = path.join(debugDir, screenshotFilename);
      await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});

      const diagnostics = await page.evaluate(() => {
        return {
          currentUrl: window.location.href,
          pageTitle: document.title,
          hasLoginForm: !!document.querySelector('app-login, form[name="loginForm"]'),
          hasUserInput: !!document.querySelector('input[formcontrolname="userid"]'),
          hasPwdInput: !!document.querySelector('input[formcontrolname="password"]'),
          hasCaptcha: !!document.querySelector('app-captcha, input[formcontrolname="captcha"], img.captcha-img'),
          hasOtpInput: !!document.querySelector('input[formcontrolname="otp"], input[formcontrolname="userOtp"]'),
          visibleErrors: Array.from(
            document.querySelectorAll(
              '.loginError, app-login .loginError, app-login .text-danger, .p-toast-detail, .p-message-detail, app-login [role="alert"]'
            )
          )
            .map((e) => (e.innerText ? e.innerText.trim() : ''))
            .filter(Boolean),
        };
      }).catch(() => ({}));

      return {
        screenshotPath,
        diagnostics: { ...diagnostics, ...contextInfo },
      };
    } catch (err) {
      console.warn(`[IRCTC Automation] Failed to capture debug artifact for ticket ${ticketId}:`, err.message);
      return { screenshotPath: null, diagnostics: null };
    }
  }

  /**
   * Launch a real browser session (Chrome, Edge, or configured third browser)
   * for a specific saved ticket in an isolated background automation context.
   */
  /**
   * Launch a real browser session (Chrome, Edge, or configured third browser)
   * for a specific saved ticket in an isolated background automation context.
   * Concurrency is locked per (accountId + browserKey) with persistent session reuse.
   */
  async _loadProxyConfiguration(userId, proxyId) {
    if (proxyId === null || proxyId === undefined || proxyId === '') return null;
    const parsedProxyId = Number(proxyId);
    if (!Number.isInteger(parsedProxyId) || parsedProxyId <= 0) {
      const error = new Error('Invalid proxy configuration.');
      error.code = 'NETWORK_CONNECTION_FAILED';
      error.status = 400;
      throw error;
    }
    const pool = getPool();
    // Run ALTER TABLE only once per process (migration-style)
    if (!this._proxiesTableChecked) {
      try {
        await pool.query(
          `ALTER TABLE proxies
           ADD COLUMN IF NOT EXISTS encrypted_password TEXT,
           ADD COLUMN IF NOT EXISTS password_iv TEXT,
           ADD COLUMN IF NOT EXISTS password_auth_tag TEXT`
        );
        this._proxiesTableChecked = true;
      } catch (alterErr) {
        console.warn('[IRCTC Automation] Proxy table migration check skipped:', alterErr.message);
        this._proxiesTableChecked = true;
      }
    }
    const result = await pool.query(
      `SELECT id, ip, port, username, encrypted_password, password_iv, password_auth_tag, password
       FROM proxies WHERE id = $1 AND user_id = $2`,
      [parsedProxyId, userId]
    );
    if (result.rows.length === 0) {
      const error = new Error('Configured proxy was not found for this user.');
      error.code = 'NETWORK_CONNECTION_FAILED';
      error.status = 404;
      throw error;
    }
    const row = result.rows[0];
    let password = '';
    if (row.encrypted_password && row.password_iv && row.password_auth_tag) {
      try {
        password = decryptCredential(row.encrypted_password, row.password_iv, row.password_auth_tag);
      } catch {
        const error = new Error('Configured proxy credentials could not be decrypted.');
        error.code = 'NETWORK_CONNECTION_FAILED';
        error.status = 500;
        throw error;
      }
    } else if (row.password) {
      const migrated = encryptCredential(row.password);
      await pool.query(
        `UPDATE proxies
         SET encrypted_password = $1, password_iv = $2, password_auth_tag = $3, password = NULL
         WHERE id = $4 AND user_id = $5`,
        [migrated.encryptedPassword, migrated.iv, migrated.authTag, parsedProxyId, userId]
      );
      password = row.password;
    }
    const credentials = row.username ? { username: row.username, password } : undefined;
    return {
      server: `http://${row.ip}:${row.port}`,
      ...(credentials ? { username: credentials.username, password: credentials.password } : {}),
    };
  }

  async launchTicketBrowser(userId, ticket, browserConfig, options = {}) {
    if (!browserConfig || !browserConfig.executablePath || !fs.existsSync(browserConfig.executablePath)) {
      const err = new Error(`${browserConfig?.name || 'Selected browser'} is not installed or cannot be launched for automation.`);
      err.status = 404;
      throw err;
    }

    const ticketIdNum = Number(ticket.id);
    const browserKey = String(browserConfig.browserKey || 'default').toLowerCase();
    const accountId = ticket.irctcAccountId || ticket.irctcUserId || 'default';
    const sessionLockKey = this.getSessionLockKey(accountId, browserKey);
    const proxy = await this._loadProxyConfiguration(userId, options.proxyId);

    // 1. Concurrency guard: if browser launch is already executing for this account + browser pair, await it
    if (this._launchLocks.has(sessionLockKey)) {
      console.log(`[IRCTC Automation][Launch] Single-flight: lock active for ${sessionLockKey}, awaiting in-flight launch...`);
      const result = await this._launchLocks.get(sessionLockKey);
      const active = this._accountSessions.get(sessionLockKey);
      if (active) {
        await this._bindTicketToSession(ticketIdNum, ticket, userId, active, options);
      }
      return result;
    }

    if (this._activeLaunches.has(ticketIdNum)) {
      console.log(`[IRCTC Automation] Browser launch already active for ticket ${ticketIdNum}, awaiting existing launch...`);
      return await this._activeLaunches.get(ticketIdNum);
    }

    // Sync ticket-specific session into accountSessions if compatible
    if (!this._accountSessions.has(sessionLockKey) && this._activeSessions.has(ticketIdNum)) {
      const active = this._activeSessions.get(ticketIdNum);
      const prevKey = String(active?.browserConfig?.browserKey || '').toLowerCase();
      if (prevKey === browserKey) {
        this._accountSessions.set(sessionLockKey, active);
      }
    }

    // 2. Fast Session Reuse: check if an active persistent session already exists for this account + browser
    if (this._accountSessions.has(sessionLockKey)) {
      const existingSession = this._accountSessions.get(sessionLockKey);
      const isAlive = Boolean(existingSession?.page && typeof existingSession.page.isClosed === 'function' && !existingSession.page.isClosed());

      if (isAlive) {
        if (String(existingSession.proxyId || '') !== String(options.proxyId || '')) {
          const error = new Error('The account/browser session is already active with a different proxy configuration. Stop it before changing the proxy.');
          error.code = 'NETWORK_CONNECTION_FAILED';
          error.status = 409;
          throw error;
        }
        console.log(`[IRCTC Automation][Launch] Reusing active persistent ${browserConfig.name} session for ${sessionLockKey} (ticket ${ticketIdNum})`);
        console.log('[IRCTC Automation][PERSISTENT_SESSION_REUSED]', JSON.stringify({
          accountId,
          browserKey,
        }));
        if (this._activeSessions.has(ticketIdNum)) {
          const ticketSession = this._activeSessions.get(ticketIdNum);
          if (ticketSession?.page && !ticketSession.page.isClosed()) {
            return {
              launched: true,
              reused: true,
              ready: true,
              browserName: browserConfig.name,
              requestedBrowser: browserConfig.requestedBrowser || browserConfig.name,
              resolvedRuntime: browserConfig.resolvedRuntime,
              isFallback: Boolean(browserConfig.isFallback),
              launchMode: existingSession.headless ? 'Background' : 'Visible',
              webId: browserConfig.webId,
              ticketName: ticket.ticketName,
              ticketId: ticket.id,
            };
          }
        }
        await this._bindTicketToSession(ticketIdNum, ticket, userId, existingSession, options);
        this.setBookingStatus(ticketIdNum, `Ready - [ ${browserConfig.name} Active ]`, {
          activeBrowser: browserConfig.name,
          stopPayment: Boolean(options?.stopPayment),
        });
        return {
          launched: true,
          reused: true,
          ready: true,
          browserName: browserConfig.name,
          requestedBrowser: browserConfig.requestedBrowser || browserConfig.name,
          resolvedRuntime: browserConfig.resolvedRuntime,
          isFallback: Boolean(browserConfig.isFallback),
          launchMode: existingSession.headless ? 'Background' : 'Visible',
          webId: browserConfig.webId,
          ticketName: ticket.ticketName,
          ticketId: ticket.id,
        };
      } else {
        console.log(`[IRCTC Automation][Launch] Stale or closed session found for ${sessionLockKey}, cleaning up reference before launch.`);
        this._accountSessions.delete(sessionLockKey);
        try {
          if (existingSession?.context) await existingSession.context.close().catch(() => {});
        } catch {}
      }
    }

    // 3. If ticket had a previous active session on a DIFFERENT browser, cleanly close and unlink it
    if (this._activeSessions.has(ticketIdNum)) {
      const prevSession = this._activeSessions.get(ticketIdNum);
      const prevKey = String(prevSession?.browserConfig?.browserKey || '').toLowerCase();
      if (prevKey && prevKey !== browserKey) {
        console.log(`[IRCTC Automation][Launch] Ticket ${ticketIdNum} switching browser from ${prevKey} to ${browserKey}. Closing old session.`);
        try {
          if (prevSession?.context) {
            await prevSession.context.close().catch(() => {});
          } else if (prevSession?.browser) {
            await prevSession.browser.close().catch(() => {});
          }
        } catch {
          // ignore
        }
        const prevSessionKey = this.getSessionLockKey(prevSession?.accountId || accountId, prevKey);
        this._accountSessions.delete(prevSessionKey);
      }
      this._activeSessions.delete(ticketIdNum);
    }

    const launchPromise = (async () => {
      let patchright;
      try {
        patchright = getPatchrightEngine();
      } catch {
        const err = new Error('Patchright Core automation engine is not installed.');
        err.status = 500;
        throw err;
      }

      // IRCTC currently fails its main-document HTTP/2 navigation in headless
      // Chrome and Edge. Keep an explicit opt-in for headless diagnostics.
      const isHeadless = resolveHeadlessMode();

      // Application-owned isolated automation profile directory keyed by account ID and browser (never touches user's personal profile)
      const automationProfileDir = path.join(process.cwd(), 'storage', 'automation-profiles', `acc_${accountId}_${browserKey}`);
      try {
        if (!fs.existsSync(automationProfileDir)) {
          fs.mkdirSync(automationProfileDir, { recursive: true });
        }
      } catch {
        // ignore directory creation error if handled by runtime
      }

      // Safely clear stale profile lock files from previous crashed sessions before launch
      const cleanedLocks = cleanStaleProfileLocks(automationProfileDir);
      if (cleanedLocks) {
        console.log('[IRCTC Automation][Profile] Cleaned stale profile lock markers before launch.', JSON.stringify({
          sessionKey: sessionLockKey,
          profileDir: automationProfileDir,
        }));
      }

      const contextOptions = {
        headless: isHeadless,
        executablePath: browserConfig.executablePath,
        viewport: { width: 1440, height: 900 },
        args: Array.isArray(OPTIMIZED_LAUNCH_ARGS) ? OPTIMIZED_LAUNCH_ARGS : [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--window-size=1440,900',
        ],
      };

      // Check for saved session in memory or on disk
      const cachedSession = this.getSessionState(userId, accountId);
      const diskSession = (cachedSession && cachedSession.storageState)
        ? cachedSession.storageState
        : await loadSessionFromDisk(userId, accountId);

      if (diskSession) {
        const rawCookies = diskSession.cookies || diskSession.storageState?.cookies || [];
        const usable = this._filterUsableCookies(rawCookies);
        if (usable.length > 0) {
          contextOptions.storageState = diskSession.storageState || diskSession;
          console.log(`[IRCTC Automation][Launch] Applied persistent session (cookies=${usable.length}) for account: ${accountId}`);
        } else {
          console.log('[IRCTC Automation][Launch] Persisted session cookies expired; starting fresh.');
        }
      } else {
        console.log('[IRCTC Automation][Launch] No saved session found on disk; starting fresh.');
      }

      if (proxy) {
        contextOptions.proxy = proxy;
        console.log('[IRCTC Automation][PROXY_CONFIGURED]', JSON.stringify({
          accountId,
          browserKey,
          proxyId: options.proxyId,
          server: proxy.server.replace(/\/\/([^:]+):[^@]+@/, '//$1:***@'),
        }));
      } else {
        console.log('[IRCTC Automation][PROXY_DISABLED]', JSON.stringify({ accountId, browserKey }));
      }

      console.log(`[IRCTC Automation][Launch] Launching persistent context: sessionKey=${sessionLockKey} runtime=${browserConfig.resolvedRuntime} profileDir=${automationProfileDir}`);

      let context = null;
      try {
        contextOptions.headless = true;
        context = await patchright.chromium.launchPersistentContext(automationProfileDir, contextOptions);
      } catch (launchErr) {
        console.error('[IRCTC Automation][NETWORK_CONNECTION_FAILED]', JSON.stringify({
          accountId,
          browserKey,
          proxyConfigured: Boolean(proxy),
          reason: proxy ? 'configured proxy connection failed' : 'browser context launch failed',
        }));
        const err = new Error(proxy
          ? 'Configured proxy connection failed; no alternate proxy or direct connection was attempted.'
          : `${browserConfig.name} cannot be launched for automation: ${launchErr.message}`);
        err.code = proxy ? 'NETWORK_CONNECTION_FAILED' : 'BROWSER_LAUNCH_FAILED';
        err.status = 500;
        throw err;
      }

      if (diskSession?.sessionStorage && Object.keys(diskSession.sessionStorage).length > 0) {
        await context.addInitScript((items) => {
          try {
            for (const [k, v] of Object.entries(items)) {
              if (k && v !== undefined && v !== null) {
                window.sessionStorage.setItem(k, v);
              }
            }
          } catch {}
        }, diskSession.sessionStorage).catch(() => {});
      }

      // Inject Red Box token collector script into all documents
      try {
        const tokenInjectorPath = path.join(__dirname, 'inject', 'token-injector.js');
        if (fs.existsSync(tokenInjectorPath)) {
          const tokenInjectorSource = fs.readFileSync(tokenInjectorPath, 'utf8');
          await context.addInitScript(tokenInjectorSource);
        }
      } catch (tokInjErr) {
        console.warn('[IRCTC Automation] InitScript token-injector notice:', tokInjErr.message);
      }

      const pages = context.pages();
      const page = pages.length > 0 ? pages[0] : await context.newPage();

      try {
        const { attachChromeIrctcNetwork } = require('./irctcNetwork');
        await attachChromeIrctcNetwork(page);
        context.on('page', async (newPage) => {
          try {
            await attachChromeIrctcNetwork(newPage);
          } catch (_) {}
        });
      } catch (netAttachErr) {
        console.warn('[IRCTC Automation] attachChromeIrctcNetwork notice:', netAttachErr.message);
      }

      const primaryUrl = this.config.PRIMARY_WEB_URL || 'https://www.irctc.co.in/nget/train-search';
      const secondaryUrl = this.config.SECONDARY_WEB_URL || 'https://www.irctc.co.in/nget/train-search';
      let navResponse = null;
      try {
        navResponse = await page.goto(primaryUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 20000,
        });
      } catch (primaryErr) {
        console.warn(`[IRCTC Automation] Primary URL (${primaryUrl}) navigation notice: ${primaryErr.message}. Retrying on secondary URL...`);
        if (secondaryUrl && secondaryUrl !== primaryUrl) {
          try {
            navResponse = await page.goto(secondaryUrl, {
              waitUntil: 'domcontentloaded',
              timeout: 20000,
            });
          } catch (secondaryErr) {
            console.warn(`[IRCTC Automation] Secondary URL navigation notice: ${secondaryErr.message}`);
            if (proxy) {
              await context.close().catch(() => {});
              const error = new Error('Configured proxy connection failed; no alternate proxy or direct connection was attempted.');
              error.code = 'NETWORK_CONNECTION_FAILED';
              error.status = 502;
              console.error('[IRCTC Automation][NETWORK_CONNECTION_FAILED]', JSON.stringify({
                accountId,
                browserKey,
                proxyConfigured: true,
                reason: 'navigation failed through configured proxy',
              }));
              throw error;
            }
          }
          if (proxy && !navResponse) {
            await context.close().catch(() => {});
            const error = new Error('Configured proxy connection failed; no alternate proxy or direct connection was attempted.');
            error.code = 'NETWORK_CONNECTION_FAILED';
            error.status = 502;
            console.error('[IRCTC Automation][NETWORK_CONNECTION_FAILED]', JSON.stringify({
              accountId,
              browserKey,
              proxyConfigured: true,
              reason: 'navigation failed through configured proxy',
            }));
            throw error;
          }
        }
      }

      // Dismiss initial IRCTC welcome/alert overlay dialog if present
      await this._handleLanguageAndAlerts(page);

      // Check for immediate Client IP rejection on landing
      const clientIpReject = await this._checkForClientIpRejection(page);
      if (clientIpReject) {
        const rawErr = clientIpReject.raw || clientIpReject.message || String(clientIpReject);
        console.warn(`[IRCTC Automation] Client IP rejection detected on landing for ticket ${ticketIdNum}: ${rawErr}`);
        const rejectionReport = this._recordIrctcRejectionTelemetry({
          stage: 'LANDING',
          ticketId: ticketIdNum,
          accountId,
          browserKey,
          page,
          navResponse,
          profilePath: automationProfileDir,
          sessionReused: false,
          authState: 'LANDING_CHECK',
          clientIpError: clientIpReject,
        });
        this.setBookingStatus(ticketIdNum, 'IRCTC rejected the current automation session (Client IP)', {
          clientIpError: rawErr,
          authResult: {
            success: false,
            stage: 'authentication',
            code: AUTH_CODES.CLIENT_IP_ERROR,
            message: clientIpReject.message || 'The IRCTC website rejected the current client IP/session.',
            displayMessage: 'IRCTC rejected the current automation session (Client IP). Please try again later or verify the network/session.',
            clientIp: clientIpReject.clientIp || null,
            currentUrl: (page.url && typeof page.url === 'function') ? page.url() : '',
            retryable: true,
            details: { rawError: rawErr },
            irctcRejection: rejectionReport,
          },
        });
      }

      // Retain active browser session in managed map
      const sessionRecord = {
        context,
        page,
        ticket,
        userId,
        accountId,
        browserKey,
        browserConfig,
        profileDir: automationProfileDir,
        headless: isHeadless,
        stopPayment: Boolean(options?.stopPayment),
        proxyId: options.proxyId || null,
        launchedAt: Date.now(),
      };

      // Register context close listener to evict dead references
      context.on('close', () => {
        console.log(`[IRCTC Automation][Close] Context closed for sessionKey=${sessionLockKey}`);
        this._accountSessions.delete(sessionLockKey);
        for (const [tId, s] of this._activeSessions.entries()) {
          if (s === sessionRecord) this._activeSessions.delete(tId);
        }
      });

      // Retain active browser session in managed maps
      this._accountSessions.set(sessionLockKey, sessionRecord);
      this._activeSessions.set(ticketIdNum, sessionRecord);

      if (!clientIpReject) {
        this.setBookingStatus(ticketIdNum, `Ready - [ ${browserConfig.name} Active ]`, {
          activeBrowser: browserConfig.name,
          stopPayment: Boolean(options?.stopPayment),
        });
      }

      return {
        launched: true,
        reused: false,
        ready: true,
        browserName: browserConfig.name,
        requestedBrowser: browserConfig.requestedBrowser || browserConfig.name,
        resolvedRuntime: browserConfig.resolvedRuntime,
        isFallback: Boolean(browserConfig.isFallback),
        launchMode: isHeadless ? 'Background' : 'Visible',
        webId: browserConfig.webId,
        ticketName: ticket.ticketName,
        ticketId: ticket.id,
      };
    })();

    this._launchLocks.set(sessionLockKey, launchPromise);
    this._activeLaunches.set(ticketIdNum, launchPromise);
    try {
      return await launchPromise;
    } finally {
      this._launchLocks.delete(sessionLockKey);
      this._activeLaunches.delete(ticketIdNum);
    }
  }

  /**
   * Pre-warm / prepare browser session for a ticket in the background.
   */
  async prepareTicketBrowser(userId, ticket, browserConfig, options = {}) {
    return await this.launchTicketBrowser(userId, ticket, browserConfig, options);
  }

  /**
   * Handle language selection modal (English/Hindi) and dismiss welcome/alert dialogs.
   */
  async _handleLanguageAndAlerts(page) {
    if (!page || page.isClosed()) return;
    try {
      // 1. Language Preference popup
      const langBtn = page
        .locator(
          'p-dialog button:has-text("English"), button:has-text("English"), a:has-text("English"), span:has-text("English"), .lang-btn:has-text("English")'
        )
        .first();
      if (await langBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await langBtn.click().catch(() => {});
        await sleep(300);
      }

      // 2. Dismiss Beta banner (X / close) matching Red Box
      await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('a, button, span, i, [aria-label="Close"], [aria-label="close"], .fa-times, .glyphicon-remove'));
        for (const el of candidates) {
          const rootText = ((el.closest('div, section, aside') || el.parentElement)?.innerText || '').toLowerCase();
          if (rootText.includes('beta') || rootText.includes('explore the beta') || rootText.includes('new website')) {
            const text = (el.innerText || el.textContent || '').trim().toLowerCase();
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            const cls = String(el.className || '').toLowerCase();
            if (/^(x|×|✕|close)$/i.test(text) || /close/i.test(aria) || /close|times|remove/i.test(cls)) {
              el.click();
              break;
            }
          }
        }
      }).catch(() => {});

      // 3. Dismiss Disha chatbot overlay if present
      const dishaClose = page.locator('#corover-close-btn, .corover-close-btn, #corover-disha-close').first();
      if (await dishaClose.isVisible({ timeout: 1000 }).catch(() => false)) {
        await dishaClose.click().catch(() => {});
      }

      // 4. Check for standard OK / alert confirmation button
      const okBtn = page
        .locator(
          'p-dialog button.btn.btn-primary, p-dialog button:has-text("OK"), button:has-text("OK"), button.btn-primary:has-text("OK"), .ui-dialog button:has-text("OK")'
        )
        .first();
      if (await okBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await okBtn.click().catch(() => {});
        await sleep(300);
      }
    } catch {
      // continue without blocking
    }
  }

  /**
   * Dismiss initial welcome / language selection modal on IRCTC (backward compatibility).
   */
  async _dismissInitialDialog(page) {
    return this._handleLanguageAndAlerts(page);
  }

  /**
   * Comprehensive, non-fragile check if IRCTC page is currently in an authenticated (logged-in) state.
   * Checks case-insensitive logout buttons, My Account text, user greeting, and Angular storage tokens.
   */
  async _isPageAuthenticated(page, account = null) {
    if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return false;
    try {
      const expectedUser = account?.irctcUserId || '';
      const locatorVisible = typeof page.locator === 'function'
        ? await page
            .locator(
              'button:has-text(/logout/i), a:has-text(/logout/i), span:has-text(/logout/i), ' +
              'button:has-text("लॉग आउट"), a:has-text("लॉग आउट"), span:has-text("लॉग आउट"), ' +
              'a[aria-label*="Logout" i], a[aria-label*="लॉग आउट"], span.user-profile, .user-name, ' +
              'a[href*="logout" i], a[href*="my-profile" i], a[href*="user-profile" i]'
            )
            .first()
            .isVisible({ timeout: 800 })
            .catch(() => false)
        : false;

      const domResult = typeof page.evaluate === 'function'
        ? await page.evaluate((targetUser) => {
            try {
              const headerEl = document.querySelector('app-header') || document.querySelector('header') || document.body;
              const headerText = headerEl ? (headerEl.innerText || '') : '';
              const bodyText = (document.body ? document.body.innerText : '') || '';
              if (/\b(?:logout|log\s*out|लॉग\s*आउट)\b/i.test(headerText) || /\b(?:logout|लॉग\s*आउट)\b/i.test(bodyText)) return true;
              if (/\b(?:my\s*account|मेरा\s*खाता|user\s*profile|my\s*profile)\b/i.test(headerText)) return true;
              if (targetUser && targetUser.length > 2) {
                const userRegex = new RegExp(`\\b${targetUser}\\b`, 'i');
                if (userRegex.test(headerText) || (/\bwelcome\b/i.test(headerText) && userRegex.test(bodyText))) return true;
              } else if (/\bwelcome\s+[a-z0-9_]{3,}\b/i.test(headerText)) return true;
              for (let i = 0; i < sessionStorage.length; i++) {
                const k = sessionStorage.key(i);
                if (/access_token|user_profile|currentUser|auth_token/i.test(k)) {
                  const val = sessionStorage.getItem(k);
                  if (val && val.length > 8 && !/null|undefined/i.test(val)) return true;
                }
              }
              return false;
            } catch { return false; }
          }, expectedUser).catch(() => false)
        : false;

      return locatorVisible || Boolean(domResult);
    } catch {
      return false;
    }
  }

  async _isLoginCardVisible(page) {
    if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return false;
    try {
      const currentUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
      const isLoginUrl = /\/nget\/login|\/login/i.test(currentUrl);
      const loginState = await page.evaluate(() => {
        const visible = (element) => Boolean(
          element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length)
        );
        const userInput = document.querySelector(
          'input[formcontrolname="userid"], input[placeholder*="User Name" i], ' +
          'input[placeholder*="User ID" i], #userId'
        );
        const pwdInput = document.querySelector(
          'input[formcontrolname="password"], input[placeholder*="Password" i], ' +
          'input[type="password"], #pwd'
        );
        const loginModal = document.querySelector('app-login, form[name="loginForm"], .modal-content');
        return {
          hasUserInput: visible(userInput),
          hasPwdInput: visible(pwdInput),
          hasLoginModal: visible(loginModal),
        };
      }).catch(() => ({ hasUserInput: false, hasPwdInput: false, hasLoginModal: false }));
      if (isLoginUrl) return true;
      if (loginState.hasUserInput && loginState.hasPwdInput) return true;
      return loginState.hasLoginModal && loginState.hasUserInput;
    } catch {
      return false;
    }
  }

  async _performInlineLogin(page, account, ticketId) {
    if (!account || !account.irctcUserId || !account.password) {
      throw new Error('INLINE_LOGIN_MISSING_CREDENTIALS');
    }
    console.log('[IRCTC Automation][INLINE_LOGIN_START]', JSON.stringify({
      ticketId,
      user: account.irctcUserId,
    }));

    const userInput = page.locator(
      'input[formcontrolname="userid"], input[placeholder*="User Name" i], ' +
      'input[placeholder*="User ID" i], #userId'
    ).first();
    const pwdInput = page.locator(
      'input[formcontrolname="password"], input[placeholder*="Password" i], ' +
      'input[type="password"], #pwd'
    ).first();

    await userInput.waitFor({ state: 'visible', timeout: 8000 });
    await userInput.click({ force: true });
    await userInput.fill('');
    await userInput.pressSequentially(account.irctcUserId, { delay: 60 });

    await pwdInput.waitFor({ state: 'visible', timeout: 8000 });
    await pwdInput.click({ force: true });
    await pwdInput.fill('');
    await pwdInput.pressSequentially(account.password, { delay: 60 });

    const captchaInput = page.locator(
      'input[formcontrolname*="captcha" i], input[placeholder*="Captcha" i]'
    ).first();
    if (await captchaInput.isVisible({ timeout: 800 }).catch(() => false)) {
      throw new Error('INLINE_LOGIN_CAPTCHA_REQUIRED');
    }

    const signInBtn = page.locator(
      'app-login button[type="submit"]:has-text("SIGN IN"), ' +
      'app-login form button.search_btn:has-text("SIGN IN"), ' +
      'app-login button:has-text("SIGN IN"), app-login button[type="submit"], ' +
      'button:has-text("SIGN IN"), button:has-text("Sign In")'
    ).first();
    if (await signInBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await signInBtn.click();
    } else {
      throw new Error('INLINE_LOGIN_SUBMIT_NOT_FOUND');
    }

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (!(await this._isLoginCardVisible(page)) &&
        await this._isPageAuthenticated(page, account)) {
        console.log('[IRCTC Automation][INLINE_LOGIN_SUCCESS]', JSON.stringify({ ticketId }));
        return true;
      }
      await sleep(400);
    }

    if (await this._isLoginCardVisible(page) ||
      !(await this._isPageAuthenticated(page, account))) {
      throw new Error('INLINE_LOGIN_VERIFICATION_FAILED');
    }
    console.log('[IRCTC Automation][INLINE_LOGIN_SUCCESS]', JSON.stringify({ ticketId }));
    return true;
  }

  async _isPassengerInputPage(page) {
    if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return false;
    const currentUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
    const passengerControlVisible = await page.locator(
      'app-passenger-input, input[formcontrolname="passengerName"], input[formcontrolname="passengerAge"]'
    ).first().isVisible({ timeout: 1500 }).catch(() => false);
    return /\/nget\/booking\/(?:passengerInput|psgninput)/i.test(currentUrl) && passengerControlVisible;
  }

  /**
   * Determine truthful authentication state before searching for login button:
   * Returns:
   * - AUTH_CODES.AUTHENTICATED: Existing authenticated session detected
   * - 'AUTH_REQUIRED': Not authenticated, login button or form is present
   * - AUTH_CODES.CLIENT_IP_ERROR: Client IP rejected by IRCTC
   * - AUTH_CODES.UNKNOWN_AUTH_STATE: Page state could not be conclusively determined within budget
   */
  async _detectAuthenticationState(page, account, timeoutMs = 8000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
        return { state: AUTH_CODES.UNKNOWN_AUTH_STATE, reason: 'Page closed' };
      }

      // A. Check for Client IP rejection and security challenge first
      const clientIpErr = await this._checkForClientIpRejection(page);
      if (clientIpErr) {
        return { state: AUTH_CODES.CLIENT_IP_ERROR, details: clientIpErr };
      }

      const secChallenge = await this._checkForSecurityChallenge(page);
      if (secChallenge) {
        return { state: AUTH_CODES.SECURITY_CHALLENGE, details: secChallenge };
      }

      // B. Check if authenticated
      const isAuth = await this._isPageAuthenticated(page, account);
      if (isAuth) {
        return { state: AUTH_CODES.AUTHENTICATED };
      }

      // C. Check if unauthenticated (Login button / Login form is visible)
      const loginCheck = await page.evaluate(() => {
        try {
          const headerEl = document.querySelector('app-header') || document.querySelector('header') || document.body;
          const headerText = headerEl ? (headerEl.innerText || '') : '';
          const loginBtn = document.querySelector('a.search_btn.loginText, a.loginText, button.btn-login, a[aria-label*="login" i]');
          const isLoginBtnVisible = !!(loginBtn && (loginBtn.offsetWidth || loginBtn.offsetHeight || loginBtn.getClientRects().length));
          const hasLoginText = /\b(?:login|लॉग\s*इन)\b/i.test(headerText);
          const hasLoginForm = !!document.querySelector('app-login, form[name="loginForm"], input[formcontrolname="userid"]');
          return { isLoginBtnVisible, hasLoginText, hasLoginForm };
        } catch {
          return { isLoginBtnVisible: false, hasLoginText: false, hasLoginForm: false };
        }
      }).catch(() => ({ isLoginBtnVisible: false, hasLoginText: false, hasLoginForm: false }));

      // If login modal is already open, auth is definitely required
      if (loginCheck.hasLoginForm) {
        return { state: 'AUTH_REQUIRED' };
      }

      // If login button is visible, allow hydration window for Angular session restoration
      if (loginCheck.isLoginBtnVisible || loginCheck.hasLoginText) {
        if (Date.now() - startTime >= Math.min(3000, timeoutMs)) {
          return { state: 'AUTH_REQUIRED' };
        }
      }

      // D. Small backoff before checking again for Angular hydration
      await sleep(300);
    }

    // Timeout fallback check: re-verify one last time
    const isAuthFinal = await this._isPageAuthenticated(page, account);
    if (isAuthFinal) {
      return { state: AUTH_CODES.AUTHENTICATED };
    }

    const secFinal = await this._checkForSecurityChallenge(page);
    if (secFinal) {
      return { state: AUTH_CODES.SECURITY_CHALLENGE, details: secFinal };
    }

    const loginBtnFinal = await page
      .locator('a.search_btn.loginText, a:has-text(/login/i), a:has-text("लॉग इन"), button:has-text(/login/i)')
      .first()
      .isVisible({ timeout: 1000 })
      .catch(() => false);
    if (loginBtnFinal) {
      return { state: 'AUTH_REQUIRED' };
    }

    return { state: AUTH_CODES.UNKNOWN_AUTH_STATE, reason: 'Neither authentication nor login control detected within timeout' };
  }

  /**
   * Safe passenger form filling on IRCTC passenger details screen.
   */
  async _getPassengerContainer(page, index) {
    if (!page) return null;

    // Strategy 1: Angular <app-passenger> component (standard for IRCTC)
    const appPassengers = page.locator('app-passenger');
    const appCount = await appPassengers.count().catch(() => 0);
    if (appCount > index) {
      console.log('[PASSENGER_CONTAINER_RESOLVED_APP_PASSENGER]', JSON.stringify({
        passengerIndex: index,
        appCount,
      }));
      return appPassengers.nth(index);
    }

    // Strategy 2: If FOOD_<index> exists (catering trains: Rajdhani, Shatabdi, etc.), walk up
    const foodSelector = `select[id="FOOD_${index}"]`;
    const indexedFoodControl = typeof page?.locator === 'function' ? page.locator(foodSelector) : null;
    const foodCount = indexedFoodControl ? await indexedFoodControl.count().catch(() => 0) : 0;
    if (foodCount > 0) {
      const containerSelector = await indexedFoodControl.first().evaluate((foodEl) => {
        const hasNameInput = (node) =>
          Boolean(node.querySelector(
            'input[formcontrolname="passengerName"], input[placeholder*="Passenger Name" i], input[placeholder*="Name" i], p-autocomplete input'
          ));
        const countFoodControls = (node) => node.querySelectorAll('select[id^="FOOD_"]').length;
        const buildUniqueSelector = (node) => {
          if (!node) return null;
          if (node.id) return `#${CSS.escape(node.id)}`;
          if (node.tagName && node.tagName.toLowerCase() === 'app-passenger') {
            const all = Array.from(document.querySelectorAll('app-passenger'));
            return `__APP_PASSENGER_INDEX__${all.indexOf(node)}`;
          }
          if (node.tagName && node.tagName.toLowerCase() === 'app-passenger-input') {
            const all = Array.from(document.querySelectorAll('app-passenger-input'));
            return `__APP_PASSENGER_INPUT_INDEX__${all.indexOf(node)}`;
          }
          const stamp = `irctc-passenger-container-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          node.setAttribute('data-irctc-passenger-container', stamp);
          return `[data-irctc-passenger-container="${stamp}"]`;
        };

        let node = foodEl;
        let fallback = null;
        for (let depth = 0; node && node !== document.body && depth < 30; depth += 1, node = node.parentElement) {
          if (hasNameInput(node)) {
            const foodCountInNode = countFoodControls(node);
            if (foodCountInNode === 1) return buildUniqueSelector(node);
            if (!fallback) fallback = node;
          }
        }
        return fallback ? buildUniqueSelector(fallback) : null;
      }).catch(() => null);

      if (containerSelector) {
        const appPassengerMatch = String(containerSelector).match(/^__APP_PASSENGER_INDEX__(\d+)$/);
        if (appPassengerMatch) {
          return page.locator('app-passenger').nth(Number(appPassengerMatch[1]));
        }
        const appPassengerInputMatch = String(containerSelector).match(/^__APP_PASSENGER_INPUT_INDEX__(\d+)$/);
        if (appPassengerInputMatch) {
          return page.locator('app-passenger-input').nth(Number(appPassengerInputMatch[1]));
        }
        return page.locator(containerSelector).first();
      }
    }

    // Strategy 3: Target by passenger name input position across the page
    const allNameInputs = page.locator(
      'app-passenger p-autocomplete input, app-passenger input[formcontrolname="passengerName"], ' +
      'app-passenger-input p-autocomplete input, app-passenger-input input[formcontrolname="passengerName"], ' +
      'p-autocomplete input, input[formcontrolname="passengerName"], input[placeholder*="Passenger Name" i]'
    );
    const nameCount = await allNameInputs.count().catch(() => 0);
    if (nameCount > index) {
      const containerSelector = await allNameInputs.nth(index).evaluate((nameEl) => {
        let node = nameEl;
        for (let depth = 0; node && node !== document.body && depth < 20; depth += 1, node = node.parentElement) {
          if (node.tagName && (node.tagName.toLowerCase() === 'app-passenger' || node.tagName.toLowerCase() === 'app-passenger-input')) {
            const stamp = `irctc-psgn-card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            node.setAttribute('data-irctc-psgn-card', stamp);
            return `[data-irctc-psgn-card="${stamp}"]`;
          }
        }
        return null;
      }).catch(() => null);

      if (containerSelector) {
        return page.locator(containerSelector).first();
      }
    }

    // Strategy 4: Component wrapper app-passenger-input
    const appPassengerInput = page.locator('app-passenger-input');
    if ((await appPassengerInput.count().catch(() => 0)) > 0) {
      return appPassengerInput.first();
    }

    // Strategy 5: Fallback to page context
    if (page && typeof page.locator === 'function') {
      console.warn('[PASSENGER_CONTAINER_FALLBACK_TO_PAGE]', JSON.stringify({
        passengerIndex: index,
      }));
      return page;
    }

    throw new Error(`PASSENGER_CONTAINER_NOT_FOUND: passengerIndex=${index}`);
  }
  async _fillPassengerDetails(page, passengers) {
    if (!page || page.isClosed()) return;
    if (await this._isLoginCardVisible(page)) {
      const currentUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
      throw new Error(`LOGIN_CARD_DETECTED_ON_PASSENGER_PAGE: url=${currentUrl}`);
    }
    if (!Array.isArray(passengers) || passengers.length === 0) return;

    // Immediately dismiss any advisory or Senior Citizen concession popup dialogs
    await this._dismissPassengerAdvisoryDialogs(page);
    await page.locator(
      'app-passenger, app-passenger-input, input[formcontrolname="passengerName"], p-autocomplete input'
    ).first().waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
    await this._dismissPassengerAdvisoryDialogs(page);

    const workflowStartedAt = Date.now();
    const timing = (stage, extra = {}) => {
      console.log('[PASSENGER_TIMING]', JSON.stringify({
        stage,
        elapsedMs: Date.now() - workflowStartedAt,
        ...extra,
      }));
    };
    const getRenderedMetrics = async () => {
      if (await this._isLoginCardVisible(page)) {
        const currentUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
        throw new Error(`LOGIN_CARD_DETECTED_ON_PASSENGER_PAGE: url=${currentUrl}`);
      }
      if (typeof page.evaluate !== 'function') {
        const names = page.locator(
          'app-passenger p-autocomplete input, app-passenger input[formcontrolname="passengerName"], p-autocomplete input, input[formcontrolname="passengerName"], input[placeholder*="Passenger Name" i]'
        );
        const foods = page.locator('select[id^="FOOD_"]');
        const components = page.locator('app-passenger, app-passenger-input');
        const nameCount = typeof names.count === 'function' ? await names.count().catch(() => 0) : 0;
        const foodCount = typeof foods.count === 'function' ? await foods.count().catch(() => 0) : 0;
        const componentCount = typeof components.count === 'function' ? await components.count().catch(() => 0) : 0;
        return {
          nameCount,
          foodCount,
          componentCount,
          passengerCount: Math.max(nameCount, foodCount, componentCount),
          nameIds: [],
          foodIds: [],
        };
      }
      return page.evaluate(() => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        return style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Boolean(element.getClientRects().length);
      };
      const names = Array.from(document.querySelectorAll(
        'app-passenger p-autocomplete input, app-passenger input[formcontrolname="passengerName"], p-autocomplete input, input[formcontrolname="passengerName"], input[placeholder*="Passenger Name" i]'
      )).filter(visible);
      const foods = Array.from(document.querySelectorAll('select[id^="FOOD_"]')).filter(visible);
      const components = Array.from(document.querySelectorAll('app-passenger, app-passenger-input')).filter(visible);
      return {
        nameCount: names.length,
        foodCount: foods.length,
        componentCount: components.length,
        passengerCount: Math.max(names.length, foods.length, components.length),
        nameIds: names.map((element) => element.id || ''),
        foodIds: foods.map((element) => element.id || ''),
      };
      }).catch(() => ({ nameCount: 0, foodCount: 0, componentCount: 0, passengerCount: 0, nameIds: [], foodIds: [] }));
    };
    const safeCount = async (locator) => (locator && typeof locator.count === 'function'
      ? locator.count().catch(() => 0)
      : 0);
    const safeNth = (locator, index) => (locator && typeof locator.nth === 'function' ? locator.nth(index) : null);
    const safeFirst = (locator) => (locator && typeof locator.first === 'function' ? locator.first() : locator || null);
    const safeEvaluate = async (target, fn, fallback = null) => (target && typeof target.evaluate === 'function'
      ? target.evaluate(fn).catch(() => fallback)
      : fallback);
    const safeVisible = async (candidate) => {
      if (!candidate) return false;
      if (typeof candidate.isVisible !== 'function') return true;
      return candidate.isVisible({ timeout: 800 }).catch(() => false);
    };
    const visibleAtIndex = async (locator, index) => {
      const count = await safeCount(locator);
      let visibleIndex = 0;
      for (let candidateIndex = 0; candidateIndex < count; candidateIndex += 1) {
        const candidate = safeNth(locator, candidateIndex);
        if (!candidate) continue;
        const visible = await safeVisible(candidate);
        if (!visible) continue;
        if (visibleIndex === index) return candidate;
        visibleIndex += 1;
      }
      return null;
    };
    try {
      timing('PASSENGER_PAGE_REACHED', { passengerCount: (await getRenderedMetrics()).passengerCount });
      for (let i = 0; i < passengers.length; i++) {
        const p = passengers[i];
        if (!p || !p.name) continue;

                let renderedMetrics = await getRenderedMetrics();
        let renderedPassengerCount = renderedMetrics.passengerCount;
        console.log('[PASSENGER_RENDER_CHECK]', JSON.stringify({
          passengerIndex: i,
          renderedPassengerCount,
        }));
        if (i > 0) {
          while (renderedPassengerCount <= i) {
            console.log(`[PASSENGER_ADD_REQUIRED] passengerIndex=${i} renderedPassengerCount=${renderedPassengerCount}`);
            const addCandidates = page.locator(
              'app-passenger-input .prenext, .prenext, ' +
              'button:has-text("Add Passenger"), a:has-text("Add Passenger"), span:has-text("Add Passenger"), ' +
              'button:has-text("Add Infant with Berth"), a:has-text("Add Infant with Berth"), ' +
              'span:has-text("Add Infant with Berth"), button:has-text("Add Infant with Birth"), ' +
              'a:has-text("Add Infant with Birth"), span:has-text("Add Infant with Birth"), ' +
              'input[value*="Add Passenger" i], input[value*="Add Infant with Berth" i], ' +
              'input[value*="Add Infant with Birth" i], [aria-label*="Add Passenger" i], ' +
              '[aria-label*="Add Infant with Berth" i], [aria-label*="Add Infant with Birth" i]'
            );
            let addBtn = null;
            const addCount = typeof addCandidates.count === 'function' ? await addCandidates.count().catch(() => 0) : 0;
            for (let addIndex = 0; addIndex < addCount; addIndex += 1) {
              const candidate = addCandidates.nth(addIndex);
              if (await candidate.isVisible({ timeout: 500 }).catch(() => false)) {
                addBtn = candidate;
                break;
              }
            }
            if (!addBtn) {
              throw new Error(`CATERING_PASSENGER_CONTAINER_NOT_FOUND: passengerIndex=${i}; renderedPassengerCount=${renderedPassengerCount}`);
            }
            const addMetadata = await addBtn.evaluate((element) => ({
              tagName: element.tagName,
              text: String(element.innerText || element.textContent || element.getAttribute('value') || '').replace(/\s+/g, ' ').trim(),
              id: element.id || '',
              className: String(element.className || '').slice(0, 180),
            })).catch(() => null);
            console.log('[PASSENGER_ADD_CONTROL_FOUND]', JSON.stringify({
              passengerIndex: i,
              ...addMetadata,
            }));
                        const before = {
              passengerCount: renderedMetrics.passengerCount,
              foodCount: renderedMetrics.foodCount,
              nameCount: renderedMetrics.nameCount,
              componentCount: renderedMetrics.componentCount,
            };
            timing('PASSENGER_ADD_ACTION_STARTED', {
              passengerIndex: i,
              renderedPassengerCount,
            });
            await page.evaluate(() => {
              window.__irctcPassengerAddMutation = false;
              if (window.__irctcPassengerAddObserver) window.__irctcPassengerAddObserver.disconnect();
              window.__irctcPassengerAddObserver = new MutationObserver(() => {
                window.__irctcPassengerAddMutation = true;
              });
              window.__irctcPassengerAddObserver.observe(document.body, { childList: true, subtree: true });
            }).catch(() => {});
                        await addBtn.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});

            // Defensive: remove any stale dialog mask/overlay left over from a
            // previous child-berth warning or IRCTC advisory popup. Without this,
            // the click on "Add Passenger" is intercepted by the overlay.
            await page.evaluate(() => {
              document.querySelectorAll(
                '.ui-dialog-mask, .ui-widget-overlay, .ui-dialog-visible, ' +
                '.ui-dialog-mask-scrollblocker, .p-dialog-mask, .p-component-overlay'
              ).forEach((el) => el.remove());
              document.body.classList.remove('ui-dialog-mask-scrollblocker');
              document.body.classList.remove('p-overflow-hidden');
              document.body.style.overflow = '';
              document.body.style.paddingRight = '';
            }).catch(() => {});
            await sleep(100);

            // Try a normal click first; if an overlay still intercepts, force it.
            try {
              await addBtn.click({ timeout: 5000 });
            } catch (clickErr) {
              console.warn('[PASSENGER_ADD_CLICK_RETRY]', JSON.stringify({
                passengerIndex: i,
                reason: clickErr.message.slice(0, 200),
              }));
              await addBtn.click({ force: true, timeout: 5000 }).catch(async () => {
                await addBtn.evaluate((el) => el.click()).catch(() => {});
              });
            }
            timing('PASSENGER_ADD_ACTION_COMPLETED', { passengerIndex: i });
            console.log(`[PASSENGER_RENDER_WAITING] passengerIndex=${i}`);
            const renderWaitStartedAt = Date.now();
                                    // Wait for the Nth passenger to be fully rendered. The signal is ANY of:
//   - app-passenger-input count grew
//   - FOOD_<index> exists AND there is a passenger name input at position `index`
// This avoids firing on a placeholder FOOD_<index> before the container is real.
            const renderChanged = await page.waitForFunction(
              ({ requestedIndex, previousFoodCount }) => {
                // The definitive signal that the Nth passenger has rendered is
                // the presence of its passenger-specific FOOD_<index> control,
                // AND the total number of FOOD controls having grown. We use
                // FOOD controls because app-passenger-input count does NOT grow
                // in the per-passenger DIV wrapper case, and name inputs can
                // already exist before the passenger has fully rendered.
                const indexedFood = document.querySelector(`select[id="FOOD_${requestedIndex}"]`);
                if (!indexedFood) return false;
                const foods = document.querySelectorAll('select[id^="FOOD_"]');
                return foods.length > previousFoodCount;
              },
              { requestedIndex: i, previousFoodCount: before.foodCount },
              { timeout: 12000 }
            ).then(() => true).catch(() => false);

if (!renderChanged) {
  // Angular can be slow. Wait extra time, then proceed — the container
  // resolver below will validate whether the passenger actually rendered.
  console.warn('[PASSENGER_RENDER_WAIT_TIMEOUT]', JSON.stringify({
    passengerIndex: i,
    note: 'Render wait timed out; allowing extra settle time.',
  }));
  await sleep(1500);
}

await page.evaluate(() => {
  if (window.__irctcPassengerAddObserver) window.__irctcPassengerAddObserver.disconnect();
  delete window.__irctcPassengerAddObserver;
}).catch(() => {});

renderedMetrics = await getRenderedMetrics();
renderedPassengerCount = renderedMetrics.passengerCount;
console.log(`[PASSENGER_RENDERED] passengerIndex=${i} renderedPassengerCount=${renderedPassengerCount}`);
timing('PASSENGER_DOM_CHANGE_DETECTED', {
  passengerIndex: i,
  renderedPassengerCount: renderedMetrics.passengerCount,
  renderWaitMs: Date.now() - renderWaitStartedAt,
});
          }
        }

        console.log(`[PASSENGER_CONTAINER_AVAILABLE] passengerIndex=${i}`);
        // Angular replaces form nodes after Add Passenger. Resolve this container
        // only after the render evidence above; do not retain pre-click handles.
        const passengerContainer = await this._getPassengerContainer(page, i);

        // VERIFY: the resolved container must actually be the i-th one in DOM order.
        const resolvedControlCount = passengerContainer
          ? await safeCount(passengerContainer.locator('input, select, mat-select, [role="combobox"]'))
          : 0;
        console.log('[PASSENGER_CONTAINER_RESOLVED_AFTER_RENDER]', JSON.stringify({
          passengerIndex: i,
          containerTagName: await safeEvaluate(passengerContainer, (element) => element.tagName, ''),
          resolvedControlCount,
          foodControlId: `FOOD_${i}`,
        }));
        timing(`PASSENGER_${i}_CONTAINER_RESOLVED`, { passengerIndex: i });
        console.log(`[PASSENGER_DETAILS_FILLING] passengerIndex=${i}`);
        if (!passengerContainer) {
          throw new Error(`PASSENGER_CONTAINER_NOT_FOUND: passengerIndex=${i}; renderedPassengerCount=${renderedPassengerCount}`);
        }
        const scopedNameInputs = passengerContainer.locator(
          'p-autocomplete input, input[formcontrolname="passengerName"], input[placeholder*="Passenger Name" i], input[placeholder*="Name" i]'
        );
        const scopedNameCount = await safeCount(scopedNameInputs);

        let nameInput = null;
        if (scopedNameCount === 1) {
          nameInput = safeFirst(scopedNameInputs);
        } else if (scopedNameCount > i) {
          const candidate = safeNth(scopedNameInputs, i);
          if (candidate && await safeVisible(candidate)) {
            nameInput = candidate;
          }
        }
        if (!nameInput && scopedNameCount > 0) {
          nameInput = await visibleAtIndex(scopedNameInputs, 0);
        }

        // Global fallback if container didn't resolve the name input directly
        if (!nameInput) {
          const globalNames = page.locator(
            'app-passenger p-autocomplete input, app-passenger input[formcontrolname="passengerName"], ' +
            'app-passenger-input p-autocomplete input, app-passenger-input input[formcontrolname="passengerName"], ' +
            'p-autocomplete input, input[formcontrolname="passengerName"], input[placeholder*="Passenger Name" i]'
          );
          const globalCount = await safeCount(globalNames);
          if (globalCount > i) {
            nameInput = safeNth(globalNames, i);
          } else if (globalCount > 0 && i === 0) {
            nameInput = safeFirst(globalNames);
          }
        }

        if (!nameInput) {
          throw new Error(
            `PASSENGER_NAME_FIELD_NOT_FOUND: passengerIndex=${i}; scopedNameCount=${scopedNameCount}`
          );
        }
        await nameInput.fill(String(p.name).trim());
        if (typeof nameInput.inputValue === 'function') {
          const enteredName = (await nameInput.inputValue()).trim();
          if (enteredName !== String(p.name).trim()) {
            throw new Error(`IRCTC passenger name ${i + 1} was not accepted by the page.`);
          }
        }

        // AGE
        const ageInputs = passengerContainer.locator(
          'input[formcontrolname="passengerAge"], input[placeholder*="Age" i]'
        );
        const ageCount = await safeCount(ageInputs);
        let ageInput = null;
        if (ageCount === 1) {
          ageInput = safeFirst(ageInputs);
        } else if (ageCount > i) {
          const candidate = safeNth(ageInputs, i);
          if (candidate && await safeVisible(candidate)) {
            ageInput = candidate;
          }
        }
        if (!ageInput && ageCount > 0) {
          ageInput = await visibleAtIndex(ageInputs, 0);
        }
        if (!ageInput) {
          const globalAges = page.locator(
            'app-passenger input[formcontrolname="passengerAge"], app-passenger-input input[formcontrolname="passengerAge"], input[formcontrolname="passengerAge"]'
          );
          const globalAgeCount = await safeCount(globalAges);
          if (globalAgeCount > i) {
            ageInput = safeNth(globalAges, i);
          } else if (globalAgeCount > 0 && i === 0) {
            ageInput = safeFirst(globalAges);
          }
        }
        if (ageInput && p.age) {
          await ageInput.fill(String(p.age));
          if (typeof ageInput.inputValue === 'function') {
            const enteredAge = await ageInput.inputValue().catch(() => '');
            if (enteredAge !== String(p.age)) {
              throw new Error(`PASSENGER_AGE_NOT_ACCEPTED: passengerIndex=${i}`);
            }
          }
        }

        // GENDER
        const passengerSex = typeof p.sex === 'string' ? p.sex : (typeof p.gender === 'string' ? p.gender : '');
        const genderSelects = passengerContainer.locator('select[formcontrolname="passengerGender"]');
        const genderCount = await safeCount(genderSelects);
        let genderSelect = null;
        if (genderCount === 1) {
          genderSelect = safeFirst(genderSelects);
        } else if (genderCount > i) {
          const candidate = safeNth(genderSelects, i);
          if (candidate && await safeVisible(candidate)) {
            genderSelect = candidate;
          }
        }
        if (!genderSelect && genderCount > 0) {
          genderSelect = await visibleAtIndex(genderSelects, 0);
        }
        if (!genderSelect) {
          const globalGenders = page.locator(
            'app-passenger select[formcontrolname="passengerGender"], app-passenger-input select[formcontrolname="passengerGender"], select[formcontrolname="passengerGender"]'
          );
          const globalGenderCount = await safeCount(globalGenders);
          if (globalGenderCount > i) {
            genderSelect = safeNth(globalGenders, i);
          } else if (globalGenderCount > 0 && i === 0) {
            genderSelect = safeFirst(globalGenders);
          }
        }
        if (genderSelect && passengerSex) {
          const rawG = String(passengerSex).toUpperCase();
          const genderVal = rawG.startsWith('F') ? 'F' : (rawG.startsWith('T') ? 'T' : 'M');
          await genderSelect.selectOption(genderVal);
          if (typeof genderSelect.inputValue === 'function') {
            const selectedGender = await genderSelect.inputValue().catch(() => '');
            if (selectedGender !== genderVal) {
              throw new Error(`PASSENGER_GENDER_NOT_ACCEPTED: passengerIndex=${i}`);
            }
          }
        }

        // BERTH CHOICE
        if (p.berth && typeof p.berth === 'string' && p.berth.trim() !== '') {
          const berthSelects = passengerContainer.locator('select[formcontrolname="passengerBerthChoice"]');
          const berthCount = await safeCount(berthSelects);
          let berthSelect = null;
          if (berthCount === 1) {
            berthSelect = safeFirst(berthSelects);
          } else if (berthCount > i) {
            berthSelect = safeNth(berthSelects, i);
          } else if (berthCount > 0) {
            berthSelect = await visibleAtIndex(berthSelects, 0);
          }
          if (!berthSelect) {
            const globalBerths = page.locator(
              'app-passenger select[formcontrolname="passengerBerthChoice"], app-passenger-input select[formcontrolname="passengerBerthChoice"], select[formcontrolname="passengerBerthChoice"]'
            );
            const globalBerthCount = await safeCount(globalBerths);
            if (globalBerthCount > i) {
              berthSelect = safeNth(globalBerths, i);
            } else if (globalBerthCount > 0 && i === 0) {
              berthSelect = safeFirst(globalBerths);
            }
          }
          if (berthSelect) {
            const rawB = String(p.berth).toUpperCase().trim();
            try {
              const options = await berthSelect.evaluate((sel) => Array.from(sel.options).map((o) => ({ value: o.value, text: (o.text || '').toUpperCase() }))).catch(() => []);
              const matched = options.find((o) => {
                if (!o.value || o.value === 'NC' || o.value === '') return false;
                if (rawB.startsWith('L') && (o.value.includes('LB') || (o.text.includes('LOWER') && !o.text.includes('SIDE')))) return true;
                if (rawB.startsWith('M') && (o.value.includes('MB') || o.text.includes('MIDDLE'))) return true;
                if (rawB.startsWith('U') && (o.value.includes('UB') || o.text.includes('UPPER') && !o.text.includes('SIDE'))) return true;
                if (rawB.includes('SIDE LOWER') || (rawB.startsWith('SL') && (o.value.includes('SL') || o.text.includes('SIDE LOWER')))) return true;
                if (rawB.includes('SIDE UPPER') || (rawB.startsWith('SU') && (o.value.includes('SU') || o.text.includes('SIDE UPPER')))) return true;
                if (rawB.includes('WINDOW') || (rawB.startsWith('W') && (o.value.includes('WS') || o.text.includes('WINDOW')))) return true;
                return o.value.toUpperCase() === rawB || o.text.includes(rawB);
              });
              if (matched) {
                await berthSelect.selectOption(matched.value);
                console.log(`[PASSENGER_BERTH_SELECTED] passengerIndex=${i} berth=${matched.value}`);
              }
            } catch (_) {}
          }
        }

        console.log('[PASSENGER_DETAILS_FILLED]', JSON.stringify({
          passengerIndex: i,
          passengerName: String(p.name).trim(),
          age: p.age ?? null,
        }));
        timing(`PASSENGER_${i}_FILLED`, { passengerIndex: i });


        const configuredFood = p.food || 'Non-Veg';
        const expectedCateringControlId = `FOOD_${i}`;
        // Resolve the index-specific control inside the already-resolved
        // passenger component. Do not let a later generic lookup select FOOD_0.
        const indexedCateringControl = passengerContainer.locator(
          `select[id="${expectedCateringControlId}"]`
        );
        const indexedCateringCount = await safeCount(indexedCateringControl);
        const fallbackCateringControl = indexedCateringCount === 0
          ? passengerContainer.locator(
            'select[formcontrolname="passengerFoodChoice"], select[id^="FOOD_"], [formcontrolname="passengerFoodChoice"]'
          )
          : null;
        const fallbackCateringCount = fallbackCateringControl
          ? await safeCount(fallbackCateringControl)
          : 0;
        const cateringField = indexedCateringCount > 0
          ? safeFirst(indexedCateringControl)
          : (fallbackCateringCount > 0 ? safeFirst(fallbackCateringControl) : null);
        const cateringVisible = cateringField && typeof cateringField.isVisible === 'function'
          ? await cateringField.isVisible({ timeout: 800 }).catch(() => false)
          : Boolean(cateringField);
        const cateringDisabled = cateringField && typeof cateringField.isDisabled === 'function'
          ? await cateringField.isDisabled().catch(() => false)
          : false;
        const cateringAvailable = Boolean(cateringField) && cateringVisible && !cateringDisabled;
        let cateringIdentity = null;
        if (!cateringAvailable) {
          console.log('[CATERING_SKIPPED]', JSON.stringify({
            passengerIndex: i,
            reason: 'FIELD_NOT_AVAILABLE',
            renderedPassengerCount,
          }));
        } else {
          cateringIdentity = await safeEvaluate(cateringField, (element) => ({
            tagName: element.tagName,
            id: element.id || '',
            formControlName: element.getAttribute('formcontrolname') || '',
            value: element.value || element.getAttribute('value') || '',
          }), null);
          if (cateringIdentity?.id && cateringIdentity.id !== expectedCateringControlId) {
            throw new Error(
              `PASSENGER_CATERING_SCOPE_MISMATCH: passengerIndex=${i}; ` +
              `expectedControlId=${expectedCateringControlId}; actualControlId=${cateringIdentity.id}`
            );
          }
          console.log('[CATERING_SCOPE_RESOLVED]', JSON.stringify({
            passengerIndex: i,
            actualControlId: cateringIdentity?.id || null,
            expectedControlId: expectedCateringControlId,
            containerTagName: await safeEvaluate(passengerContainer, (element) => element.tagName, ''),
          }));
          try {
            await this._selectCateringChoice(cateringField, configuredFood, {
              passengerIndex: i,
              expectedControlId: expectedCateringControlId,
            });
          } catch (error) {
            throw new Error(`${error.message}; passengerIndex=${i}; renderedPassengerCount=${renderedPassengerCount}`);
          }
          cateringIdentity = await safeEvaluate(cateringField, (element) => ({
            tagName: element.tagName,
            id: element.id || '',
            formControlName: element.getAttribute('formcontrolname') || '',
            value: element.value || element.getAttribute('value') || '',
          }), null);
          console.log('[CATERING_VERIFIED]', JSON.stringify({
            passengerIndex: i,
            requestedValue: configuredFood,
            actualValue: cateringIdentity?.value || null,
          }));
        }
        timing(`PASSENGER_${i}_CATERING_COMPLETED`, { passengerIndex: i });
        timing(`PASSENGER_${i}_CHILD_BERTH_STARTED`, { passengerIndex: i });
        await this._synchronizeOptChildBirth(page, passengerContainer, p, i);
        timing(`PASSENGER_${i}_CHILD_BERTH_COMPLETED`, { passengerIndex: i });
        const childBerthControl = passengerContainer.locator(
          'input[type="checkbox"][formcontrolname="childBerthFlag"]'
        );
        const childBerthCount = await safeCount(childBerthControl);
        const childBerthIdentity = childBerthCount > 0
          ? await safeEvaluate(safeFirst(childBerthControl), (element) => ({
            tagName: element.tagName,
            id: element.id || '',
            formControlName: element.getAttribute('formcontrolname') || '',
            checked: element.checked,
          }), null)
          : null;
        timing(`PASSENGER_${i}_CONTAINER_VERIFY_START`, { passengerIndex: i });
        console.log('[PASSENGER_CONTAINER_VERIFIED]', JSON.stringify({
          passengerIndex: i,
          passengerName: String(p.name).trim(),
          containerTagName: await safeEvaluate(passengerContainer, (element) => element.tagName, ''),
          cateringControl: cateringIdentity,
          childBerthControl: childBerthIdentity,
        }));
        timing(`PASSENGER_${i}_CONTAINER_VERIFY_END`, { passengerIndex: i });
        console.log(`[IRCTC Automation][PASSENGER_CONTINUE] passengerIndex=${i}`);
        timing(`PASSENGER_${i}_COMPLETED`, { passengerIndex: i });
      }
      timing('PASSENGER_WORKFLOW_COMPLETE', { passengerCount: passengers.length });
      console.log('[PASSENGER_WORKFLOW_TIMING_SUMMARY]', JSON.stringify({
        totalPassengerWorkflowMs: Date.now() - workflowStartedAt,
      }));

    } catch (err) {
      console.error('[IRCTC Automation] Passenger details fill failed:', err.message);
      throw err;
    }
  }

  async _synchronizeOptChildBirth(page, passengerContainer, passenger, passengerIndex) {
    const age = Number(passenger?.age);
    if (!Number.isFinite(age) || age >= 12) return;

    const desired = Boolean(passenger?.child) || Boolean(passenger?.bed);
    const passengerName = String(passenger?.name || '').replace(/\s+/g, ' ').trim();
    console.log(
      `[IRCTC Automation][OPT_CHILD_BIRTH_SEARCH] passengerIndex=${passengerIndex} ` +
      `passengerName=${passengerName} age=${age} desired=${desired}`
    );

    const checkbox = await this._findOptChildBirthControl(
      page,
      passengerContainer,
      passengerName,
      age,
      passengerIndex
    );
    if (!checkbox) {
      console.log(
        `[IRCTC Automation][OPT_CHILD_BIRTH_NOT_AVAILABLE] passengerIndex=${passengerIndex} ` +
        `age=${age} action=SKIPPED`
      );
      return;
    }
    console.log(`[IRCTC Automation][OPT_CHILD_BIRTH_FOUND] passengerIndex=${passengerIndex}`);

    const actual = await this._readOptChildBirthState(checkbox);
    if (actual === null) {
      throw new Error(`OPT_CHILD_BIRTH_STATE_UNREADABLE: passengerIndex=${passengerIndex}`);
    }
    console.log(`[IRCTC Automation][OPT_CHILD_BERTH_INITIAL_STATE] passengerIndex=${passengerIndex} checked=${actual}`);
    console.log(
      `[IRCTC Automation][OPT_CHILD_BIRTH_RESOLVED] passengerIndex=${passengerIndex} ` +
      `desired=${desired} actual=${actual}`
    );

        const handleChildBerthWarning = async (page, passengerIndex) => {
      const warningDetectedAt = Date.now();
      const deadline = warningDetectedAt + 3000;
      let warning = null;
      while (Date.now() < deadline) {
        const dialogs = page.locator(
          '[role="dialog"], .modal, .ui-dialog, .swal2-popup, .p-dialog, .toast, [role="alert"]'
        );
        const count = await dialogs.count().catch(() => 0);
        for (let index = 0; index < count; index += 1) {
          const candidate = dialogs.nth(index);
          const metadata = await candidate.evaluate((element) => {
            const visible = Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
            const text = String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
            return { visible, text: text.slice(0, 500) };
          }).catch(() => null);
          if (metadata?.visible && /child\s+(?:berth|birth)|berth.*(?:child|concession)|concession.*child|no\s+birth\s+will\s+be\s+allowed/i.test(metadata.text)) {
            warning = { locator: candidate, metadata };
            break;
          }
        }
        if (warning) break;
        await sleep(150);
      }
      if (!warning) return false;

      console.log('[CHILD_BERTH_WARNING_DETECTED]', JSON.stringify({
        passengerIndex,
        message: warning.metadata.text,
      }));
      const warningTiming = (stage) => console.log('[CHILD_BERTH_WARNING_TIMING]', JSON.stringify({
        stage,
        passengerIndex,
        elapsedMs: Date.now() - warningDetectedAt,
      }));
      warningTiming('DETECTED');
      const okButtons = warning.locator.locator(
        'button, input[type="button"], input[type="submit"], [role="button"]'
      );
      const okCount = await okButtons.count().catch(() => 0);
      let okButton = null;
      for (let index = 0; index < okCount; index += 1) {
        const candidate = okButtons.nth(index);
        const text = String(await candidate.innerText().catch(() => '')).replace(/\s+/g, ' ').trim() ||
          String(await candidate.getAttribute('value').catch(() => '')).trim();
        if (/^ok$/i.test(text) && await candidate.isVisible().catch(() => false)) {
          okButton = candidate;
          break;
        }
      }
      if (!okButton) throw new Error(`CHILD_BERTH_WARNING_OK_NOT_FOUND: passengerIndex=${passengerIndex}`);

      let okClicked = false;
      try {
        await okButton.click({ timeout: 3000 });
        okClicked = true;
      } catch (clickErr) {
        console.warn('[CHILD_BERTH_WARNING_OK_CLICK_RETRY]', JSON.stringify({
          passengerIndex,
          reason: clickErr.message.slice(0, 200),
        }));
      }

      if (!okClicked) {
        try {
          await okButton.click({ force: true, timeout: 3000 });
          okClicked = true;
        } catch (forceErr) {
          console.warn('[CHILD_BERTH_WARNING_OK_FORCE_CLICK_FAILED]', JSON.stringify({
            passengerIndex,
            reason: forceErr.message.slice(0, 200),
          }));
        }
      }

      if (!okClicked) {
        await okButton.evaluate((element) => element.click()).catch(() => {});
        okClicked = true;
      }

      console.log(`[CHILD_BERTH_WARNING_OK_CLICKED] passengerIndex=${passengerIndex}`);
      warningTiming('OK_CLICKED');

      await warning.locator
        .waitFor({ state: 'hidden', timeout: 3000 })
        .catch(() => {});

      await page.evaluate(() => {
        document.querySelectorAll(
          '.ui-dialog-mask, .ui-widget-overlay, .ui-dialog-visible, ' +
          '.ui-dialog-mask-scrollblocker, .p-dialog-mask, .p-component-overlay'
        ).forEach((el) => el.remove());
        document.body.classList.remove('ui-dialog-mask-scrollblocker');
        document.body.classList.remove('p-overflow-hidden');
        document.body.style.overflow = '';
        document.body.style.paddingRight = '';
      }).catch(() => {});

      await sleep(150);

      console.log(`[CHILD_BERTH_WARNING_DISMISSED] passengerIndex=${passengerIndex}`);
      return true;
    };

    let action = 'UNCHANGED';
    if (actual !== desired) {
      console.log(
        `[IRCTC Automation][OPT_CHILD_BERTH_${desired ? 'CHECK' : 'UNCHECK'}_REQUESTED] ` +
        `passengerIndex=${passengerIndex} desired=${desired}`
      );
      await this._setOptChildBirthState(page, checkbox, desired);
      action = desired ? 'CHECKED' : 'UNCHECKED';
      if (!desired) {
        await handleChildBerthWarning(page, passengerIndex);
      }
    }

    const verified = await this._readOptChildBirthState(checkbox);
    console.log(`[IRCTC Automation][OPT_CHILD_BERTH_STATE] passengerIndex=${passengerIndex} checked=${verified}`);
    if (verified !== desired) {
      const settled = await this._settleOptChildBirthState(page, checkbox, desired);
      console.log(`[IRCTC Automation][OPT_CHILD_BIRTH_AFTER_SETTLE] passengerIndex=${passengerIndex} checked=${settled}`);
    }
    const finalState = await this._readOptChildBirthState(checkbox);
    if (finalState !== desired) {
      throw new Error(`OPT_CHILD_BIRTH_SYNC_NOT_VERIFIED: passengerIndex=${passengerIndex}`);
    }
    console.log('[OPT_CHILD_BERTH_VERIFIED]', JSON.stringify({
      passengerIndex,
      desired,
      actual: finalState,
    }));
    console.log(
      `[IRCTC Automation][OPT_CHILD_BIRTH_SYNC] passengerIndex=${passengerIndex} ` +
      `action=${action} verified=true`
    );
  }

  async _logOptChildBirthLayoutForensics(page, passengerContainer, checkbox, passengerIndex) {
    const serializeBox = (box) => box ? {
      x: box.x,
      y: box.y,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
      left: box.left,
      width: box.width,
      height: box.height,
    } : null;
    const layoutFor = async (locator) => locator.evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        tagName: element.tagName,
        id: element.id || '',
        className: String(element.className || '').slice(0, 240),
        boundingBox: {
          x: rect.x,
          y: rect.y,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        },
        display: style.display,
        visibility: style.visibility,
        position: style.position,
        transform: style.transform,
        left: style.left,
        right: style.right,
        width: style.width,
        overflow: style.overflow,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        scrollLeft: element.scrollLeft,
        scrollTop: element.scrollTop,
        innerTextLength: (element.innerText || '').length,
        childCount: element.children.length,
        offsetParent: element.offsetParent ? element.offsetParent.tagName : null,
      };
    }).catch(() => null);

    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    })).catch(() => null);
    const containerLayout = await layoutFor(passengerContainer);
    const containerBox = await passengerContainer.boundingBox().catch(() => null);
    const foodLocator = page.locator('select[id^="FOOD_"]').nth(passengerIndex);
    const foodLayout = await layoutFor(foodLocator).catch(() => null);
    const foodBox = await foodLocator.boundingBox().catch(() => null);
    const checkboxLayout = await layoutFor(checkbox);
    const checkboxBox = await checkbox.boundingBox().catch(() => null);
    const ancestorChain = await checkbox.evaluate((element) => {
      const result = [];
      let node = element;
      for (let index = 0; node && index < 12; index += 1, node = node.parentElement) {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        result.push({
          index,
          tagName: node.tagName,
          id: node.id || '',
          className: String(node.className || '').slice(0, 240),
          boundingBox: {
            x: rect.x,
            y: rect.y,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          },
          position: style.position,
          display: style.display,
          visibility: style.visibility,
          transform: style.transform,
          overflow: style.overflow,
        });
      }
      return result;
    }).catch(() => []);
    const allCandidates = await page.locator(
      'input[type="checkbox"][formcontrolname="childBerthFlag"]'
    ).evaluateAll((elements) => elements.map((element, index) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        index,
        id: element.id || '',
        checked: element.checked,
        boundingBox: {
          x: rect.x,
          y: rect.y,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        },
        visible: Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length),
        display: style.display,
        visibility: style.visibility,
        disabled: element.disabled,
      };
    })).catch(() => []);

    console.log('[OPT_CHILD_BERTH_LAYOUT_FORENSIC]', JSON.stringify({
      passengerIndex,
      viewport,
      passengerContainer: {
        locatorVisible: await passengerContainer.isVisible().catch(() => false),
        boundingBox: serializeBox(containerBox),
        layout: containerLayout,
      },
      foodControl: {
        boundingBox: serializeBox(foodBox),
        layout: foodLayout,
      },
      checkbox: {
        boundingBox: serializeBox(checkboxBox),
        layout: checkboxLayout,
      },
      ancestorChain,
      allChildBerthCandidates: allCandidates,
      actualCandidateId: checkboxLayout?.id || null,
    }));
  }

 async _findOptChildBirthControl(page, passengerContainer, passengerName, passengerAge, passengerIndex) {
  if (!passengerContainer) return null;
  const checkboxes = passengerContainer.locator(
    'input[type="checkbox"][formcontrolname="childBerthFlag"]'
  );

  // Wait briefly for the checkbox to appear INSIDE this specific container.
  // Do NOT count page-wide checkboxes — that would give false positives when
  // multiple passengers each have their own per-passenger wrapper.
  const deadline = Date.now() + 3000;
  let count = await checkboxes.count().catch(() => 0);
  while (count === 0 && Date.now() < deadline) {
    await sleep(200);
    count = await checkboxes.count().catch(() => 0);
  }

  console.log(
    `[IRCTC Automation][OPT_CHILD_BIRTH_SEARCH] passengerIndex=${passengerIndex} ` +
    `candidateCount=${count} passengerName=${passengerName} age=${passengerAge}`
  );

    if (count === 0) {
    console.log(
      `[IRCTC Automation][OPT_CHILD_BIRTH_NOT_AVAILABLE] passengerIndex=${passengerIndex} ` +
      `candidateCount=${count} action=SKIPPED (no checkbox in container)`
    );
    return null;
  }

  // Per-passenger wrapper case: container holds exactly one checkbox for this passenger.
  // Shared-component case: container holds N checkboxes; pick nth(passengerIndex).
  const target = count > passengerIndex ? checkboxes.nth(passengerIndex) : checkboxes.nth(0);
  if (!(await target.isVisible({ timeout: 800 }).catch(() => false))) {
    return null;
  }

  const metadata = await target.evaluate((element) => ({
    tagName: element.tagName,
    type: element.getAttribute('type') || '',
    id: element.id || '',
    formControlName: element.getAttribute('formcontrolname') || '',
    className: String(element.className || ''),
    checked: element instanceof HTMLInputElement ? element.checked : null,
  })).catch(() => null);

  console.log('[OPT_CHILD_BERTH_CONTROL_INSPECTED]', JSON.stringify({
    passengerIndex,
    ...metadata,
  }));

  if (!metadata || metadata.tagName !== 'INPUT' ||
    metadata.type.toLowerCase() !== 'checkbox' ||
    metadata.formControlName !== 'childBerthFlag') {
    return null;
  }

  console.log('[IRCTC Automation][OPT_CHILD_BIRTH_CONTROL_RESOLVED]', JSON.stringify({
    passengerIndex,
    controlTag: metadata.tagName,
    controlType: metadata.type,
    controlId: metadata.id,
  }));

  return target;
}

  async _countOptChildBirthCandidates(passengerContainer) {
    if (!passengerContainer) return 0;
    return passengerContainer.locator(
      'input[type="checkbox"][formcontrolname="childBerthFlag"]'
    ).count().catch(() => 0);
  }

  async _readOptChildBirthState(control) {
    return control.evaluate((element) => {
      const resolveControl = (candidate) => {
        if (candidate.matches('input[type="checkbox"], [role="checkbox"]')) return candidate;
        const label = candidate.closest('label');
        return candidate.querySelector('input[type="checkbox"], [role="checkbox"]') ||
          label?.querySelector('input[type="checkbox"], [role="checkbox"]') ||
          (candidate.id ? document.getElementById(candidate.id) : null) ||
          (label?.htmlFor
            ? document.getElementById(label.htmlFor)
            : null);
      };
      const resolved = resolveControl(element) || element;
      if (resolved instanceof HTMLInputElement && resolved.type === 'checkbox') return resolved.checked;
      if (resolved.getAttribute('aria-checked') === 'true') return true;
      if (resolved.getAttribute('aria-checked') === 'false') return false;
      return /\b(?:checked|selected|active)\b/i.test(String(resolved.className || ''));
    }).catch(() => null);
  }

  async _setOptChildBirthState(page, control, desired) {
    const metadata = await control.evaluate((element) => ({
      native: element instanceof HTMLInputElement && element.type === 'checkbox',
      nestedNative: Boolean(element.querySelector('input[type="checkbox"]')),
      disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
    })).catch(() => ({ native: false, disabled: true }));
    if (metadata.disabled) throw new Error('OPT_CHILD_BIRTH_CONTROL_DISABLED');
    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    })).catch(() => null);
    const layout = await control.evaluate((element) => {
      const isScrollable = (node) => {
        const style = getComputedStyle(node);
        return (/(auto|scroll|overlay)/i.test(style.overflowY) && node.scrollHeight > node.clientHeight) ||
          (/(auto|scroll|overlay)/i.test(style.overflowX) && node.scrollWidth > node.clientWidth);
      };
      const scrollContainers = [];
      for (let node = element.parentElement; node; node = node.parentElement) {
        if (isScrollable(node)) {
          scrollContainers.push({
            tagName: node.tagName,
            id: node.id || '',
            className: String(node.className || '').slice(0, 160),
            scrollTop: node.scrollTop,
            scrollLeft: node.scrollLeft,
            clientWidth: node.clientWidth,
            clientHeight: node.clientHeight,
            scrollWidth: node.scrollWidth,
            scrollHeight: node.scrollHeight,
          });
        }
      }
      const rect = element.getBoundingClientRect();
      return {
        rect: {
          x: rect.x,
          y: rect.y,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        },
        tagName: element.tagName,
        type: element.getAttribute('type'),
        checked: element.checked,
        disabled: element.disabled,
        id: element.id,
        formControlName: element.getAttribute('formcontrolname'),
        offsetParent: element.offsetParent ? element.offsetParent.tagName : null,
        clientWidth: element.clientWidth,
        clientHeight: element.clientHeight,
        scrollContainers,
      };
    }).catch(() => null);
    console.log('[IRCTC Automation][OPT_CHILD_BERTH_VIEWPORT]', JSON.stringify({
      desired,
      checkboxRect: layout?.rect || null,
      viewport,
      scrollContainer: layout?.scrollContainers || [],
    }));
    console.log('[IRCTC Automation][OPT_CHILD_BERTH_STATE]', JSON.stringify({
      desired,
      actualBefore: layout?.checked ?? null,
      actualAfter: null,
    }));
    await control.evaluate((element) => {
      element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
      const isScrollable = (node) => {
        const style = getComputedStyle(node);
        return (/(auto|scroll|overlay)/i.test(style.overflowY) && node.scrollHeight > node.clientHeight) ||
          (/(auto|scroll|overlay)/i.test(style.overflowX) && node.scrollWidth > node.clientWidth);
      };
      for (let node = element.parentElement; node; node = node.parentElement) {
        if (!isScrollable(node)) continue;
        const elementRect = element.getBoundingClientRect();
        const containerRect = node.getBoundingClientRect();
        if (elementRect.top < containerRect.top) node.scrollTop -= containerRect.top - elementRect.top;
        if (elementRect.bottom > containerRect.bottom) node.scrollTop += elementRect.bottom - containerRect.bottom;
        if (elementRect.left < containerRect.left) node.scrollLeft -= containerRect.left - elementRect.left;
        if (elementRect.right > containerRect.right) node.scrollLeft += elementRect.right - containerRect.right;
      }
    }).catch(() => {});
    await control.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await control.evaluate((element, desiredState) => {
      if (!(element instanceof HTMLInputElement) || element.type !== 'checkbox') {
        throw new Error('OPT_CHILD_BIRTH_NATIVE_CONTROL_REQUIRED');
      }
      if (element.checked !== desiredState) element.click();
    }, desired);
    const actualAfter = await control.evaluate((element) => (
      element instanceof HTMLInputElement && element.type === 'checkbox' ? element.checked : null
    )).catch(() => null);
    console.log('[IRCTC Automation][OPT_CHILD_BERTH_STATE]', JSON.stringify({
      desired,
      actualBefore: layout?.checked ?? null,
      actualAfter,
    }));
  }

  async _settleOptChildBirthState(page, control, desired) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await control.evaluate((element) => {
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.dispatchEvent(new Event('blur', { bubbles: true }));
      }).catch(() => {});
      await sleep(150);
      const current = await this._readOptChildBirthState(control);
      if (current === desired) return current;
      await this._setOptChildBirthState(page, control, desired);
    }
    return this._readOptChildBirthState(control);
  }

  _resolveConfiguredFoodChoice(ticket = null) {
    const passengers = Array.isArray(ticket?.passengers) ? ticket.passengers : [];
    const firstPassengerFood = passengers[0]?.food;
    return normalizeIrctcCateringChoice(firstPassengerFood || ticket?.food || 'NON-VEGETARIAN');
  }

  _extractMobileNumber(ticket = null) {
    const rawMobile = String(ticket?.mobileNumber || ticket?.mobile_number || '').trim();
    const digits = rawMobile.replace(/\D/g, '');
    return digits.length >= 10 ? digits : null;
  }

  async _fillMobileNumber(page, mobileNumber) {
    const mobile = String(mobileNumber || '').replace(/\D/g, '');
    if (!mobile || mobile.length < 10) {
      throw new Error('MOBILE_VALUE_NOT_AVAILABLE');
    }
    if (await this._isLoginCardVisible(page)) {
      const currentUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
      throw new Error(`LOGIN_CARD_DETECTED_ON_PASSENGER_PAGE: url=${currentUrl}`);
    }

    const mobileSelectors = [
      'input[formcontrolname="mobileNumber"]',
      'input[formcontrolname="mobileNo"]',
      'input[placeholder*="Mobile" i]',
      'input[aria-label*="Mobile" i]',
      'input[name*="mobile" i]',
      'input[type="tel"]',
    ].join(', ');

    const mobileField = page.locator(mobileSelectors).first();
    await mobileField.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    const inputPresent = await mobileField.isVisible({ timeout: 5000 }).catch(() => false);
    if (!inputPresent) {
      throw new Error('MOBILE_FIELD_NOT_FOUND');
    }

    await mobileField.fill('');
    await mobileField.fill(mobile);
    await mobileField.evaluate((element) => {
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      element.dispatchEvent(new Event('blur', { bubbles: true }));
    }).catch(() => {});

    const finalMobile = (await mobileField.inputValue().catch(() => '')).replace(/\D/g, '');
    if (finalMobile !== mobile) {
      throw new Error('MOBILE_VERIFICATION_FAILED');
    }
    console.log('[IRCTC Automation][MOBILE] Mobile number verified on passenger page.');
    return true;
  }

  async _selectCateringChoice(field, configuredFood, scope = {}) {
    const normalizedFood = normalizeIrctcCateringChoice(configuredFood);
    if (!field || typeof field.isVisible !== 'function') {
      throw new Error('CATERING_FIELD_NOT_FOUND');
    }
    const fieldVisible = await field.isVisible({ timeout: 5000 }).catch(() => false);
    if (!fieldVisible) {
      throw new Error('CATERING_FIELD_NOT_FOUND');
    }
    const requestedChoice = normalizedFood;
    const optionMetadata = await field.locator('option').evaluateAll((options) => options.map((option) => ({
      label: (option.textContent || '').replace(/\s+/g, ' ').trim(),
      value: option.value || '',
      selected: option.selected,
    }))).catch(() => []);
    const fieldMetadata = await field.evaluate((element) => ({
      tagName: element.tagName,
      name: element.getAttribute('name') || '',
      id: element.id || '',
      formControlName: element.getAttribute('formcontrolname') || '',
      ariaLabel: element.getAttribute('aria-label') || '',
    })).catch(() => null);
    if (scope.expectedControlId && fieldMetadata?.id && fieldMetadata.id !== scope.expectedControlId) {
      throw new Error(
        `PASSENGER_CATERING_SCOPE_MISMATCH: passengerIndex=${scope.passengerIndex}; ` +
        `expectedControlId=${scope.expectedControlId}; actualControlId=${fieldMetadata.id}`
      );
    }
    console.log('[CATERING_DOM]', JSON.stringify({
      passengerIndex: scope.passengerIndex ?? null,
      label: 'Catering Service Option',
      ...fieldMetadata,
      options: optionMetadata,
    }));
    console.log('[CATERING_DEBUG] catering options discovered:', JSON.stringify(optionMetadata));

    const matchingOption = optionMetadata.find((option) =>
      cateringOptionMatches(option.label, option.value, requestedChoice)
    );
    const tagName = await field.evaluate((element) => element.tagName).catch(() => '');
    if (tagName === 'SELECT') {
      if (!matchingOption) {
        throw new Error(`CATERING_OPTION_NOT_AVAILABLE: ${normalizedFood}`);
      }
      await field.selectOption({ value: matchingOption.value }).catch(async () => {
        await field.selectOption({ label: matchingOption.label });
      });
    } else {
      await field.click({ force: true });
      const container = field.locator('xpath=ancestor::*[self::div or self::mat-form-field][1]');
      const optionCandidates = container.locator('mat-option, p-dropdownitem, .ui-dropdown-item, [role="option"]');
      const optionCount = await optionCandidates.count().catch(() => 0);
      let clicked = false;
      for (let index = 0; index < optionCount; index += 1) {
        const option = optionCandidates.nth(index);
        const optionText = (await option.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (cateringOptionMatches(optionText, '', requestedChoice)) {
          await option.click({ force: true });
          clicked = true;
          break;
        }
      }
      if (!clicked) {
        throw new Error(`CATERING_OPTION_NOT_AVAILABLE: ${normalizedFood}`);
      }
    }

    await field.evaluate((element) => {
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      element.dispatchEvent(new Event('blur', { bubbles: true }));
    }).catch(() => {});

    const selectedState = await field.evaluate((element) => {
      if (element.tagName === 'SELECT') {
        const selected = element.options[element.selectedIndex];
        return {
          value: selected?.value || '',
          label: (selected?.textContent || '').replace(/\s+/g, ' ').trim(),
          valid: element.checkValidity ? element.checkValidity() : true,
          invalid: element.getAttribute('aria-invalid') === 'true',
        };
      }
      return {
        value: element.getAttribute('value') || '',
        label: (element.textContent || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
        valid: true,
        invalid: element.getAttribute('aria-invalid') === 'true',
      };
    }).catch(() => null);
    const selectedMatches = cateringOptionMatches(
      selectedState?.label || '',
      selectedState?.value || '',
      requestedChoice
    );
    if (!selectedState || !selectedMatches || selectedState.invalid || selectedState.valid === false) {
      throw new Error('CATERING_SELECTION_NOT_VERIFIED');
    }

    console.log(`[CATERING] ${configuredFood} selected`);
    console.log('[CATERING] Catering selection verified');
    return true;
  }

  async _handleLoyaltyCoBrandedSection(page) {
    if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return;
    try {
      console.log('[IRCTC Automation] Checking for Co-branded Card / Loyalty points section on passenger page...');
      const handled = await page.evaluate(() => {
        // Method 1: Look for any radiobutton or label or button with text matching "Skip"
        const candidates = Array.from(document.querySelectorAll('app-passenger-input p-radiobutton, p-radiobutton, label, [role="radio"], .ui-radiobutton, button, div, span'));
        for (const el of candidates) {
          const rawText = (el.innerText || el.textContent || '').trim();
          if (/^skip$/i.test(rawText) || /^skip\b/i.test(rawText) || rawText.toLowerCase() === 'skip') {
            const pRadio = el.closest('p-radiobutton') || el.closest('.ui-radiobutton') || el;
            const box = pRadio.querySelector('.ui-radiobutton-box') || pRadio;
            box.scrollIntoView({ behavior: 'instant', block: 'center' });
            box.click();
            box.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            const inp = pRadio.querySelector('input');
            if (inp) {
              inp.checked = true;
              inp.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return { skipped: true, method: 'radio-or-label', text: rawText };
          }
        }

        // Method 2: Check for input with value="skip" or name containing "loyalty"
        const inputs = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
        for (const inp of inputs) {
          const val = (inp.value || inp.getAttribute('value') || inp.id || inp.name || '').toLowerCase();
          if (val.includes('skip')) {
            inp.scrollIntoView({ behavior: 'instant', block: 'center' });
            inp.click();
            inp.checked = true;
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            return { skipped: true, method: 'input-value-skip', byInput: val };
          }
        }
        return { skipped: false };
      }).catch(() => ({ skipped: false }));

      if (handled?.skipped) {
        console.log('[IRCTC Automation][LOYALTY_CARD_BENEFITS_SKIPPED]', JSON.stringify(handled));
      } else {
        // Method 3: Playwright locator fallback
        const skipLoc = page.locator(
          'p-radiobutton:has-text("Skip"), label:has-text("Skip"), input[value*="skip" i], button:has-text("Skip")'
        ).first();
        if (await skipLoc.isVisible({ timeout: 600 }).catch(() => false)) {
          await skipLoc.click({ force: true }).catch(() => {});
          console.log('[IRCTC Automation][LOYALTY_CARD_BENEFITS_SKIPPED_LOCATOR]');
        }
      }
    } catch (err) {
      console.warn('[IRCTC Automation] Notice: Co-branded loyalty section check:', err.message);
    }
  }

  async _fillPassengerPreferences(page, ticket = {}) {
    if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return;
    console.log('[IRCTC Automation] Filling passenger preferences...');

    // 1. Mobile Number (Mandatory)
    const configuredMobile = this._extractMobileNumber(ticket);
    if (!configuredMobile) {
      throw new Error('MOBILE_VALUE_NOT_AVAILABLE');
    }
    await this._fillMobileNumber(page, configuredMobile);

    // 2. Auto Upgradation
    const shouldUpgrade = Boolean(ticket?.autoUpgradation || ticket?.auto_upgradation);
    try {
      const upgradeCheckbox = page.locator('input#autoUpgradation, input[name="autoUpgradation"]');
      if (await upgradeCheckbox.isVisible({ timeout: 1000 }).catch(() => false)) {
        const isChecked = await upgradeCheckbox.isChecked().catch(() => false);
        if (shouldUpgrade !== isChecked) {
          console.log(`[IRCTC Automation] Setting autoUpgradation to ${shouldUpgrade}`);
          await upgradeCheckbox.click({ force: true }).catch(() => {});
        }
      }
    } catch {}

    // 3. Confirm Berths Only
    const shouldConfirm = Boolean(ticket?.confirmBerths || ticket?.confirm_berths || ticket?.onlyConfirm);
    try {
      const confirmLabel = page.locator('label[for="confirmberths"], label[for="confirmBerths"]');
      const confirmCheckbox = page.locator('input#confirmberths, input#confirmBerths');
      const hasConfirm = (await confirmCheckbox.isVisible({ timeout: 1000 }).catch(() => false)) ||
                         (await confirmLabel.isVisible({ timeout: 1000 }).catch(() => false));
      if (hasConfirm) {
        const isChecked = await confirmCheckbox.isChecked().catch(() => false);
        if (shouldConfirm !== isChecked) {
          console.log(`[IRCTC Automation] Setting confirmBerths to ${shouldConfirm}`);
          if (await confirmLabel.isVisible({ timeout: 500 }).catch(() => false)) {
            await confirmLabel.click({ force: true }).catch(() => {});
          } else {
            await confirmCheckbox.click({ force: true }).catch(() => {});
          }
        }
      }
    } catch {}

    // 4. Travel Insurance (Opt-in or Opt-out)
    try {
      const travelInsuranceOpt = ticket?.travelInsurance ?? ticket?.travel_insurance;
      const wantYes = travelInsuranceOpt !== false && travelInsuranceOpt !== 'no' && travelInsuranceOpt !== 0 && travelInsuranceOpt !== '0';
      const labelText = wantYes ? 'Yes, and I accept' : 'No, I do not want travel insurance';

      const insSelected = await page.evaluate((wantYes) => {
        const radios = Array.from(document.querySelectorAll('app-passenger-input p-radiobutton, p-radiobutton'));
        for (const r of radios) {
          const inp = r.querySelector('input');
          const text = (r.innerText || r.textContent || r.parentElement?.innerText || '').toLowerCase();
          const isYes = (inp && (inp.value === 'yes' || inp.value === '1' || inp.value === 'true')) ||
                        text.includes('yes, and i accept') || text.includes('i accept');
          const isNo = (inp && (inp.value === 'no' || inp.value === '0' || inp.value === 'false')) ||
                       text.includes('no, i do not want') || text.includes('do not want');

          if ((wantYes && isYes) || (!wantYes && isNo)) {
            const box = r.querySelector('.ui-radiobutton-box') || inp || r;
            box.scrollIntoView({ block: 'nearest' });
            box.click();
            box.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            if (inp) {
              inp.checked = true;
              inp.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return true;
          }
        }
        return false;
      }, wantYes).catch(() => false);

      if (insSelected) {
        console.log(`[IRCTC Automation] Travel insurance set to: ${wantYes ? 'YES' : 'NO'}`);
      } else {
        const fallback = page.locator(`label:has-text("${labelText}"), input[name="travelInsuranceOpted"][value="${wantYes ? 'yes' : 'no'}"]`).first();
        if (await fallback.isVisible({ timeout: 800 }).catch(() => false)) {
          await fallback.click({ force: true }).catch(() => {});
        }
      }
    } catch (insErr) {
      console.warn('[IRCTC Automation] Notice: Travel insurance selection:', insErr.message);
    }

    // 5. Payment Mode Radio on Passenger Page (UPI vs Card/NetBanking - Red Box Optimization)
    try {
      const allPayStrings = [
        ticket?.paymentMethod,
        ticket?.payment_method,
        ticket?.bankName,
        ticket?.priorBank,
        ticket?.paymentBank,
        ticket?.bank,
      ].filter(Boolean).join(' ').toUpperCase();

      const isUpiMode = allPayStrings.includes('UPI') ||
                        allPayStrings.includes('QR') ||
                        allPayStrings.includes('PHONEPE') ||
                        allPayStrings.includes('PAYTM') ||
                        allPayStrings.includes('RAZORPAY') ||
                        allPayStrings.includes('PAYU') ||
                        allPayStrings.includes('BHIM');

      if (isUpiMode) {
        console.log(`[IRCTC Automation] UPI Payment mode detected on passenger page (matched string: "${allPayStrings}"). Selecting UPI radio (value="2")...`);
        const upiRadioClicked = await page.evaluate(() => {
          const radioWrappers = Array.from(document.querySelectorAll('app-passenger-input p-radiobutton, p-radiobutton'));
          let targetRadio = null;
          for (const wrapper of radioWrappers) {
            const inp = wrapper.querySelector('input');
            if (inp && (inp.value === '2' || inp.getAttribute('value') === '2')) {
              targetRadio = wrapper.querySelector('.ui-radiobutton-box') || inp;
              break;
            }
          }
          if (!targetRadio) {
            const labels = Array.from(document.querySelectorAll('label, span, div'));
            const upiLabel = labels.find((l) => /bhim\s*\/\s*upi|pay\s+through\s+bhim/i.test(l.innerText || ''));
            if (upiLabel) {
              const r = upiLabel.closest('p-radiobutton') || upiLabel;
              targetRadio = r.querySelector('.ui-radiobutton-box') || r;
            }
          }
          if (targetRadio) {
            targetRadio.scrollIntoView({ behavior: 'instant', block: 'center' });
            targetRadio.click();
            targetRadio.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            const inp = targetRadio.closest('p-radiobutton')?.querySelector('input');
            if (inp) {
              inp.checked = true;
              inp.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return true;
          }
          return false;
        }).catch(() => false);

        if (upiRadioClicked) {
          console.log('[IRCTC Automation] UPI radio mode selected on passenger page.');
        }
      } else {
        console.log('[IRCTC Automation] Card/NetBanking payment mode detected on passenger page (Default radio "1").');
      }
    } catch (payRadioErr) {
      console.warn('[IRCTC Automation] Notice: Payment radio selection on passenger page:', payRadioErr.message);
    }

    // 6. IRCTC Co-branded Card Benefits / Loyalty Section -> ALWAYS SELECT "Skip"
    await this._handleLoyaltyCoBrandedSection(page);
  }

  async _continueExistingPassengerPage(page, ticket, ticketId, selectedAvailability = 'AVAILABLE', options = {}) {
    const currentUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
    const passengerPageReady = await this._isPassengerInputPage(page);
    if (!passengerPageReady) {
      throw new Error(`Existing IRCTC page is not a verified passenger-details page. Current URL: ${currentUrl}`);
    }

    console.log(`[IRCTC Automation] Reusing authenticated passenger page for ticket ${ticketId}.`);
    logStage(ticketId, 'PASSENGER_PAGE_READY', { url: currentUrl, reusedSession: true });
    this.setBookingStatus(ticketId, 'Passenger Details Ready', {
      authResult: null,
      availability: selectedAvailability,
      passengerPageReady: true,
      currentUrl,
      reusedSession: true,
    });

    await this._fillPassengerDetails(page, ticket?.passengers);
    await this._fillPassengerPreferences(page, ticket);

    await this._continueFromPassengerToPayment(page, ticket, ticketId, {
      stopPayment: Boolean(options.stopPayment),
      account: options.account,
      userId: options.userId,
      availability: selectedAvailability,
    });
  }

  async _dismissPassengerAdvisoryDialogs(page) {
    if (!page || typeof page.evaluate !== 'function') return false;
    return page.evaluate(() => {
      let dismissed = false;
      const dialogs = Array.from(document.querySelectorAll('div.ui-dialog[role="dialog"], div.p-dialog[role="dialog"], .ui-dialog, .p-dialog, p-confirmdialog'));
      for (const dialog of dialogs) {
        if (dialog.querySelector('app-login, input[formcontrolname="userid"]')) continue;
        const text = (dialog.innerText || '').toLowerCase();
        if (text.includes('preferred language') || text.includes('user id') || text.includes('password') || text.includes('sign in')) continue;

        const buttons = Array.from(dialog.querySelectorAll('button, .ui-button, .p-button, a.ui-dialog-titlebar-close, .p-dialog-header-close'));
        const confirmBtn = buttons.find((b) => {
          const bText = (b.innerText || b.textContent || b.getAttribute('value') || '').trim().toLowerCase();
          return /^(yes|ok|okay|agree|continue|proceed|close|accept)$/i.test(bText) ||
                 bText.startsWith('ok') ||
                 b.classList.contains('p-confirm-dialog-accept') ||
                 b.classList.contains('ui-confirmdialog-yes');
        });
        if (confirmBtn) {
          confirmBtn.click();
          dismissed = true;
        } else if (buttons.length > 0) {
          const actionBtn = buttons.find((b) => !b.disabled && b.offsetParent !== null) || buttons[0];
          actionBtn.click();
          dismissed = true;
        }
      }
      return dismissed;
    }).catch(() => false);
  }

  async _findPassengerContinueButton(page) {
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    }).catch(() => {});
    await sleep(350);

    const candidateSelectors = [
      "app-passenger-input button.train_Search.btnDefault[type='submit']",
      "app-passenger-input button.train_Search.btnDefault",
      "app-passenger-input button.mob-bot-btn.search_btn[type='submit']",
      "app-passenger-input button.mob-bot-btn.search_btn",
      "app-passenger-input button.btnDefault",
      "button.train_Search.btnDefault[type='submit']",
      "button.train_Search.btnDefault",
      "app-passenger-input button:has-text('Continue')",
      "button:has-text('Continue')"
    ];

    for (const selector of candidateSelectors) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const candidate = locator.nth(i);
        const state = await candidate.evaluate((el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const isVis = (rect.width > 2 && rect.height > 2 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0');
          const isDisabled = Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true';
          const text = (el.innerText || el.textContent || '').trim().toUpperCase();
          const isContinue = text.includes('CONTINUE') || (el.getAttribute('value') || '').toUpperCase().includes('CONTINUE') || el.getAttribute('type') === 'submit';
          return { isVis, isDisabled, isContinue };
        }).catch(() => ({ isVis: false, isDisabled: true, isContinue: false }));

        if (state.isVis && !state.isDisabled && state.isContinue) {
          return candidate;
        }
      }
    }

    const fallbackButtons = page.locator('button:has-text("Continue"), input[type="submit"][value*="Continue" i]');
    const fallbackCount = await fallbackButtons.count().catch(() => 0);
    for (let i = 0; i < fallbackCount; i += 1) {
      const candidate = fallbackButtons.nth(i);
      const isVisible = await candidate.isVisible().catch(() => false);
      const isDisabled = await candidate.isDisabled().catch(() => true);
      if (isVisible && !isDisabled) {
        return candidate;
      }
    }

    return null;
  }

  async _continuePassengerStage(page, { preferLast = false } = {}) {
    if (await this._isLoginCardVisible(page)) {
      const currentUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
      throw new Error(`LOGIN_CARD_DETECTED_ON_PASSENGER_PAGE: url=${currentUrl}`);
    }

    await this._dismissPassengerAdvisoryDialogs(page);

    const deadline = Date.now() + 20000;
    let continueButton = null;
    while (Date.now() < deadline) {
      if (await this._isLoginCardVisible(page)) {
        const currentUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
        throw new Error(`LOGIN_CARD_DETECTED_ON_PASSENGER_PAGE: url=${currentUrl}`);
      }
      continueButton = await this._findPassengerContinueButton(page);
      if (continueButton) break;
      await sleep(350);
    }

    if (!continueButton) {
      throw new Error('CONTINUE_BUTTON_DISABLED');
    }

    if (await this._isLoginCardVisible(page)) {
      const currentUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
      throw new Error(`LOGIN_CARD_DETECTED_ON_PASSENGER_PAGE: url=${currentUrl}`);
    }

    await continueButton.scrollIntoViewIfNeeded().catch(() => {});
    await continueButton.click({ timeout: 5000 }).catch(async () => {
      await continueButton.click({ force: true }).catch(() => {});
    });
    console.log('[IRCTC Automation][PASSENGER_STAGE_CONTINUE_CLICKED]');

    const reviewUrlPattern = /\/nget\/booking\/reviewBooking/i;
    const paymentUrlPattern = /\/nget\/payment\/|\/payment\/bkgPaymentOptions/i;
    const passengerStageStart = Date.now();
    const passengerStageDeadline = passengerStageStart + 120000; // 120s total
    let urlMoved = false;
    let waitCycles = 0;

    while (Date.now() < passengerStageDeadline && !urlMoved) {
      const currentUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
      if (reviewUrlPattern.test(currentUrl) || paymentUrlPattern.test(currentUrl)) {
        const stageName = reviewUrlPattern.test(currentUrl)
          ? 'PASSENGER_STAGE_URL_MOVED_TO_REVIEW'
          : 'PASSENGER_STAGE_URL_MOVED_TO_PAYMENT';
        console.log(`[IRCTC Automation][${stageName}]`, JSON.stringify({ currentUrl }));
        urlMoved = true;
        break;
      }
      if (await this._isLoginCardVisible(page)) {
        throw new Error(`LOGIN_CARD_DETECTED_ON_PASSENGER_PAGE: url=${currentUrl}`);
      }

      const hasReviewHeading = await page.locator(
        'text=/Review\\s+Journey/i, text=/Review\\s+Your\\s+Journey/i, ' +
        'text=/Passenger\\s+Details\\s+Summary/i, text=/Booking\\s+Summary/i'
      ).first().isVisible({ timeout: 200 }).catch(() => false);
      if (hasReviewHeading) {
        console.log('[IRCTC Automation][PASSENGER_STAGE_REVIEW_HEADING_DETECTED]', JSON.stringify({
          url: currentUrl,
        }));
        urlMoved = true;
        break;
      }

      await sleep(100);
      waitCycles += 1;

      // Check for and dismiss any advisory dialogs (e.g. waitlist confirmation, concession alert)
      const dialogDismissed = await this._dismissPassengerAdvisoryDialogs(page);
      if (dialogDismissed) {
        console.log('[IRCTC Automation] Dismissed passenger advisory dialog. Re-clicking Continue...');
        await sleep(100);
        const retryBtn = await this._findPassengerContinueButton(page);
        if (retryBtn) {
          await retryBtn.scrollIntoViewIfNeeded().catch(() => {});
          await retryBtn.click({ force: true }).catch(() => {});
        }
      }

      // Check for transient error toast / high load (Red Box error catcher)
      if (waitCycles % 4 === 0) {
        const toastInfo = await page.evaluate(() => {
          const toast = document.querySelector('.ui-toast-detail, .ui-toast-message-text-content, .p-toast-message-content');
          if (!toast) return null;
          const text = (toast.innerText || '').toLowerCase();
          const isRetryable = text.includes('high load') ||
                              text.includes('please retry') ||
                              text.includes('unable to process request') ||
                              text.includes('unable to perform this transaction') ||
                              text.includes('please try again') ||
                              text.includes('client ip') ||
                              text.includes('accrual booking') ||
                              text.includes('loyalty bank') ||
                              text.includes('skip option') ||
                              text.includes('loyality passenger');
          const closeBtn = document.querySelector('.ui-toast-close-icon, .p-toast-icon-close');
          if (closeBtn) closeBtn.click();
          return { text, isRetryable };
        }).catch(() => null);

        if (toastInfo?.isRetryable) {
          console.warn(`[IRCTC Automation] Transient passenger submit error toast: "${toastInfo.text}". Re-locating and re-clicking Continue...`);
          if (toastInfo.text.includes('accrual') || toastInfo.text.includes('loyalty') || toastInfo.text.includes('skip option') || toastInfo.text.includes('loyality')) {
            console.log('[IRCTC Automation] Accrual/Loyalty toast detected! Enforcing Skip option selection...');
            await this._handleLoyaltyCoBrandedSection(page);
            await sleep(400);
          }
          await sleep(800);
          const retryBtn = await this._findPassengerContinueButton(page);
          if (retryBtn) {
            await retryBtn.scrollIntoViewIfNeeded().catch(() => {});
            await retryBtn.focus().catch(() => {});
            await sleep(200);
            await retryBtn.click({ force: true }).catch(() => {});
          }
        }
      }

      if (waitCycles > 0 && waitCycles % 12 === 0) {
        console.log('[IRCTC Automation] Re-dispatching Continue click & Enter key on passenger stage...');
        const retryBtn = await this._findPassengerContinueButton(page);
        if (retryBtn) {
          await retryBtn.scrollIntoViewIfNeeded().catch(() => {});
          await retryBtn.click({ force: true }).catch(() => {});
          try {
            await retryBtn.focus().catch(() => {});
            await page.keyboard.press('Enter');
          } catch {}
        }
      }

      if (waitCycles % 20 === 0) {
        console.log('[IRCTC Automation][PASSENGER_STAGE_WAITING]', JSON.stringify({
          url: currentUrl,
          waitCycles,
          elapsedMs: Date.now() - passengerStageStart,
        }));
      }
    }

    if (!urlMoved) {
      const currentUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
      throw new Error(`PASSENGER_STAGE_URL_NOT_MOVED: url=${currentUrl}`);
    }
    return true;
  }

  async _waitForReviewJourney(page) {
    const reviewUrlPattern = /\/nget\/booking\/reviewBooking/i;
    const paymentUrlPattern = /\/nget\/payment\/|\/payment\/bkgPaymentOptions/i;
    const deadline = Date.now() + IRCTC_STATE_WAIT_TIMEOUT_MS;
    let reviewConfirmed = false;

    while (Date.now() < deadline) {
      const currentUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
      if (reviewUrlPattern.test(currentUrl)) { reviewConfirmed = true; break; }
      if (paymentUrlPattern.test(currentUrl)) return true;
      if (await this._isLoginCardVisible(page)) {
        throw new Error(`LOGIN_CARD_DETECTED_BEFORE_REVIEW: url=${currentUrl}`);
      }
      await sleep(IRCTC_STATE_POLL_INTERVAL_MS);
    }

    if (!reviewConfirmed) {
      const currentUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
      throw new Error(`REVIEW_JOURNEY_URL_NOT_REACHED: url=${currentUrl}`);
    }

    // URL confirms reviewBooking. Soft-check for the component root instead of responsive heading text.
    const reviewRoot = page.locator('app-review-booking').first();
    const rootDeadline = Date.now() + 15000;
    let reviewEvidenceFound = false;
    while (Date.now() < rootDeadline) {
      if (await reviewRoot.count().catch(() => 0) > 0) {
        reviewEvidenceFound = true;
        break;
      }
      await sleep(IRCTC_STATE_POLL_INTERVAL_MS);
    }
    if (!reviewEvidenceFound) {
      console.warn('[IRCTC Automation][REVIEW_JOURNEY_EVIDENCE_SOFT_MISS]', JSON.stringify({
        url: (page.url && typeof page.url === 'function') ? page.url() : '',
        note: 'app-review-booking component not found, but URL is reviewBooking. Proceeding.',
      }));
    }

    const settledUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
    if (!reviewUrlPattern.test(settledUrl)) {
      if (paymentUrlPattern.test(settledUrl)) return true;
      throw new Error(`REVIEW_JOURNEY_URL_NOT_REACHED: url=${settledUrl}`);
    }

    const continueButtons = page.locator(
      'button:has-text("Continue"), input[type="submit"][value*="Continue" i], ' +
      'input[type="button"][value*="Continue" i], a:has-text("Continue"), ' +
      '[role="button"]:has-text("Continue")'
    );
    await continueButtons.first().waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
    const continueCount = await continueButtons.count().catch(() => 0);
    if (continueCount <= 0) {
      throw new Error('REVIEW_JOURNEY_CONTINUE_NOT_AVAILABLE');
    }
    console.log('[IRCTC Automation][REVIEW_JOURNEY_READY]', JSON.stringify({
      url: (page.url && typeof page.url === 'function') ? page.url() : '',
      continueButtons: continueCount,
      evidenceFound: reviewEvidenceFound,
    }));
    return true;
  }

  async _waitForReviewJourneyTransition(page, previousUrl, previousContinue) {
    const startedAt = Date.now();
    const deadline = startedAt + 120000;
    const paymentUrlPattern = /\/nget\/payment\/|\/payment\/bkgPaymentOptions|\/bkgPaymentOptions/i;
    const reviewUrlPattern = /\/nget\/booking\/reviewBooking/i;

    let errorStrike = 0;
    let lastStateLog = 0;

    while (Date.now() < deadline) {
      if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
        throw new Error('REVIEW_TRANSITION_PAGE_CLOSED');
      }

      const currentUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
      if (paymentUrlPattern.test(currentUrl)) {
        console.log('[IRCTC Automation][REVIEW_TO_PAYMENT_SUCCESS]', JSON.stringify({
          url: currentUrl,
          elapsedMs: Date.now() - startedAt,
        }));
        return true;
      }

      if (await this._isLoginCardVisible(page)) {
        throw new Error(`LOGIN_CARD_DETECTED_DURING_REVIEW_TRANSITION: url=${currentUrl}`);
      }

      const domState = await this._getPostReviewDomState(page);
      if (Date.now() - lastStateLog > 5000) {
        lastStateLog = Date.now();
        console.log('[IRCTC Automation][REVIEW_TRANSITION_WAITING]', JSON.stringify({
          url: currentUrl,
          elapsedMs: Date.now() - startedAt,
          reviewVisible: domState.review,
          paymentSection: domState.paymentSection,
          paymentMethod: domState.paymentMethod,
          loading: domState.loading,
          errorCount: (domState.errors || []).length,
        }));
      }

      const nonBlockingPatterns = [
        /senior citizen concession not allowed.*person with disability/i,
        /request is under process.*multiple request/i,
        /please wait.*processing/i,
        /do not submit multiple/i,
      ];

      const allErrors = Array.isArray(domState.errors) ? domState.errors : [];
      const blockingErrors = allErrors.filter((message) => {
        if (nonBlockingPatterns.some((pattern) => pattern.test(message))) return false;
        return /required|mandatory|invalid|please enter|cannot proceed|error|failed/i.test(message);
      });

      if (blockingErrors.length > 0) {
        errorStrike += 1;
        console.warn('[IRCTC Automation][REVIEW_TRANSITION_BLOCKING_ERROR]', JSON.stringify({
          url: currentUrl,
          strike: errorStrike,
          errors: blockingErrors,
        }));

        if (errorStrike >= 3) {
          throw new Error(`REVIEW_JOURNEY_VALIDATION_FAILED: ${JSON.stringify(blockingErrors)}`);
        }
        await sleep(3000);
        continue;
      }

      errorStrike = 0;

      if (!reviewUrlPattern.test(currentUrl) && currentUrl !== previousUrl) {
        console.log('[IRCTC Automation][REVIEW_TRANSITION_URL_CHANGED]', JSON.stringify({
          url: currentUrl,
        }));
        await sleep(2000);
        return true;
      }

      await sleep(IRCTC_STATE_POLL_INTERVAL_MS);
    }

    const finalUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
    console.error('[IRCTC Automation][REVIEW_TRANSITION_TIMEOUT]', JSON.stringify({
      url: finalUrl,
      elapsedMs: Date.now() - startedAt,
    }));
    throw new Error(`REVIEW_JOURNEY_TRANSITION_FAILED: url=${finalUrl}`);
  }

  async _getPostReviewDomState(page) {
    return page.evaluate(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = (element) => Boolean(
        element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length)
      );
      const visibleElements = (selector) => Array.from(document.querySelectorAll(selector))
        .filter(visible)
        .map((element) => normalize(element.innerText || element.textContent || element.getAttribute('aria-label')))
        .filter(Boolean)
        .slice(0, 20);
      const headings = visibleElements('h1,h2,h3,h4,[role="heading"]');
      const paymentRoots = Array.from(document.querySelectorAll(
        'app-payment, app-payment-gateway, [data-testid*="payment" i], ' +
        '[id^="payment" i], [id*="-payment" i], [class^="payment" i], [class*="-payment" i]'
      )).filter(visible);
      const paymentSections = paymentRoots
        .map((element) => normalize(element.innerText || element.textContent))
        .filter(Boolean)
        .slice(0, 20);
      const bodyText = normalize(document.body?.innerText);
      const review = /review\s+journey|passenger\s+details\s+summary|journey\s+details/i.test(bodyText);
      const errors = visibleElements(
        '[role="alert"], .error, .errors, .invalid-feedback, mat-error, [aria-live="assertive"], ' +
        '[class*="error" i], [class*="invalid" i]'
      ).filter((text) => !/^error$/i.test(text)).slice(0, 20);
      const paymentSection = paymentRoots.length > 0 && !review;
      const paymentMethod = paymentRoots.some((root) => Array.from(root.querySelectorAll(
        'select, input[type="radio"], [role="radio"], [role="combobox"], mat-select, button, [role="button"]'
      )).some((element) => visible(element)));
      const buttons = visibleElements('button,input[type="button"],input[type="submit"],[role="button"],a');
      const radios = visibleElements('input[type="radio"],[role="radio"]');
      const selects = visibleElements('select,[role="combobox"],mat-select');
      const overlay = Array.from(document.querySelectorAll(
        '[role="dialog"], .modal, .modal-backdrop, .cdk-overlay-pane, .loading, [class*="spinner" i]'
      )).some(visible);
      const loading = Array.from(document.querySelectorAll(
        '[aria-busy="true"], [role="progressbar"], mat-spinner, .spinner, .loading-indicator, .loader'
      )).some(visible);
      // Check payment readiness from the route; review pages can contain payment-related text.
      const currentUrl = window.location.href;
      const isPaymentUrl = /\/nget\/payment\/|\/payment\/bkgPaymentOptions/i.test(currentUrl);
      const isReviewUrl = /\/nget\/booking\/reviewBooking/i.test(currentUrl);
      const paymentPageReady = isPaymentUrl && !isReviewUrl;

      return {
        title: normalize(document.title),
        headings,
        paymentSections,
        buttons,
        radios,
        selects,
        review,
        paymentSection,
        paymentMethod,
        paymentControls: paymentMethod || buttons.some((text) => /pay|bank|upi|gateway|qr/i.test(text)),
        paymentPageReady,
        overlay,
        loading,
        errors,
      };
        }).catch(() => ({
      title: '',
      headings: [],
      paymentSections: [],
      buttons: [],
      radios: [],
      selects: [],
      review: false,
      paymentSection: false,
      paymentMethod: false,
      paymentControls: false,
      paymentPageReady: false,
      overlay: false,
      loading: true,
      errors: [],
    }));
  }

  async _waitForPaymentStage(page) {
    const startedAt = Date.now();
    const deadline = startedAt + 120000;
    const paymentUrlPattern = /\/nget\/payment\/|\/payment\/bkgPaymentOptions|\/bkgPaymentOptions/i;
    const reviewUrlPattern = /\/nget\/booking\/reviewBooking/i;
    let lastLog = 0;

    while (Date.now() < deadline) {
      if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
        throw new Error('PAYMENT_STAGE_PAGE_CLOSED');
      }

      const currentUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
      if (paymentUrlPattern.test(currentUrl)) {
        console.log('[IRCTC Automation][PAYMENT_PAGE_URL_DETECTED]', JSON.stringify({
          url: currentUrl,
          elapsedMs: Date.now() - startedAt,
        }));
        return true;
      }

      if (await this._isLoginCardVisible(page)) {
        throw new Error(`LOGIN_CARD_DETECTED_DURING_PAYMENT_WAIT: url=${currentUrl}`);
      }

      const onReviewPage = reviewUrlPattern.test(currentUrl);
      const interactionReady = await this._hasPaymentInteractionEvidence(page);
      if (!onReviewPage && interactionReady) {
        console.log('[IRCTC Automation][PAYMENT_INTERACTION_READY]', JSON.stringify({
          url: currentUrl,
          elapsedMs: Date.now() - startedAt,
        }));
        return true;
      }

      if (Date.now() - lastLog > 5000) {
        lastLog = Date.now();
        console.log('[IRCTC Automation][PAYMENT_WAITING]', JSON.stringify({
          url: currentUrl,
          elapsedMs: Date.now() - startedAt,
          onReviewPage,
          interactionReady,
        }));
      }

      await sleep(IRCTC_STATE_POLL_INTERVAL_MS);
    }

    const currentUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
    console.error('[IRCTC Automation] Payment stage timeout', {
      timeoutCode: 'PAYMENT_STAGE_TIMEOUT',
      elapsedMs: Date.now() - startedAt,
      currentUrl,
      hint: 'Stuck on review page - Continue button click did not navigate to payment.',
    });
    throw new Error(`PAYMENT_STAGE_TIMEOUT: url=${currentUrl}`);
  }

  async _hasPaymentInteractionEvidence(page) {
    const domState = await this._getPostReviewDomState(page);
    return domState.paymentSection && (domState.paymentMethod || domState.paymentControls);
  }

  async _waitForVisibleStateEvidence(page, locators, timeoutCode) {
    const startedAt = Date.now();
    const deadline = startedAt + IRCTC_STATE_WAIT_TIMEOUT_MS;

    while (Date.now() < deadline) {
      for (const locator of locators) {
        if (await locator.isVisible({ timeout: 1000 }).catch(() => false)) {
          return true;
        }
      }
      await sleep(IRCTC_STATE_POLL_INTERVAL_MS);
    }

    const currentUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
    const elapsedMs = Date.now() - startedAt;
    const visibleText = await page.locator('body').innerText({ timeout: 1000 })
      .then((text) => String(text).replace(/\s+/g, ' ').trim().slice(0, 500))
      .catch(() => '');
    console.error('[IRCTC Automation] State transition timeout', {
      timeoutCode,
      elapsedMs,
      currentUrl,
      visibleText,
    });
    throw new Error(timeoutCode);
  }

  async _handleReviewJourneyDialog(page, ticketId) {
    const dialogs = page.locator(
      '[role="dialog"], .ui-dialog-visible, .modal.show, .swal2-popup, .p-dialog'
    );
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const count = await dialogs.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const dialog = dialogs.nth(index);
        const metadata = await dialog.evaluate((element) => ({
          visible: Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length),
          text: String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 600),
        })).catch(() => null);
        if (!metadata?.visible || !metadata.text ||
          !/senior\s+citizen|concession|warning|cannot\s+proceed|invalid|error|confirm|proceed/i.test(metadata.text)) {
          continue;
        }

        console.log('[REVIEW_DIALOG_DETECTED]', JSON.stringify({ ticketId, message: metadata.text }));
        const buttons = dialog.locator('button, input[type="button"], input[type="submit"], [role="button"]');
        const buttonCount = await buttons.count().catch(() => 0);
        let okButton = null;
        for (let buttonIndex = 0; buttonIndex < buttonCount; buttonIndex += 1) {
          const button = buttons.nth(buttonIndex);
          const buttonText = (
            String(await button.innerText().catch(() => '')).replace(/\s+/g, ' ').trim() ||
            String(await button.getAttribute('value').catch(() => '')).replace(/\s+/g, ' ').trim()
          );
          if (/^ok$/i.test(buttonText) && await button.isVisible().catch(() => false)) {
            okButton = button;
            break;
          }
        }
        if (!okButton) throw new Error(`REVIEW_DIALOG_OK_NOT_FOUND: ticketId=${ticketId}`);
        console.log('[REVIEW_DIALOG_OK_FOUND]', JSON.stringify({ ticketId }));
        await okButton.click();
        console.log('[REVIEW_DIALOG_OK_CLICKED]', JSON.stringify({ ticketId }));
        await sleep(100);
        if (await dialog.isVisible().catch(() => false)) {
          throw new Error(`REVIEW_DIALOG_NOT_DISMISSED: ticketId=${ticketId}`);
        }
        console.log('[REVIEW_DIALOG_DISMISSED]', JSON.stringify({ ticketId }));
        return true;
      }
      await sleep(100);
    }
    console.log('[REVIEW_DIALOG_NOT_PRESENT]', JSON.stringify({ ticketId }));
    return false;
  }

  async _continueFromPassengerToPayment(page, ticket, ticketId, { stopPayment = false, account = null, userId = null, availability = 'AVAILABLE', passengerPageEnteredAt = null } = {}) {
    logStage(ticketId, 'PASSENGER_DETAILS_READY');
    this.setBookingStatus(ticketId, 'Passenger Details Ready', {
      authResult: null,
      availability,
      passengerPageReady: true,
    });

    // RED BOX QUOTA PACING & MIN PSGN INPUT TIME
    const rawQuota = String(ticket?.quota || 'General').trim().toUpperCase();
    const isLadies = rawQuota === 'LD' || rawQuota === 'LADIES';
    const isTatkal = rawQuota === 'TQ' || rawQuota === 'TATKAL' || rawQuota === 'PT' || rawQuota === 'PREMIUM TATKAL' || rawQuota === 'PREMIUM_TATKAL';

    // Only pace minPsgnInputTime if Tatkal quota AND within opening 45 seconds (10:00:00-10:00:45 or 11:00:00-11:00:45 IST)
    let targetWaitMs = 0;
    if (isTatkal && !isLadies) {
      const nowUtc = Date.now();
      const istDate = new Date(nowUtc + 5.5 * 3600 * 1000);
      const istHours = istDate.getUTCHours();
      const istMinutes = istDate.getUTCMinutes();
      const istSeconds = istDate.getUTCSeconds();
      const isOpeningWindow = (istHours === 10 || istHours === 11) && istMinutes === 0 && istSeconds < 45;
      if (isOpeningWindow) {
        targetWaitMs = 45000;
      }
    }

    if (targetWaitMs > 0) {
      const startTime = passengerPageEnteredAt || Date.now();
      const elapsed = Date.now() - startTime;
      const remainingMs = Math.max(0, targetWaitMs - elapsed);

      if (remainingMs > 0) {
        console.log(`[IRCTC Automation] Pacing passenger submit: minPsgnInputTime wait ${remainingMs}ms (quota=${rawQuota})`);
        const countdownEnd = Date.now() + remainingMs;
        let lastShown = -1;
        while (Date.now() < countdownEnd) {
          if (this._ticketBookingState.get(ticketId)?.status === 'Stopped') return;
          const left = Math.max(0, countdownEnd - Date.now());
          if (left !== lastShown) {
            const ms = String(left).padStart(5, '0');
            const countdownMsg = `Passenger Submit in ${ms}ms`;
            this.setBookingStatus(ticketId, countdownMsg, {
              authResult: null,
              availability,
              passengerPageReady: true,
            });
            lastShown = left;
          }
          await sleep(Math.min(50, Math.max(1, countdownEnd - Date.now())));
        }
        this.setBookingStatus(ticketId, 'Passenger Submit in 00000ms', {
          authResult: null,
          availability,
          passengerPageReady: true,
        });
        await sleep(50);
      }
    }

    await this._continuePassengerStage(page);
    logStage(ticketId, 'PASSENGER_DETAILS_CONTINUE_CLICKED');

    logStage(ticketId, 'REVIEW_JOURNEY_WAITING');
    const reviewStartedAt = Date.now();

    // Short-circuit: if URL already moved to reviewBooking (as detected inside
    // _continuePassengerStage), skip the redundant 90s wait.
    const preReviewUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
    if (/\/nget\/booking\/reviewBooking/i.test(preReviewUrl)) {
      console.log('[IRCTC Automation][REVIEW_JOURNEY_ALREADY_PRESENT]', JSON.stringify({ url: preReviewUrl }));
    } else {
      await this._waitForReviewJourney(page);
    }

    console.log(`[IRCTC Automation] Review Journey detected after ${Date.now() - reviewStartedAt}ms`);
    logStage(ticketId, 'REVIEW_JOURNEY_READY');
    this.setBookingStatus(ticketId, 'Review Journey Ready', {
      authResult: null,
      availability,
      currentUrl: page.url(),
    });

    // IMPORTANT: some IRCTC layouts are single-page — clicking Continue on
    // the passenger page transitions directly to the payment stage without a
    // separate review page. In that case, do NOT try to click another
    // Continue button. Check if we already transitioned to payment.
    const postPassengerUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
    if (/\/nget\/payment\/|\/payment\/bkgPaymentOptions/i.test(postPassengerUrl)) {
      console.log('[IRCTC Automation][REVIEW_JOURNEY_SKIPPED_ALREADY_ON_PAYMENT]', JSON.stringify({
        url: postPassengerUrl,
      }));
      return this._monitorRealPaymentWorkflow(page, ticketId, {
        stopPayment: false,
        targetTicket: ticket,
        account,
        liveAvailabilityString: availability,
        userId,
      });
    }

    if (/\/nget\/booking\/(?:passengerInput|psgninput)/i.test(postPassengerUrl)) {
      throw new Error(`REVIEW_PAGE_NOT_REACHED_DOUBLE_SUBMIT_GUARD: url=${postPassengerUrl}`);
    }

    console.log(`[IRCTC Automation][REVIEW_JOURNEY_CONTINUE_SEARCH] Ticket ${ticketId}`);
    const reviewContinue = await this._findReviewJourneyContinue(page);
    console.log(`[IRCTC Automation][REVIEW_JOURNEY_CONTINUE_FOUND] Ticket ${ticketId}`);
    const continueMetadata = await reviewContinue.evaluate((element) => ({
      tagName: element.tagName,
      id: element.id || '',
      className: String(element.className || ''),
      text: String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim(),
      value: element.getAttribute('value') || '',
      type: element.getAttribute('type') || '',
      disabled: Boolean(element.disabled),
      ariaDisabled: element.getAttribute('aria-disabled') || '',
      visible: Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length),
      rect: (() => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })(),
      parentTag: element.parentElement?.tagName || '',
      parentClass: String(element.parentElement?.className || ''),
    })).catch(() => null);
    console.log('[IRCTC Automation][REVIEW_JOURNEY_CONTINUE_ACTIONABLE]', JSON.stringify(continueMetadata));
    let reviewUrl = page.url();
    const expectedPaymentUrlPattern = /\/nget\/payment\/|\/payment\/bkgPaymentOptions/i;

    if (expectedPaymentUrlPattern.test(reviewUrl)) {
      console.log('[IRCTC Automation][REVIEW_JOURNEY_ALREADY_PAYMENT]', JSON.stringify({ url: reviewUrl }));
      return this._monitorRealPaymentWorkflow(page, ticketId, {
        stopPayment: false,
        targetTicket: ticket,
        account,
        liveAvailabilityString: availability,
        userId,
      });
    }

    if (!/\/nget\/booking\/reviewBooking/i.test(reviewUrl)) {
      const settleDeadline = Date.now() + 5000;
      while (Date.now() < settleDeadline) {
        reviewUrl = page.url();
        if (/\/nget\/booking\/reviewBooking/i.test(reviewUrl)) break;
        if (expectedPaymentUrlPattern.test(reviewUrl)) {
          console.log('[IRCTC Automation][REVIEW_JOURNEY_URL_SETTLED_TO_PAYMENT]', JSON.stringify({ url: reviewUrl }));
          return this._monitorRealPaymentWorkflow(page, ticketId, {
            stopPayment: false,
            targetTicket: ticket,
            account,
            liveAvailabilityString: availability,
            userId,
          });
        }
        await sleep(300);
      }
      if (!/\/nget\/booking\/reviewBooking/i.test(reviewUrl)) {
        throw new Error(`REVIEW_JOURNEY_NOT_ON_CORRECT_PAGE: url=${reviewUrl}`);
      }
    }
    // Wait for IRCTC loader (#loaderP) to settle if visible (Red Box pattern)
    const loaderDeadline = Date.now() + 6000;
    while (Date.now() < loaderDeadline) {
      const isLoaderActive = await page.evaluate(() => {
        const isVis = (el) => Boolean(el && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0) && window.getComputedStyle(el).visibility !== 'hidden');
        const loader = document.querySelector('#loaderP');
        if (loader && window.getComputedStyle(loader).display !== 'none' && isVis(loader)) return true;
        const spinners = document.querySelectorAll('.ngx-spinner, .ui-progress-spinner, div.blockUI, .loading-shade');
        for (const s of spinners) {
          if (isVis(s)) return true;
        }
        return false;
      }).catch(() => false);
      if (!isLoaderActive) break;
      await sleep(100);
    }

    // Check for review captcha if present
    const reviewCaptchaSelector = '#captcha, app-captcha img, img.captcha-img, #captchaImg';
    const hasReviewCaptcha = await page.locator(reviewCaptchaSelector).first().isVisible({ timeout: 800 }).catch(() => false);
    if (hasReviewCaptcha) {
      console.log(`[IRCTC Automation] Captcha detected on Review page for ticket ${ticketId}.`);
      logStage(ticketId, 'SECURITY_CHALLENGE', { type: 'CAPTCHA', stage: 'review' });
      this.setBookingStatus(ticketId, 'Manual Interaction Required: Review CAPTCHA', {
        reviewCaptcha: true,
      });
      const captchaSettleDeadline = Date.now() + 45000;
      while (Date.now() < captchaSettleDeadline) {
        if (expectedPaymentUrlPattern.test(page.url())) break;
        await sleep(500);
      }
    }

    // Resilient multi-attempt Continue dispatch
    const maxReviewAttempts = 4;
    let transitioned = false;

    for (let attempt = 1; attempt <= maxReviewAttempts && !transitioned; attempt++) {
      console.log(`[IRCTC Automation][REVIEW_CONTINUE_ATTEMPT] Ticket ${ticketId} - Attempt ${attempt}/${maxReviewAttempts}`);

      // Handle any pre-click modal dialog (senior citizen concession, tatkal advisory, etc.)
      await this._handleReviewJourneyDialog(page, ticketId).catch(() => {});

      let currentContinue = reviewContinue;
      if (attempt > 1) {
        currentContinue = await this._findReviewJourneyContinue(page).catch(() => null);
        if (!currentContinue) {
          if (expectedPaymentUrlPattern.test(page.url())) {
            transitioned = true;
            break;
          }
        }
      }

      if (currentContinue) {
        await currentContinue.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await sleep(200);

        // Native click first, fallback to force click
        try {
          await currentContinue.click({ timeout: 4000 });
        } catch {
          await currentContinue.click({ force: true, timeout: 4000 }).catch(() => {});
        }

        // Enter key dispatch as per Red Box standard
        try {
          await currentContinue.focus().catch(() => {});
          await page.keyboard.press('Enter');
        } catch {}
      }

      logStage(ticketId, 'REVIEW_JOURNEY_CONTINUE_CLICKED', { attempt });

      // Dismiss dialog that may pop up immediately after clicking Continue
      await sleep(400);
      await this._handleReviewJourneyDialog(page, ticketId).catch(() => {});

      // Dismiss error toast if present (e.g. "High load", "Please retry")
      const toastErr = await page.evaluate(() => {
        const toast = document.querySelector('.ui-toast-detail, .ui-toast-message-text-content, .p-toast-message-content');
        if (!toast) return null;
        const text = (toast.innerText || '').toLowerCase();
        const closeBtn = document.querySelector('.ui-toast-close-icon, .p-toast-icon-close');
        if (closeBtn) closeBtn.click();
        return text;
      }).catch(() => null);

      if (toastErr) {
        console.warn(`[IRCTC Automation][REVIEW_TOAST_ERROR] "${toastErr}". Retrying continue...`);
      }

      // Check URL progression
      const attemptWaitStart = Date.now();
      while (Date.now() - attemptWaitStart < 5000) {
        const currUrl = page.url();
        if (expectedPaymentUrlPattern.test(currUrl)) {
          transitioned = true;
          console.log('[IRCTC Automation][REVIEW_JOURNEY_URL_MOVED_TO_PAYMENT]', JSON.stringify({ currentUrl: currUrl, attempt }));
          break;
        }
        if (await this._isLoginCardVisible(page)) {
          throw new Error(`LOGIN_CARD_DETECTED_DURING_REVIEW_TRANSITION: url=${currUrl}`);
        }
        await sleep(300);
      }
    }

    if (!transitioned) {
      logStage(ticketId, 'PAYMENT_TRANSITION_WAITING');
      await this._waitForReviewJourneyTransition(page, reviewUrl, reviewContinue);
    }
    logStage(ticketId, 'REVIEW_PAYMENT_TRANSITION_VERIFIED');
    logStage(ticketId, 'REVIEW_AND_TRANSFER_TRANSITION_VERIFIED');

    logStage(ticketId, 'PAYMENT_WAITING');
    const paymentStartedAt = Date.now();
    await this._waitForPaymentStage(page);
    console.log('[IRCTC Automation] Payment page detected', JSON.stringify({
      ticketId,
      url: (page.url && typeof page.url === 'function') ? page.url() : '',
      elapsedMs: Date.now() - paymentStartedAt,
    }));
    logStage(ticketId, 'PAYMENT_PAGE_DETECTED');
    logStage(ticketId, 'PAYMENT_PAGE_READY');
    this.setBookingStatus(ticketId, 'Payment page detected', {
      authResult: null,
      availability,
      currentUrl: page.url(),
    });

    const configuredBank = ticket?.bankName
      || ticket?.priorBank
      || ticket?.paymentBank
      || ticket?.bank
      || null;
    const configuredPayment = String(ticket?.paymentMethod || 'Default Payment (Auto)');
    const normalizedPayment = normalizeIrctcPaymentMethodChoice(configuredPayment);

    const bankUpper = String(configuredBank || '').toUpperCase();
    const paymentUpper = String(configuredPayment || '').toUpperCase();
    const combinedPaymentConfig = `${paymentUpper} ${bankUpper}`;
    const isPaytm = /\bPAY\s*TM\b|PAYTM/.test(combinedPaymentConfig);
    const isPhonePe = /PHONE\s*PE|PHONEPE/.test(combinedPaymentConfig);
    const isIpayQr = !isPaytm && !isPhonePe && (
      /IPAY/i.test(configuredPayment) ||
      /IPAY/i.test(bankUpper) ||
      !configuredBank ||
      bankUpper === 'SELECT YOUR BANK' ||
      bankUpper === 'NO ALTERNATE BANK' ||
      configuredPayment === 'Default Payment (Auto)'
    );

    logStage(ticketId, 'PAYMENT_METHOD_DETECTED');
    logStage(ticketId, 'PAYMENT_METHOD_SELECTION_STARTED');
    await this._selectConfiguredPaymentMethod(page, configuredPayment, { configuredBank });
    console.log('[IRCTC Automation] Payment method selected', JSON.stringify({
      ticketId,
      configuredPayment,
      normalizedPayment,
      configuredBank,
      isPaytm,
      isPhonePe,
      isIpayQr,
    }));
    logStage(ticketId, 'PAYMENT_METHOD_SELECTED');
    logStage(ticketId, 'PAYMENT_METHOD_SELECTION_VERIFIED');
    this.setBookingStatus(ticketId, 'Payment method selected', {
      authResult: null,
      availability,
      configuredPaymentMethod: configuredPayment,
      configuredBank,
    });

    const isUpiPayment = isPaytm || isPhonePe || normalizeIrctcPaymentMethodChoice(configuredPayment) === 'UPI';

    if (configuredBank && !isPaytm && !isPhonePe && !isIpayQr) {
      logStage(ticketId, 'PAYMENT_BANK_SELECTION_STARTED', { bank: configuredBank });
      try {
        await this._selectConfiguredBank(page, configuredBank);
        logStage(ticketId, 'PAYMENT_BANK_SELECTION_COMPLETED', { bank: configuredBank });
        await sleep(500);
      } catch (bankErr) {
        console.warn(`[IRCTC Automation] Bank selection failed for ticket ${ticketId}: ${bankErr.message}`);
        logStage(ticketId, 'PAYMENT_BANK_SELECTION_FAILED', { bank: configuredBank, error: bankErr.message });
      }
    } else if (isIpayQr) {
      logStage(ticketId, 'IPAY_SUB_OPTION_SELECTION_STARTED');
      try {
        const subOptionSelected = await this._selectIrctcIpaySubOption(page, configuredPayment, {
          required: true,
          requiredLabel: 'IRCTC iPay New',
        });
        if (subOptionSelected) {
          logStage(ticketId, 'IPAY_SUB_OPTION_SELECTION_COMPLETED');
          this.setBookingStatus(ticketId, 'Payment Sub-Option Selected', {
            authResult: null,
            availability,
            configuredPaymentMethod: configuredPayment,
            ipaySubOptionSelected: true,
          });
        }
      } catch (subErr) {
        console.warn('[IRCTC Automation][IPAY_SUB_OPTION_NOTICE]', subErr.message);
      }
    }

    if (stopPayment) {
      console.log('[IRCTC Automation] Waiting for user confirmation', JSON.stringify({
        ticketId,
        paymentMethod: configuredPayment,
        action: 'Pay & Book',
      }));
      logStage(ticketId, 'WAITING_FOR_USER_CONFIRMATION');
      this.setBookingStatus(ticketId, 'Waiting for user confirmation', {
        authResult: null,
        availability,
        paymentStopped: true,
        selectedPaymentMethod: configuredPayment,
        actionRequired: 'Manual payment confirmation required by user',
        isFinal: true,
      });
      return { stoppedAtPayment: true };
    }

    // RED BOX PAYMENT TRIGGER: iPay inline QR click vs Pay & Book
    let inlineQrClicked = false;

    if (isIpayQr) {
      logStage(ticketId, 'IPAY_INLINE_QR_TRIGGER_WAITING');
      console.log('[IRCTC Automation][IPAY_QR_MODE] Checking for inline "Click to pay" button...');

      const inlineStart = Date.now();
      while (Date.now() - inlineStart < 4000) {
        inlineQrClicked = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll(
            "button.ipay-qr-button, .ipay-qr button[type='button'], .ipay-card button, .payment-card.ipay-card button, button"
          ));
          const inlineBtn = btns.find((b) => {
            const t = (b.textContent || '').replace(/\s+/g, ' ').trim();
            const vis = b.offsetParent !== null && !b.disabled;
            return /click\s*to\s*pay/i.test(t) && vis;
          });
          if (inlineBtn) {
            inlineBtn.click();
            return true;
          }
          const qrWrap = document.querySelector(".ipay-card .ipay-qr, .payment-card.ipay-card .ipay-qr, .ipay-qr");
          if (qrWrap && qrWrap.offsetParent !== null) {
            const wrapBtn = qrWrap.querySelector("button.ipay-qr-button, button");
            if (wrapBtn && wrapBtn.offsetParent !== null && !wrapBtn.disabled) {
              wrapBtn.click();
              return true;
            }
          }
          return false;
        }).catch(() => false);

        if (inlineQrClicked) {
          console.log('[IRCTC Automation][IPAY_INLINE_CLICK_TO_PAY_TRIGGERED]');
          logStage(ticketId, 'IPAY_INLINE_CLICK_TO_PAY_TRIGGERED');
          await sleep(500);
          break;
        }
        await sleep(300);
      }

      if (!inlineQrClicked) {
        console.log('[IRCTC Automation][IPAY_INLINE_NOT_PRESENT] No inline Click to pay button; proceeding with standard Pay & Book');
      }
    }

    if (!inlineQrClicked) {
      // For PayTM-QR, PHONEPE-QR, and external gateways: Click Pay & Book to transition to gateway QR page
      try {
        const payButton = await this._waitForPayAndBookControl(page, {
          ticketId,
          configuredPayment,
        });
        const payState = await payButton.evaluate((element) => ({
          disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
          visible: Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length),
        })).catch(() => ({ disabled: true, visible: false }));

        if (payState.visible && !payState.disabled) {
          logStage(ticketId, 'REDIRECTING_TO_PAYMENT_GATEWAY');
          this.setBookingStatus(ticketId, 'Redirecting to payment gateway...', {
            authResult: null,
            availability,
            configuredPaymentMethod: configuredPayment,
            submitting: true,
          });
          await payButton.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          try {
            await payButton.click({ timeout: 5000 });
          } catch {
            await payButton.evaluate((btn) => btn.click()).catch(() => {});
          }
          logStage(ticketId, 'PAY_AND_BOOK_SUBMITTED');

          // Monitor transition from bkgPaymentOptions to payment gateway
          console.log('[IRCTC Automation] Waiting for transition from bkgPaymentOptions to payment gateway...');
          const navWaitStart = Date.now();
          while (Date.now() - navWaitStart < 12000) {
            const currUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
            if (currUrl && !currUrl.includes('bkgPaymentOptions')) {
              console.log('[IRCTC Automation][GATEWAY_NAVIGATED]', currUrl);
              break;
            }
            // Check for on-screen warning toast blocking submission
            const warningText = await page.evaluate(() => {
              const toast = document.querySelector(
                '.ui-toast-detail, .ui-toast-message-text-content, .p-toast-message-content, .ui-messages-error-summary, .alert-danger, .error-msg'
              );
              return toast ? (toast.innerText || toast.textContent || '').trim() : null;
            }).catch(() => null);

            if (warningText) {
              console.warn(`[IRCTC Automation][PAYMENT_SUBMIT_BLOCKED] Warning: "${warningText}". Re-selecting bank option...`);
              await this._selectConfiguredPaymentMethod(page, configuredPayment, { configuredBank }).catch(() => {});
              await sleep(600);
              const retryBtn = await this._waitForPayAndBookControl(page, { ticketId, configuredPayment }).catch(() => null);
              if (retryBtn) {
                await retryBtn.click({ timeout: 3000 }).catch(() => retryBtn.evaluate(b => b.click()).catch(() => {}));
              }
            }
            await sleep(600);
          }
        }
      } catch (payBtnErr) {
        console.warn('[IRCTC Automation][PAY_AND_BOOK_TRIGGER_NOTICE]', payBtnErr.message);
      }
    }

    // Wait and capture real QR code (supports both inline iPay QR and external gateway QR)
    logStage(ticketId, 'PAYMENT_QR_WAITING');
    const qrResult = await this._waitForRealQrCode(page, {
      ticketId,
      timeoutMs: (isUpiPayment || isIpayQr || isPaytm || isPhonePe) ? IRCTC_PAYMENT_ACTION_TIMEOUT_MS : 15000,
    });

    if (qrResult && qrResult.dataUrl) {
      logStage(ticketId, 'PAYMENT_QR_DETECTED', {
        sourceType: qrResult.sourceType,
        filePath: qrResult.filePath,
      });
      this.setBookingStatus(ticketId, 'QR Code Available — Scan to Pay', {
        authResult: null,
        availability,
        qrCode: qrResult.dataUrl,
        qrFilePath: qrResult.filePath,
        qrSourceType: qrResult.sourceType,
        qrCapturedAt: qrResult.capturedAt,
        paymentStopped: Boolean(stopPayment),
      });
      console.log('[IRCTC Automation][QR_RENDERED_PROMPTLY]', JSON.stringify({
        ticketId,
        filePath: qrResult.filePath,
      }));
    }

    return this._monitorRealPaymentWorkflow(page, ticketId, {
      stopPayment: false,
      targetTicket: ticket,
      account,
      liveAvailabilityString: availability,
      userId,
    });
  }

async _findReviewJourneyContinue(page) {
  const reviewHeadings = [
    page.getByText(/Review\s+Journey/i).first(),
    page.getByText(/Journey\s+Details/i).first(),
    page.getByText(/Passenger\s+Details\s+Summary/i).first(),
    page.getByText(/Review\s+Your\s+Journey/i).first(),
    page.getByText(/Confirm\s+Your\s+Journey/i).first(),
    page.getByText(/Booking\s+Summary/i).first(),
  ];

  const currentUrlForHeading = (page.url && typeof page.url === 'function') ? page.url() : '';
  const onReviewBookingUrl = /\/nget\/booking\/reviewBooking/i.test(currentUrlForHeading);
  let headingFound = false;
  if (!onReviewBookingUrl) {
    const headingDeadline = Date.now() + 3000;
    while (Date.now() < headingDeadline) {
      for (const locator of reviewHeadings) {
        const c = await locator.count().catch(() => 0);
        if (c > 0) {
          const visible = await locator.evaluate((el) => {
            const style = getComputedStyle(el);
            return style.display !== 'none' &&
                   style.visibility !== 'hidden' &&
                   Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
          }).catch(() => false);
          if (visible) {
            headingFound = true;
            break;
          }
        }
      }
      if (headingFound) break;
      await sleep(IRCTC_STATE_POLL_INTERVAL_MS);
    }
  }

  if (!headingFound) {
    console.warn('[REVIEW_JOURNEY_HEADING_NOT_FOUND]', JSON.stringify({
      url: (page.url && typeof page.url === 'function') ? page.url() : '',
      note: 'No review heading detected; falling back to page-wide Continue button search.',
    }));
  }

  const allContinueButtons = page.locator(
    'button:has-text("Continue"), ' +
    'input[type="submit"][value*="Continue" i], ' +
    'input[type="button"][value*="Continue" i], ' +
    'a:has-text("Continue"), [role="button"]:has-text("Continue")'
  );

  const continueDeadline = Date.now() + 20000;
  const candidates = [];
  while (Date.now() < continueDeadline) {
    const count = await allContinueButtons.count().catch(() => 0);
    candidates.length = 0;
    for (let index = 0; index < count; index += 1) {
      const candidate = allContinueButtons.nth(index);
      const metadata = await candidate.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const text = String(element.innerText || element.textContent || element.getAttribute('value') || '')
          .replace(/\s+/g, ' ')
          .trim();
        const label = `${text} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('value') || ''}`.trim();
        const visible = style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(rect.width) > 0 &&
          Number(rect.height) > 0;
        const disabled = Boolean(element.disabled) ||
          element.getAttribute('aria-disabled') === 'true' ||
          element.hasAttribute('disabled');
        const isContinueLike = /continue/i.test(label);
        return {
          visible,
          disabled,
          text,
          label,
          className: String(element.className || ''),
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          area: rect.width * rect.height,
          isContinueLike,
        };
      }).catch(() => null);
      if (!metadata || !metadata.visible || metadata.disabled || !metadata.isContinueLike) {
        continue;
      }
      const textScore = /^continue$/i.test(metadata.text) ? 1000 : /continue/i.test(metadata.text) ? 500 : 0;
      const positionScore = Math.round(metadata.top);
      const areaScore = Math.round(metadata.area);
      const score = textScore + positionScore + areaScore;
      candidates.push({ candidate, score, metadata });
    }
    if (candidates.length > 0) {
      candidates.sort((left, right) => right.score - left.score);
      // Prefer the desktop Continue over the mobile sidebar Continue.
      const desktopPreferred = candidates.find((c) =>
        /train_Search|btnDefault/i.test(c.metadata.className || '')
      );
      const chosen = (desktopPreferred || candidates[0]).candidate;
      const stillValid = await chosen.evaluate((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' &&
               style.visibility !== 'hidden' &&
               Number(rect.width) > 0 &&
               Number(rect.height) > 0 &&
               !element.disabled &&
               element.getAttribute('aria-disabled') !== 'true';
      }).catch(() => false);
      if (stillValid) {
        console.log('[IRCTC Automation][REVIEW_JOURNEY_CONTINUE_CANDIDATES]', JSON.stringify({
          url: (page.url && typeof page.url === 'function') ? page.url() : '',
          candidates: candidates.map((entry) => ({
            text: entry.metadata.text,
            score: entry.score,
            top: entry.metadata.top,
            area: entry.metadata.area,
          })),
        }));
        const chosenEntry = desktopPreferred || candidates[0];
        console.log('[REVIEW_JOURNEY_CONTINUE_RESOLVED]', JSON.stringify({
          totalContinueButtons: count,
          chosenScore: chosenEntry.score,
          chosenText: chosenEntry.metadata.text,
          chosenClassName: chosenEntry.metadata.className || '',
          isDesktop: Boolean(desktopPreferred),
          url: (page.url && typeof page.url === 'function') ? page.url() : '',
        }));
        return chosen;
      }
    }
    await sleep(IRCTC_STATE_POLL_INTERVAL_MS);
  }

  throw new Error('REVIEW_JOURNEY_CONTINUE_NOT_AVAILABLE');
}

  async _waitForPayAndBookControl(page, { ticketId = null, configuredPayment = 'unknown' } = {}) {
    const startedAt = Date.now();
    const deadline = startedAt + IRCTC_PAYMENT_ACTION_TIMEOUT_MS;
    let lastDiagnostics = [];
    let lastDiagnosticLogAt = 0;

    while (Date.now() < deadline) {
      lastDiagnostics = [];
      const frames = typeof page.frames === 'function' ? page.frames() : [page];
      const candidates = [];

      // Check for page-wide blocking validation errors before selecting button
      const blockingError = await page.evaluate(() => {
        const errorEls = Array.from(document.querySelectorAll(
          '.mat-error, .invalid-feedback, .ui-messages-error, .alert-danger, .has-error'
        )).filter((el) => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && (el.offsetWidth > 0 || el.offsetHeight > 0);
        });
        return errorEls.length > 0 ? (errorEls[0].innerText || errorEls[0].textContent || '').trim() : null;
      }).catch(() => null);

      if (blockingError) {
        console.warn('[IRCTC Automation][PAYMENT_PAGE_BLOCKING_ERROR_DETECTED]', JSON.stringify({
          error: blockingError,
          ticketId,
        }));
      }

      for (const frame of frames) {
        const controls = frame.locator(
          'button, input[type="button"], input[type="submit"], [role="button"], a'
        );
        const controlCount = await controls.count().catch(() => 0);

        for (let index = 0; index < controlCount; index += 1) {
          const control = controls.nth(index);
          const metadata = await control.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            const visible = Boolean(
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              (element.offsetWidth || element.offsetHeight || element.getClientRects().length) &&
              rect.width > 0 &&
              rect.height > 0
            );
            const text = String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
            const parent = element.parentElement;
            const parentText = String(parent?.innerText || '').replace(/\s+/g, ' ').trim();
            const parentClasses = String(parent?.className || '');
            const grandParentClasses = String(parent?.parentElement?.className || '');
            const allClasses = `${element.className || ''} ${parentClasses} ${grandParentClasses}`;
            const disabled = Boolean(element.disabled) ||
              element.getAttribute('aria-disabled') === 'true' ||
              element.hasAttribute('disabled');

            return {
              tag: element.tagName,
              text: text.slice(0, 160),
              ariaLabel: String(element.getAttribute('aria-label') || '').slice(0, 160),
              title: String(element.getAttribute('title') || '').slice(0, 160),
              value: String(element.getAttribute('value') || '').slice(0, 160),
              id: String(element.id || '').slice(0, 120),
              className: String(element.className || '').slice(0, 160),
              allClasses,
              parentText: parentText.slice(0, 240),
              disabled,
              visible,
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: rect.height,
              area: rect.width * rect.height,
              isMobileOnly: /\b(visible-xs|mobile-only|d-block\s+d-md-none)\b/i.test(allClasses),
              isDesktop: /\b(hidden-xs|train_Search|btnDefault|d-none\s+d-md-block)\b/i.test(allClasses),
            };
          }).catch(() => null);

          if (!metadata) continue;
          if (metadata.visible) lastDiagnostics.push(metadata);
          const label = `${metadata.text} ${metadata.ariaLabel} ${metadata.title} ${metadata.value}`.toLowerCase();
          if (metadata.visible && !metadata.disabled && /\bpay\b/.test(label) && /\bbook\b/.test(label)) {
            let score = 1000;
            if (metadata.isDesktop) score += 2000;
            if (metadata.isMobileOnly) score -= 1500;
            if (/train_Search/i.test(metadata.className)) score += 1000;
            if (/btnDefault/i.test(metadata.className)) score += 500;
            if (metadata.width >= 80 && metadata.height >= 30) score += 300;
            candidates.push({ control, score, metadata });
          }
        }
      }

      if (candidates.length > 0) {
        candidates.sort((a, b) => b.score - a.score);
        const bestCandidate = candidates[0].control;
        console.log('[IRCTC Automation][PAY_AND_BOOK_CONTROL_RESOLVED]', JSON.stringify({
          ticketId,
          chosenScore: candidates[0].score,
          chosenText: candidates[0].metadata.text,
          chosenClass: candidates[0].metadata.className,
          isDesktop: candidates[0].metadata.isDesktop,
          totalCandidates: candidates.length,
        }));
        return bestCandidate;
      }

      if (Date.now() - lastDiagnosticLogAt >= 15000) {
        lastDiagnosticLogAt = Date.now();
        console.log(
          `[IRCTC Automation][PAYMENT_ACTION_WAITING] ticketId=${ticketId ?? 'unknown'} ` +
          `elapsedMs=${lastDiagnosticLogAt - startedAt}`
        );
      }
      await sleep(IRCTC_STATE_POLL_INTERVAL_MS);
    }

    const currentUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
    console.error('[IRCTC Automation] Pay & Book control timeout', {
      timeoutCode: 'PAYMENT_ACTION_CONTROL_TIMEOUT',
      ticketId,
      configuredPayment,
      elapsedMs: Date.now() - startedAt,
      currentUrl,
      frameCount: typeof page.frames === 'function' ? page.frames().length : 1,
      visiblePaymentControls: lastDiagnostics,
    });
    throw new Error('PAYMENT_ACTION_CONTROL_TIMEOUT');
  }

  async _selectConfiguredPaymentMethod(page, configuredPayment = null, options = {}) {
    const configuredBank = options.configuredBank || null;
    const bankUpper = String(configuredBank || '').toUpperCase();
    const paymentUpper = String(configuredPayment || '').toUpperCase();
    const upperConfig = `${paymentUpper} ${bankUpper}`;
    const isPaytm = /\bPAY\s*TM\b|PAYTM/.test(upperConfig);
    const isPhonePe = /PHONE\s*PE|PHONEPE/.test(upperConfig);
    const isPayu = /\bPAY\s*U\b|PAYU/.test(upperConfig);
    const isIpay = /IPAY/.test(upperConfig);

    let normalizedPayment = normalizeIrctcPaymentMethodChoice(configuredPayment);
    if (isPaytm || isPhonePe) {
      normalizedPayment = 'UPI';
    } else if (normalizedPayment === 'DEFAULT' || !normalizedPayment || normalizedPayment === 'UPI') {
      normalizedPayment = 'IRCTC_IPAY';
    }

    console.log('[IRCTC Automation][PAYMENT_METHOD_SELECTION_START]', JSON.stringify({
      requested: normalizedPayment,
      raw: configuredPayment,
      bank: configuredBank,
      isPaytm,
      isPhonePe,
      isPayu,
      isIpay,
    }));

    const paymentButtonPatterns = {
      UPI: /IRCTC\s*IPAY|UPI|BHIM/i,
      NET_BANKING: /Net\s*Banking|Internet\s*Banking|NETBANKING/i,
      IRCTC_IPAY: /IRCTC\s*IPAY/i,
      CARD: /Credit\s*\/?\s*Debit\s*Card|Debit\s*\/?\s*Credit\s*Card|Card\s*Payment|Payment\s*Gateway/i,
      IMUDRA: /IMUDRA/i,
    };

    const targetRegex = paymentButtonPatterns[normalizedPayment];
    if (!targetRegex) {
      throw new Error(`PAYMENT_METHOD_NOT_SUPPORTED: ${configuredPayment}`);
    }

    const dropdown = page.locator(
      'select[formcontrolname*="payment" i], select[name*="payment" i], ' +
      'select[formcontrolname*="payType" i], select[id*="payment" i]'
    ).first();

    const dropdownVisible = await dropdown.isVisible({ timeout: 1500 }).catch(() => false);
    if (dropdownVisible) {
      const optionCount = await dropdown.locator('option').count().catch(() => 0);
      for (let index = 0; index < optionCount; index += 1) {
        const option = dropdown.locator('option').nth(index);
        const optionText = await option.innerText().catch(() => '');
        const optionValue = await option.getAttribute('value').catch(() => '');
        const label = `${optionText} ${optionValue}`.trim();
        if (targetRegex.test(label) || targetRegex.test(optionText.trim())) {
          await dropdown.selectOption({ value: optionValue });
          await sleep(500);

          const verified = await dropdown.inputValue().catch(() => '');
          if (verified !== optionValue) {
            throw new Error(`PAYMENT_METHOD_SELECTION_VERIFICATION_FAILED: ${configuredPayment}`);
          }
          console.log('[IRCTC Automation][PAYMENT_METHOD_SELECTION_VERIFIED]', JSON.stringify({
            requested: normalizedPayment,
            method: 'dropdown',
            selectedValue: verified,
          }));
          return true;
        }
      }
      throw new Error(`PAYMENT_METHOD_NOT_FOUND: ${configuredPayment}`);
    }

    // REDBOX PAYMENT MAP (parities with REDBOX inject/content_script.js & content_script_beta.js)
    const REDBOX_PAYMENT_MAP = {
      'PAYTM': { category: 'BHIM/ UPI/ USSD', option: 'Paytm UPI' },
      'PAYTM UPI': { category: 'BHIM/ UPI/ USSD', option: 'Paytm UPI' },
      'PHONEPE': { category: 'Multiple Payment Service', option: 'PhonePe' },
      'RAZORPAY': { category: 'Multiple Payment Service', option: 'Razorpay' },
      'PAYU': { category: 'Multiple Payment Service', option: 'Payu' },
      'AMAZON': { category: 'Wallets / Cash Card', option: 'Amazonpay' },
      'MOBIKWIK': { category: 'Wallets / Cash Card', option: 'Mobikwik Wallet' },
      'HDFC': { category: 'Payment Gateway / Credit Card / Debit Card', option: 'Powered By HDFC BANK' },
      'KOTAK': { category: 'Payment Gateway / Credit Card / Debit Card', option: 'Powered by KOTAK BANK' },
      'ICICI': { category: 'Payment Gateway / Credit Card / Debit Card', option: 'Powered by ICICI BANK' },
      'SBI': { category: 'Netbanking', option: 'State Bank of India' },
      'EWALLET': { category: 'E-Wallet', option: 'IRCTC eWallet' },
      'IRCWA': { category: 'E-Wallet', option: 'IRCTC eWallet' },
      'IPAY': { category: 'IRCTC iPay (Credit Card/Debit Card/UPI)', option: 'IRCTC iPay' },
    };

    // RED BOX FAST-PATH: Category (#pay-type) -> Option (.border-all.no-pad / .bank-cell)
    const searchPlans = [];

    if (isPaytm) {
      // Plan 1: BHIM/ UPI/ USSD -> Paytm UPI (Primary Red Box path when Radio 2 selected on psgn page)
      searchPlans.push({
        categoryPatterns: ['BHIM/ UPI/ USSD', 'BHIM/UPI/USSD', 'BHIM', 'UPI/USSD', 'UPI'],
        optionPatterns: ['Paytm UPI', 'Paytm'],
        forbiddenOptionPatterns: ['Payu', 'PayU', 'Pay U', 'PhonePe', 'IRCTC iPay', 'Razorpay', 'Cashfree'],
      });
      // Plan 2: Multiple Payment Service -> Paytm (Fallback path if Radio 1 was active)
      searchPlans.push({
        categoryPatterns: ['Multiple Payment Service', 'Multiple Payment', 'Multiple'],
        optionPatterns: ['Paytm', 'Paytm UPI', 'Paytm Payment Gateway', 'Paytm PG'],
        forbiddenOptionPatterns: ['Payu', 'PayU', 'Pay U', 'PhonePe', 'IRCTC iPay', 'Razorpay', 'Cashfree'],
      });
      // Plan 3: Wallets / Cash Card -> Paytm (Wallet fallback)
      searchPlans.push({
        categoryPatterns: ['Wallets / Cash Card', 'Wallets', 'Cash Card'],
        optionPatterns: ['Paytm', 'Paytm Wallet'],
        forbiddenOptionPatterns: ['Payu', 'PayU', 'Pay U', 'PhonePe', 'IRCTC iPay', 'Mobikwik', 'Amazonpay'],
      });
    } else if (isPhonePe) {
      // Plan 1: Multiple Payment Service -> PhonePe (Redbox default)
      searchPlans.push({
        categoryPatterns: ['Multiple Payment Service', 'Multiple Payment', 'Multiple'],
        optionPatterns: ['PhonePe', 'Phone Pe'],
        forbiddenOptionPatterns: ['Paytm', 'Payu', 'PayU', 'Pay U', 'IRCTC iPay', 'Razorpay'],
      });
      // Plan 2: BHIM/ UPI/ USSD -> PhonePe
      searchPlans.push({
        categoryPatterns: ['BHIM/ UPI/ USSD', 'BHIM/UPI/USSD', 'BHIM', 'UPI/USSD', 'UPI'],
        optionPatterns: ['PhonePe', 'Phone Pe'],
        forbiddenOptionPatterns: ['Paytm', 'Payu', 'PayU', 'Pay U', 'IRCTC iPay', 'Razorpay'],
      });
      // Plan 3: Wallets / Cash Card -> PhonePe
      searchPlans.push({
        categoryPatterns: ['Wallets / Cash Card', 'Wallets', 'Cash Card'],
        optionPatterns: ['PhonePe', 'Phone Pe Wallet'],
        forbiddenOptionPatterns: ['Paytm', 'Payu', 'PayU', 'Pay U', 'IRCTC iPay', 'Mobikwik'],
      });
    } else if (isIpay) {
      searchPlans.push({
        categoryPatterns: ['IRCTC iPay (Credit Card/Debit Card/UPI)', 'IRCTC iPay', 'iPay'],
        optionPatterns: ['IRCTC iPay', 'IRCTC', 'IRCTC iPay New'],
      });
    } else if (isPayu) {
      searchPlans.push({
        categoryPatterns: ['Multiple Payment Service', 'Multiple Payment'],
        optionPatterns: ['Payu', 'PayU', 'Pay U'],
        forbiddenOptionPatterns: ['Paytm', 'PhonePe', 'IRCTC iPay'],
      });
    } else {
      const match = REDBOX_PAYMENT_MAP[upperConfig] ||
        Object.entries(REDBOX_PAYMENT_MAP).find(([k]) => upperConfig.includes(k))?.[1];
      if (match) {
        searchPlans.push({
          categoryPatterns: [match.category],
          optionPatterns: [match.option],
        });
      }
    }

    for (const plan of searchPlans) {
      try {
        console.log(`[IRCTC Automation] Trying payment category [${plan.categoryPatterns.join(', ')}] for options [${plan.optionPatterns.join(', ')}]...`);

        // Step 1: Click the payment category on the left sidebar
        // Exact selectors matching Red Box content_script.js line 1519:
        // "#pay-type span.bank-type-heading, #pay-type div.bank-type, #pay-type .bank-type, #pay-type li, #pay-type div"
        let catFound = false;
        for (const catPattern of plan.categoryPatterns) {
          const catLocator = page.locator('#pay-type span.bank-type-heading, #pay-type div.bank-type, #pay-type .bank-type, #pay-type li, #pay-type div, .bank-type')
            .filter({ hasText: new RegExp(catPattern.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i') }).first();

          let isCatVis = await catLocator.isVisible({ timeout: 1500 }).catch(() => false);
          if (!isCatVis) {
            // Evaluated DOM fallback like Red Box content_script.js line 1519
            isCatVis = await page.evaluate((pattern) => {
              const elements = Array.from(document.querySelectorAll('#pay-type span.bank-type-heading, #pay-type div.bank-type, #pay-type .bank-type, #pay-type li, #pay-type div'));
              const match = elements.find(el => (el.innerText || '').toUpperCase().includes(pattern.toUpperCase()));
              if (match) {
                match.scrollIntoView({ behavior: 'instant', block: 'center' });
                match.click();
                return true;
              }
              return false;
            }, catPattern).catch(() => false);
          }

          if (isCatVis) {
            console.log(`[IRCTC Automation] Clicking category: "${catPattern}"`);
            await catLocator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
            try {
              await catLocator.click({ timeout: 3000 });
            } catch {
              await catLocator.click({ force: true, timeout: 2000 }).catch(async () => {
                await catLocator.evaluate((el) => el.click()).catch(() => {});
              });
            }
            catFound = true;
            break;
          }
        }

        if (!catFound) {
          console.log(`[IRCTC Automation] Category [${plan.categoryPatterns.join(', ')}] not matched, checking next plan...`);
          continue;
        }

        // Wait for Angular to render the bank options for the clicked category
        await sleep(100);

        // Step 2: Click the payment option card on the right pane
        // Exact selectors matching Red Box content_script.js line 1536: ".border-all.no-pad", "app-bank", ".bank-cell", ".bank-card"
        let optFound = false;
        const optStart = Date.now();
        while (Date.now() - optStart < 6000) {
          for (const optPattern of plan.optionPatterns) {
            const optLocator = page.locator('.border-all.no-pad, .border-all, app-bank, .bank-cell, .bank-card, div[class*="bank"]')
              .filter({
                hasText: new RegExp(`(^|\\b)${optPattern.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}(\\b|$)`, 'i'),
              }).first();

            if (await optLocator.isVisible({ timeout: 1500 }).catch(() => false)) {
              const optionText = await optLocator.evaluate((el) =>
                (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
              ).catch(() => '');
              const forbidden = (plan.forbiddenOptionPatterns || []).some((bad) =>
                new RegExp(`(^|\\b)${bad.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}(\\b|$)`, 'i').test(optionText)
              );
              if (forbidden) {
                console.warn('[IRCTC Automation][PAYMENT_OPTION_FORBIDDEN_MATCH_SKIPPED]', JSON.stringify({
                  requested: optPattern,
                  optionText,
                }));
                continue;
              }

              console.log(`[IRCTC Automation] Found payment option: "${optPattern}"`);
              await optLocator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
              try {
                await optLocator.click({ timeout: 3000 });
              } catch {
                await optLocator.click({ force: true, timeout: 2000 }).catch(async () => {
                  await optLocator.evaluate((el) => el.click()).catch(() => {});
                });
              }

              // Ensure radio button inside card is checked
              const radio = optLocator.locator('input[type="radio"]').first();
              if (await radio.isVisible({ timeout: 300 }).catch(() => false)) {
                await radio.check().catch(() => {});
              }

              optFound = true;
              break;
            }
          }
          if (!optFound) {
            for (const optPattern of plan.optionPatterns) {
              const domClicked = await page.evaluate(({ pattern, forbiddenPatterns }) => {
                const elements = Array.from(document.querySelectorAll('.border-all.no-pad, .border-all, app-bank, .bank-cell, .bank-card, div[class*="bank"]'));
                for (const el of elements) {
                  const text = (el.innerText || el.textContent || '').trim();
                  if (text.toUpperCase().includes(pattern.toUpperCase())) {
                    const isForbidden = (forbiddenPatterns || []).some(bad => text.toUpperCase().includes(bad.toUpperCase()));
                    if (!isForbidden) {
                      el.scrollIntoView({ behavior: 'instant', block: 'center' });
                      el.click();
                      const radio = el.querySelector('input[type="radio"]');
                      if (radio) radio.checked = true;
                      return { success: true, text };
                    }
                  }
                }
                return { success: false };
              }, { pattern: optPattern, forbiddenPatterns: plan.forbiddenOptionPatterns }).catch(() => ({ success: false }));

              if (domClicked?.success) {
                console.log(`[IRCTC Automation] DOM-clicked payment option: "${optPattern}" (${domClicked.text})`);
                optFound = true;
                break;
              }
            }
          }
          if (optFound) break;
          await sleep(100);
        }

        if (optFound) {
          console.log(`[IRCTC Automation][REDBOX_PAYMENT_OPTION_CLICKED] Successfully clicked option: [${plan.optionPatterns.join(', ')}] under [${plan.categoryPatterns.join(', ')}]`);
          await sleep(100);

          // If eWallet, auto click confirm button if present
          if (upperConfig.includes('IRCWA') || upperConfig.includes('EWALLET')) {
            await page.evaluate(() => {
              const confirmBtn = Array.from(document.querySelectorAll('button.mob-bot-btn.search_btn, button[type="button"], button'))
                .find(b => (b.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase().includes('CONFIRM'));
              if (confirmBtn) confirmBtn.click();
            }).catch(() => {});
          }

          return true;
        } else {
          console.log(`[IRCTC Automation] Options [${plan.optionPatterns.join(', ')}] not found under [${plan.categoryPatterns.join(', ')}], checking next plan...`);
        }
      } catch (err) {
        console.warn('[IRCTC Automation][PAYMENT_SELECTION_PLAN_ERROR]', err.message);
      }
    }

    // Critical Red Box rule: if user chose Paytm or PhonePe, NEVER fall back to IRCTC iPay!
    if (isPaytm || isPhonePe) {
      throw new Error(`PAYMENT_OPTION_NOT_FOUND: Could not find ${isPaytm ? 'Paytm' : 'PhonePe'} under IRCTC payment categories`);
    }

    const candidates = page.locator(
      'button, [role="button"], [role="radio"], p-radiobutton, ' +
      'mat-radio-button, .ui-radiobutton, .bank-type, .bank-text, ' +
      '.bank-text .col-pad, div.payment-option, div.payment-method, label'
    );
    const count = await candidates.count().catch(() => 0);
    let paymentOption = null;
    let matchedText = null;

    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      const metadata = await candidate.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const visible = style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0;
        return {
          tagName: element.tagName,
          text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim(),
          ariaLabel: element.getAttribute('aria-label') || '',
          title: element.getAttribute('title') || '',
          value: element.getAttribute('value') || '',
          disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
          visible,
        };
      }).catch(() => null);

      if (!metadata?.visible || metadata.disabled) continue;

      const label = `${metadata.text} ${metadata.ariaLabel} ${metadata.title} ${metadata.value}`.trim();
      if (targetRegex.test(metadata.text.trim()) || targetRegex.test(label)) {
        paymentOption = candidate;
        matchedText = metadata.text;
        break;
      }
    }

    if (!paymentOption) {
      throw new Error(`PAYMENT_METHOD_NOT_FOUND: ${configuredPayment || 'configured payment method'}`);
    }

    console.log('[IRCTC Automation][PAYMENT_METHOD_MATCHED]', JSON.stringify({
      requested: normalizedPayment,
      matchedText,
      tagName: await paymentOption.evaluate((el) => el.tagName).catch(() => ''),
    }));

    await paymentOption.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    try {
      await paymentOption.click({ timeout: 5000 });
    } catch (clickErr) {
      console.warn('[IRCTC Automation][PAYMENT_METHOD_CLICK_RETRY]', JSON.stringify({
        reason: clickErr.message.slice(0, 150),
      }));
      await paymentOption.click({ force: true, timeout: 5000 }).catch(async () => {
        await paymentOption.evaluate((el) => el.click()).catch(() => {});
      });
    }

    await sleep(150);

    const selectionVerified = await page.evaluate((requested) => {
      const visible = (el) => Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const activeSelectors = [
        '[aria-checked="true"]',
        '[aria-selected="true"]',
        '[aria-pressed="true"]',
        '.active',
        '.selected',
        '.ui-state-active',
        '.ui-radiobutton-icon-checked',
        '.bank-type-active',
        'input[type="radio"]:checked',
      ];
      for (const sel of activeSelectors) {
        const elements = Array.from(document.querySelectorAll(sel)).filter(visible);
        for (const el of elements) {
          const text = `${el.innerText || ''} ${el.getAttribute('aria-label') || ''}`.toUpperCase();
          if (text.includes(requested) || (requested === 'IRCTC_IPAY' && /IPAY|WALLET/i.test(text))) return true;
        }
      }
      return false;
    }, normalizedPayment).catch(() => false);

    if (!selectionVerified) {
      console.warn('[IRCTC Automation][PAYMENT_METHOD_VERIFY_SOFT_FAIL]', JSON.stringify({
        requested: normalizedPayment,
        note: 'Click hua lekin active state detect nahi hua. Continuing anyway.',
      }));
    } else {
      console.log('[IRCTC Automation][PAYMENT_METHOD_SELECTION_VERIFIED]', JSON.stringify({
        requested: normalizedPayment,
      }));
    }

    if (normalizedPayment === 'UPI') {
      // Natural browser navigation headers are preserved to ensure payment gateway WAFs (Akamai/Cloudflare)
      // do not reject cross-origin payment redirects with 403 Forbidden.
      try {
        await page.evaluate(() => {
          try {
            const meta = document.querySelector('meta[name="referrer"]');
            if (!meta) {
              const tag = document.createElement('meta');
              tag.name = 'referrer';
              tag.content = 'origin-when-cross-origin';
              document.head.appendChild(tag);
            }
          } catch (_) {}
        }).catch(() => {});
      } catch (refErr) {
        console.warn('[IRCTC Automation][PAYMENT_REFERER_SET_FAILED]', refErr.message);
      }
    }

    return true;
  }

  async _selectConfiguredBank(page, bankName) {
    if (!bankName) return true;
    const normalizedBank = String(bankName).trim().toUpperCase();
    if (normalizedBank === 'DEFAULT' || normalizedBank === 'AUTO') return true;

    console.log('[IRCTC Automation][BANK_SELECTION_START]', JSON.stringify({ bank: normalizedBank }));

    const dropdown = page.locator(
      'select[formcontrolname*="bank" i], select[name*="bank" i], ' +
      'select[formcontrolname*="payType" i], select[id*="bank" i]'
    ).first();

    const dropdownVisible = await dropdown.isVisible({ timeout: 3000 }).catch(() => false);
    if (dropdownVisible) {
      const optionCount = await dropdown.locator('option').count().catch(() => 0);
      for (let i = 0; i < optionCount; i += 1) {
        const option = dropdown.locator('option').nth(i);
        const optionText = await option.innerText().catch(() => '');
        const optionValue = await option.getAttribute('value').catch(() => '');
        const label = `${optionText} ${optionValue}`.toUpperCase();
        if (label.includes(normalizedBank)) {
          await dropdown.selectOption({ value: optionValue });
          await sleep(1500);
          console.log('[IRCTC Automation][BANK_SELECTION_COMPLETED]', JSON.stringify({
            bank: normalizedBank,
            method: 'dropdown',
            matchedOption: optionText.trim(),
          }));
          return true;
        }
      }
      throw new Error(`BANK_NOT_FOUND_IN_DROPDOWN: ${bankName}`);
    }

    // Check Red Box style option card (.border-all.no-pad)
    const directOptionClicked = await page.evaluate((bName) => {
      const optElements = Array.from(document.querySelectorAll('.border-all.no-pad, .border-all, .bank-text, div[class*="bank"]'));
      const opt = optElements.find((el) => {
        const span = el.querySelector('span') || el;
        return span && (span.innerText || '').toUpperCase().includes(bName.toUpperCase());
      });
      if (opt) {
        opt.click();
        return true;
      }
      return false;
    }, normalizedBank).catch(() => false);

    if (directOptionClicked) {
      console.log('[IRCTC Automation][BANK_SELECTION_COMPLETED]', JSON.stringify({
        bank: normalizedBank,
        method: 'redbox-card',
      }));
      await sleep(1500);
      return true;
    }

    const bankButtons = page.locator(
      'button, [role="button"], [role="radio"], p-radiobutton, ' +
      'mat-radio-button, li, .bank-option, .bank-list-item, ' +
      'div[class*="bank" i]'
    );
    const count = await bankButtons.count().catch(() => 0);

    let bankOption = null;
    let matchedLabel = null;

    for (let i = 0; i < count; i += 1) {
      const candidate = bankButtons.nth(i);
      const metadata = await candidate.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return {
          text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
          ariaLabel: el.getAttribute('aria-label') || '',
          value: el.getAttribute('value') || '',
          disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
          visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
        };
      }).catch(() => null);

      if (!metadata?.visible || metadata.disabled) continue;
      const label = `${metadata.text} ${metadata.ariaLabel} ${metadata.value}`.toUpperCase();
      if (label.includes(normalizedBank)) {
        bankOption = candidate;
        matchedLabel = metadata.text;
        break;
      }
    }

    if (!bankOption) {
      throw new Error(`BANK_NOT_FOUND: ${bankName}`);
    }

    await bankOption.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    try {
      await bankOption.click({ timeout: 5000 });
    } catch (clickErr) {
      await bankOption.click({ force: true, timeout: 5000 }).catch(async () => {
        await bankOption.evaluate((el) => el.click()).catch(() => {});
      });
    }

    await sleep(2000);
    console.log('[IRCTC Automation][BANK_SELECTION_COMPLETED]', JSON.stringify({
      bank: normalizedBank,
      method: 'button',
      matchedLabel,
    }));
    return true;
  }

  async _selectIrctcIpaySubOption(page, requestedPayment, options = {}) {
    const normalizedPayment = normalizeIrctcPaymentMethodChoice(requestedPayment);
    const required = options.required !== false;
    const requiredLabel = String(options.requiredLabel || 'IRCTC iPay New').trim();

    console.log('[IRCTC Automation][IPAY_SUB_OPTION_SEARCH]', JSON.stringify({
      requested: normalizedPayment, required, requiredLabel,
      url: (page.url && typeof page.url === 'function') ? page.url() : '',
    }));

    const isIpayFlow = normalizedPayment === 'IRCTC_IPAY'
      || normalizedPayment === 'DEFAULT'
      || normalizedPayment === 'UPI'
      || !normalizedPayment
      || (typeof requiredLabel === 'string' && requiredLabel.toLowerCase().includes('ipay'));
    if (!isIpayFlow) {
      // Legacy UPI/card flows retain their existing behavior.
      const legacyPatterns = {
        UPI: [/^UPI\s*\/?\s*BHIM$/i, /^UPI$/i, /^BHIM\s*UPI$/i, /^BHIM$/i, /^Pay\s*via\s*UPI$/i, /^UPI\s*QR$/i],
        CARD: [/^Credit\s*\/?\s*Debit\s*Card$/i, /^Credit\s*Card$/i, /^Debit\s*Card$/i, /^Card$/i],
        NET_BANKING: [/^Net\s*Banking$/i, /^Internet\s*Banking$/i, /^NETBANKING$/i],
        IMUDRA: [/^IMUDRA$/i],
      };
      const patterns = legacyPatterns[normalizedPayment] || [];
      if (!patterns.length) {
        if (required) throw new Error(`PAYMENT_SUB_OPTION_NOT_SUPPORTED: ${normalizedPayment}`);
        return false;
      }
      const candidates = page.locator('li, button, [role="button"], [role="radio"], mat-radio-button, p-radiobutton, .ui-radiobutton, .payment-option, .payment-method, label, .list-group-item, .card-body li');
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const count = await candidates.count().catch(() => 0);
        for (let i = 0; i < count; i += 1) {
          const candidate = candidates.nth(i);
          const meta = await candidate.evaluate((el) => { const r=el.getBoundingClientRect(), st=getComputedStyle(el); return {text:String(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim(), aria:el.getAttribute('aria-label')||'', visible:st.display!=='none'&&st.visibility!=='hidden'&&r.width>0&&r.height>0, disabled:Boolean(el.disabled)||el.getAttribute('aria-disabled')==='true'}; }).catch(()=>null);
          if (!meta || !meta.visible || meta.disabled) continue;
          if (!patterns.some((rx)=>rx.test(meta.text)) && !patterns.some((rx)=>rx.test(meta.aria))) continue;
          await candidate.scrollIntoViewIfNeeded({timeout:3000}).catch(()=>{});
          await candidate.click({timeout:5000}).catch(async()=>candidate.click({force:true,timeout:5000}));
          await sleep(1000);
          return true;
        }
        await sleep(IRCTC_STATE_POLL_INTERVAL_MS);
      }
      if (required) throw new Error(`PAYMENT_SUB_OPTION_NOT_FOUND: ${normalizedPayment}`);
      return false;
    }

    // Current IRCTC iPay flow: the parent "IRCTC iPay (Credit Card/Debit Card/UPI)"
    // must be followed by the explicit "IRCTC iPay New" child option.
    const deadline = Date.now() + 20000;
    const candidates = page.locator(
      'app-bank input[type="radio"], app-bank .bank-text, app-bank .bank-text .col-pad, app-bank label, app-bank .link, ' +
      'input[type="radio"], li, button, [role="button"], [role="radio"], ' +
      'mat-radio-button, p-radiobutton, .ui-radiobutton, .bank-text, ' +
      '.bank-text .col-pad, .payment-option, .payment-method, label, ' +
      '.list-group-item, .card-body li'
    );
    while (Date.now() < deadline) {
      const count = await candidates.count().catch(() => 0);
      let paymentOption = null;
      let matchedLabel = null;
      let bestMatchScore = Number.POSITIVE_INFINITY;
      for (let index = 0; index < count; index += 1) {
        const candidate = candidates.nth(index);
        const metadata = await candidate.evaluate((element) => {
          const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
          const labelText = Array.from(element.labels || [])
            .map((label) => label.innerText || label.textContent || '')
            .join(' ');
          return {
            text: String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim(),
            ariaLabel: element.getAttribute('aria-label') || '',
            title: element.getAttribute('title') || '',
            labelText: labelText.replace(/\s+/g, ' ').trim(),
            visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
            disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
          };
        }).catch(()=>null);
        if (!metadata || !metadata.visible || metadata.disabled) continue;

        // Disqualify main parent category so it is never clicked as the child option
        if (/IRCTC\s*iPay\s*\(\s*Credit\s*Card/i.test(metadata.text)) continue;

        const ownTextMatch = paymentOptionLabelMatches(metadata.text, requiredLabel);
        const accessibleTextMatch = paymentOptionLabelMatches(
          `${metadata.ariaLabel} ${metadata.title} ${metadata.labelText}`,
          requiredLabel
        );
        if (!ownTextMatch && !accessibleTextMatch) continue;

        const normalizedText = metadata.text.replace(/\s+/g, ' ').trim().toUpperCase();
        const normalizedRequired = requiredLabel.replace(/\s+/g, ' ').trim().toUpperCase();
        const matchScore = ownTextMatch
          ? (normalizedText === normalizedRequired ? 0 : 1)
          : 2;
        if (matchScore < bestMatchScore) {
          paymentOption = candidate;
          matchedLabel = metadata.text || metadata.labelText || metadata.ariaLabel;
          bestMatchScore = matchScore;
        }
      }

      if (paymentOption) {
        console.log('[IRCTC Automation][IPAY_NEW_MATCHED]', JSON.stringify({
          requested: normalizedPayment,
          matchedLabel,
        }));
        await paymentOption.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        const clickOnce = async (force = false) => {
          try {
            await paymentOption.click({ timeout: 5000, force });
          } catch {
            await paymentOption.evaluate((element) => {
              const target = element.closest(
                '.bank-text, [role="radio"], mat-radio-button, p-radiobutton, label, li, button'
              ) || element;
              if (target instanceof HTMLElement) target.click();
            });
          }
        };
        const isSelected = () => paymentOption.evaluate((element) => {
          const root = element.closest('.bank-text') || element;
          const selectionParent = root.closest(
            '[role="radio"], mat-radio-button, p-radiobutton, label, li, button'
          ) || root;
          const classes = `${typeof root.className === 'string' ? root.className : ''} ` +
            `${typeof selectionParent.className === 'string' ? selectionParent.className : ''}`;
          return root.getAttribute('aria-checked') === 'true' || root.getAttribute('aria-selected') === 'true' ||
            selectionParent.getAttribute('aria-checked') === 'true' ||
            selectionParent.getAttribute('aria-selected') === 'true' ||
            /\b(active|selected|checked|ui-state-active|bank-type-active)\b/i.test(classes) ||
            Boolean(root.matches('input[type="radio"]:checked')) ||
            Boolean(root.querySelector('input[type="radio"]:checked')) ||
            Boolean(selectionParent.querySelector('input[type="radio"]:checked')) ||
            Boolean(root.querySelector('.txnCharge')) ||
            Boolean(document.querySelector('app-bank .txnCharge')) ||
            Boolean(document.querySelector('.txnCharge'));
        }).catch(() => false);
        const waitForSelection = async (timeoutMs) => {
          const selectionDeadline = Date.now() + timeoutMs;
          while (Date.now() < selectionDeadline) {
            if (await isSelected()) return true;
            await sleep(250);
          }
          return isSelected();
        };

        await clickOnce(false);
        let active = await waitForSelection(3000);
        if (!active) {
          await paymentOption.evaluate((element) => {
            const container = element.closest('.link') || element.closest('.bank-text') || element;
            if (container instanceof HTMLElement) container.click();
          }).catch(() => {});
          active = await waitForSelection(3000);
        }
        if (!active) {
          await clickOnce(true);
          active = await waitForSelection(3000);
        }
        if (!active) throw new Error('IPAY_NEW_SELECTION_VERIFICATION_FAILED');
        console.log('[IRCTC Automation][IPAY_NEW_SELECTED]', JSON.stringify({
          requested: normalizedPayment,
          requiredLabel,
          activeVerified: true,
        }));
        return true;
      }
      await sleep(IRCTC_STATE_POLL_INTERVAL_MS);
    }
    console.error('[IRCTC Automation][IPAY_NEW_NOT_FOUND]', JSON.stringify({requested:normalizedPayment, requiredLabel, url:page.url()}));
    if (required) throw new Error('IRCTC_IPAY_NEW_REQUIRED_NOT_SELECTED');
    return false;
  }

  async _waitForRealQrCode(page, options = {}) {
    const { ticketId = null, timeoutMs = IRCTC_PAYMENT_ACTION_TIMEOUT_MS } = options;
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let lastDiagnostics = null;
    let captureAttempts = 0;

    const KNOWN_QR_SELECTORS = [
      'img#qrCodeImage',
      'img.qr-image',
      'img.qrImage',
      '.qr-container img',
      '.qrcode-container img',
      'canvas#qrCode',
      'div[data-testid="qr-code"] img',
      'div.qr-code img',
      'div.qr-code canvas',
      '.ipay-qr img',
      '.ipay-card img',
      'img[alt*="PhonePe" i]',
      'img[alt*="Paytm" i]',
      'img[alt*="QR" i]',
      'img[src*="generateQrCode" i]',
      'img[src*="qr" i]',
      'img[src^="data:image"]',
    ];

    while (Date.now() < deadline) {
      // Bail out if user stopped booking
      if (ticketId && this._ticketBookingState.get(ticketId)?.status === 'Stopped') {
        return null;
      }

      const frames = typeof page.frames === 'function' ? page.frames() : [page];

      for (const frame of frames) {
        // Fast-path: Check for known QR element locators directly with Playwright
        for (const sel of KNOWN_QR_SELECTORS) {
          try {
            const loc = frame.locator(sel).first();
            const isVis = await loc.isVisible({ timeout: 100 }).catch(() => false);
            if (isVis) {
              const src = await loc.getAttribute('src').catch(() => null);
              if (src && src.startsWith('data:image/')) {
                return this._saveQrToDisk(src, ticketId, `known-selector-src:${sel}`);
              }
              // If not inline data URL, take a direct element screenshot
              const buffer = await loc.screenshot({ type: 'png' }).catch(() => null);
              if (buffer && buffer.length > 200) {
                const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
                return this._saveQrToDisk(dataUrl, ticketId, `known-selector-screenshot:${sel}`);
              }
            }
          } catch (_) {}
        }

        let qrResult = null;

        try {
          qrResult = await frame.evaluate(() => {
            const visible = (el) => {
              if (!el) return false;
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                style.opacity !== '0' &&
                rect.width > 20 &&
                rect.height > 20;
            };

            const hasQrMarkerInAncestors = (el, maxDepth = 6) => {
              let node = el;
              for (let i = 0; i < maxDepth && node; i += 1) {
                const text = `${node.className || ''} ${node.id || ''} ` +
                  `${node.getAttribute?.('aria-label') || ''} ` +
                  `${node.getAttribute?.('alt') || ''} ` +
                  `${node.tagName || ''}`;
                if (/qr|upi|bhim|scan|paytm|phonepe/i.test(text)) return true;
                node = node.parentElement;
              }
              return false;
            };

            // Strategy 1: <img> tag with data URI
            // Fast Check: Paytm pushAppData (Red Box parity)
            try {
              let pushApp = window.pushAppData;
              if (!pushApp) {
                const scripts = Array.from(document.querySelectorAll('script'));
                for (const s of scripts) {
                  const m = (s.textContent || '').match(/var\s+pushAppData\s*=\s*"([^"]+)"/);
                  if (m && m[1]) {
                    pushApp = m[1];
                    break;
                  }
                }
              }
              if (pushApp && typeof pushApp === 'string') {
                const raw = atob(pushApp);
                let decoded = raw;
                try {
                  decoded = decodeURIComponent(
                    raw.split('').map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
                  );
                } catch (_) {}
                const parsed = JSON.parse(decoded);
                const qrUrl = parsed?.qr?.dataurl;
                if (qrUrl && qrUrl.startsWith('data:image/')) {
                  return { type: 'paytm-pushAppData', source: qrUrl, width: 250, height: 250 };
                }
              }
            } catch (_) {}

            // Strategy 1: <img> tag
            const isOnBkgPaymentOptions = window.location.href.includes('bkgPaymentOptions');
            const images = Array.from(document.querySelectorAll('img'));
            for (const img of images) {
              if (!visible(img)) continue;
              const src = String(img.currentSrc || img.src || img.getAttribute('src') || '').trim();
              const alt = String(img.alt || '').toLowerCase();
              const cls = String(img.className || '').toLowerCase();
              const id = String(img.id || '').toLowerCase();
              const parentText = String(img.parentElement?.innerText || '').toLowerCase();

              const isImageSource = /^(data:image\/|blob:|https?:\/\/)/i.test(src);
              if (!isImageSource) continue;

              // If still on bkgPaymentOptions, ONLY inline iPay QR is a valid QR code!
              // Static bank option logos/cards must NEVER be mistaken for QR codes.
              if (isOnBkgPaymentOptions) {
                const isInsideIpayQr = Boolean(img.closest('.ipay-qr, .ipay-card, .payment-card.ipay-card'));
                const isRealQrSrc = src.startsWith('data:image/') || src.includes('generateQrCode');
                if (!isInsideIpayQr && !isRealQrSrc) {
                  continue;
                }
              }

              const hasQrKeyword = /qr|upi|bhim|scan|paytm|phonepe/i.test(
                `${alt} ${cls} ${id} ${parentText}`
              );
              const hasQrAncestor = hasQrMarkerInAncestors(img);
              const sizeLooksRight = (img.naturalWidth >= 80 && img.naturalWidth <= 600) ||
                (img.offsetWidth >= 80 && img.offsetWidth <= 600);

              if (hasQrKeyword || (hasQrAncestor && sizeLooksRight)) {
                if (src.startsWith('data:image/')) {
                  return {
                    type: 'img',
                    source: src,
                    width: img.naturalWidth || img.offsetWidth,
                    height: img.naturalHeight || img.offsetHeight,
                  };
                }
                // Mark element for zero-selector screenshot
                img.setAttribute('data-netx-qr-target', '1');
                return {
                  type: 'img-element',
                  selectorId: img.id || '',
                  className: String(img.className || ''),
                  src,
                  width: img.naturalWidth || img.offsetWidth,
                  height: img.naturalHeight || img.offsetHeight,
                };
              }
            }

            // Strategy 2: <canvas> tag
            const canvases = Array.from(document.querySelectorAll('canvas'));
            for (const canvas of canvases) {
              if (!visible(canvas)) continue;
              if (canvas.width < 80 || canvas.width > 600) continue;
              if (isOnBkgPaymentOptions && !canvas.closest('.ipay-qr')) continue;
              const cls = String(canvas.className || '').toLowerCase();
              const id = String(canvas.id || '').toLowerCase();
              if (/qr|upi|bhim|scan/i.test(`${cls} ${id}`) || hasQrMarkerInAncestors(canvas)) {
                try {
                  const dataUrl = canvas.toDataURL('image/png');
                  if (dataUrl && dataUrl.startsWith('data:image/')) {
                    return { type: 'canvas', source: dataUrl, width: canvas.width, height: canvas.height };
                  }
                } catch (err) {
                  canvas.setAttribute('data-netx-qr-target', '1');
                  return {
                    type: 'canvas-tainted',
                    selectorId: canvas.id || '',
                    className: String(canvas.className || ''),
                    width: canvas.width,
                    height: canvas.height,
                  };
                }
              }
            }

            // Strategy 3: <svg> tag
            const svgs = Array.from(document.querySelectorAll('svg'));
            for (const svg of svgs) {
              if (!visible(svg)) continue;
              if (isOnBkgPaymentOptions && !svg.closest('.ipay-qr')) continue;
              const cls = String(svg.className || '').toLowerCase();
              const id = String(svg.id || '').toLowerCase();
              if (/qr|upi|bhim|scan/i.test(`${cls} ${id}`) || hasQrMarkerInAncestors(svg)) {
                const rect = svg.getBoundingClientRect();
                if (rect.width >= 80 && rect.width <= 600) {
                  svg.setAttribute('data-netx-qr-target', '1');
                  return {
                    type: 'svg',
                    selectorId: svg.id || '',
                    className: String(svg.className || ''),
                    width: rect.width,
                    height: rect.height,
                  };
                }
              }
            }

            return null;
          });
        } catch (frameErr) {
          continue;
        }

        if (qrResult) {
          captureAttempts += 1;
          console.log('[IRCTC Automation][QR_FOUND]', JSON.stringify({
            type: qrResult.type,
            width: qrResult.width,
            height: qrResult.height,
            frameUrl: typeof frame.url === 'function' ? frame.url() : '',
            attempt: captureAttempts,
          }));

          // Handle direct string / test mocks
          if (typeof qrResult === 'string') {
            qrResult = { type: 'direct-data-url', source: qrResult };
          } else if (qrResult && typeof qrResult === 'object' && qrResult.dataUrl && !qrResult.source) {
            qrResult = { ...qrResult, type: qrResult.type || 'direct-data-url', source: qrResult.dataUrl };
          }

          // Handle img-element: take frame screenshot of the element
          if (qrResult.type === 'img-element') {
            try {
              let locator = frame.locator('[data-netx-qr-target="1"]').first();
              let isVis = await locator.isVisible().catch(() => false);
              if (!isVis) {
                if (qrResult.selectorId) {
                  locator = frame.locator(`#${qrResult.selectorId}`).first();
                } else if (qrResult.src) {
                  locator = frame.locator(`img[src="${qrResult.src}"]`).first();
                } else if (qrResult.className) {
                  const firstClass = qrResult.className.split(/\s+/)[0];
                  locator = frame.locator(`img.${firstClass}`).first();
                }
                isVis = locator ? await locator.isVisible().catch(() => false) : false;
              }
              if (isVis && locator) {
                const buffer = await locator.screenshot({ type: 'png' }).catch(() => null);
                await frame.evaluate(() => {
                  document.querySelectorAll('[data-netx-qr-target="1"]').forEach(el => el.removeAttribute('data-netx-qr-target'));
                }).catch(() => {});
                if (buffer && buffer.length > 200) {
                  const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
                  return this._saveQrToDisk(dataUrl, ticketId, 'img-element-screenshot');
                }
              }
            } catch (fallbackErr) {
              console.warn('[IRCTC Automation][QR_IMG_SCREENSHOT_FAILED]', fallbackErr.message);
            }
          }

          // Handle canvas-tainted: use frame screenshot of the canvas
          if (qrResult.type === 'canvas-tainted') {
            try {
              let canvasLocator = frame.locator('[data-netx-qr-target="1"]').first();
              let isVis = await canvasLocator.isVisible().catch(() => false);
              if (!isVis) {
                if (qrResult.selectorId) {
                  canvasLocator = frame.locator(`#${qrResult.selectorId}`).first();
                } else if (qrResult.className) {
                  const firstClass = qrResult.className.split(/\s+/)[0];
                  canvasLocator = frame.locator(`canvas.${firstClass}`).first();
                }
                isVis = canvasLocator ? await canvasLocator.isVisible().catch(() => false) : false;
              }
              if (isVis && canvasLocator) {
                const buffer = await canvasLocator.screenshot({ type: 'png' }).catch(() => null);
                await frame.evaluate(() => {
                  document.querySelectorAll('[data-netx-qr-target="1"]').forEach(el => el.removeAttribute('data-netx-qr-target'));
                }).catch(() => {});
                if (buffer && buffer.length > 200) {
                  const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
                  return this._saveQrToDisk(dataUrl, ticketId, 'canvas-screenshot');
                }
              }
            } catch (fallbackErr) {
              console.warn('[IRCTC Automation][QR_CANVAS_FALLBACK_FAILED]', fallbackErr.message);
            }
            continue;
          }

          // Handle SVG: use frame screenshot
          if (qrResult.type === 'svg') {
            try {
              let svgLocator = frame.locator('[data-netx-qr-target="1"]').first();
              let isVis = await svgLocator.isVisible().catch(() => false);
              if (!isVis) {
                if (qrResult.selectorId) {
                  svgLocator = frame.locator(`#${qrResult.selectorId}`).first();
                } else if (qrResult.className) {
                  const firstClass = qrResult.className.split(/\s+/)[0];
                  svgLocator = frame.locator(`svg.${firstClass}`).first();
                }
                isVis = svgLocator ? await svgLocator.isVisible().catch(() => false) : false;
              }
              if (isVis && svgLocator) {
                const buffer = await svgLocator.screenshot({ type: 'png' }).catch(() => null);
                await frame.evaluate(() => {
                  document.querySelectorAll('[data-netx-qr-target="1"]').forEach(el => el.removeAttribute('data-netx-qr-target'));
                }).catch(() => {});
                if (buffer && buffer.length > 200) {
                  const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
                  return this._saveQrToDisk(dataUrl, ticketId, 'svg-screenshot');
                }
              }
            } catch (svgErr) {
              console.warn('[IRCTC Automation][QR_SVG_FALLBACK_FAILED]', svgErr.message);
            }
            continue;
          }

          // Direct data URL source (e.g. paytm-pushAppData, img with data URI, canvas)
          if (qrResult.source && qrResult.source.startsWith('data:image/')) {
            return this._saveQrToDisk(qrResult.source, ticketId, qrResult.type);
          }
        }
      }

      // Diagnostic log every 5 seconds
      if (!lastDiagnostics || Date.now() - (lastDiagnostics.loggedAt || 0) > 5000) {
        const diag = await page.evaluate(() => {
          const visible = (el) => Boolean(
            el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)
          );
          return {
            url: window.location.href,
            totalImages: document.querySelectorAll('img').length,
            visibleImages: Array.from(document.querySelectorAll('img')).filter(visible).length,
            totalCanvas: document.querySelectorAll('canvas').length,
            visibleCanvas: Array.from(document.querySelectorAll('canvas')).filter(visible).length,
            totalSvg: document.querySelectorAll('svg').length,
            bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
          };
        }).catch(() => null);
        if (diag) {
          diag.loggedAt = Date.now();
          diag.elapsedMs = Date.now() - startedAt;
          lastDiagnostics = diag;
          console.log('[IRCTC Automation][QR_WAITING_DIAGNOSTIC]', JSON.stringify(diag));
        }
      }

      await sleep(IRCTC_STATE_POLL_INTERVAL_MS);
    }

    console.warn('[IRCTC Automation][QR_TIMEOUT]', JSON.stringify({
      elapsedMs: timeoutMs,
      lastDiagnostics,
    }));
    return null;
  }

  _saveQrToDisk(dataUrl, ticketId, sourceType = 'unknown') {
    if (!dataUrl || typeof dataUrl !== 'string') return null;
    try {
      const qrDir = path.join(process.cwd(), 'storage', 'qr-codes');
      if (!fs.existsSync(qrDir)) {
        fs.mkdirSync(qrDir, { recursive: true });
      }

      // Extract base64 payload
      let base64Payload = null;
      const dataUriMatch = dataUrl.match(/^data:image\/[^;]+;base64,(.+)$/i);
      if (dataUriMatch) {
        base64Payload = dataUriMatch[1];
      } else if (/^[A-Za-z0-9+/=]+$/.test(dataUrl) && dataUrl.length > 100) {
        base64Payload = dataUrl;
      }

      let filePath = null;
      if (base64Payload) {
        const safeTicketId = String(ticketId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
        const filename = `qr_${safeTicketId}_${Date.now()}.png`;
        filePath = path.join(qrDir, filename);
        fs.writeFileSync(filePath, Buffer.from(base64Payload, 'base64'));
        console.log('[IRCTC Automation][QR_SAVED]', JSON.stringify({
          ticketId,
          filePath,
          sourceType,
          size: base64Payload.length,
        }));
      }

      // Normalize return: always a data URL
      let normalizedDataUrl = dataUrl;
      if (base64Payload && !dataUrl.startsWith('data:')) {
        normalizedDataUrl = `data:image/png;base64,${base64Payload}`;
      }

      return {
        dataUrl: normalizedDataUrl,
        filePath,
        sourceType,
        capturedAt: Date.now(),
      };
    } catch (err) {
      console.warn('[IRCTC Automation][QR_SAVE_FAILED]', err.message);
      return { dataUrl, filePath: null, sourceType, capturedAt: Date.now() };
    }
  }

  getBookingStatus(userId, ticketId) {
  const id = Number(ticketId);
  const state = this._ticketBookingState.get(id);
  if (!state) {
    return {
      ticketId: id,
      status: 'Ready - { Bkg Fare Limit: 0 }',
      stopPayment: false,
    };
  }
  if (state.userId && Number(state.userId) !== Number(userId)) {
    const err = new Error('Access denied: booking state belongs to another user.');
    err.status = 403;
    throw err;
  }
  return state;
}

  setBookingStatus(ticketId, status, extra = {}) {
    const id = Number(ticketId);
    const existing = this._ticketBookingState.get(id) || {};
    const updated = {
      ...existing,
      ticketId: id,
      status,
      updatedAt: Date.now(),
      ...extra,
    };
    if (extra && extra.authResult === null) {
      delete updated.authResult;
    }
    this._ticketBookingState.set(id, updated);
    return updated;
  }

  async startTicketBooking(userId, ticketId, { stopPayment = false, ticket = null } = {}) {
    const id = Number(ticketId);

    if (this._activeBookings.has(id)) {
      console.log(`[IRCTC Automation] Booking already active for ticket ${id}, ignoring duplicate trigger.`);
      return this.getBookingStatus(userId, id);
    }
    this._activeBookings.add(id);

    if (this._bookingTimers.has(id)) {
      const prev = this._bookingTimers.get(id);
      if (Array.isArray(prev)) {
        prev.forEach((t) => clearTimeout(t));
      } else {
        clearTimeout(prev);
      }
      this._bookingTimers.delete(id);
    }

    const isStop = Boolean(stopPayment);
    this._ticketBookingState.set(id, {
      ticketId: id,
      userId,
      stopPayment: isStop,
      status: 'Starting...',
      startTime: Date.now(),
      updatedAt: Date.now(),
    });

    let activeSession = this._activeSessions.get(id);
    if ((!activeSession || !activeSession.page || activeSession.page.isClosed()) && ticket) {
      const accountId = ticket.irctcAccountId || ticket.irctcUserId;
      if (accountId) {
        for (const [sKey, sess] of this._accountSessions.entries()) {
          if (
            sKey.startsWith(`${accountId}_`) &&
            sess?.page &&
            !sess.page.isClosed() &&
            Number(sess.ticket?.id) === id &&
            Number(sess.userId) === Number(userId)
          ) {
            activeSession = sess;
            this._activeSessions.set(id, sess);
            break;
          }
        }
      }
    }
    if (activeSession && activeSession.page && !activeSession.page.isClosed()) {
      this._runRealBookingWorkflow(userId, id, activeSession, { stopPayment: isStop, ticket }).catch((err) => {
        console.error(`[IRCTC Automation] Real booking pipeline error for ticket ${id}:`, err);
        this.setBookingStatus(id, `Error: ${err.message}`);
      });
      return this.getBookingStatus(userId, id);
    }

    const timers = [];
    let cleanedUp = false;
    const cleanupTimers = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      timers.forEach((t) => clearTimeout(t));
      timers.length = 0;
      this._bookingTimers.delete(id);
      this._activeBookings.delete(id);
    };

    const scheduleStage = (delayMs, statusText, extra = {}) => {
      const t = setTimeout(() => {
        const current = this._ticketBookingState.get(id);
        if (!current || current.status === 'Stopped') {
          cleanupTimers();
          return;
        }
        this.setBookingStatus(id, statusText, extra);
        if (extra?.isFinal) {
          cleanupTimers();
        }
      }, delayMs);
      timers.push(t);
      return t;
    };

    scheduleStage(500, 'Logging in...');
    scheduleStage(1000, 'Login successful');
    scheduleStage(1400, 'Searching Train...');
    scheduleStage(1800, 'Checking Availability...');
    scheduleStage(2200, 'Train Selected...');
    scheduleStage(2600, 'Submitting Passengers...');
    scheduleStage(2800, 'Opening Payment...');

    if (isStop) {
      scheduleStage(3000, 'Waiting for Payment (Stopped)', { paymentStopped: true, isFinal: true });
    } else {
      scheduleStage(3000, 'Waiting for Payment', { paymentStopped: false, isFinal: true });
    }

    this._bookingTimers.set(id, timers);
    return this.getBookingStatus(userId, id);
  }

  async _runRealBookingWorkflow(userId, ticketId, activeSession, {
    stopPayment = false,
    ticket = null,
    midLoginRetries = 0,
  }) {
    const id = Number(ticketId);
    const { page } = activeSession;
    const targetTicket = ticket || activeSession.ticket;
    const accountId = targetTicket?.irctcAccountId
      || activeSession?.accountId
      || activeSession?.ticket?.irctcAccountId;
    let account = null;
    let loginCapturedTokens = null;

    try {
      console.log('[IRCTC Automation][WORKFLOW_PAGE_ACTIVE]', JSON.stringify({
        ticketId: id,
        accountId: activeSession.accountId || targetTicket?.irctcAccountId || null,
        browserKey: activeSession.browserKey || activeSession.browserConfig?.browserKey || null,
        pageId: page?.guid || null,
        owner: activeSession.workflowOwner || `ticket:${id}`,
      }));
      if (accountId) {
        account = await targetAccountService.getDecryptedAccountForAutomation(userId, accountId);
      }

      if (!account || !account.irctcUserId || !account.password) {
        const msg = 'Login Failed: IRCTC account credentials missing in database.';
        console.warn(`[IRCTC Automation] ${msg}`);
        this.setBookingStatus(id, msg, {
          authResult: {
            success: false,
            stage: 'authentication',
            code: AUTH_CODES.INVALID_CREDENTIALS,
            message: msg,
            displayMessage: msg,
            retryable: false,
          },
        });
        return;
      }
      logStage(id, 'CREDENTIALS_LOADED');

      const proactiveAccountId = accountId
        || targetTicket?.irctcAccountId
        || activeSession?.accountId;
      if (proactiveAccountId && activeSession?.context) {
        try {
          const currentPageUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
          if (!/irctc\.co\.in\/nget\//i.test(currentPageUrl)) {
            await this._gotoWithDiagnostics(
              page,
              this.config.SECONDARY_WEB_URL || 'https://www.irctc.co.in/nget/train-search',
              {
                ticketId: id,
                accountId: proactiveAccountId,
                browser: activeSession?.browserConfig?.name || activeSession?.browserKey,
                sessionKey: this.getSessionLockKey(proactiveAccountId, activeSession?.browserKey),
                profileIdentifier: activeSession?.profileDir || null,
                timeout: this.config.NAVIGATION_TIMEOUT_MS || 35000,
              }
            );
          }
        } catch (proactiveErr) {
          console.warn('[IRCTC Automation][PROACTIVE_NAVIGATION_ERROR]', proactiveErr.message);
        }
      }

      if (this._ticketBookingState.get(id)?.status === 'Stopped') return;

      const initialUrl = (page && page.url && typeof page.url === 'function') ? page.url() : '';
      if (initialUrl && !/irctc\.co\.in\/nget\//i.test(initialUrl)) {
        console.log('[IRCTC Automation] Non-IRCTC URL detected at start; navigating to train-search.');
        const trainSearchUrl = this.config.SECONDARY_WEB_URL || 'https://www.irctc.co.in/nget/train-search';
        await this._gotoWithDiagnostics(page, trainSearchUrl, {
          ticketId: id,
          accountId: targetTicket?.irctcAccountId || activeSession?.accountId,
          browser: activeSession?.browserConfig?.name || activeSession?.browserKey,
          sessionKey: this.getSessionLockKey(
            targetTicket?.irctcAccountId || activeSession?.accountId,
            activeSession?.browserKey
          ),
          profileIdentifier: activeSession?.profileDir || null,
          timeout: this.config.NAVIGATION_TIMEOUT_MS || 35000,
        });
      }

      this.setBookingStatus(id, 'Opening IRCTC...');
      const currentUrl = (page && page.url && typeof page.url === 'function') ? page.url() : '';
      if (!currentUrl || !currentUrl.includes('irctc.co.in')) {
        const targetUrl = this.config.SECONDARY_WEB_URL || 'https://www.irctc.co.in/nget/train-search';
        try {
          if (page && typeof page.goto === 'function') {
            await this._gotoWithDiagnostics(page, targetUrl, {
              ticketId: id,
              accountId: targetTicket?.irctcAccountId || activeSession?.accountId,
              browser: activeSession?.browserConfig?.name || activeSession?.browserKey,
              sessionKey: this.getSessionLockKey(
                targetTicket?.irctcAccountId || activeSession?.accountId,
                activeSession?.browserKey
              ),
              profileIdentifier: activeSession?.profileDir || null,
              timeout: this.config.NAVIGATION_TIMEOUT_MS || 35000,
            });
          }
        } catch (navErr) {
          console.error(`[IRCTC Automation] Navigation failed for ticket ${id}:`, navErr.message);
          this.setBookingStatus(id, 'Error: IRCTC navigation timed out or failed to load.', {
            authResult: {
              success: false,
              stage: 'authentication',
              code: navErr.code || AUTH_CODES.SERVER_ERROR,
              message: `IRCTC navigation failed: ${navErr.message}`,
              displayMessage: 'IRCTC navigation failed before the page became available. See navigation diagnostics.',
              retryable: true,
              navigationDiagnostics: navErr.navigationDiagnostics || null,
            },
          });
          return;
        }
      }
      logStage(id, 'IRCTC_PAGE_LOADED', { url: (page && page.url && typeof page.url === 'function') ? page.url() : '' });

      if (this._ticketBookingState.get(id)?.status === 'Stopped') return;

      const clientIpErrNav = await this._checkForClientIpRejection(page);
      if (clientIpErrNav) {
        const rawErr = clientIpErrNav.raw || clientIpErrNav.message || String(clientIpErrNav);
        const rejectionReport = this._recordIrctcRejectionTelemetry({
          stage: 'POST_NAVIGATION',
          ticketId: id,
          accountId: targetTicket?.irctcAccountId || activeSession?.accountId || 'unknown',
          browserKey: activeSession?.browserKey || 'chrome',
          page,
          profilePath: path.join(process.cwd(), 'storage', 'automation-profiles', `acc_${targetTicket?.irctcAccountId || activeSession?.accountId}_${activeSession?.browserKey || 'chrome'}`),
          sessionReused: Boolean(activeSession?.reused),
          authState: 'POST_NAVIGATION_CHECK',
          clientIpError: clientIpErrNav,
        });
        logStage(id, 'CLIENT_IP_ERROR', { correlationId: rejectionReport.correlationId, source: 'post-navigation', clientIp: clientIpErrNav.clientIp });
        console.warn(`[IRCTC Automation] Client IP rejection after navigation for ticket ${id}: ${rawErr}`);
        this.setBookingStatus(id, 'IRCTC rejected the current automation session (Client IP)', {
          clientIpError: rawErr,
          authResult: {
            success: false,
            stage: 'authentication',
            code: AUTH_CODES.CLIENT_IP_ERROR,
            message: clientIpErrNav.message || 'The IRCTC website rejected the current client IP/session.',
            displayMessage: 'IRCTC rejected the current automation session (Client IP). Please try again later or verify the network/session.',
            clientIp: clientIpErrNav.clientIp || null,
            currentUrl: (page && page.url && typeof page.url === 'function') ? page.url() : '',
            retryable: true,
            details: { rawError: rawErr },
            irctcRejection: rejectionReport,
          },
        });
        return;
      }

      await this._handleLanguageAndAlerts(page);

      logStage(id, 'AUTH_STATE_CHECKING');
      this.setBookingStatus(id, 'Checking session...');

      const authState = await this._detectAuthenticationState(page, account, 1500);

      if (authState.state === AUTH_CODES.CLIENT_IP_ERROR) {
        const clientIpErr = authState.details;
        const rawErr = clientIpErr?.raw || clientIpErr?.message || 'Client IP rejected by IRCTC';
        const rejectionReport = this._recordIrctcRejectionTelemetry({
          stage: 'AUTH_STATE_CHECK',
          ticketId: id,
          accountId: targetTicket?.irctcAccountId || activeSession?.accountId || 'unknown',
          browserKey: activeSession?.browserKey || 'chrome',
          page,
          profilePath: path.join(process.cwd(), 'storage', 'automation-profiles', `acc_${targetTicket?.irctcAccountId || activeSession?.accountId}_${activeSession?.browserKey || 'chrome'}`),
          sessionReused: Boolean(activeSession?.reused),
          authState: 'CLIENT_IP_ERROR',
          clientIpError: clientIpErr,
        });
        logStage(id, 'CLIENT_IP_ERROR', { correlationId: rejectionReport.correlationId, clientIp: clientIpErr?.clientIp });
        this.setBookingStatus(id, 'IRCTC rejected the current automation session (Client IP)', {
          clientIpError: rawErr,
          authResult: {
            success: false,
            stage: 'authentication',
            code: AUTH_CODES.CLIENT_IP_ERROR,
            message: clientIpErr?.message || 'The IRCTC website rejected the current client IP/session.',
            displayMessage: 'IRCTC rejected the current automation session (Client IP). Please try again later or verify the network/session.',
            clientIp: clientIpErr?.clientIp || null,
            currentUrl: (page.url && typeof page.url === 'function') ? page.url() : '',
            retryable: true,
            details: { rawError: rawErr },
            irctcRejection: rejectionReport,
          },
        });
        return;
      }

      let alreadyAuth = false;
      let restoredFromDisk = false;

      if (authState.state === AUTH_CODES.AUTHENTICATED) {
        alreadyAuth = true;
        logStage(id, 'EXISTING_SESSION_DETECTED', { user: account.irctcUserId });
        console.log(`[IRCTC Automation] Existing IRCTC session detected for account: ${account.irctcUserId}`);
        this.setBookingStatus(id, 'Existing IRCTC session detected', {
          authResult: {
            success: true,
            stage: 'authentication',
            code: AUTH_CODES.AUTHENTICATED,
            message: 'Active session reused',
            displayMessage: 'Existing IRCTC session detected',
            reusedSession: true,
          },
        });
      } else {
        if (await this._isPageAuthenticated(page, account)) {
          alreadyAuth = true;
          logStage(id, 'AUTHENTICATED_EXISTING_SESSION', { user: account.irctcUserId });
          this.setBookingStatus(id, 'Existing IRCTC session detected', {
            authResult: {
              success: true,
              stage: 'authentication',
              code: AUTH_CODES.AUTHENTICATED,
              message: 'Active session reused',
              displayMessage: 'Existing IRCTC session detected',
              reusedSession: true,
            },
          });
        } else {
          const isFormAlreadyOpen = alreadyAuth || await page.evaluate(() => {
            const uInput = document.querySelector('input[formcontrolname="userid"], input[placeholder*="User Name" i], input[placeholder*="User ID" i]');
            const loginModal = document.querySelector('app-login, form[name="loginForm"]');
            const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
            return isVisible(uInput) || isVisible(loginModal);
          }).catch(() => false);

          if (isFormAlreadyOpen && !alreadyAuth) {
            logStage(id, 'AUTH_LOGIN_IN_PROGRESS', { formAlreadyOpen: true });
            logStage(id, 'LOGIN_FORM_FOUND', { preOpened: true });
          } else if (!alreadyAuth) {
            await this._handleLanguageAndAlerts(page);

            logStage(id, 'AUTH_REQUIRED');
            this.setBookingStatus(id, 'Opening Login...');

            const loginBtn = page
              .locator(
                'a.search_btn.loginText, a:has-text("LOGIN"), button.btn-login, button:has-text("LOGIN"), a:has-text("लॉग इन"), a[aria-label*="Login" i]'
              )
              .first();

            let clickedLogin = false;
            if (await loginBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
              try {
                await loginBtn.click({ timeout: 4000 });
                clickedLogin = true;
              } catch {}
            }

            if (!clickedLogin) {
              clickedLogin = await page.evaluate(() => {
                const btn =
                  document.querySelector('a.search_btn.loginText') ||
                  document.querySelector('button.btn-login') ||
                  Array.from(document.querySelectorAll('button, a')).find(
                    (a) => /^\s*(?:login|लॉग\s*इन)\s*$/i.test(a.innerText ? a.innerText.trim() : '')
                  ) ||
                  Array.from(document.querySelectorAll('button, a')).find(
                    (a) => /\b(?:login|लॉग\s*इन)\b/i.test(a.innerText ? a.innerText.trim() : '')
                  );
                if (btn) {
                  btn.click();
                  return true;
                }
                return false;
              }).catch(() => false);
            }

            let formOpened = false;
            const checkDeadline = Date.now() + 4000;
            while (Date.now() < checkDeadline) {
              if (await this._isPageAuthenticated(page, account)) {
                alreadyAuth = true;
                break;
              }
              const hasForm = await page.evaluate(() => {
                const u = document.querySelector('input[formcontrolname="userid"], input[placeholder*="User Name" i]');
                return !!(u && (u.offsetWidth || u.offsetHeight || u.getClientRects().length));
              }).catch(() => false);
              if (hasForm) {
                formOpened = true;
                break;
              }
              await sleep(300);
            }

            if (alreadyAuth) {
              logStage(id, 'AUTHENTICATED_EXISTING_SESSION', { user: account.irctcUserId });
              this.setBookingStatus(id, 'Existing IRCTC session detected', {
                authResult: {
                  success: true,
                  stage: 'authentication',
                  code: AUTH_CODES.AUTHENTICATED,
                  message: 'Active session reused',
                  displayMessage: 'Existing IRCTC session detected',
                  reusedSession: true,
                },
              });
            } else if (!formOpened && !clickedLogin) {
              if (await this._isPageAuthenticated(page, account)) {
                alreadyAuth = true;
                logStage(id, 'AUTHENTICATED_EXISTING_SESSION');
                this.setBookingStatus(id, 'Existing IRCTC session detected', {
                  authResult: {
                    success: true,
                    stage: 'authentication',
                    code: AUTH_CODES.AUTHENTICATED,
                    message: 'Active session reused',
                    displayMessage: 'Existing IRCTC session detected',
                    reusedSession: true,
                  },
                });
              } else {
                const clientIpErrLogin = await this._checkForClientIpRejection(page);
                if (clientIpErrLogin) {
                  const rawErr = clientIpErrLogin.raw || clientIpErrLogin.message || String(clientIpErrLogin);
                  const rejectionReport = this._recordIrctcRejectionTelemetry({
                    stage: 'LOGIN_BUTTON_INSPECTION',
                    ticketId: id,
                    accountId: targetTicket?.irctcAccountId || activeSession?.accountId || 'unknown',
                    browserKey: activeSession?.browserKey || 'chrome',
                    page,
                    profilePath: path.join(process.cwd(), 'storage', 'automation-profiles', `acc_${targetTicket?.irctcAccountId || activeSession?.accountId}_${activeSession?.browserKey || 'chrome'}`),
                    sessionReused: Boolean(activeSession?.reused),
                    authState: 'CLIENT_IP_ERROR',
                    clientIpError: clientIpErrLogin,
                  });
                  logStage(id, 'CLIENT_IP_ERROR', { correlationId: rejectionReport.correlationId, clientIp: clientIpErrLogin.clientIp });
                  this.setBookingStatus(id, 'IRCTC rejected the current automation session (Client IP)', {
                    clientIpError: rawErr,
                    authResult: {
                      success: false,
                      stage: 'authentication',
                      code: AUTH_CODES.CLIENT_IP_ERROR,
                      message: clientIpErrLogin.message || 'The IRCTC website rejected the current client IP/session.',
                      displayMessage: 'IRCTC rejected the current automation session (Client IP). Please try again later or verify the network/session.',
                      clientIp: clientIpErrLogin.clientIp || null,
                      currentUrl: (page.url && typeof page.url === 'function') ? page.url() : '',
                      retryable: true,
                      details: { rawError: rawErr },
                      irctcRejection: rejectionReport,
                    },
                  });
                  return;
                }

                const secChallenge = await this._checkForSecurityChallenge(page);
                if (secChallenge) {
                  logStage(id, 'SECURITY_CHALLENGE', { type: secChallenge.type });
                  this.setBookingStatus(id, secChallenge.displayMessage, {
                    authResult: {
                      success: false,
                      stage: 'authentication',
                      code: AUTH_CODES.SECURITY_CHALLENGE,
                      message: secChallenge.message,
                      displayMessage: secChallenge.displayMessage,
                      currentUrl: (page.url && typeof page.url === 'function') ? page.url() : '',
                      retryable: true,
                      details: secChallenge,
                    },
                  });
                  return;
                }

                const { screenshotPath, diagnostics } = await this._captureSafeDebugArtifact(page, id, {
                  stage: 'LOGIN_BUTTON_UNAVAILABLE',
                  clickedLogin,
                  formOpened,
                });

                logStage(id, 'UNKNOWN_AUTH_STATE', { stage: 'LOGIN_BUTTON_UNAVAILABLE' });
                this.setBookingStatus(id, 'IRCTC page state unrecognized (Login button not available)', {
                  authResult: {
                    success: false,
                    stage: 'authentication',
                    code: AUTH_CODES.UNKNOWN_AUTH_STATE,
                    message: 'IRCTC login button was not detected and no authenticated session or form was found.',
                    displayMessage: 'IRCTC login button could not be opened. Please check the page state.',
                    retryable: true,
                    debugArtifact: screenshotPath,
                    details: diagnostics,
                  },
                });
                return;
              }
            } else {
              logStage(id, 'LOGIN_BUTTON_FOUND');
            }
          }
        }
      }

      if (!alreadyAuth) {
        if (this._ticketBookingState.get(id)?.status === 'Stopped') return;

        // Check for Client IP rejection after opening login
        const clientIpErrLogin = await this._checkForClientIpRejection(page);
        if (clientIpErrLogin) {
          const rawErr = clientIpErrLogin.raw || clientIpErrLogin.message || String(clientIpErrLogin);
          const rejectionReport = this._recordIrctcRejectionTelemetry({
            stage: 'POST_LOGIN_OPEN',
            ticketId: id,
            accountId: targetTicket?.irctcAccountId || activeSession?.accountId || 'unknown',
            browserKey: activeSession?.browserKey || 'chrome',
            page,
            profilePath: path.join(process.cwd(), 'storage', 'automation-profiles', `acc_${targetTicket?.irctcAccountId || activeSession?.accountId}_${activeSession?.browserKey || 'chrome'}`),
            sessionReused: Boolean(activeSession?.reused),
            authState: 'POST_LOGIN_OPEN_CHECK',
            clientIpError: clientIpErrLogin,
          });
          logStage(id, 'CLIENT_IP_ERROR', { correlationId: rejectionReport.correlationId, source: 'post-login-open', clientIp: clientIpErrLogin.clientIp });
          console.warn(`[IRCTC Automation] Client IP rejection on login form for ticket ${id}: ${rawErr}`);
          this.setBookingStatus(id, 'IRCTC rejected the current automation session (Client IP)', {
            clientIpError: rawErr,
            authResult: {
              success: false,
              stage: 'authentication',
              code: AUTH_CODES.CLIENT_IP_ERROR,
              message: clientIpErrLogin.message || 'The IRCTC website rejected the current client IP/session.',
              displayMessage: 'IRCTC rejected the current automation session (Client IP). Please try again later or verify the network/session.',
              clientIp: clientIpErrLogin.clientIp || null,
              currentUrl: (page.url && typeof page.url === 'function') ? page.url() : '',
              retryable: true,
              details: { rawError: rawErr },
              irctcRejection: rejectionReport,
            },
          });
          return;
        }

        // Stage D: Detect Login Form modal (Stage timeout: 8s)
        const userInput = page
          .locator('input[formcontrolname="userid"], input[placeholder*="User Name" i], input[placeholder*="User ID" i]')
          .first();

        const pwdInput = page
          .locator('input[formcontrolname="password"], input[placeholder*="Password" i], input[type="password"]')
          .first();

        const formAppeared = await userInput.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
        if (!formAppeared) {
          if (await this._isPageAuthenticated(page, account)) {
            alreadyAuth = true;
            logStage(id, 'AUTHENTICATED_EXISTING_SESSION', { user: account.irctcUserId });
            this.setBookingStatus(id, 'Existing IRCTC session detected', {
              authResult: {
                success: true,
                stage: 'authentication',
                code: AUTH_CODES.AUTHENTICATED,
                message: 'Active session reused',
                displayMessage: 'Existing IRCTC session detected',
                reusedSession: true,
              },
            });
          } else {
            const clientIpErrForm = await this._checkForClientIpRejection(page);
            if (clientIpErrForm) {
              const rawErr = clientIpErrForm.raw || clientIpErrForm.message || String(clientIpErrForm);
              const rejectionReport = this._recordIrctcRejectionTelemetry({
                stage: 'LOGIN_FORM_WAIT',
                ticketId: id,
                accountId: targetTicket?.irctcAccountId || activeSession?.accountId || 'unknown',
                browserKey: activeSession?.browserKey || 'chrome',
                page,
                profilePath: path.join(process.cwd(), 'storage', 'automation-profiles', `acc_${targetTicket?.irctcAccountId || activeSession?.accountId}_${activeSession?.browserKey || 'chrome'}`),
                sessionReused: Boolean(activeSession?.reused),
                authState: 'CLIENT_IP_ERROR',
                clientIpError: clientIpErrForm,
              });
              logStage(id, 'CLIENT_IP_ERROR', { correlationId: rejectionReport.correlationId, clientIp: clientIpErrForm.clientIp });
              this.setBookingStatus(id, 'IRCTC rejected the current automation session (Client IP)', {
                clientIpError: rawErr,
                authResult: {
                  success: false,
                  stage: 'authentication',
                  code: AUTH_CODES.CLIENT_IP_ERROR,
                  message: clientIpErrForm.message || 'The IRCTC website rejected the current client IP/session.',
                  displayMessage: 'IRCTC rejected the current automation session (Client IP). Please try again later or verify the network/session.',
                  clientIp: clientIpErrForm.clientIp || null,
                  currentUrl: (page.url && typeof page.url === 'function') ? page.url() : '',
                  retryable: true,
                  details: { rawError: rawErr },
                  irctcRejection: rejectionReport,
                },
              });
              return;
            }

            const secChallengeForm = await this._checkForSecurityChallenge(page);
            if (secChallengeForm) {
              logStage(id, 'SECURITY_CHALLENGE', { type: secChallengeForm.type });
              this.setBookingStatus(id, secChallengeForm.displayMessage, {
                authResult: {
                  success: false,
                  stage: 'authentication',
                  code: AUTH_CODES.SECURITY_CHALLENGE,
                  message: secChallengeForm.message,
                  displayMessage: secChallengeForm.displayMessage,
                  currentUrl: (page.url && typeof page.url === 'function') ? page.url() : '',
                  retryable: true,
                  details: secChallengeForm,
                },
              });
              return;
            }

            const { screenshotPath, diagnostics } = await this._captureSafeDebugArtifact(page, id, {
              stage: 'LOGIN_FORM_NOT_APPEARED',
            });

            logStage(id, 'UNKNOWN_AUTH_STATE', { stage: 'LOGIN_FORM_NOT_APPEARED' });
            this.setBookingStatus(id, 'Error: IRCTC login form was not detected.', {
              authResult: {
                success: false,
                stage: 'authentication',
                code: AUTH_CODES.UNKNOWN_AUTH_STATE,
                message: 'IRCTC login form was not detected.',
                displayMessage: 'IRCTC login form did not appear.',
                retryable: true,
                debugArtifact: screenshotPath,
                details: diagnostics,
              },
            });
            return;
          }
        }
        if (!alreadyAuth) {
          logStage(id, 'LOGIN_FORM_FOUND');
        }

        if (this._ticketBookingState.get(id)?.status === 'Stopped') return;

        // Stage E: Entering Credentials safely (never log values) (Stage timeout: 5s)
        this.setBookingStatus(id, 'Entering Credentials...');
        await userInput.fill(account.irctcUserId);
        await sleep(300);
        await pwdInput.fill(account.password);
        await sleep(400);
        logStage(id, 'CREDENTIALS_FILLED');

        if (this._ticketBookingState.get(id)?.status === 'Stopped') return;

        // Stage F: Check for pre-submission CAPTCHA prompt
        const captchaSelector =
          'app-captcha img, img.captcha-img, #captchaImg, input[formcontrolname*="captcha" i], input[placeholder*="captcha" i]';
        const hasCaptcha = await page.locator(captchaSelector).first().isVisible({ timeout: 1500 }).catch(() => false);

        if (hasCaptcha) {
          logStage(id, 'SECURITY_CHALLENGE', { type: 'CAPTCHA' });
          this.setBookingStatus(id, 'Manual Interaction Required: CAPTCHA', {
            authResult: {
              success: false,
              stage: 'authentication',
              code: AUTH_CODES.CAPTCHA_REQUIRED,
              message: 'IRCTC CAPTCHA challenge detected.',
              displayMessage: 'Manual Verification Required: CAPTCHA',
              currentUrl: (page.url && typeof page.url === 'function') ? page.url() : '',
              retryable: true,
            },
          });
          console.log(`[IRCTC Automation] CAPTCHA challenge detected for ticket ${id}. Pausing for manual interaction.`);
          return;
        }

        // Stage G: Authenticating & Precision Result Detection
        this.setBookingStatus(id, 'Authenticating...');

        // Intercept network auth responses to immediately capture IRCTC server verdicts
        let interceptedAuthResponse = null;
        loginCapturedTokens = null;
        const authResponseListener = async (response) => {
          try {
            const url = response.url ? response.url() : '';
            if (url.includes('/authprovider/webtoken')) {
              let bodyText = '';
              try {
                bodyText = await response.text();
              } catch {}
              interceptedAuthResponse = {
                url,
                status: response.status ? response.status() : 0,
                body: bodyText,
              };
              if (response.status && response.status() === 200 && bodyText) {
                try {
                  const parsed = JSON.parse(bodyText);
                  if (parsed && parsed.access_token) {
                    loginCapturedTokens = {
                      access_token: parsed.access_token,
                      refresh_token: parsed.refresh_token || '',
                      token_type: parsed.token_type || 'bearer',
                      scope: parsed.scope || '',
                      user_name: parsed.user_name || '',
                      userId: parsed.userId || '',
                      lastUpdated: new Date().toISOString(),
                      source: 'login_authprovider',
                    };
                    if (activeSession) activeSession.tokens = loginCapturedTokens;
                    if (page) page.__capturedTokens = Object.assign(page.__capturedTokens || {}, loginCapturedTokens);
                    await page.evaluate((toks) => {
                      try {
                        const cur = JSON.parse(localStorage.getItem('ir:tokens') || '{}');
                        const next = { ...cur, ...toks };
                        localStorage.setItem('ir:tokens', JSON.stringify(next));
                      } catch (_) {}
                    }, loginCapturedTokens).catch(() => {});
                    console.log('[IRCTC Automation][TOKEN_CAPTURED_FROM_LOGIN]', JSON.stringify({
                      hasAccessToken: Boolean(loginCapturedTokens.access_token),
                      hasRefreshToken: Boolean(loginCapturedTokens.refresh_token),
                      user: loginCapturedTokens.user_name,
                    }));
                  }
                } catch (_) {}
              }
            } else if (url.includes('/eticketing/login') || url.includes('/eticketing/captchaImage')) {
              let bodyText = '';
              try {
                bodyText = await response.text();
              } catch {}
              interceptedAuthResponse = {
                url,
                status: response.status ? response.status() : 0,
                body: bodyText,
              };
            }
          } catch {}
        };

        if (page.on) {
          page.on('response', authResponseListener);
        }

        try {
          // Precision Submit Button: strictly scoped to app-login modal (NEVER clicks background "Search Trains")
          const signInBtn = page
            .locator(
              'app-login button[type="submit"]:has-text("SIGN IN"), app-login form button.search_btn:has-text("SIGN IN"), app-login button:has-text("SIGN IN"), app-login button:has-text("साइन इन"), app-login button[type="submit"]'
            )
            .first();

          if (await signInBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
            await signInBtn.click().catch(() => {});
            logStage(id, 'LOGIN_SUBMITTED');
          } else {
            // Fallback inside app-login modal
            const clickedModalBtn = await page.evaluate(() => {
              const modal = document.querySelector('app-login') || document.querySelector('div.modal-content');
              if (!modal) return false;
              const btn = Array.from(modal.querySelectorAll('button')).find((b) =>
                /SIGN IN|साइन इन|LOGIN/i.test(b.innerText || '')
              );
              if (btn) {
                btn.click();
                return true;
              }
              return false;
            }).catch(() => false);
            if (clickedModalBtn) {
              logStage(id, 'LOGIN_SUBMITTED', { via: 'eval-fallback' });
            }
          }

          logStage(id, 'AUTH_RESULT_CHECKING');
          const deadline = Date.now() + 20000;
          let authenticated = false;
          let detectedFailure = null;
          let receivedTokenResponse = false;

          while (Date.now() < deadline) {
            const state = this._ticketBookingState.get(id);
            if (!state || state.status === 'Stopped') return;

            // 1. Check intercepted network response
            if (interceptedAuthResponse) {
              const { url, status, body } = interceptedAuthResponse;
              if (url.includes('/authprovider/webtoken')) {
                if (status === 200 && (body.includes('"access_token"') || body.includes('token_type'))) {
                  // Intermediate network signal: credentials accepted by auth API.
                  // DO NOT mark authenticated = true yet! Real page state verification is required.
                  receivedTokenResponse = true;
                }
                if (body.includes('Invalid User') || body.includes('unauthorized') || body.includes('invalid_grant') || body.includes('Bad credentials')) {
                  let errDesc = 'Invalid User';
                  try {
                    const parsed = JSON.parse(body);
                    errDesc = parsed.error_description || parsed.error || errDesc;
                  } catch {}
                  detectedFailure = {
                    code: AUTH_CODES.INVALID_CREDENTIALS,
                    message: `IRCTC authentication rejected: ${errDesc}`,
                    displayMessage: `Invalid IRCTC Credentials (${errDesc})`,
                    raw: errDesc,
                    retryable: false,
                  };
                  break;
                }
              }

              if (url.includes('/eticketing/login')) {
                if (body.includes('Unable to Process Request') || body.includes('Client IP')) {
                  let clientIp = null;
                  const ipMatch = body.match(/Client IP:\s*([0-9a-f.:]+)/i);
                  if (ipMatch) clientIp = ipMatch[1];
                  detectedFailure = {
                    code: AUTH_CODES.CLIENT_IP_ERROR,
                    message: 'The IRCTC website rejected the current client IP/session.',
                    displayMessage: 'The IRCTC website returned a Client IP error. Please try again later or check the network/IP.',
                    clientIp,
                    raw: body.slice(0, 300),
                    retryable: true,
                  };
                  break;
                }
              }
            }

            // 2. Check for Client IP rejection in DOM
            const clientIpErr = await this._checkForClientIpRejection(page);
            if (clientIpErr) {
              const rawErr = clientIpErr.raw || clientIpErr.message || String(clientIpErr);
              detectedFailure = {
                code: AUTH_CODES.CLIENT_IP_ERROR,
                message: clientIpErr.message || 'The IRCTC website rejected the current client IP/session.',
                displayMessage: clientIpErr.displayMessage || 'The IRCTC website returned a Client IP error. Please try again later or check the network/IP.',
                clientIp: clientIpErr.clientIp || null,
                raw: rawErr,
                retryable: true,
              };
              break;
            }

            // 3. Real Authentication Verification: Check if page/session actually reached authenticated state
            const isPageAuth = await this._isPageAuthenticated(page, account);
            if (isPageAuth) {
              authenticated = true;
              break;
            }

            // 4. Check for visible, non-empty error banner in modal or toast
            const errorMsg = await page
              .evaluate(() => {
                const selectors = [
                  'app-login .loginError',
                  '.loginError',
                  'app-login .text-danger',
                  'app-login div[role="alert"]',
                  'app-login .ui-messages-error .ui-message-text',
                  'app-login .ui-message-error',
                  '.p-toast-detail',
                  '.p-message-detail',
                  '.p-message-error',
                ];
                for (const sel of selectors) {
                  const els = Array.from(document.querySelectorAll(sel));
                  for (const el of els) {
                    const visible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
                    const text = el.innerText ? el.innerText.trim() : '';
                    if (visible && text.length > 0) {
                      return text;
                    }
                  }
                }
                return null;
              })
              .catch(() => null);

            if (errorMsg) {
              const isClientIp = /unable to process request|client ip/i.test(errorMsg);
              if (isClientIp) {
                const ipMatch = errorMsg.match(/client ip\s*:\s*([0-9a-f.:]+)/i);
                detectedFailure = {
                  code: AUTH_CODES.CLIENT_IP_ERROR,
                  message: 'The IRCTC website rejected the current client IP/session.',
                  displayMessage: 'The IRCTC website returned a Client IP error. Please try again later or check the network/IP.',
                  clientIp: ipMatch ? ipMatch[1] : null,
                  raw: errorMsg,
                  retryable: true,
                };
              } else if (/captcha/i.test(errorMsg)) {
                detectedFailure = {
                  code: AUTH_CODES.CAPTCHA_REQUIRED,
                  message: `IRCTC CAPTCHA Error: ${errorMsg}`,
                  displayMessage: `Manual Interaction Required: CAPTCHA (${errorMsg})`,
                  raw: errorMsg,
                  retryable: true,
                };
              } else {
                detectedFailure = {
                  code: AUTH_CODES.INVALID_CREDENTIALS,
                  message: `IRCTC Login Failed: ${errorMsg}`,
                  displayMessage: `Login Failed: ${errorMsg}`,
                  raw: errorMsg,
                  retryable: false,
                };
              }
              break;
            }

            // 5. Check if genuine OTP prompt appeared (strictly excludes otpLogin checkboxes)
            const hasOtp = await this._detectGenuineOtpChallenge(page);
            if (hasOtp) {
              detectedFailure = {
                code: AUTH_CODES.OTP_REQUIRED,
                message: 'IRCTC genuine OTP challenge detected.',
                displayMessage: 'Manual Interaction Required: OTP',
                retryable: true,
              };
              break;
            }

            // 6. Check if CAPTCHA prompt appeared post-submission
            const hasCaptchaPost = await page.locator(captchaSelector).first().isVisible({ timeout: 150 }).catch(() => false);
            if (hasCaptchaPost) {
              detectedFailure = {
                code: AUTH_CODES.CAPTCHA_REQUIRED,
                message: 'IRCTC CAPTCHA prompt detected.',
                displayMessage: 'Manual Interaction Required: CAPTCHA',
                retryable: true,
              };
              break;
            }

            await sleep(400);
          }

          if (detectedFailure) {
            if (detectedFailure.code === AUTH_CODES.CLIENT_IP_ERROR) {
              const rejectionReport = this._recordIrctcRejectionTelemetry({
                stage: 'POST_SUBMIT_AUTH',
                ticketId: id,
                accountId: targetTicket?.irctcAccountId || activeSession?.accountId || 'unknown',
                browserKey: activeSession?.browserKey || 'chrome',
                page,
                profilePath: path.join(process.cwd(), 'storage', 'automation-profiles', `acc_${targetTicket?.irctcAccountId || activeSession?.accountId}_${activeSession?.browserKey || 'chrome'}`),
                sessionReused: Boolean(activeSession?.reused),
                authState: 'POST_SUBMIT_CHECK',
                clientIpError: detectedFailure,
              });
              logStage(id, 'CLIENT_IP_ERROR', { correlationId: rejectionReport.correlationId, clientIp: detectedFailure.clientIp });
              this.setBookingStatus(id, 'IRCTC rejected the current automation session (Client IP)', {
                clientIpError: detectedFailure.raw,
                authResult: {
                  success: false,
                  stage: 'authentication',
                  ...detectedFailure,
                  displayMessage: 'IRCTC rejected the current automation session (Client IP). Please try again later or verify the network/session.',
                  currentUrl: (page.url && typeof page.url === 'function') ? page.url() : '',
                  details: { rawError: detectedFailure.raw },
                  irctcRejection: rejectionReport,
                },
              });
            } else if (detectedFailure.code === AUTH_CODES.CAPTCHA_REQUIRED || detectedFailure.code === AUTH_CODES.OTP_REQUIRED) {
              logStage(id, 'SECURITY_CHALLENGE', { type: detectedFailure.code });
              this.setBookingStatus(id, detectedFailure.displayMessage, {
                authResult: {
                  success: false,
                  stage: 'authentication',
                  ...detectedFailure,
                  currentUrl: (page.url && typeof page.url === 'function') ? page.url() : '',
                },
              });
            } else {
              logStage(id, 'AUTH_FAILURE', { reason: detectedFailure.raw || detectedFailure.message });
              this.setBookingStatus(id, `Login Failed: ${detectedFailure.raw || detectedFailure.message}`, {
                authResult: {
                  success: false,
                  stage: 'authentication',
                  ...detectedFailure,
                  currentUrl: (page.url && typeof page.url === 'function') ? page.url() : '',
                  details: { rawError: detectedFailure.raw },
                },
              });
            }
            return;
          }

          if (!authenticated) {
            // Check whether login modal is still open
            const formStillOpen = await page.locator('app-login, form[name="loginForm"]').first().isVisible().catch(() => false);
            const { screenshotPath, diagnostics } = await this._captureSafeDebugArtifact(page, id, {
              timeoutReached: true,
              formStillOpen,
              lastNetworkStatus: interceptedAuthResponse?.status,
              receivedTokenResponse,
            });

            if (formStillOpen) {
              logStage(id, 'UNKNOWN_AUTH_STATE', { formStillOpen: true });
              this.setBookingStatus(id, 'Login Form Still Present — verification required', {
                authResult: {
                  success: false,
                  stage: 'authentication',
                  code: AUTH_CODES.LOGIN_FORM_STILL_PRESENT,
                  message: 'IRCTC login form did not complete authentication within the timeout period.',
                  displayMessage: 'IRCTC login form is still open. Manual interaction or CAPTCHA may be required.',
                  currentUrl: (page.url && typeof page.url === 'function') ? page.url() : '',
                  retryable: true,
                  debugArtifact: screenshotPath,
                  details: diagnostics,
                },
              });
            } else {
              logStage(id, 'UNKNOWN_AUTH_STATE', { formStillOpen: false, receivedTokenResponse });
              this.setBookingStatus(id, 'Authentication Failed — unrecognized state', {
                authResult: {
                  success: false,
                  stage: 'authentication',
                  code: AUTH_CODES.UNKNOWN_AUTH_STATE,
                  message: 'IRCTC returned an unrecognized authentication state.',
                  displayMessage: 'IRCTC authentication could not be verified on the page (no Logout/user profile detected).',
                  currentUrl: (page.url && typeof page.url === 'function') ? page.url() : '',
                  retryable: true,
                  debugArtifact: screenshotPath,
                  details: diagnostics,
                },
              });
            }
            return;
          }
        } finally {
          if (page.off) {
            page.off('response', authResponseListener);
          } else if (page.removeListener) {
            page.removeListener('response', authResponseListener);
          }
        }
      }

const isReused = Boolean(alreadyAuth);
logStage(id, 'AUTH_SUCCESS', {
  reused: isReused,
  verifiedOnPage: true,
  user: account?.irctcUserId,
});
this.setBookingStatus(id, isReused ? 'Existing IRCTC session detected' : 'Login successful', {
  authResult: {
    success: true,
    stage: 'authentication',
    code: AUTH_CODES.AUTHENTICATED,
    message: isReused ? 'Active session reused' : 'Authentication verified on IRCTC',
    displayMessage: isReused ? 'Existing IRCTC session detected' : 'Login successful',
    currentUrl: (page && page.url && typeof page.url === 'function') ? page.url() : '',
    retryable: false,
    reusedSession: isReused,
  },
});


if (!isReused || restoredFromDisk) {
  try {
    const contextRef = activeSession?.context;
    if (contextRef) {
      const sessionData = await capturePageStorage(page, contextRef).catch(() => null);
      if (sessionData) {
        const sessionAccountId = accountId
          || activeSession?.accountId
          || targetTicket?.irctcAccountId
          || activeSession?.ticket?.irctcAccountId;
        if (sessionAccountId) {
          this.setSessionState(userId, sessionAccountId, {
            storageState: sessionData,
            irctcUserId: account.irctcUserId,
          });
          saveSessionToDisk(userId, sessionAccountId, sessionData);
          const profileDir = activeSession?.profileDir || path.join(
            process.cwd(),
            'storage',
            'automation-profiles',
            `acc_${sessionAccountId}_${activeSession?.browserKey || 'chrome'}`
          );
          await touchProfileCookieFile(contextRef, profileDir);
          const savedCookies = Array.isArray(sessionData.cookies) ? sessionData.cookies : [];
          const usableSaved = this._filterUsableCookies(savedCookies);
          console.log('[IRCTC Automation][LOGIN_COOKIE_SAVE]', JSON.stringify({
            ticketId: id,
            totalCookies: savedCookies.length,
            usableCookies: usableSaved.length,
            hasJsessionId: savedCookies.some((cookie) => cookie.name === 'JSESSIONID'),
            hasSessionStorage: Boolean(sessionData.sessionStorage && Object.keys(sessionData.sessionStorage).length > 0),
          }));
          console.log('[IRCTC Automation] Booking-workflow session persisted to disk.');
        } else {
          console.warn('[IRCTC Automation] Cannot persist session: accountId undefined.');
        }
      }
    }
  } catch (saveErr) {
    console.warn('[IRCTC Automation] Booking-workflow session save failed:', saveErr.message);
  }
}

if (this._ticketBookingState.get(id)?.status === 'Stopped') return;

      // =========================================================================
      // BOOKING ENGINE MODE TOGGLE (RED BOX BACKGROUND DIRECT vs VISUAL DOM DEMO)
      // =========================================================================
      // By default: runs in Red Box direct background mode (fast direct APIs, permanent train-search tab).
      // To run in visual DOM mode for demo: set IRCTC_DIRECT_BOOKING_MODE=false in .env
      const USE_DIRECT_BACKGROUND_MODE = process.env.IRCTC_DIRECT_BOOKING_MODE !== 'false';

      if (USE_DIRECT_BACKGROUND_MODE) {
        console.log(`[IRCTC Automation] Ticket ${id}: Running in Red Box Direct Background Mode...`);
        const directRunner = require('./irctcDirectBookingRunner');
        const directResult = await directRunner.executeDirectBooking(
          page,
          id,
          targetTicket,
          account,
          {
            stopPayment,
            automationService: this,
            capturedTokens: activeSession?.tokens || page?.__capturedTokens || loginCapturedTokens || null,
          }
        );
        console.log(`[IRCTC Automation] Ticket ${id} direct booking flow finished:`, JSON.stringify(directResult));
        return;
      }

      console.log(`[IRCTC Automation] Ticket ${id}: Running in VISUAL DOM MODE (Full Chrome Screen UI Visible for Client Demo)`);

      // =========================================================================
      // PHASE 2: REAL IRCTC TRAIN SEARCH, TRAIN SELECTION, & BOOK NOW ENTRY (FALLBACK)
      // =========================================================================

      // STEP 2: Verify and ensure the page is ready on the IRCTC train search page
      let bookingUrl = (page && page.url && typeof page.url === 'function') ? page.url() : '';
      if (!bookingUrl.includes('irctc.co.in/nget/train-search') && !bookingUrl.includes('/nget/train-search')) {
        const trainSearchUrl = this.config.SECONDARY_WEB_URL || 'https://www.irctc.co.in/nget/train-search';
        console.log(`[IRCTC Automation] Forcing navigation to train-search from ${bookingUrl}`);
        try {
          await this._gotoWithDiagnostics(page, trainSearchUrl, {
            ticketId: id,
            accountId: targetTicket?.irctcAccountId || activeSession?.accountId,
            browser: activeSession?.browserConfig?.name || activeSession?.browserKey,
            sessionKey: this.getSessionLockKey(
              targetTicket?.irctcAccountId || activeSession?.accountId,
              activeSession?.browserKey
            ),
            profileIdentifier: activeSession?.profileDir || null,
            timeout: 20000,
            waitUntil: 'domcontentloaded',
          });
        } catch (navErr) {
          console.warn('[IRCTC Automation] Navigation to train-search failed:', navErr.message);
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        }
      }

      // Dismiss any lingering welcome dialogs/overlays
      await this._handleLanguageAndAlerts(page);

      const originReadyAfterNavigation = await page.locator(
        'p-autocomplete[formcontrolname="origin"] input, #origin input'
      ).first().waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
      if (!originReadyAfterNavigation) {
        await this._handleLanguageAndAlerts(page);
        await page.keyboard.press('Escape').catch(() => {});
      }

      // Verify origin input field is present and visible
      const originInputLocator = page.locator('p-autocomplete[formcontrolname="origin"] input, #origin input').first();
      let originReady = await originInputLocator.waitFor({ state: 'visible', timeout: 12000 }).then(() => true).catch(() => false);
      if (!originReady) {
        await page.keyboard.press('Escape').catch(() => {});
        await this._handleLanguageAndAlerts(page);
        originReady = await originInputLocator.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
        if (!originReady) {
          throw new Error('IRCTC train search page is not ready or Origin input field was not found.');
        }
      }

      // STEP 3: Real From Station
      if (this._ticketBookingState.get(id)?.status === 'Stopped') return;

      const cleanFrom = String(targetTicket?.fromStation || '').trim().toUpperCase();
      if (!cleanFrom) {
        throw new Error('Ticket is missing From Station.');
      }

      this.setBookingStatus(id, `Entering From Station (${cleanFrom})...`, { authResult: null });
      console.log(`[IRCTC Automation] Entering From Station for ticket ${id}: ${cleanFrom}`);

      await originInputLocator.click({ force: true });
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await originInputLocator.pressSequentially(cleanFrom, { delay: 90 });

      // Wait for autocomplete suggestions listbox
      const fromListbox = page.locator('ul[role="listbox"], .ui-autocomplete-items').first();
      await fromListbox.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

      const fromOption = page
        .locator('ul[role="listbox"] li, .ui-autocomplete-items li')
        .filter({ hasText: cleanFrom })
        .first();
      const fromOptionVisible = await fromOption.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);

      if (fromOptionVisible) {
        await fromOption.click({ force: true });
      } else {
        const firstFromOption = page.locator('ul[role="listbox"] li:not(:has-text("---")), .ui-autocomplete-items li:not(:has-text("---"))').first();
        if (await firstFromOption.isVisible({ timeout: 1000 }).catch(() => false)) {
          await firstFromOption.click({ force: true });
        } else {
          await page.keyboard.press('ArrowDown');
          await page.keyboard.press('Enter');
        }
      }
      await sleep(400);

      const fromCommitted = await originInputLocator.inputValue().catch(() => '');
      if (!fromCommitted || fromCommitted.trim() === '') {
        throw new Error(`Failed to commit From Station "${cleanFrom}" on IRCTC.`);
      }
      console.log(`[IRCTC Automation] From Station committed on IRCTC: "${fromCommitted}"`);

      // STEP 4: Real To Station
      if (this._ticketBookingState.get(id)?.status === 'Stopped') return;

      const cleanTo = String(targetTicket?.toStation || '').trim().toUpperCase();
      if (!cleanTo) {
        throw new Error('Ticket is missing To Station.');
      }
      if (cleanFrom === cleanTo) {
        throw new Error('From Station and To Station cannot be the same.');
      }

      this.setBookingStatus(id, `Entering To Station (${cleanTo})...`, { authResult: null });
      console.log(`[IRCTC Automation] Entering To Station for ticket ${id}: ${cleanTo}`);

      const destInputLocator = page.locator('p-autocomplete[formcontrolname="destination"] input, #destination input').first();
      await destInputLocator.waitFor({ state: 'visible', timeout: 10000 });
      await destInputLocator.click({ force: true });
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await destInputLocator.pressSequentially(cleanTo, { delay: 90 });

      const toListbox = page.locator('ul[role="listbox"], .ui-autocomplete-items').first();
      await toListbox.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

      const toOption = page
        .locator('ul[role="listbox"] li, .ui-autocomplete-items li')
        .filter({ hasText: cleanTo })
        .first();
      const toOptionVisible = await toOption.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);

      if (toOptionVisible) {
        await toOption.click({ force: true });
      } else {
        const firstToOption = page.locator('ul[role="listbox"] li:not(:has-text("---")), .ui-autocomplete-items li:not(:has-text("---"))').first();
        if (await firstToOption.isVisible({ timeout: 1000 }).catch(() => false)) {
          await firstToOption.click({ force: true });
        } else {
          await page.keyboard.press('ArrowDown');
          await page.keyboard.press('Enter');
        }
      }
      await sleep(400);

      const toCommitted = await destInputLocator.inputValue().catch(() => '');
      if (!toCommitted || toCommitted.trim() === '') {
        throw new Error(`Failed to commit To Station "${cleanTo}" on IRCTC.`);
      }
      console.log(`[IRCTC Automation] To Station committed on IRCTC: "${toCommitted}"`);

      // STEP 5: Real Journey Date
      if (this._ticketBookingState.get(id)?.status === 'Stopped') return;

      const canonicalJourneyDate = normalizeJourneyDate(targetTicket?.journeyDate);
      if (targetTicket) {
        targetTicket.journeyDate = canonicalJourneyDate;
      }
      const formattedDate = formatJourneyDateForIrctc(canonicalJourneyDate);
      const [year, , day] = canonicalJourneyDate.split('-');

      this.setBookingStatus(id, `Setting Journey Date (${formattedDate})...`, { authResult: null });
      console.log(`[IRCTC Automation] Setting Journey Date for ticket ${id}: ${formattedDate} (canonical: ${canonicalJourneyDate})`);

      const dateInput = page.locator('p-calendar[formcontrolname="journeyDate"] input, input[placeholder*="Date"]').first();
      await dateInput.waitFor({ state: 'visible', timeout: 8000 });
      await dateInput.click({ force: true });
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await dateInput.pressSequentially(formattedDate, { delay: 40 });
      await page.keyboard.press('Tab');
      // Close PrimeNG calendar overlay with Escape so it doesn't block search button
      await page.keyboard.press('Escape');
      await sleep(300);

      let dateCommitted = await dateInput.inputValue().catch(() => '');
      if (!dateCommitted || /[a-z]/i.test(dateCommitted) || !dateCommitted.includes(day) || !dateCommitted.includes(year)) {
        await page.evaluate(({ sel, val }) => {
          const input = document.querySelector(sel);
          if (input) {
            input.value = val;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, { sel: 'p-calendar[formcontrolname="journeyDate"] input, input[placeholder*="Date"]', val: formattedDate }).catch(() => {});
        dateCommitted = await dateInput.inputValue().catch(() => '');
      }

      if (!dateCommitted || /[a-z]/i.test(dateCommitted) || !dateCommitted.includes(day) || !dateCommitted.includes(year)) {
        throw new Error(`Failed to commit Journey Date "${formattedDate}" on IRCTC calendar.`);
      }
      console.log(`[IRCTC Automation] Journey Date committed on IRCTC: "${dateCommitted}"`);

      // STEP 6: Real Quota
      if (this._ticketBookingState.get(id)?.status === 'Stopped') return;

      const quotaMap = {
        GENERAL: 'GENERAL',
        GN: 'GENERAL',
        LADIES: 'LADIES',
        LD: 'LADIES',
        TATKAL: 'TATKAL',
        TQ: 'TATKAL',
        'PREMIUM TATKAL': 'PREMIUM TATKAL',
        PREMIUM_TATKAL: 'PREMIUM TATKAL',
        PT: 'PREMIUM TATKAL',
      };
      const rawQuota = String(targetTicket?.quota || 'General').trim().toUpperCase();
      const targetQuotaLabel = quotaMap[rawQuota] || 'GENERAL';

      if (targetQuotaLabel !== 'GENERAL') {
        this.setBookingStatus(id, `Selecting Quota (${targetQuotaLabel})...`, { authResult: null });
        console.log(`[IRCTC Automation] Selecting Quota for ticket ${id}: ${targetQuotaLabel}`);

        const quotaDropdown = page.locator('p-dropdown[formcontrolname="journeyQuota"], #journeyQuota').first();
        if (await quotaDropdown.isVisible({ timeout: 4000 }).catch(() => false)) {
          await quotaDropdown.click({ force: true });
          await sleep(400);

          const quotaOption = page
            .locator('p-dropdownitem li, .ui-dropdown-items li, .p-dropdown-items li')
            .filter({ hasText: targetQuotaLabel })
            .first();
          if (await quotaOption.isVisible({ timeout: 3000 }).catch(() => false)) {
            await quotaOption.click({ force: true });
          } else {
            console.warn(`[IRCTC Automation] Quota option ${targetQuotaLabel} not found in dropdown list.`);
          }
          await page.keyboard.press('Escape').catch(() => {});
          await sleep(200);
        }
      }

      // STEP 7: Real Search Button & Train List
      if (this._ticketBookingState.get(id)?.status === 'Stopped') return;

      this.setBookingStatus(id, 'Searching Train...', { authResult: null });
      console.log(`[IRCTC Automation] Submitting train search on IRCTC for ticket ${id}...`);

      await page.keyboard.press('Escape').catch(() => {});
      await sleep(200);

      const searchBtn = page.locator('button.search_btn, button[type="submit"]:has-text("Search"), button:has-text("Search")').first();
      await searchBtn.waitFor({ state: 'visible', timeout: 6000 });
      await searchBtn.click({ force: true });
      logStage(id, 'SEARCH_SUBMITTED');

      const resultWaitTimeout = 60000;
      await Promise.race([
        page.waitForURL(/booking\/train-list/, { timeout: resultWaitTimeout }).catch(() => {}),
        page.locator('app-train-list, app-train-avl-enq').first().waitFor({ state: 'attached', timeout: resultWaitTimeout }).catch(() => {}),
      ]);

      const postSearchTitle = (await page.title().catch(() => '')) || '';
      if (postSearchTitle.includes('Access Denied')) {
        throw new Error('IRCTC access was blocked by portal firewall (Akamai Access Denied).');
      }

      // Check for Client IP rejection after search submission
      const clientIpErrSearch = await this._checkForClientIpRejection(page);
      if (clientIpErrSearch) {
        throw new Error(`IRCTC Client IP error during train search: ${clientIpErrSearch.message || 'Unable to Process Request'}`);
      }

      const noTrainsMsg = await page
        .locator('text="No direct trains", text="No trains found", text="Trains are not available"')
        .first()
        .isVisible({ timeout: 2000 })
        .catch(() => false);
      if (noTrainsMsg) {
        throw new Error(`No trains found on IRCTC for route ${cleanFrom} -> ${cleanTo} on ${formattedDate}.`);
      }

      let avlCount = await page.locator('app-train-avl-enq').count().catch(() => 0);
      let trainCardsLocator = avlCount > 0
        ? page.locator('app-train-avl-enq')
        : page.locator('.train-heading, .form-group.no-pad');
      await trainCardsLocator.first().waitFor({ state: 'attached', timeout: 20000 }).catch(() => {});
      let totalCards = await trainCardsLocator.count().catch(() => 0);

      if (totalCards === 0) {
        console.warn('[IRCTC Automation] No train cards yet; waiting additional 15s...');
        await sleep(5000);
        avlCount = await page.locator('app-train-avl-enq').count().catch(() => 0);
        trainCardsLocator = avlCount > 0
          ? page.locator('app-train-avl-enq')
          : page.locator('.train-heading, .form-group.no-pad');
        totalCards = await trainCardsLocator.count().catch(() => 0);
      }

      if (totalCards === 0) {
        const noTrainsFallback = await page
          .locator('text="No direct trains", text="No trains found", text="Trains are not available", text="No train found"')
          .first().isVisible({ timeout: 1000 }).catch(() => false);
        if (noTrainsFallback) {
          throw new Error(`No trains found on IRCTC for route ${cleanFrom} -> ${cleanTo} on ${formattedDate}.`);
        }
        throw new Error('IRCTC train search results did not load or timed out. No train cards rendered in DOM.');
      }
      console.log(`[IRCTC Automation] IRCTC train list loaded with ${totalCards} train cards.`);
      logStage(id, 'TRAIN_SEARCH_SUCCESS', { count: totalCards });
      this.setBookingStatus(id, `Train Search Completed — Results Verified (${totalCards} trains)`, { authResult: null, trainCount: totalCards });

      // STEP 8: Find the Selected Train (if specified)
      if (this._ticketBookingState.get(id)?.status === 'Stopped') return;

      const targetTrainNo = String(targetTicket?.trainNumber || '').trim();
      let selectedAvailability = 'AVAILABLE';
      let targetClass = String(targetTicket?.selectedClass || '3A').trim().toUpperCase();
      let matchingTrainCard = null;

      if (targetTrainNo) {
        this.setBookingStatus(id, `Selecting Train (${targetTrainNo})...`, { authResult: null, trainCount: totalCards });
        console.log(`[IRCTC Automation] Searching for target train ${targetTrainNo} in IRCTC results...`);

        matchingTrainCard = page.locator('app-train-avl-enq, .form-group.no-pad')
          .filter({ hasText: targetTrainNo })
          .first();

        const trainFound = await matchingTrainCard.waitFor({ state: 'attached', timeout: 8000 }).then(() => true).catch(() => false);
        if (!trainFound) {
          throw new Error(`Selected train ${targetTrainNo} not found on IRCTC result list.`);
        }

        await matchingTrainCard.scrollIntoViewIfNeeded().catch(() => {});
        console.log(`[IRCTC Automation] Train card for ${targetTrainNo} located successfully.`);
        logStage(id, 'TRAIN_FOUND_IN_RESULTS', { trainNumber: targetTrainNo });

        // STEP 9: Select Class
        if (this._ticketBookingState.get(id)?.status === 'Stopped') return;

        console.log(`[IRCTC Automation] Selecting class ${targetClass} on train ${targetTrainNo}...`);

        const classControls = matchingTrainCard.locator(
          'button, [role="button"], input, a, li, span, div.pre-avl, [class*="pre-avl"], [role="tab"]'
        );
        const classMetadata = await classControls.evaluateAll((elements) => elements.map((element, index) => ({
          index,
          tagName: element.tagName,
          text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim(),
          ariaLabel: element.getAttribute('aria-label') || '',
          title: element.getAttribute('title') || '',
          value: element.getAttribute('value') || '',
          dataClass: element.getAttribute('data-class') || element.getAttribute('data-coach') || '',
          className: typeof element.className === 'string' ? element.className : '',
        }))).catch(() => []);
        const detectedClasses = classMetadata
          .map((metadata) => normalizeIrctcClassCode([
            metadata.text,
            metadata.ariaLabel,
            metadata.title,
            metadata.value,
            metadata.dataClass,
          ].join(' ')))
          .filter(Boolean);
        console.log('[IRCTC][TRAIN_CLASS_INSPECTION]', JSON.stringify({
          trainNumber: targetTrainNo,
          requestedClass: targetClass,
          detectedClasses: [...new Set(detectedClasses)],
          classControls: classMetadata.length,
          controls: classMetadata.map((metadata) => ({
            index: metadata.index,
            tagName: metadata.tagName,
            text: metadata.text,
            ariaLabel: metadata.ariaLabel,
            title: metadata.title,
            value: metadata.value,
            dataClass: metadata.dataClass,
          })),
        }));

        const matchingClassIndexes = classMetadata
          .map((metadata, index) => ({
            index,
            metadata,
            classCode: normalizeIrctcClassCode([
              metadata.text,
              metadata.ariaLabel,
              metadata.title,
              metadata.value,
              metadata.dataClass,
            ].join(' ')),
          }))
          .filter(({ classCode }) => classCode === targetClass);
        const preferredClassControl = matchingClassIndexes.sort((left, right) => {
          const leftTextLength = left.metadata.text.length;
          const rightTextLength = right.metadata.text.length;
          const leftIsTab = /^(A|BUTTON|LI|INPUT)$/.test(left.metadata.tagName) || /pre-avl|tab/i.test(left.metadata.className);
          const rightIsTab = /^(A|BUTTON|LI|INPUT)$/.test(right.metadata.tagName) || /pre-avl|tab/i.test(right.metadata.className);
          return Number(rightIsTab) - Number(leftIsTab) || leftTextLength - rightTextLength;
        })[0];
        const targetClassIndex = preferredClassControl?.index ?? -1;
        if (targetClassIndex < 0) {
          throw new Error(`Requested class "${targetClass}" not found on train ${targetTrainNo} in IRCTC results.`);
        }

        const classTab = classControls.nth(targetClassIndex);
        await classTab.waitFor({ state: 'visible', timeout: 6000 });
        await classTab.click({ force: true });
        await sleep(1000);
        const selectionVerified = await classTab.evaluate((element) => {
          const className = typeof element.className === 'string' ? element.className : '';
          return element.getAttribute('aria-selected') === 'true' ||
            element.getAttribute('aria-pressed') === 'true' ||
            element.getAttribute('data-selected') === 'true' ||
            /\b(?:active|selected|ui-state-active)\b/i.test(className);
        }).catch(() => false);
        if (!selectionVerified) {
          const selectedControlCount = await matchingTrainCard.locator(
            '[aria-selected="true"], [aria-pressed="true"], [data-selected="true"], .active, .selected, .ui-state-active'
          ).count().catch(() => 0);
          if (selectedControlCount === 0) {
            throw new Error(`IRCTC class "${targetClass}" was found on train ${targetTrainNo}, but selection could not be verified.`);
          }
        }

        // STEP 10: Real Availability (Read from live IRCTC result, NEVER from Ghumo)
        if (this._ticketBookingState.get(id)?.status === 'Stopped') return;

        const canonicalJourneyDate = normalizeJourneyDate(targetTicket?.journeyDate);
        const availabilityCards = matchingTrainCard.locator('div.pre-avl, .availability-cache, [class*="pre-avl"]');
        await availabilityCards.first().waitFor({ state: 'visible', timeout: 10000 });
        const availabilityDeadline = Date.now() + IRCTC_STATE_WAIT_TIMEOUT_MS;
        let availabilityMetadata = [];
        while (Date.now() < availabilityDeadline) {
          availabilityMetadata = await availabilityCards.evaluateAll((elements) => elements.map((element, index) => ({
            index,
            text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim(),
            className: typeof element.className === 'string' ? element.className : '',
            ariaSelected: element.getAttribute('aria-selected'),
            dataSelected: element.getAttribute('data-selected'),
          }))).catch(() => []);
          if (availabilityMetadata.some((metadata) =>
            extractIrctcAvailabilityDate(metadata.text, canonicalJourneyDate.slice(0, 4)) === canonicalJourneyDate
          )) {
            break;
          }
          await sleep(IRCTC_STATE_POLL_INTERVAL_MS);
        }
        console.log('[IRCTC][AVAILABILITY_CARDS_DETECTED]', JSON.stringify({
          trainNumber: targetTrainNo,
          journeyDate: canonicalJourneyDate,
          cards: availabilityMetadata.map(({ index, text, className }) => ({ index, text, className })),
        }));

        const targetYear = canonicalJourneyDate.slice(0, 4);
        const targetCard = availabilityMetadata.find((metadata) =>
          extractIrctcAvailabilityDate(metadata.text, targetYear) === canonicalJourneyDate
        );
        if (!targetCard) {
          throw new Error(`Requested journey date "${canonicalJourneyDate}" was not found in availability cards for train ${targetTrainNo}.`);
        }
        console.log('[IRCTC][TARGET_DATE_CARD_FOUND]', JSON.stringify({
          trainNumber: targetTrainNo,
          journeyDate: canonicalJourneyDate,
          cardIndex: targetCard.index,
        }));

        const targetAvailabilityCard = availabilityCards.nth(targetCard.index);
        const wasSelected = targetCard.ariaSelected === 'true' ||
          targetCard.dataSelected === 'true' ||
          /\b(?:active|selected|ui-state-active)\b/i.test(targetCard.className);
        if (!wasSelected) {
          await targetAvailabilityCard.click();
          await sleep(300);
        }
        const selectedCardState = await targetAvailabilityCard.evaluate((element) => ({
          selected: element.getAttribute('aria-selected') === 'true' ||
            element.getAttribute('data-selected') === 'true' ||
            /\b(?:active|selected|ui-state-active)\b/i.test(typeof element.className === 'string' ? element.className : ''),
        })).catch(() => ({ selected: false }));
        if (!wasSelected && !selectedCardState.selected) {
          throw new Error(`Journey date availability card "${canonicalJourneyDate}" could not be selected for train ${targetTrainNo}.`);
        }
        logStage(id, 'TARGET_DATE_CARD_SELECTED', { trainNumber: targetTrainNo, journeyDate: canonicalJourneyDate });

        const cardText = (await targetAvailabilityCard.innerText().catch(() => '')) || '';
        const avlMatch = cardText.match(/\b(AVAILABLE[-\s]?\d+|CURR_AVBL[-\s]?\d+|RAC\s*\d+|WL\s*\d+|RLWL\s*\d+|PQWL\s*\d+|GNWL\s*\d+|REGRET|NOT AVAILABLE|TRAIN CANCELLED)\b/i);
        if (avlMatch) {
          selectedAvailability = avlMatch[0].toUpperCase();
        }
        console.log(`[IRCTC Automation] Real IRCTC availability for train ${targetTrainNo} (${targetClass}): ${selectedAvailability}`);

        if (/REGRET|NOT AVAILABLE|TRAIN CANCELLED/i.test(selectedAvailability)) {
          this.setBookingStatus(id, `Train Unavailable on IRCTC: ${selectedAvailability}`, {
            availability: selectedAvailability,
            businessError: 'TRAIN_NOT_AVAILABLE',
            suggestion: 'Try a different date or class',
          });
          const notAvailableErr = new Error(
            `Train ${targetTrainNo} (${targetClass}) is unavailable on IRCTC: ${selectedAvailability}`
          );
          notAvailableErr.code = 'TRAIN_NOT_AVAILABLE';
          notAvailableErr.businessError = true;
          notAvailableErr.retryable = false;
          throw notAvailableErr;
        }

        this.setBookingStatus(id, `Train Selected (${targetTrainNo} - ${targetClass})... [ ${selectedAvailability} ]`, {
          authResult: null,
          availability: selectedAvailability,
          trainCount: totalCards,
          trainFound: true,
          stage: 'train_search_completed',
        });
      }

      // STEP 11: Real Book Now Entry
      if (this._ticketBookingState.get(id)?.status === 'Stopped') return;

      this.setBookingStatus(id, 'Opening Passenger Details...', {
        authResult: null,
        availability: selectedAvailability,
      });
      console.log(`[IRCTC Automation] Clicking Book Now for train ${targetTrainNo} (${targetClass})...`);

      if (!matchingTrainCard) {
        throw new Error(`Target train ${targetTrainNo || 'requested train'} was not retained for Book Now selection.`);
      }
      const bookNowBtn = matchingTrainCard
        .locator('button:has-text("Book Now"), button.btnDefault:has-text("Book Now"), a:has-text("Book Now")')
        .first();
      await bookNowBtn.waitFor({ state: 'visible', timeout: 10000 });
      await bookNowBtn.waitFor({ state: 'enabled', timeout: 15000 }).catch(() => {});
      const bookNowState = await bookNowBtn.evaluate((element) => ({
        disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
        visible: Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length),
      })).catch(() => ({ disabled: true, visible: false }));
      if (!bookNowState.visible || bookNowState.disabled) {
        throw new Error(`IRCTC "Book Now" remains disabled for train ${targetTrainNo} (${targetClass}) after availability selection.`);
      }
      await bookNowBtn.click();

      // Handle legitimate IRCTC confirmation / guidelines / advisory popups
      await sleep(1000);
      const confirmDialogBtn = page.locator(`
        p-dialog button:has-text("I Agree"),
        p-dialog button:has-text("Agree"),
        p-dialog button:has-text("Yes"),
        p-dialog button:has-text("OK"),
        .ui-dialog button:has-text("I Agree"),
        .ui-dialog button:has-text("Agree"),
        .ui-dialog button:has-text("Yes"),
        .ui-dialog button:has-text("OK"),
        button:has-text("I Agree"),
        button:has-text("Agree")
      `).first();

      if (await confirmDialogBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log('[IRCTC Automation] Dismissing IRCTC confirmation / advisory modal...');
        await confirmDialogBtn.click({ force: true }).catch(() => {});
      }

      // Wait for navigation and verification of the IRCTC Passenger Input page
      console.log('[IRCTC Automation] Awaiting navigation to /booking/psgninput...');
      const passengerPageDeadline = Date.now() + 25000;
      let passengerPageEnteredAt = Date.now();
      while (Date.now() < passengerPageDeadline) {
        const currentUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
        const passengerPageReached = /\/booking\/(?:passengerInput|psgninput)/i.test(currentUrl) ||
          await page.locator('app-passenger-input, input[formcontrolname="passengerName"]')
            .first().isVisible({ timeout: 300 }).catch(() => false);
        if (passengerPageReached) {
          passengerPageEnteredAt = Date.now();
          break;
        }
        if (await this._isLoginCardVisible(page)) {
          throw new Error(`LOGIN_CARD_DETECTED_AFTER_BOOK_NOW: url=${currentUrl}`);
        }
        await sleep(400);
      }

      const postBookUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
      const psgnInputVisible = await page.locator('app-passenger-input, input[formcontrolname="passengerName"]').first().isVisible({ timeout: 5000 }).catch(() => false);

      if (!postBookUrl.includes('/booking/psgninput') && !psgnInputVisible) {
        throw new Error(`Failed to reach IRCTC passenger input page. Current URL: ${postBookUrl}`);
      }

      await this._fillPassengerDetails(page, targetTicket?.passengers);
      await this._fillPassengerPreferences(page, targetTicket);
      await this._continueFromPassengerToPayment(page, targetTicket, id, {
        stopPayment: Boolean(this._ticketBookingState.get(id)?.stopPayment),
        account,
        userId,
        availability: selectedAvailability,
        passengerPageEnteredAt,
      });
      console.log(`[IRCTC Automation] Passenger, review, and payment stages progressed for ticket ${id}.`);
    } catch (flowErr) {
      // Capture a screenshot + body snippet on any failure for post-mortem debugging
      try {
        const debugDir = path.join(process.cwd(), 'storage', 'debug');
        if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
        const url = (page.url && typeof page.url === 'function') ? page.url() : 'unknown';
        const safeUrl = url.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
        await page.screenshot({
          path: path.join(debugDir, `fail_${id}_${safeUrl}_${Date.now()}.png`),
          fullPage: true,
        }).catch(() => {});
        const bodyText = await page.locator('body').innerText({ timeout: 2000 })
          .then((t) => t.replace(/\s+/g, ' ').slice(0, 500))
          .catch(() => '');
        console.error('[IRCTC Automation][FAIL_DEBUG]', JSON.stringify({
          ticketId: id,
          url,
          error: flowErr.message,
          bodySnippet: bodyText,
        }));
      } catch (dbgErr) {
        console.warn('[IRCTC Automation][FAIL_DEBUG_CAPTURE_FAILED]', dbgErr.message);
      }

      if (await this._isLoginCardVisible(page)) {
        if (midLoginRetries >= 2) {
          const retryError = new Error('MID_WORKFLOW_LOGIN_RETRY_LIMIT_REACHED');
          console.error(`[IRCTC Automation][MID_WORKFLOW_LOGIN_FAILED] ticket=${id}`, retryError.message);
          this.setBookingStatus(id, `Error: ${retryError.message}`);
          return;
        }

        console.warn(
          `[IRCTC Automation][MID_WORKFLOW_LOGIN_REQUIRED] ticket=${id} ` +
          `attempt=${midLoginRetries + 1} reason=${flowErr?.message || 'login card detected'}`
        );

        let restoredMidFlow = false;
        try {
          const restoreAccountId = accountId
            || targetTicket?.irctcAccountId
            || activeSession?.accountId;
          if (restoreAccountId && activeSession?.context) {
            restoredMidFlow = await this._tryRestoreSessionFromDisk(
              page,
              activeSession.context,
              userId,
              restoreAccountId,
              id,
              account
            );
          }
        } catch (restoreErr) {
          console.warn('[IRCTC Automation][MID_WORKFLOW_COOKIE_RESTORE_ERROR]', restoreErr.message);
        }

        if (restoredMidFlow) {
          console.log('[IRCTC Automation][MID_WORKFLOW_COOKIE_RESTORE_SUCCESS]', JSON.stringify({ ticketId: id }));
          const trainSearchUrl = this.config.SECONDARY_WEB_URL || 'https://www.irctc.co.in/nget/train-search';
          try {
            await this._gotoWithDiagnostics(page, trainSearchUrl, {
              ticketId: id,
              accountId: accountId || targetTicket?.irctcAccountId || activeSession?.accountId,
              browser: activeSession?.browserConfig?.name || activeSession?.browserKey,
              sessionKey: this.getSessionLockKey(
                accountId || targetTicket?.irctcAccountId || activeSession?.accountId,
                activeSession?.browserKey
              ),
              profileIdentifier: activeSession?.profileDir || null,
              timeout: this.config.NAVIGATION_TIMEOUT_MS || 35000,
            });
          } catch (navErr) {
            console.warn('[IRCTC Automation][MID_WORKFLOW_RESTORE_NAV_FAILED]', navErr.message);
          }
          await this._handleLanguageAndAlerts(page);
          return await this._runRealBookingWorkflow(userId, id, activeSession, {
            stopPayment,
            ticket: targetTicket,
            midLoginRetries: midLoginRetries + 1,
          });
        }

        try {
          await this._performInlineLogin(page, account, id);
        } catch (loginErr) {
          console.error(`[IRCTC Automation][MID_WORKFLOW_LOGIN_FAILED] ticket=${id}`, loginErr.message);
          this.setBookingStatus(id, `Error: ${loginErr.message}`);
          return;
        }

        const sessionAccountId = accountId
          || targetTicket?.irctcAccountId
          || activeSession?.accountId;
        const context = activeSession?.context;
        if (context) {
          try {
            const sessionData = await capturePageStorage(page, context);
            if (sessionAccountId && sessionData) {
              this.setSessionState(userId, sessionAccountId, {
                storageState: sessionData,
                irctcUserId: account.irctcUserId,
              });
              saveSessionToDisk(userId, sessionAccountId, sessionData);
              const savedCookies = Array.isArray(sessionData.cookies) ? sessionData.cookies : [];
              console.log('[IRCTC Automation][LOGIN_COOKIE_SAVE]', JSON.stringify({
                ticketId: id,
                totalCookies: savedCookies.length,
                usableCookies: this._filterUsableCookies(savedCookies).length,
                hasJsessionId: savedCookies.some((cookie) => cookie.name === 'JSESSIONID'),
                hasSessionStorage: Boolean(sessionData.sessionStorage && Object.keys(sessionData.sessionStorage).length > 0),
              }));
            }
            const profileDir = activeSession?.profileDir || path.join(
              process.cwd(),
              'storage',
              'automation-profiles',
              `acc_${sessionAccountId}_${activeSession?.browserKey || 'chrome'}`
            );
            await touchProfileCookieFile(context, profileDir);
          } catch (saveErr) {
            console.warn('[IRCTC Automation] Inline-login session save failed:', saveErr.message);
          }
        }

        const trainSearchUrl = this.config.SECONDARY_WEB_URL || 'https://www.irctc.co.in/nget/train-search';
        try {
          await this._gotoWithDiagnostics(page, trainSearchUrl, {
            ticketId: id,
            accountId: sessionAccountId,
            browser: activeSession?.browserConfig?.name || activeSession?.browserKey,
            sessionKey: this.getSessionLockKey(
              sessionAccountId,
              activeSession?.browserKey
            ),
            profileIdentifier: activeSession?.profileDir || null,
            timeout: this.config.NAVIGATION_TIMEOUT_MS || 35000,
          });
        } catch (navErr) {
          const restartError = new Error(`MID_WORKFLOW_NAVIGATION_FAILED: ${navErr.message}`);
          console.error(`[IRCTC Automation][MID_WORKFLOW_NAV_FAILED] ticket=${id}`, navErr.message);
          this.setBookingStatus(id, `Error: ${restartError.message}`);
          return;
        }
        await this._handleLanguageAndAlerts(page);
        console.log(`[IRCTC Automation][MID_WORKFLOW_RESTART] ticket=${id} attempt=${midLoginRetries + 1}`);
        return await this._runRealBookingWorkflow(userId, id, activeSession, {
          stopPayment,
          ticket: targetTicket,
          midLoginRetries: midLoginRetries + 1,
        });
      }

      console.error(`[IRCTC Automation] Workflow error for ticket ${id}:`, flowErr);
      this.setBookingStatus(id, `Error: ${flowErr.message}`);
    } finally {
      this._activeBookings.delete(id);
    }
  }

  /**
   * Monitor real payment gateway / IRCTC payment screen in the active browser.
   * Detects real QR code from payment gateway (if rendered), observes client-selected payment method,
   * watches for confirmation / PNR extraction, and enforces the payment timeout.
   */
  async _monitorRealPaymentWorkflow(page, ticketId, { stopPayment = false, targetTicket, account, liveAvailabilityString, userId }) {
  const id = Number(ticketId);
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return;

  let toolService = null;
  try {
    toolService = require('../../services/toolService');
  } catch (reqErr) {
    console.warn('[IRCTC Automation] toolService not available:', reqErr.message);
  }

    const startTime = Date.now();
    const MAX_WAIT_MS = IRCTC_PAYMENT_ACTION_TIMEOUT_MS;
    // Persist QR capture state across loop iterations.
    let qrDetected = false;
    let lastQrDataUrl = null;
    let lastQrFilePath = null;
    let lastQrSourceType = null;

    while (Date.now() - startTime < MAX_WAIT_MS) {
      // 1. Check if user manually stopped or closed booking
      const currentState = this._ticketBookingState.get(id);
      if (!currentState || currentState.status === 'Stopped' || !this._activeBookings.has(id)) {
        break;
      }

      // 2. Check if page was closed
      if (typeof page.isClosed === 'function' && page.isClosed()) {
        break;
      }

      // Fail fast when the payment gateway has returned an explicit 403 before QR capture.
      try {
        const currentUrlForFailure = (page.url && typeof page.url === 'function') ? page.url() : '';
        if (!qrDetected && /pg\.irctcpayments\.com/i.test(currentUrlForFailure)) {
          const gwBody = await page.locator('body').innerText({ timeout: 1500 })
            .then((text) => String(text).slice(0, 200))
            .catch(() => '');
          if (/403\s*forbidden/i.test(gwBody)) {
            console.warn('[IRCTC Automation][PAYMENT_GATEWAY_403]', JSON.stringify({
              ticketId: id,
              url: currentUrlForFailure,
              snippet: gwBody,
            }));
            const message = 'Payment gateway rejected the request (403 Forbidden). Please retry the booking.';
            this.setBookingStatus(id, 'Payment Failed: Gateway returned 403 Forbidden. IRCTC session may have expired.', {
              qrCode: null,
              availability: liveAvailabilityString,
              paymentFailed: true,
              paymentFailureCode: 'GATEWAY_403',
              paymentFailureMessage: message,
              paymentFailureSnippet: gwBody,
              paymentFailedAt: Date.now(),
              isFinal: true,
            });
            return { completed: false, error: 'GATEWAY_403' };
          }
        }
      } catch {}

      // 3. Check for booking confirmation & real PNR
      try {
        const pageUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
        const isConfirmUrl = pageUrl.includes('/booking/confirmation') ||
                             pageUrl.includes('/ticketConfirmation') ||
                             pageUrl.includes('/printTicket') ||
                             pageUrl.includes('booking-confirm') ||
                             pageUrl.includes('/booking/booking-confirm');

        let confirmData = null;
        try {
          confirmData = await page.evaluate(() => {
            const bodyText = (document.body ? document.body.innerText : '') || '';
            const pnrMatch = bodyText.match(/PNR\s*(?:No\.?|Number)?\s*[:#-]?\s*([0-9]{10})/i) ||
                             bodyText.match(/\b([0-9]{10})\b/);
            const hasCongrats = /congratulations/i.test(bodyText) && /booked\s+a?\s*ticket/i.test(bodyText);
            const hasPnr = /\bpnr\b/i.test(bodyText);
            const hasCnf = /\bcnf\b/i.test(bodyText);
            const hasConfirmText = /booking\s+confirmation|ticket\s+details|transaction\s+id/i.test(bodyText) &&
                                   (pnrMatch || /congratulations|booked\s+successfully/i.test(bodyText));
            const confirmed = Boolean(pnrMatch || hasConfirmText || (hasCongrats && hasPnr) || (hasPnr && hasCnf));
            return {
              confirmed,
              pnr: pnrMatch ? pnrMatch[1] : null,
            };
          });
        } catch {}

        if (isConfirmUrl || confirmData?.confirmed) {
          const pnr = confirmData?.pnr || 'Confirmed';
          const completedStatus = `Booking Completed (PNR: ${pnr})`;
          this.setBookingStatus(id, completedStatus, {
            qrCode: null,
            bookingCompleted: true,
            pnr,
            availability: liveAvailabilityString,
          });

          // Record confirmed booking in history
          try {
            if (toolService) {
              await toolService.createBookingHistory(userId, {
                ticket_name: targetTicket?.ticketName || `Ticket ${id}`,
                irctc_id: account?.irctcUserId || 'N/A',
                from_station: targetTicket?.fromStation || 'NDLS',
                to_station: targetTicket?.toStation || 'CSMT',
                journey_date: targetTicket?.journeyDate || new Date().toISOString().split('T')[0],
                bank_name: targetTicket?.paymentMethod || 'SBI - UPI QR',
                remarks: `Booking Confirmed (PNR: ${pnr})`,
              });
            }
          } catch (histErr) {
            console.warn('[IRCTC Automation] Confirmation history notice:', histErr.message);
          }
          return { completed: true, pnr };
        }

        // 4. Check for payment failure / cancellation / IRCTC gateway errors
        let failureInfo = null;
        try {
          const detectedFailure = await page.evaluate((isQrSeen) => {
            const text = (document.body ? document.body.innerText : '') || '';
            if (/unable to process payment request/i.test(text)) {
              return { error: 'IRCTC_ERROR', message: 'IRCTC could not process the payment request. Please try again later.' };
            }
            if (!isQrSeen && /403\s*forbidden/i.test(text)) {
              return { error: 'GATEWAY_403', message: 'Payment gateway rejected the request (403 Forbidden). The session may have expired.' };
            }
            if (/session\s+(?:expired|timed\s*out)/i.test(text)) {
              return { error: 'SESSION_EXPIRED', message: 'IRCTC session expired during payment. Please restart the booking.' };
            }
            if (/insufficient\s+(?:balance|funds)/i.test(text)) {
              return { error: 'INSUFFICIENT_FUNDS', message: 'Insufficient balance in the payment method.' };
            }
            if (/invalid\s+(?:upi|vpa|account)/i.test(text)) {
              return { error: 'INVALID_PAYMENT_METHOD', message: 'Invalid payment method details (UPI/VPA/account).' };
            }
            if (/payment\s+declined/i.test(text)) {
              return { error: 'PAYMENT_DECLINED', message: 'Payment was declined by the bank/payment provider.' };
            }
            if (/payment\s+(?:failed|unsuccessful)/i.test(text)) {
              return { error: 'PAYMENT_FAILED', message: 'Payment failed on the gateway.' };
            }
            if (/transaction\s+(?:failed|cancelled)/i.test(text)) {
              return { error: 'TRANSACTION_FAILED', message: 'Transaction was cancelled or failed.' };
            }
            if (/payment\s+(?:cancelled|aborted)/i.test(text)) {
              return { error: 'PAYMENT_CANCELLED', message: 'Payment was cancelled.' };
            }
            return null;
          }, qrDetected);
          if (detectedFailure && typeof detectedFailure === 'object' && detectedFailure.error) {
            failureInfo = detectedFailure;
          } else if (detectedFailure === true) {
            this.setBookingStatus(id, 'Payment Failed / Cancelled', {
              qrCode: null,
              availability: liveAvailabilityString,
            });
            return { completed: false, error: 'Payment Failed / Cancelled' };
          }
        } catch {}

        if (failureInfo) {
          console.warn('[IRCTC Automation][PAYMENT_FAILURE_DETECTED]', JSON.stringify({
            ticketId: id,
            ...failureInfo,
            currentUrl: (page.url && typeof page.url === 'function') ? page.url() : '',
          }));

          const pageSnippet = typeof page.locator === 'function'
            ? await page.locator('body').innerText({ timeout: 2000 })
              .then((text) => text.replace(/\s+/g, ' ').trim().slice(0, 500))
              .catch(() => '')
            : '';
          this.setBookingStatus(id, `Payment Failed: ${failureInfo.message}`, {
            qrCode: null,
            availability: liveAvailabilityString,
            paymentFailed: true,
            paymentFailureCode: failureInfo.error,
            paymentFailureMessage: failureInfo.message,
            paymentFailureSnippet: pageSnippet || null,
            paymentFailedAt: Date.now(),
            isFinal: true,
          });
          return { completed: false, error: failureInfo.message, code: failureInfo.error };
        }

        // 5. Capture QR code from payment gateway (ONLY ONCE per booking)
        if (!qrDetected) {
          let qrResult = null;
          try {
            qrResult = await this._waitForRealQrCode(page, {
              ticketId: id,
              timeoutMs: 5000, // Short check inside monitor loop
            });
          } catch {}

          if (qrResult && qrResult.dataUrl) {
            qrDetected = true;
            lastQrDataUrl = qrResult.dataUrl;
            lastQrFilePath = qrResult.filePath || null;
            lastQrSourceType = qrResult.sourceType || 'monitor';
            console.log('[IRCTC Automation][QR_CAPTURED_IN_MONITOR]', JSON.stringify({
              ticketId: id,
              filePath: lastQrFilePath,
              sourceType: lastQrSourceType,
            }));
            this.setBookingStatus(id, 'QR Code Available — Scan to Pay', {
              qrCode: lastQrDataUrl,
              qrFilePath: lastQrFilePath,
              qrSourceType: lastQrSourceType,
              paymentStopped: Boolean(stopPayment),
              availability: liveAvailabilityString,
            });
          }
        }

        if (qrDetected && lastQrDataUrl) {
          const existing = this._ticketBookingState.get(id);
          if (!existing || existing.qrCode !== lastQrDataUrl) {
            this.setBookingStatus(id, 'QR Code Available — Scan to Pay', {
              qrCode: lastQrDataUrl,
              qrFilePath: lastQrFilePath,
              qrSourceType: lastQrSourceType,
              paymentStopped: Boolean(stopPayment),
              availability: liveAvailabilityString,
            });
          }
        }
      } catch (pollErr) {
        console.warn(`[IRCTC Automation] Payment poll notice for ticket ${id}:`, pollErr.message);
      }

      await sleep(1500);
    }

    // Check if timed out without completion
    const finalState = this._ticketBookingState.get(id);
    if (finalState && !qrDetected && finalState.status !== 'Stopped' && !finalState.status.startsWith('Booking Completed') && !finalState.status.startsWith('Payment Failed')) {
      this.setBookingStatus(id, 'Payment Timed Out', {
        qrCode: null,
        availability: liveAvailabilityString,
      });
    }
  }

  /**
   * Gracefully close all automation resources during process shutdown.
   */
  async shutdown() {
    this._activeBookings.clear();
    for (const timers of this._bookingTimers.values()) {
      for (const timer of (Array.isArray(timers) ? timers : [timers])) clearTimeout(timer);
    }
    this._bookingTimers.clear();

    const sessions = [
      ...this._activeSessions.values(),
      ...this._accountSessions.values(),
    ];
    const uniqueContexts = new Set();
    const uniqueBrowsers = new Set();
    for (const entry of sessions) {
      if (entry?.context && !uniqueContexts.has(entry.context)) uniqueContexts.add(entry.context);
      if (entry?.browser && !uniqueBrowsers.has(entry.browser)) uniqueBrowsers.add(entry.browser);
    }
    await Promise.all([...uniqueContexts].map((context) => Promise.resolve().then(() => context.close()).catch(() => {})));
    await Promise.all([...uniqueBrowsers].map((browser) => Promise.resolve().then(() => browser.close()).catch(() => {})));
    this._activeSessions.clear();
    this._accountSessions.clear();
    this._activeLaunches.clear();
    this._launchLocks.clear();
  }

  /**
   * Stop active booking workflow for a ticket.
   */
  async stopTicketBooking(userId, ticketId) {
    const id = Number(ticketId);
    this._activeBookings.delete(id);
    if (this._bookingTimers.has(id)) {
      const active = this._bookingTimers.get(id);
      if (Array.isArray(active)) {
        active.forEach((t) => clearTimeout(t));
      } else {
        clearTimeout(active);
      }
      this._bookingTimers.delete(id);
    }
    return this.setBookingStatus(id, 'Stopped');
  }

  /**
   * Close active browser for a ticket if running.
   */
  async closeTicketBrowser(ticketId) {
    const id = Number(ticketId);
    this._activeBookings.delete(id);
    if (this._activeSessions.has(id)) {
      const session = this._activeSessions.get(id);
      const otherSessions = Array.from(this._activeSessions.entries())
        .filter(([otherId, otherSession]) => otherId !== id && otherSession?.context === session?.context);
      try {
        if (otherSessions.length > 0) {
          if (session?.page && !session.page.isClosed()) {
            await session.page.close().catch(() => {});
          }
        } else {
          if (session?.context) await session.context.close().catch(() => {});
          if (session?.browser) await session.browser.close().catch(() => {});
          for (const [sessionKey, accountSession] of this._accountSessions.entries()) {
            if (accountSession === session || accountSession?.context === session?.context) {
              this._accountSessions.delete(sessionKey);
            }
          }
        }
      } catch {
        // ignore
      }
      this._activeSessions.delete(id);
    }
  }
}

const service = new IrctcAutomationService();
service.AUTH_CODES = AUTH_CODES;
service.resolveHeadlessMode = resolveHeadlessMode;
service.normalizeIrctcClassCode = normalizeIrctcClassCode;
service.normalizeIrctcCateringChoice = normalizeIrctcCateringChoice;
service.normalizeIrctcPaymentMethodChoice = normalizeIrctcPaymentMethodChoice;
service.extractIrctcAvailabilityDate = extractIrctcAvailabilityDate;
module.exports = service;
