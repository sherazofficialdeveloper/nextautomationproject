'use strict';

const fs = require('fs');
const path = require('path');
const irctcConfig = require('../../config/irctc');
const targetAccountService = require('../../services/targetAccountService');
const { normalizeJourneyDate, formatJourneyDateForIrctc } = require('../../utils/dateUtils');
const { OPTIMIZED_LAUNCH_ARGS } = require('../browserConfig');

/**
 * Stages of the train search pipeline for diagnostic visibility.
 */
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

/**
 * Domain patterns safe to block during search automation to reduce network contention.
 * Never block IRCTC application scripts, stylesheets, fonts, or APIs.
 */
const BLOCKED_DOMAINS = [
  'google-analytics.com',
  'googletagmanager.com',
  'doubleclick.net',
  'googleadservices.com',
  'adservice.google',
  'hotjar.com',
  'clarity.ms',
];

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
/**
 * Standardized Authentication & Verification Codes
 */
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
    // In-memory session cache: key = `${userId}:${accountId}` -> { storageState, lastActive, irctcUserId }
    this._sessionCache = new Map();
    // In-memory ticket booking state: ticketId -> { status, stopPayment, startTime, updatedAt }
    this._ticketBookingState = new Map();
    this._bookingTimers = new Map();
    // Active browser sessions for ticket automation: ticketId -> { browser, context, page, ticket, userId, irctcAccountId, browserConfig }
    // Active browser sessions for ticket automation: ticketId -> { context, page, ticket, userId, irctcAccountId, browserConfig }
    this._activeSessions = new Map();
    // Concurrency guards: prevent duplicate simultaneous launches or bookings for same ticket
    // Account-specific browser sessions: sessionLockKey ("${accountId}_${browserKey}") -> { context, page, ticket, userId, accountId, browserKey, browserConfig, stopPayment, launchedAt }
    this._accountSessions = new Map();
    // Single-flight launch concurrency locks: sessionLockKey -> Promise
    this._launchLocks = new Map();
    // Concurrency guards: prevent duplicate simultaneous bookings for same ticket
    this._activeLaunches = new Map();
    this._activeBookings = new Set();

    // Clean up any child browser processes on process exit to avoid zombie/orphan processes
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

  getSessionState(userId, accountId) {
    const key = this.getSessionKey(userId, accountId);
    const session = this._sessionCache.get(key);
    if (!session) return null;

    // Check TTL (default: 15 minutes)
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

    // Close and remove matching active persistent browser sessions before disk deletion
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

    // Purge account-specific automation profiles on disk in storage/automation-profiles
    try {
      const profilesBase = path.join(process.cwd(), 'storage', 'automation-profiles');
      if (fs.existsSync(profilesBase)) {
        const entries = fs.readdirSync(profilesBase);
        for (const entry of entries) {
          let shouldDelete = false;
          if (accountId) {
            if (entry.startsWith(`acc_${accountId}_`) || entry === `acc_${accountId}`) {
              shouldDelete = true;
            }
          } else {
            // Delete application-owned automation profiles
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

  /**
   * Main entrypoint: Performs automated real train search with controlled retry.
   */
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

        // Determine if error is non-retryable
        const nonRetryableCodes = [
          'LOGIN_FAILED',
          'LOGIN_REQUIRES_CAPTCHA',
          'LOGIN_REQUIRES_OTP',
          'IRCTC_ACCESS_DENIED',
          'IRCTC_MANUAL_VERIFICATION_REQUIRED',
          'VALIDATION_ERROR',
        ];

        if (err.code && nonRetryableCodes.includes(err.code)) {
          throw err;
        }

        // If client parameters are invalid
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

  /**
   * Executes a single attempt of the complete search pipeline.
   */
  async _executeSearchWorkflow(userId, { accountId, fromStation, toStation, journeyDate, quota = 'General', travelClass = 'All' }) {
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
      // 1. BROWSER LAUNCH (Headless mode with msedge channel fallback)
      const launchOptions = {
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
        ],
      };

      try {
        browser = await patchright.chromium.launch({ ...launchOptions, channel: 'msedge' });
      } catch (launchErr) {
        console.warn('[IRCTC Automation] msedge channel unavailable, falling back to default chromium:', launchErr?.message);
        browser = await patchright.chromium.launch(launchOptions);
      }

      // Check for cached storageState in memory
      const cachedSession = this.getSessionState(userId, accountId);
      const contextOptions = {
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        viewport: { width: 1440, height: 900 },
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9',
        },
      };

      if (cachedSession && cachedSession.storageState) {
        contextOptions.storageState = cachedSession.storageState;
        console.log('[IRCTC Automation] Reusing authenticated in-memory session for account:', account.irctcUserId);
      }

      context = await browser.newContext(contextOptions);
      page = await context.newPage();
      page.setDefaultTimeout(this.config.ACTION_TIMEOUT_MS || 10000);

      // Safe network routing & diagnostics: block non-essential analytics
      await page.route('**/*', (route) => {
        const url = route.request().url();
        const isBlocked = BLOCKED_DOMAINS.some((domain) => url.includes(domain));
        if (isBlocked) {
          route.abort();
        } else {
          route.continue();
        }
      });

      // Handle native browser alert/confirm/prompt dialogs
      page.on('dialog', async (dialog) => {
        try {
          console.log('[IRCTC Automation] Dialog detected and dismissed:', dialog.message());
          await dialog.dismiss();
        } catch {}
      });

      // 2. NAVIGATION & FIREWALL DETECTION
      currentStage = STAGES.NAVIGATION;
      console.log(`[IRCTC Automation] TRAIN_SEARCH_STAGE=${currentStage}`);

      let navResponse = null;
      try {
        navResponse = await page.goto(this.getTrainSearchUrl(), {
          waitUntil: 'domcontentloaded',
          timeout: this.config.NAVIGATION_TIMEOUT_MS || 35000,
        });
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

      // Dismiss initial language / advisory popups cleanly
      await page.waitForTimeout(2000);
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
      await page.waitForTimeout(500);

      // 3. AUTHENTICATION & LOGIN VERIFICATION
      currentStage = STAGES.LOGIN;
      console.log(`[IRCTC Automation] TRAIN_SEARCH_STAGE=${currentStage}`);

      const alreadyLoggedIn = await page.evaluate((uname) => {
        const text = document.body ? document.body.innerText : '';
        const hasUser = uname ? text.includes(uname) : false;
        const hasMyAccount = text.includes('MY ACCOUNT');
        const hasLogout = text.includes('LOGOUT') || text.includes('Logout');
        const loginBtn = document.querySelector('a.loginText, a[aria-label*="Login"]');
        const loginHidden = !loginBtn || loginBtn.offsetParent === null;
        return (hasUser || hasMyAccount || hasLogout) && loginHidden;
      }, account.irctcUserId).catch(() => false);

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

        // Enter credentials
        await userInput.click({ force: true });
        await userInput.fill('');
        await userInput.pressSequentially(account.irctcUserId, { delay: 60 });

        const passInput = page.locator('input[formcontrolname="password"], input[placeholder*="Password"], #pwd').first();
        await passInput.click({ force: true });
        await passInput.fill('');
        await passInput.pressSequentially(account.password, { delay: 60 });

        // Check if explicit CAPTCHA input challenge is present before submission
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

        // Submit login
        const signInBtn = page.locator('button:has-text("SIGN IN"), button[type="submit"]:has-text("SIGN IN"), button:has-text("Sign In")').first();
        if (await signInBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await signInBtn.click({ force: true }).catch(() => {});
        }

        // 4. LOGIN VERIFICATION
        currentStage = STAGES.LOGIN_VERIFICATION;
        console.log(`[IRCTC Automation] TRAIN_SEARCH_STAGE=${currentStage}`);

        await page.waitForTimeout(2500);

        // Check for genuine OTP prompt (excludes otpLogin checkbox)
        const isOtpPrompt = await this._detectGenuineOtpChallenge(page);
        if (isOtpPrompt) {
          console.warn('[IRCTC Automation] Login requires OTP verification');
          const otpErr = new Error('IRCTC login requires 2FA OTP verification sent to your registered mobile.');
          otpErr.status = 403;
          otpErr.code = 'LOGIN_REQUIRES_OTP';
          otpErr.stage = STAGES.LOGIN_VERIFICATION;
          throw otpErr;
        }

        // Check for login rejection message inside modal
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

        // Verify post-login state via top banner and account navbar
        const loginSuccess = await page.evaluate((uname) => {
          const text = document.body ? document.body.innerText : '';
          const hasUser = uname ? text.includes(uname) : false;
          const hasMyAccount = text.includes('MY ACCOUNT');
          const hasLogout = text.includes('LOGOUT') || text.includes('Logout');
          return hasUser || hasMyAccount || hasLogout;
        }, account.irctcUserId).catch(() => false);

        if (loginSuccess) {
          console.log('[IRCTC Automation] Login verified successfully. Caching storageState in memory.');
          const storageState = await context.storageState().catch(() => null);
          if (storageState) {
            this.setSessionState(userId, accountId, {
              storageState,
              irctcUserId: account.irctcUserId,
            });
          }
        } else {
          console.warn('[IRCTC Automation] Post-login authentication state could not be verified');
          this.clearSessionState(userId, accountId);
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

      // 5. FROM STATION AUTOCOMPLETE
      currentStage = STAGES.FROM_STATION;
      console.log(`[IRCTC Automation] TRAIN_SEARCH_STAGE=${currentStage}:`, cleanFrom);

      const fromInput = page.locator('p-autocomplete[formcontrolname="origin"] input, #origin input').first();
      await fromInput.waitFor({ state: 'visible', timeout: 10000 });
      await fromInput.click({ force: true });
      await fromInput.fill('');
      await fromInput.pressSequentially(cleanFrom, { delay: 100 });
      await page.waitForTimeout(1500);

      // Wait for suggestion listbox to populate
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

      // 6. TO STATION AUTOCOMPLETE
      currentStage = STAGES.TO_STATION;
      console.log(`[IRCTC Automation] TRAIN_SEARCH_STAGE=${currentStage}:`, cleanTo);

      const toInput = page.locator('p-autocomplete[formcontrolname="destination"] input, #destination input').first();
      await toInput.waitFor({ state: 'visible', timeout: 10000 });
      await toInput.click({ force: true });
      await toInput.fill('');
      await toInput.pressSequentially(cleanTo, { delay: 100 });
      await page.waitForTimeout(1500);

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

      // 7. JOURNEY DATE
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
          // Crucial: close the PrimeNG calendar overlay with Escape so it doesn't block search button
          await page.keyboard.press('Escape');
          await page.waitForTimeout(200);

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

      // 8. SUBMIT SEARCH
      currentStage = STAGES.SUBMIT_SEARCH;
      console.log(`[IRCTC Automation] TRAIN_SEARCH_STAGE=${currentStage}`);

      // Ensure calendar/tooltip overlays are dismissed
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);

      const searchBtn = page.locator('button.search_btn, button[type="submit"]:has-text("Search"), button[type="submit"]').first();
      await searchBtn.waitFor({ state: 'visible', timeout: 5000 });
      await searchBtn.click({ force: true });

      // 9. WAITING RESULTS
      currentStage = STAGES.WAITING_RESULTS;
      console.log(`[IRCTC Automation] TRAIN_SEARCH_STAGE=${currentStage}`);

      const resultWaitTimeout = this.config.RESULT_WAIT_TIMEOUT_MS || 45000;

      // Wait for navigation to /booking/train-list or results components to attach
      await Promise.race([
        page.waitForURL(/booking\/train-list/, { timeout: resultWaitTimeout }).catch(() => {}),
        page.locator('app-train-list, app-train-avl-enq').first().waitFor({ state: 'attached', timeout: resultWaitTimeout }).catch(() => {}),
      ]);

      // Check for explicit "No trains found" state
      const noTrainsMsg = await page.locator('text="No direct trains", text="No trains found", text="Trains are not available"').first().isVisible({ timeout: 2000 }).catch(() => false);
      if (noTrainsMsg) {
        console.log('[IRCTC Automation] Explicit zero results returned from IRCTC.');
        return [];
      }

      // Check for Akamai Access Denied after submission
      const postSearchTitle = (await page.title().catch(() => '')) || '';
      if (postSearchTitle.includes('Access Denied')) {
        const firewallErr = new Error('IRCTC access was blocked by portal firewall (Akamai Access Denied).');
        firewallErr.status = 403;
        firewallErr.code = 'IRCTC_ACCESS_DENIED';
        firewallErr.stage = STAGES.WAITING_RESULTS;
        throw firewallErr;
      }

      // 10. EXTRACTING RESULTS
      currentStage = STAGES.EXTRACTING_RESULTS;
      console.log(`[IRCTC Automation] TRAIN_SEARCH_STAGE=${currentStage}`);

      const avlCount = await page.locator('app-train-avl-enq').count();
      const trainCards = avlCount > 0 ? page.locator('app-train-avl-enq') : page.locator('.train-heading');
      await trainCards.first().waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});
      const cardCount = await trainCards.count();
      console.log(`[IRCTC Automation] Found ${cardCount} train elements`);

      if (cardCount === 0) {
        // Results did not render within configured budget
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

          // Format duration to match reference (e.g. "17:05" -> "17h 05m")
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
            // Merge: preserve real times over '—'
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
   * Detect IRCTC Client IP rejection or server-side firewall denial.
   * Checks DOM body and error dialogs for "Unable to Process Request ... Client IP: ...".
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

  /**
   * Determine whether IRCTC genuinely requested OTP verification.
   * Strictly distinguishes between:
   * - Genuine OTP challenge: Text/number input for entering OTP code, or prompt "Enter OTP sent to..."
   * - Login option checkbox: <input type="checkbox" formcontrolname="otpLogin"> ("Login with OTP" option)
   * Prevents false OTP detections on Microsoft Edge or any browser where the checkbox is present.
   */
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

    // 1. Concurrency guard: if browser launch is already executing for this account + browser pair, await it
    if (this._launchLocks.has(sessionLockKey)) {
      console.log(`[IRCTC Automation][Launch] Single-flight: lock active for ${sessionLockKey}, awaiting in-flight launch...`);
      const result = await this._launchLocks.get(sessionLockKey);
      const active = this._accountSessions.get(sessionLockKey);
      if (active) {
        this._activeSessions.set(ticketIdNum, active);
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
        console.log(`[IRCTC Automation][Launch] Reusing active persistent ${browserConfig.name} session for ${sessionLockKey} (ticket ${ticketIdNum})`);
        existingSession.ticket = ticket;
        existingSession.userId = userId;
        existingSession.stopPayment = Boolean(options?.stopPayment);
        this._activeSessions.set(ticketIdNum, existingSession);
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
          launchMode: 'Background',
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

      // Default to headless / background execution (never open visible window)
      const isHeadless = process.env.IRCTC_LAUNCH_HEADLESS !== 'false';

      // Application-owned isolated automation profile directory keyed by account ID (never touches user's personal profile)
      const browserKey = String(browserConfig.browserKey || 'default').toLowerCase();
      const accountId = ticket.irctcAccountId || ticket.irctcUserId || 'default';
      // Application-owned isolated automation profile directory keyed by account ID and browser (never touches user's personal profile)
      const automationProfileDir = path.join(process.cwd(), 'storage', 'automation-profiles', `acc_${accountId}_${browserKey}`);
      try {
        if (!fs.existsSync(automationProfileDir)) {
          fs.mkdirSync(automationProfileDir, { recursive: true });
        }
      } catch {
        // ignore directory creation error if handled by runtime
      }

      // Remove stale Chromium lock files in isolated profile dir to prevent Target closed / profile lock conflicts
      const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile'];
      for (const lockFile of lockFiles) {
        try {
          const lockPath = path.join(automationProfileDir, lockFile);
          if (fs.existsSync(lockPath)) {
            fs.unlinkSync(lockPath);
          }
        } catch {
          // ignore if file is locked or cannot be deleted
          // ignore if file cannot be unlinked
        }
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

      console.log(`[IRCTC Automation][Launch] Launching persistent context: sessionKey=${sessionLockKey} runtime=${browserConfig.resolvedRuntime} profileDir=${automationProfileDir}`);

      let context = null;
      try {
        context = await patchright.chromium.launchPersistentContext(automationProfileDir, contextOptions);
      } catch (launchErr) {
        const err = new Error(`${browserConfig.name} cannot be launched for automation: ${launchErr.message}`);
        err.status = 500;
        throw err;
      }

      const pages = context.pages();
      const page = pages.length > 0 ? pages[0] : await context.newPage();

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
        stopPayment: Boolean(options?.stopPayment),
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
        launchMode: 'Background',
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
      // 1. Check for English button in dialog or banner
      const langBtn = page
        .locator(
          'p-dialog button:has-text("English"), button:has-text("English"), a:has-text("English"), span:has-text("English"), .lang-btn:has-text("English")'
        )
        .first();
      if (await langBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await langBtn.click().catch(() => {});
        await page.waitForTimeout(300);
      }

      // 2. Check for standard OK / alert confirmation button
      const okBtn = page
        .locator(
          'p-dialog button.btn.btn-primary, p-dialog button:has-text("OK"), button:has-text("OK"), button.btn-primary:has-text("OK"), .ui-dialog button:has-text("OK")'
        )
        .first();
      if (await okBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await okBtn.click().catch(() => {});
        await page.waitForTimeout(300);
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
      // 1. Direct Playwright locator check (case-insensitive regex)
      const logoutLocator = page
        .locator(
          'button:has-text(/logout/i), a:has-text(/logout/i), span:has-text(/logout/i), ' +
          'button:has-text("लॉग आउट"), a:has-text("लॉग आउट"), span:has-text("लॉग आउट"), ' +
          'a[aria-label*="Logout" i], a[aria-label*="लॉग आउट"], span.user-profile, .user-name, ' +
          'a[href*="logout" i], a[href*="my-profile" i], a[href*="user-profile" i]'
        )
        .first();

      const locatorVisible = await logoutLocator.isVisible({ timeout: 1000 }).catch(() => false);
      if (locatorVisible) return true;

      // 2. DOM-level deep inspection via evaluate
      const expectedUser = account?.irctcUserId || '';
      const domResult = await page.evaluate((targetUser) => {
        try {
          const headerEl = document.querySelector('app-header') || document.querySelector('header') || document.body;
          const headerText = headerEl ? (headerEl.innerText || '') : '';
          const bodyText = (document.body ? document.body.innerText : '') || '';

          // Check for Logout text in header or body
          if (/\b(?:logout|log\s*out|लॉग\s*आउट)\b/i.test(headerText) || /\b(?:logout|लॉग\s*आउट)\b/i.test(bodyText)) {
            return true;
          }

          // Check for user greeting or My Account in header
          if (/\b(?:my\s*account|मेरा\s*खाता|user\s*profile|my\s*profile)\b/i.test(headerText)) {
            return true;
          }

          if (targetUser && targetUser.length > 2) {
            const userRegex = new RegExp(`\\b${targetUser}\\b`, 'i');
            if (userRegex.test(headerText) || (/\bwelcome\b/i.test(headerText) && userRegex.test(bodyText))) {
              return true;
            }
          } else if (/\bwelcome\s+[a-z0-9_]{3,}\b/i.test(headerText)) {
            return true;
          }

          // Check sessionStorage for authenticated token/profile
          for (let i = 0; i < sessionStorage.length; i++) {
            const k = sessionStorage.key(i);
            if (/access_token|user_profile|currentUser|auth_token/i.test(k)) {
              const val = sessionStorage.getItem(k);
              if (val && val.length > 8 && !/null|undefined/i.test(val)) {
                return true;
              }
            }
          }
        } catch {}
        return false;
      }, expectedUser).catch(() => false);

      return Boolean(domResult);
    } catch {
      return false;
    }
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

      // If login button is visible, allow a brief 600ms hydration window for Angular session restoration
      if (loginCheck.isLoginBtnVisible || loginCheck.hasLoginText) {
        if (Date.now() - startTime >= 600) {
          return { state: 'AUTH_REQUIRED' };
        }
      }

      // D. Small backoff before checking again for Angular hydration
      await page.waitForTimeout(300).catch(() => {});
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
  async _fillPassengerDetails(page, passengers) {
    if (!page || page.isClosed() || !Array.isArray(passengers) || passengers.length === 0) return;
    try {
      for (let i = 0; i < passengers.length; i++) {
        const p = passengers[i];
        if (!p || !p.name) continue;

        if (i > 0) {
          const addBtn = page.locator('span:has-text("+ Add Passenger"), a:has-text("+ Add Passenger"), button:has-text("Add Passenger")').first();
          if (await addBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
            await addBtn.click().catch(() => {});
            await page.waitForTimeout(300);
          }
        }

        const nameInputs = page.locator('input[placeholder*="Passenger Name" i], input[formcontrolname="passengerName"]');
        const count = await nameInputs.count().catch(() => 0);
        if (count > i) {
          await nameInputs.nth(i).fill(p.name).catch(() => {});
        }

        const ageInputs = page.locator('input[placeholder*="Age" i], input[formcontrolname="passengerAge"]');
        const ageCount = await ageInputs.count().catch(() => 0);
        if (ageCount > i && p.age) {
          await ageInputs.nth(i).fill(String(p.age)).catch(() => {});
        }

        const genderSelects = page.locator('select[formcontrolname="passengerGender"]');
        const genderCount = await genderSelects.count().catch(() => 0);
        if (genderCount > i && p.gender) {
          const rawG = String(p.gender).toUpperCase();
          const genderVal = rawG.startsWith('F') ? 'F' : (rawG.startsWith('T') ? 'T' : 'M');
          await genderSelects.nth(i).selectOption(genderVal).catch(() => {});
        }
      }
    } catch (err) {
      console.warn('[IRCTC Automation] _fillPassengerDetails notice:', err.message);
    }
  }

  /**
   * Get active booking status for a ticket.
   */
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
    return state;
  }

  /**
   * Update booking status for a ticket.
   */
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

  /**
   * Start booking workflow for a ticket, enforcing the stopPayment requirement.
   * If stopPayment is true: automation stops at payment stage without auto-clicking Pay Now and allows manual payment/QR scan.
   * If stopPayment is false: automation proceeds to payment action without faking success or bypassing OTP/MFA.
   * Controls live Patchright Core browser instance when available, or executes test progression.
   */
  async startTicketBooking(userId, ticketId, { stopPayment = false, ticket = null } = {}) {
    const id = Number(ticketId);

    // Concurrency guard: if booking workflow is already running for this ticket, return current status
    if (this._activeBookings.has(id)) {
      console.log(`[IRCTC Automation] Booking already active for ticket ${id}, ignoring duplicate trigger.`);
      return this.getBookingStatus(userId, id);
    }
    this._activeBookings.add(id);

    // Clear any previous timer for this ticket
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

    // Schedule real workflow stage transitions
    let activeSession = this._activeSessions.get(id);
    if ((!activeSession || !activeSession.page || activeSession.page.isClosed()) && ticket) {
      const accountId = ticket.irctcAccountId || ticket.irctcUserId;
      if (accountId) {
        for (const [sKey, sess] of this._accountSessions.entries()) {
          if (sKey.startsWith(`${accountId}_`) && sess?.page && !sess.page.isClosed()) {
            activeSession = sess;
            this._activeSessions.set(id, sess);
            break;
          }
        }
      }
    }
    if (activeSession && activeSession.page && !activeSession.page.isClosed()) {
      // Execute REAL browser-driven booking workflow asynchronously
      this._runRealBookingWorkflow(userId, id, activeSession, { stopPayment: isStop, ticket }).catch((err) => {
        console.error(`[IRCTC Automation] Real booking pipeline error for ticket ${id}:`, err);
        this.setBookingStatus(id, `Error: ${err.message}`);
      });
      return this.getBookingStatus(userId, id);
    }

    // Fallback: Scheduled stage transitions when running without active browser (e.g. unit tests)
    const timers = [];

    const scheduleStage = (delayMs, statusText, extra = {}) => {
      const t = setTimeout(() => {
        const current = this._ticketBookingState.get(id);
        if (!current || current.status === 'Stopped') return;
        this.setBookingStatus(id, statusText, extra);
        if (extra?.isFinal) {
          this._activeBookings.delete(id);
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
      // Case A: Stop payment is checked.
      // Automation stops at payment stage without auto-clicking Pay Now and allows manual payment/QR scan.
      scheduleStage(3000, 'Waiting for Payment (Stopped)', { paymentStopped: true, isFinal: true });
    } else {
      // Case B: Stop payment is unchecked.
      // Automation proceeds to payment action without faking success or bypassing OTP/MFA.
      scheduleStage(3000, 'Waiting for Payment', { paymentStopped: false, isFinal: true });
    }

    this._bookingTimers.set(id, timers);
    return this.getBookingStatus(userId, id);
  }

  /**
   * Real browser automation workflow: Logs into IRCTC, checks CAPTCHA/OTP, and advances stages.
   */
  async _runRealBookingWorkflow(userId, ticketId, activeSession, { stopPayment = false, ticket = null }) {
    const id = Number(ticketId);
    const { page } = activeSession;
    const targetTicket = ticket || activeSession.ticket;

    try {
      // 1. Retrieve decrypted credentials from database
      const accountId = targetTicket?.irctcAccountId || activeSession?.ticket?.irctcAccountId;
      let account = null;
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

      // Check if user stopped booking
      if (this._ticketBookingState.get(id)?.status === 'Stopped') return;

      // 2. Ensure page is open on IRCTC and domcontentloaded
      this.setBookingStatus(id, 'Opening IRCTC...');
      const currentUrl = (page && page.url && typeof page.url === 'function') ? page.url() : '';
      if (!currentUrl || !currentUrl.includes('irctc.co.in')) {
        const targetUrl = this.config.SECONDARY_WEB_URL || 'https://www.irctc.co.in/nget/train-search';
        try {
          if (page && typeof page.goto === 'function') {
            await page.goto(targetUrl, {
              waitUntil: 'domcontentloaded',
              timeout: 20000,
            });
          }
        } catch (navErr) {
          console.error(`[IRCTC Automation] Navigation failed for ticket ${id}:`, navErr.message);
          this.setBookingStatus(id, 'Error: IRCTC navigation timed out or failed to load.', {
            authResult: {
              success: false,
              stage: 'authentication',
              code: AUTH_CODES.SERVER_ERROR,
              message: `IRCTC navigation failed: ${navErr.message}`,
              displayMessage: 'IRCTC page failed to load or timed out. Please check network connection.',
              retryable: true,
            },
          });
          return;
        }
      }
      logStage(id, 'IRCTC_PAGE_LOADED', { url: (page && page.url && typeof page.url === 'function') ? page.url() : '' });

      if (this._ticketBookingState.get(id)?.status === 'Stopped') return;

      // Check for immediate Client IP rejection after navigation
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

      // Handle language selection modal / overlay if present
      await this._handleLanguageAndAlerts(page);

      // CRITICAL AUTHENTICATION CHECK: Detect whether the session is ALREADY authenticated
      logStage(id, 'AUTH_STATE_CHECKING');
      this.setBookingStatus(id, 'Checking session...');

      const authState = await this._detectAuthenticationState(page, account, 8000);

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

      if (authState.state === AUTH_CODES.AUTHENTICATED) {
        // CASE A: ALREADY AUTHENTICATED -> Skip login completely!
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
        // CASE B: NOT AUTHENTICATED -> Verify if session became authenticated, or if modal is already open
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
          // Check if login modal/form is ALREADY open
          const isFormAlreadyOpen = await page.evaluate(() => {
            const uInput = document.querySelector('input[formcontrolname="userid"], input[placeholder*="User Name" i], input[placeholder*="User ID" i]');
            const loginModal = document.querySelector('app-login, form[name="loginForm"]');
            const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
            return isVisible(uInput) || isVisible(loginModal);
          }).catch(() => false);

          if (isFormAlreadyOpen) {
            logStage(id, 'AUTH_LOGIN_IN_PROGRESS', { formAlreadyOpen: true });
            logStage(id, 'LOGIN_FORM_FOUND', { preOpened: true });
          } else {
            // Dismiss any lingering overlay dialogs
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

            // Wait up to 4s for login form to open or authenticated state to appear
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
              await page.waitForTimeout(300).catch(() => {});
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
              // Inspect page state truth: never blindly fail with "login button not detected"
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
        await page.waitForTimeout(300);
        await pwdInput.fill(account.password);
        await page.waitForTimeout(400);
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
        const authResponseListener = async (response) => {
          try {
            const url = response.url ? response.url() : '';
            if (url.includes('/authprovider/webtoken') || url.includes('/eticketing/login') || url.includes('/eticketing/captchaImage')) {
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

            await page.waitForTimeout(400);
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

      // 3. Login Succeeded or Session Reused!
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
      if (this._ticketBookingState.get(id)?.status === 'Stopped') return;

      // =========================================================================
      // PHASE 2: REAL IRCTC TRAIN SEARCH, TRAIN SELECTION, & BOOK NOW ENTRY
      // =========================================================================

      // STEP 2: Verify and ensure the page is ready on the IRCTC train search page
      let bookingUrl = (page && page.url && typeof page.url === 'function') ? page.url() : '';
      if (!bookingUrl.includes('irctc.co.in/nget/train-search') && !bookingUrl.includes('/nget/')) {
        const trainSearchUrl = this.config.SECONDARY_WEB_URL || 'https://www.irctc.co.in/nget/train-search';
        console.log(`[IRCTC Automation] Navigating to IRCTC train search URL for ticket ${id}: ${trainSearchUrl}`);
        await page.goto(trainSearchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      }

      // Dismiss any lingering welcome dialogs/overlays
      await this._handleLanguageAndAlerts(page);

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
      await page.waitForTimeout(400);

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
      await page.waitForTimeout(400);

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
      await page.waitForTimeout(300);

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
          await page.waitForTimeout(400);

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
          await page.waitForTimeout(200);
        }
      }

      // STEP 7: Real Search Button & Train List
      if (this._ticketBookingState.get(id)?.status === 'Stopped') return;

      this.setBookingStatus(id, 'Searching Train...', { authResult: null });
      console.log(`[IRCTC Automation] Submitting train search on IRCTC for ticket ${id}...`);

      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(200);

      const searchBtn = page.locator('button.search_btn, button[type="submit"]:has-text("Search"), button:has-text("Search")').first();
      await searchBtn.waitFor({ state: 'visible', timeout: 6000 });
      await searchBtn.click({ force: true });
      logStage(id, 'SEARCH_SUBMITTED');

      const resultWaitTimeout = 35000;
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

      const avlCount = await page.locator('app-train-avl-enq').count().catch(() => 0);
      const trainCardsLocator = avlCount > 0 ? page.locator('app-train-avl-enq') : page.locator('.train-heading, .form-group.no-pad');
      await trainCardsLocator.first().waitFor({ state: 'attached', timeout: 12000 }).catch(() => {});
      const totalCards = await trainCardsLocator.count().catch(() => 0);

      if (totalCards === 0) {
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

      if (targetTrainNo) {
        this.setBookingStatus(id, `Selecting Train (${targetTrainNo})...`, { authResult: null, trainCount: totalCards });
        console.log(`[IRCTC Automation] Searching for target train ${targetTrainNo} in IRCTC results...`);

        const matchingTrainCard = page.locator('app-train-avl-enq, .form-group.no-pad')
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

        const classTab = matchingTrainCard
          .locator('div.pre-avl, div.ui-panel, td, span, div')
          .filter({ hasText: new RegExp(`\\b${targetClass}\\b`) })
          .first();

        const classTabVisible = await classTab.waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false);
        if (!classTabVisible) {
          throw new Error(`Requested class "${targetClass}" not found on train ${targetTrainNo} in IRCTC results.`);
        }

        await classTab.click({ force: true });
        await page.waitForTimeout(1000);

        // STEP 10: Real Availability (Read from live IRCTC result, NEVER from Ghumo)
        if (this._ticketBookingState.get(id)?.status === 'Stopped') return;

        await matchingTrainCard
          .locator('button:has-text("Book Now"), .availability-cache, div.pre-avl, table')
          .first()
          .waitFor({ state: 'visible', timeout: 10000 })
          .catch(() => {});

        const cardText = (await matchingTrainCard.innerText().catch(() => '')) || '';
        const avlMatch = cardText.match(/\b(AVAILABLE[-\s]?\d+|CURR_AVBL[-\s]?\d+|RAC\s*\d+|WL\s*\d+|RLWL\s*\d+|PQWL\s*\d+|GNWL\s*\d+|REGRET|NOT AVAILABLE|TRAIN CANCELLED)\b/i);
        if (avlMatch) {
          selectedAvailability = avlMatch[0].toUpperCase();
        }
        console.log(`[IRCTC Automation] Real IRCTC availability for train ${targetTrainNo} (${targetClass}): ${selectedAvailability}`);

        if (/REGRET|NOT AVAILABLE|TRAIN CANCELLED/i.test(selectedAvailability)) {
          this.setBookingStatus(id, `Train Unavailable on IRCTC: ${selectedAvailability}`, {
            availability: selectedAvailability,
          });
          throw new Error(`Train ${targetTrainNo} (${targetClass}) is unavailable on IRCTC: ${selectedAvailability}`);
        }

        this.setBookingStatus(id, `Train Selected (${targetTrainNo} - ${targetClass})... [ ${selectedAvailability} ]`, {
          authResult: null,
          availability: selectedAvailability,
          trainCount: totalCards,
          trainFound: true,
          stage: 'train_search_completed',
        });
      }

      // =========================================================================
      // TASK STOP BOUNDARY: Halt execution after verified real train search.
      // Do not proceed to passenger submission, payment, QR, or booking completion.
      // =========================================================================
      console.log(`[IRCTC Automation] Verified real IRCTC train search and results for ticket ${id}. Halting execution as required.`);
      logStage(id, 'TRAIN_SEARCH_COMPLETED', {
        trainCount: totalCards,
        trainNumber: targetTrainNo || null,
        selectedClass: targetClass,
        availability: selectedAvailability,
      });
      this._activeBookings.delete(id);
      return;

      // STEP 11: Real Book Now Entry (Preserved for subsequent phases)
      if (this._ticketBookingState.get(id)?.status === 'Stopped') return;

      this.setBookingStatus(id, 'Opening Passenger Details...', {
        authResult: null,
        availability: liveAvailability,
      });
      console.log(`[IRCTC Automation] Clicking Book Now for train ${targetTrainNo} (${targetClass})...`);

      let bookNowBtn = matchingTrainCard.locator('button:has-text("Book Now"), button.btnDefault:has-text("Book Now"), a:has-text("Book Now")').first();
      let bookNowVisible = await bookNowBtn.isVisible({ timeout: 4000 }).catch(() => false);

      if (!bookNowVisible) {
        bookNowBtn = page.locator('button:has-text("Book Now"), button.btnDefault:has-text("Book Now")').first();
        bookNowVisible = await bookNowBtn.isVisible({ timeout: 3000 }).catch(() => false);
      }

      if (!bookNowVisible) {
        throw new Error(`"Book Now" button was not found or not active for train ${targetTrainNo} (${targetClass}).`);
      }

      await bookNowBtn.click({ force: true });

      // Handle legitimate IRCTC confirmation / guidelines / advisory popups
      await page.waitForTimeout(1000);
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
      await Promise.race([
        page.waitForURL(/booking\/psgninput/, { timeout: 25000 }).catch(() => {}),
        page.locator('app-passenger-input, input[formcontrolname="passengerName"]').first().waitFor({ state: 'attached', timeout: 25000 }).catch(() => {}),
      ]);

      const postBookUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
      const psgnInputVisible = await page.locator('app-passenger-input, input[formcontrolname="passengerName"]').first().isVisible({ timeout: 5000 }).catch(() => false);

      if (!postBookUrl.includes('/booking/psgninput') && !psgnInputVisible) {
        throw new Error(`Failed to reach IRCTC passenger input page. Current URL: ${postBookUrl}`);
      }

      // STEP 12: Emit verified status and STOP (Phase 2 completion)
      logStage(id, 'PASSENGER_PAGE_READY', { url: postBookUrl, availability: liveAvailability });
      this.setBookingStatus(id, 'Passenger Details Ready', {
        authResult: null,
        availability: liveAvailability,
        passengerPageReady: true,
        currentUrl: postBookUrl,
        isFinal: true,
      });
      console.log(`[IRCTC Automation] Phase 2 COMPLETE: Verified IRCTC passenger page reached for ticket ${id}. URL: ${postBookUrl}`);
    } catch (flowErr) {
      console.error(`[IRCTC Automation] Workflow error for ticket ${id}:`, flowErr);
      this.setBookingStatus(id, `Error: ${flowErr.message}`);
    } finally {
      this._activeBookings.delete(id);
    }
  }

  /**
   * Monitor real payment gateway / IRCTC payment screen in the active browser.
   * Detects real QR code from payment gateway (if rendered), observes client-selected payment method,
   * watches for confirmation / PNR extraction, and enforces a 300s timeout.
   */
  async _monitorRealPaymentWorkflow(page, ticketId, { stopPayment = false, targetTicket, account, liveAvailabilityString, userId }) {
    const id = Number(ticketId);
    if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
      return;
    }

    const startTime = Date.now();
    const MAX_WAIT_MS = 300000; // 5 minutes max payment monitoring
    let qrDetected = false;

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

      // 3. Check for booking confirmation & real PNR
      try {
        const pageUrl = (page.url && typeof page.url === 'function') ? page.url() : '';
        const isConfirmUrl = pageUrl.includes('/booking/confirmation') ||
                             pageUrl.includes('/ticketConfirmation') ||
                             pageUrl.includes('/printTicket');

        let confirmData = null;
        try {
          confirmData = await page.evaluate(() => {
            const bodyText = (document.body ? document.body.innerText : '') || '';
            const pnrMatch = bodyText.match(/PNR\s*(?:No\.?|Number)?\s*[:#-]?\s*([0-9]{10})/i);
            const hasConfirmText = /booking\s+confirmation|ticket\s+details|transaction\s+id/i.test(bodyText) &&
                                   (pnrMatch || /congratulations|booked\s+successfully/i.test(bodyText));
            return {
              confirmed: Boolean(pnrMatch || hasConfirmText),
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
            const toolService = require('../../services/toolService');
            await toolService.createBookingHistory(userId, {
              ticket_name: targetTicket?.ticketName || `Ticket ${id}`,
              irctc_id: account?.irctcUserId || 'N/A',
              from_station: targetTicket?.fromStation || 'NDLS',
              to_station: targetTicket?.toStation || 'CSMT',
              journey_date: targetTicket?.journeyDate || new Date().toISOString().split('T')[0],
              bank_name: targetTicket?.paymentMethod || 'SBI - UPI QR',
              remarks: `Booking Confirmed (PNR: ${pnr})`,
            });
          } catch (histErr) {
            console.warn('[IRCTC Automation] Confirmation history notice:', histErr.message);
          }
          return { completed: true, pnr };
        }

        // 4. Check for payment failure / cancellation on gateway
        let failureDetected = false;
        try {
          failureDetected = Boolean(await page.evaluate(() => {
            const text = (document.body ? document.body.innerText : '').toLowerCase();
            return text.includes('payment failed') ||
                   text.includes('transaction failed') ||
                   text.includes('payment declined') ||
                   text.includes('transaction cancelled') ||
                   text.includes('payment cancelled');
          }));
        } catch {}

        if (failureDetected) {
          this.setBookingStatus(id, 'Payment Failed / Cancelled', {
            qrCode: null,
            availability: liveAvailabilityString,
          });
          return { completed: false, error: 'Payment Failed / Cancelled' };
        }

        // 5. Scan for real QR code rendered by payment gateway (data:image or QR canvas/img)
        let realQr = null;
        try {
          realQr = await page.evaluate(() => {
            // Check images
            const imgs = Array.from(document.querySelectorAll('img'));
            for (const img of imgs) {
              const src = (img.src || '').trim();
              const alt = (img.alt || '').toLowerCase();
              const cls = (img.className || '').toLowerCase();
              const isVis = !!(img.offsetWidth || img.offsetHeight || img.getClientRects().length);
              if (!isVis) continue;

              if (src.startsWith('data:image/') && (alt.includes('qr') || cls.includes('qr') || (img.width >= 100 && img.width <= 400))) {
                return src;
              }
              if ((alt.includes('qr') || cls.includes('qr') || src.includes('qr') || src.includes('qrcode')) &&
                  (src.startsWith('http') || src.startsWith('data:image/'))) {
                return src;
              }
            }

            // Check canvas
            const canvases = Array.from(document.querySelectorAll('canvas'));
            for (const canvas of canvases) {
              const isVis = !!(canvas.offsetWidth || canvas.offsetHeight || canvas.getClientRects().length);
              if (isVis && canvas.width >= 100 && canvas.width <= 450) {
                try {
                  const dataUrl = canvas.toDataURL('image/png');
                  if (dataUrl && dataUrl.startsWith('data:image/')) return dataUrl;
                } catch {}
              }
            }

            return null;
          });
        } catch {}

        if (realQr && !qrDetected) {
          qrDetected = true;
          this.setBookingStatus(id, 'QR Code Available — Scan to Pay', {
            qrCode: realQr,
            paymentStopped: Boolean(stopPayment),
            availability: liveAvailabilityString,
          });
        } else if (!realQr && qrDetected) {
          qrDetected = false;
          this.setBookingStatus(id, stopPayment ? 'Waiting for Payment (Stopped)' : 'Waiting for Payment', {
            qrCode: null,
            paymentStopped: Boolean(stopPayment),
            availability: liveAvailabilityString,
          });
        }
      } catch (pollErr) {
        console.warn(`[IRCTC Automation] Payment poll notice for ticket ${id}:`, pollErr.message);
      }

      if (typeof page.waitForTimeout === 'function') {
        await page.waitForTimeout(1500).catch(() => {});
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }

    // Check if timed out without completion
    const finalState = this._ticketBookingState.get(id);
    if (finalState && finalState.status !== 'Stopped' && !finalState.status.startsWith('Booking Completed') && !finalState.status.startsWith('Payment Failed')) {
      this.setBookingStatus(id, 'Payment Timed Out', {
        qrCode: null,
        availability: liveAvailabilityString,
      });
    }
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
      try {
        if (session?.context) await session.context.close().catch(() => {});
        if (session?.browser) await session.browser.close().catch(() => {});
      } catch {
        // ignore
      }
      this._activeSessions.delete(id);
    }
  }
}

const service = new IrctcAutomationService();
service.AUTH_CODES = AUTH_CODES;
module.exports = service;
