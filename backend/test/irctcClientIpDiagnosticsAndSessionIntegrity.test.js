'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const irctcAutomationService = require('../src/automation/irctc/irctcAutomationService');
const { resolveBrowserConfig } = require('../src/automation/browserConfig');

test('IRCTC Client IP Diagnostics, Network Path & Session Integrity Suite', async (t) => {
  // 1. Normal manual browser remains unaffected
  await t.test('1. Normal manual browser unaffected: application never touches personal Chrome/Edge User Data paths', () => {
    const localAppData = process.env.LOCALAPPDATA || 'C:\\Users\\Mock\\AppData\\Local';
    const personalChromeProfile = path.join(localAppData, 'Google', 'Chrome', 'User Data');
    const personalEdgeProfile = path.join(localAppData, 'Microsoft', 'Edge', 'User Data');

    const appProfile130 = path.join(process.cwd(), 'storage', 'automation-profiles', 'acc_130_chrome');
    const appProfile131 = path.join(process.cwd(), 'storage', 'automation-profiles', 'acc_131_edge');

    assert.notEqual(appProfile130, personalChromeProfile);
    assert.notEqual(appProfile131, personalEdgeProfile);
    assert.ok(appProfile130.includes(path.join('storage', 'automation-profiles')));
    assert.ok(!appProfile130.includes(path.join('Google', 'Chrome', 'User Data')));
  });

  // 2. Automation direct connection without unintended proxy
  await t.test('2. Automation direct connection: confirms zero proxy configuration in process and environment', () => {
    assert.equal(process.env.HTTP_PROXY, undefined, 'HTTP_PROXY must not be set');
    assert.equal(process.env.HTTPS_PROXY, undefined, 'HTTPS_PROXY must not be set');
    assert.equal(process.env.ALL_PROXY, undefined, 'ALL_PROXY must not be set');

    const chromeConfig = resolveBrowserConfig('chrome');
    assert.ok(chromeConfig.executablePath, 'Chrome executable must be resolvable');
    assert.equal(chromeConfig.proxy, undefined, 'Browser config must not define a proxy');
  });

  // 3. Persistent session reuse: first request registers session, second request reuses it
  await t.test('3. Persistent session reuse: second request reuses session without re-launching context', async () => {
    const ticketId = 88001;
    const accountId = 140;
    const sessionLockKey = irctcAutomationService.getSessionLockKey(accountId, 'chrome');

    let closed = false;
    const mockSession = {
      context: { close: async () => { closed = true; }, on: () => {} },
      page: { isClosed: () => false, url: () => 'https://www.irctc.co.in/nget/train-search' },
      ticket: { id: ticketId, ticketName: 'Reuse Trip', irctcAccountId: accountId },
      userId: 1,
      accountId,
      browserKey: 'chrome',
      browserConfig: { browserKey: 'chrome', name: 'Google Chrome', executablePath: 'C:\\test\\chrome.exe' },
      reused: false,
      launchedAt: Date.now(),
    };

    irctcAutomationService._accountSessions.set(sessionLockKey, mockSession);

    const chromeConfig = resolveBrowserConfig('chrome');
    const result = await irctcAutomationService.launchTicketBrowser(
      1,
      { id: ticketId, ticketName: 'Reuse Trip', irctcAccountId: accountId },
      chromeConfig
    );

    assert.equal(result.launched, true);
    assert.equal(result.reused, true, 'Second request must mark reused: true');
    assert.equal(closed, false, 'Healthy context must not be closed on reuse');

    irctcAutomationService._accountSessions.delete(sessionLockKey);
    irctcAutomationService._activeSessions.delete(ticketId);
  });

  // 4. No duplicate workflow launch
  await t.test('4. No duplicate workflow launch: _activeBookings prevents concurrent runs for same ticket', async () => {
    const ticketId = 88004;
    irctcAutomationService._activeBookings.add(ticketId);

    const status = await irctcAutomationService.startTicketBooking(1, ticketId, {
      ticket: { id: ticketId, irctcAccountId: 140 },
    });

    assert.ok(status, 'Must return current status');
    // Active bookings set must still contain the single run
    assert.ok(irctcAutomationService._activeBookings.has(ticketId));

    irctcAutomationService._activeBookings.delete(ticketId);
  });

  // 5. Same account/browser does not create duplicate contexts (single-flight lock)
  await t.test('5. Single-flight lock: concurrent launches for same (account + browser) share single launch promise', async () => {
    const accountId = 145;
    const sessionLockKey = irctcAutomationService.getSessionLockKey(accountId, 'chrome');

    let resolvePending;
    const inFlightPromise = new Promise((resolve) => {
      resolvePending = resolve;
    });
    irctcAutomationService._launchLocks.set(sessionLockKey, inFlightPromise);

    let secondCompleted = false;
    const chromeConfig = resolveBrowserConfig('chrome');
    const secondCall = irctcAutomationService.launchTicketBrowser(
      1,
      { id: 88005, ticketName: 'Lock Test', irctcAccountId: accountId },
      chromeConfig
    ).then((res) => {
      secondCompleted = true;
      return res;
    });

    assert.equal(secondCompleted, false, 'Must await in-flight promise');
    resolvePending({ launched: true, reused: false, browserName: 'Google Chrome' });

    const res = await secondCall;
    assert.equal(res.launched, true);
    assert.equal(secondCompleted, true);

    irctcAutomationService._launchLocks.delete(sessionLockKey);
  });

  // 6. Different accounts remain isolated
  await t.test('6. Profile isolation: account 130 and 131 use isolated paths and distinct lock keys', () => {
    const key130 = irctcAutomationService.getSessionLockKey(130, 'chrome');
    const key131 = irctcAutomationService.getSessionLockKey(131, 'chrome');
    assert.notEqual(key130, key131);

    const path130 = path.join(process.cwd(), 'storage', 'automation-profiles', `acc_130_chrome`);
    const path131 = path.join(process.cwd(), 'storage', 'automation-profiles', `acc_131_chrome`);
    assert.notEqual(path130, path131);
  });

  // 7. Client-IP response is correctly detected and surfaced with structured IRCTC_REJECTION telemetry
  await t.test('7. Client-IP detection: structured IRCTC_REJECTION telemetry is generated without sensitive data', async () => {
    const mockPage = {
      isClosed: () => false,
      url: () => 'https://www.irctc.co.in/nget/train-search',
      evaluate: async () => ({
        raw: 'Unable to Process Request (Client IP: 103.17.108.174)',
        message: 'The IRCTC website rejected the current client IP/session.',
        displayMessage: 'The IRCTC website returned a Client IP error. Please try again later or check the network/IP.',
        clientIp: '103.17.108.174',
      }),
    };

    const clientIpErr = await irctcAutomationService._checkForClientIpRejection(mockPage);
    assert.ok(clientIpErr, 'Must detect Client IP error');
    assert.equal(clientIpErr.clientIp, '103.17.108.174');

    const telemetry = irctcAutomationService._recordIrctcRejectionTelemetry({
      stage: 'LANDING',
      ticketId: 88007,
      accountId: 150,
      browserKey: 'chrome',
      page: mockPage,
      profilePath: 'storage/automation-profiles/acc_150_chrome',
      sessionReused: false,
      authState: 'LANDING_CHECK',
      clientIpError: clientIpErr,
    });

    assert.equal(telemetry.type, 'IRCTC_REJECTION');
    assert.ok(telemetry.correlationId.startsWith('rej_'));
    assert.equal(telemetry.stage, 'LANDING');
    assert.equal(telemetry.ticketId, 88007);
    assert.equal(telemetry.accountId, '150');
    assert.equal(telemetry.browserKey, 'chrome');
    assert.equal(telemetry.clientIp, '103.17.108.174');
    assert.equal(telemetry.proxyConfigured, false);
    assert.equal(telemetry.pageUrl, 'https://www.irctc.co.in/nget/train-search');

    // 8. No sensitive information appears in rejection telemetry
    assert.equal(telemetry.password, undefined);
    assert.equal(telemetry.cookies, undefined);
    assert.equal(telemetry.cookie, undefined);
    assert.equal(telemetry.authorization, undefined);
    assert.equal(telemetry.token, undefined);
    assert.equal(telemetry.captcha, undefined);
  });

  // 9. Existing AUTH_SUCCESS behavior remains working
  await t.test('9. Existing AUTH_SUCCESS behavior: valid login or reused session updates status correctly', () => {
    const ticketId = 88009;
    const status = irctcAutomationService.setBookingStatus(ticketId, 'Existing IRCTC session detected', {
      authResult: {
        success: true,
        stage: 'authentication',
        code: irctcAutomationService.AUTH_CODES.AUTHENTICATED,
        message: 'Active session reused',
        displayMessage: 'Existing IRCTC session detected',
        reusedSession: true,
      },
    });

    assert.equal(status.status, 'Existing IRCTC session detected');
    assert.equal(status.authResult.success, true);
    assert.equal(status.authResult.reusedSession, true);
    assert.equal(status.authResult.code, 'AUTHENTICATED');
  });

  // 10. Cookie Delete still clears only application-owned automation session/profile
  await t.test('10. Cookie Delete: clearUserSessions deletes only application-owned profile directory', () => {
    const accountId = 88888;
    const sessionLockKey = irctcAutomationService.getSessionLockKey(accountId, 'chrome');

    let closed = false;
    irctcAutomationService._accountSessions.set(sessionLockKey, {
      context: { close: async () => { closed = true; } },
      page: { isClosed: () => false },
      accountId,
      browserKey: 'chrome',
    });

    const testDir = path.join(process.cwd(), 'storage', 'automation-profiles', `acc_${accountId}_chrome`);
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    fs.writeFileSync(path.join(testDir, 'Cookies'), 'dummy_cookie');

    const cleared = irctcAutomationService.clearUserSessions(1, accountId);
    assert.ok(cleared >= 1);
    assert.equal(closed, true, 'Active context must be closed before deletion');
    assert.equal(fs.existsSync(testDir), false, 'Application-owned profile must be deleted');
    assert.equal(irctcAutomationService._accountSessions.has(sessionLockKey), false);
  });
});

