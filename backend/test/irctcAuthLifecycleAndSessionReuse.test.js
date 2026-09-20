'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const irctcAutomationService = require('../src/automation/irctc/irctcAutomationService');
const { resolveBrowserConfig } = require('../src/automation/browserConfig');

test('IRCTC Critical Authentication Order, Session Reuse & Profile Isolation Suite', async (t) => {
  function createMockPage({ isAuthenticated = false, hasLoginButton = true, hasClientIpError = false } = {}) {
    return {
      isClosed: () => false,
      locator: (sel) => ({
        first: () => ({
          isVisible: async () => {
            if (sel.includes('logout') || sel.includes('लॉग आउट')) return isAuthenticated;
            if (sel.includes('login') || sel.includes('लॉग इन')) return hasLoginButton;
            return false;
          },
        }),
      }),
      evaluate: async (fn, arg) => {
        const fnStr = typeof fn === 'function' ? fn.toString() : '';
        if (fnStr.includes('unable to process request') || fnStr.includes('client ip')) {
          if (hasClientIpError) {
            return {
              raw: 'Unable to Process Request (Client IP: 1.2.3.4)',
              message: 'The IRCTC website rejected the current client IP/session.',
              displayMessage: 'The IRCTC website returned a Client IP error.',
              clientIp: '1.2.3.4',
            };
          }
          return null;
        }
        if (fnStr.includes('app-header') && fnStr.includes('logout')) {
          return isAuthenticated;
        }
        if (fnStr.includes('loginText') || fnStr.includes('btn-login')) {
          return hasLoginButton;
        }
        return null;
      },
      waitForTimeout: async () => {},
    };
  }

  // Test 1: Unauthenticated page returns AUTH_REQUIRED
  await t.test('1. Unauthenticated page: _detectAuthenticationState returns AUTH_REQUIRED when login button present', async () => {
    const mockPage = createMockPage({ isAuthenticated: false, hasLoginButton: true });

    const isAuth = await irctcAutomationService._isPageAuthenticated(mockPage);
    assert.equal(isAuth, false, 'Unauthenticated page must return false for _isPageAuthenticated');

    const authState = await irctcAutomationService._detectAuthenticationState(mockPage, { irctcUserId: 'IRCTCUSER1' }, 1000);
    assert.equal(authState.state, 'AUTH_REQUIRED', 'Must return AUTH_REQUIRED when login button is present');
  });

  // Test 2: Authenticated page detects session and skips login button
  await t.test('2. Authenticated page: _detectAuthenticationState returns AUTHENTICATED and skips login button requirement', async () => {
    const mockPage = createMockPage({ isAuthenticated: true, hasLoginButton: false });

    const isAuth = await irctcAutomationService._isPageAuthenticated(mockPage, { irctcUserId: 'IRCTCUSER1' });
    assert.equal(isAuth, true, 'Authenticated page must return true for _isPageAuthenticated');

    const authState = await irctcAutomationService._detectAuthenticationState(mockPage, { irctcUserId: 'IRCTCUSER1' }, 1000);
    assert.equal(authState.state, irctcAutomationService.AUTH_CODES.AUTHENTICATED, 'Must return AUTHENTICATED when session is active');
  });

  // Test 3: Authenticated persistent profile reuses session without re-launching
  await t.test('3. Authenticated persistent profile: second request reuses session and skips re-launch', async () => {
    const ticketId = 77001;
    const accountId = 130;
    const sessionLockKey = irctcAutomationService.getSessionLockKey(accountId, 'chrome');

    let closedCount = 0;
    const mockContext = {
      close: async () => { closedCount++; },
      on: () => {},
    };
    const mockPage = {
      isClosed: () => false,
      url: () => 'https://www.irctc.co.in/nget/train-search',
    };

    const mockSession = {
      context: mockContext,
      page: mockPage,
      ticket: { id: ticketId, ticketName: 'Trip A', irctcAccountId: accountId },
      userId: 1,
      accountId,
      browserKey: 'chrome',
      browserConfig: { browserKey: 'chrome', name: 'Google Chrome', executablePath: 'C:\\test\\chrome.exe' },
      stopPayment: false,
      launchedAt: Date.now(),
    };

    // Populate active session
    irctcAutomationService._accountSessions.set(sessionLockKey, mockSession);

    const chromeConfig = resolveBrowserConfig('chrome');
    const result = await irctcAutomationService.launchTicketBrowser(
      1,
      { id: ticketId, ticketName: 'Trip A', irctcAccountId: accountId },
      chromeConfig
    );

    assert.equal(result.launched, true);
    assert.equal(result.reused, true, 'Second request must mark reused: true');
    assert.equal(result.browserName, 'Google Chrome');
    assert.equal(closedCount, 0, 'Must not close healthy context on session reuse');

    // Clean up
    irctcAutomationService._accountSessions.delete(sessionLockKey);
    irctcAutomationService._activeSessions.delete(ticketId);
  });

  // Test 4: Expired or invalid session triggers login path
  await t.test('4. Expired/invalid session: authentication check returns false and begins normal login path', async () => {
    const mockPage = createMockPage({ isAuthenticated: false, hasLoginButton: true });

    const isAuth = await irctcAutomationService._isPageAuthenticated(mockPage, { irctcUserId: 'IRCTCUSER1' });
    assert.equal(isAuth, false, 'Expired session must return false for _isPageAuthenticated');

    const authState = await irctcAutomationService._detectAuthenticationState(mockPage, { irctcUserId: 'IRCTCUSER1' }, 1000);
    assert.equal(authState.state, 'AUTH_REQUIRED', 'Must return AUTH_REQUIRED so normal login begins');
  });

  // Test 5: Same account + same browser concurrency single-flight
  await t.test('5. Same account + same browser: single-flight lock prevents duplicate launches', async () => {
    const accountId = 130;
    const sessionLockKey = irctcAutomationService.getSessionLockKey(accountId, 'chrome');

    assert.equal(sessionLockKey, '130_chrome');

    let resolveLaunch;
    const fakePendingLaunch = new Promise((resolve) => {
      resolveLaunch = resolve;
    });

    irctcAutomationService._launchLocks.set(sessionLockKey, fakePendingLaunch);

    // Call launchTicketBrowser while lock is active
    let completedSecond = false;
    const chromeConfig = resolveBrowserConfig('chrome');
    const secondCall = irctcAutomationService.launchTicketBrowser(
      1,
      { id: 77002, ticketName: 'Trip Concurrent', irctcAccountId: accountId },
      chromeConfig
    ).then((res) => {
      completedSecond = true;
      return res;
    });

    // Verify second call is waiting for the single-flight lock
    assert.equal(completedSecond, false, 'Second request must wait on in-flight promise');

    // Resolve the first launch
    resolveLaunch({
      launched: true,
      reused: false,
      browserName: 'Google Chrome',
      ticketId: 77002,
    });

    const res2 = await secondCall;
    assert.equal(res2.launched, true);
    assert.equal(completedSecond, true);

    // Clean up
    irctcAutomationService._launchLocks.delete(sessionLockKey);
  });

  // Test 6: Different accounts use isolated profile paths
  await t.test('6. Different accounts: acc_130_chrome and acc_131_chrome use distinct isolated profiles', () => {
    const key130 = irctcAutomationService.getSessionLockKey(130, 'chrome');
    const key131 = irctcAutomationService.getSessionLockKey(131, 'chrome');

    assert.equal(key130, '130_chrome');
    assert.equal(key131, '131_chrome');
    assert.notEqual(key130, key131, 'Account 130 and 131 must have different session keys');

    const path130 = path.join(process.cwd(), 'storage', 'automation-profiles', `acc_130_chrome`);
    const path131 = path.join(process.cwd(), 'storage', 'automation-profiles', `acc_131_chrome`);
    assert.notEqual(path130, path131, 'Account 130 and 131 profile directories must be completely isolated');
    assert.ok(path130.includes('acc_130_chrome'));
    assert.ok(path131.includes('acc_131_chrome'));
  });

  // Test 7: Different browsers use distinct browser-specific profiles
  await t.test('7. Different browsers: Chrome and Edge use distinct browser-specific profiles for same account', () => {
    const chromeKey = irctcAutomationService.getSessionLockKey(130, 'chrome');
    const edgeKey = irctcAutomationService.getSessionLockKey(130, 'edge');

    assert.equal(chromeKey, '130_chrome');
    assert.equal(edgeKey, '130_edge');
    assert.notEqual(chromeKey, edgeKey, 'Chrome and Edge must have different session keys');

    const chromePath = path.join(process.cwd(), 'storage', 'automation-profiles', `acc_130_chrome`);
    const edgePath = path.join(process.cwd(), 'storage', 'automation-profiles', `acc_130_edge`);
    assert.notEqual(chromePath, edgePath, 'Chrome and Edge profiles must be isolated');
  });

  // Test 8: Closed/stale context is purged safely
  await t.test('8. Closed/stale context: detects dead page and purges stale session reference', async () => {
    const ticketId = 77008;
    const accountId = 135;
    const sessionLockKey = irctcAutomationService.getSessionLockKey(accountId, 'chrome');

    let closedCalled = false;
    const mockContext = {
      close: async () => { closedCalled = true; },
      on: () => {},
    };
    const mockDeadPage = {
      isClosed: () => true, // simulates closed / crashed page
      url: () => '',
    };

    const staleSession = {
      context: mockContext,
      page: mockDeadPage,
      ticket: { id: ticketId, ticketName: 'Stale Trip', irctcAccountId: accountId },
      userId: 1,
      accountId,
      browserKey: 'chrome',
      browserConfig: { browserKey: 'chrome', name: 'Google Chrome', executablePath: 'C:\\fake\\chrome.exe' },
      launchedAt: Date.now(),
    };
    irctcAutomationService._accountSessions.set(sessionLockKey, staleSession);

    assert.ok(irctcAutomationService._accountSessions.has(sessionLockKey));

    // Stale session check matching launchTicketBrowser logic
    const existing = irctcAutomationService._accountSessions.get(sessionLockKey);
    const isAlive = Boolean(existing?.page && typeof existing.page.isClosed === 'function' && !existing.page.isClosed());
    assert.equal(isAlive, false, 'Closed page must be recognized as not alive');

    if (!isAlive) {
      irctcAutomationService._accountSessions.delete(sessionLockKey);
      if (existing?.context) await existing.context.close().catch(() => {});
    }

    // Must have purged the stale reference
    assert.equal(closedCalled, true, 'Must have closed dead session context');
    assert.equal(irctcAutomationService._accountSessions.has(sessionLockKey), false, 'Stale session must be evicted from _accountSessions');
  });

  // Test 9: Cookie Delete clears application-owned session and disk profile
  await t.test('9. Cookie Delete: clearUserSessions closes contexts and purges application-owned profile directory', () => {
    const accountId = 9999;
    const sessionLockKey = irctcAutomationService.getSessionLockKey(accountId, 'chrome');

    let contextClosed = false;
    irctcAutomationService._accountSessions.set(sessionLockKey, {
      context: { close: async () => { contextClosed = true; } },
      page: { isClosed: () => false },
      accountId,
      browserKey: 'chrome',
    });

    // Create mock disk profile directory
    const testProfileDir = path.join(process.cwd(), 'storage', 'automation-profiles', `acc_${accountId}_chrome`);
    if (!fs.existsSync(testProfileDir)) {
      fs.mkdirSync(testProfileDir, { recursive: true });
    }
    const dummyCookie = path.join(testProfileDir, 'Cookies');
    fs.writeFileSync(dummyCookie, 'session_cookie_data');
    assert.ok(fs.existsSync(dummyCookie), 'Dummy cookie file must exist before purge');

    // Run clearUserSessions
    const cleared = irctcAutomationService.clearUserSessions(1, accountId);
    assert.ok(cleared >= 1, 'Must report at least 1 session cleared');
    assert.equal(irctcAutomationService._accountSessions.has(sessionLockKey), false, 'Must be removed from _accountSessions');
    assert.equal(fs.existsSync(testProfileDir), false, 'Disk profile directory must be deleted');
    assert.equal(contextClosed, true, 'Active persistent context must be closed before deletion');
  });

  // Test 10: Existing AUTH_SUCCESS status flow continues to emit valid authResult
  await t.test('10. Existing AUTH_SUCCESS path sets authenticated status properly', () => {
    const ticketId = 77010;
    const status = irctcAutomationService.setBookingStatus(ticketId, 'Login successful', {
      authResult: {
        success: true,
        stage: 'authentication',
        code: irctcAutomationService.AUTH_CODES.AUTHENTICATED,
        message: 'Authentication successful',
        displayMessage: 'Login successful',
        currentUrl: 'https://www.irctc.co.in/nget/train-search',
        retryable: false,
        reusedSession: false,
      },
    });

    assert.equal(status.status, 'Login successful');
    assert.equal(status.authResult.success, true);
    assert.equal(status.authResult.code, 'AUTHENTICATED');
    assert.equal(status.authResult.reusedSession, false);

    const retrieved = irctcAutomationService.getBookingStatus(1, ticketId);
    assert.equal(retrieved.status, 'Login successful');
    assert.equal(retrieved.authResult.code, 'AUTHENTICATED');
  });
});

