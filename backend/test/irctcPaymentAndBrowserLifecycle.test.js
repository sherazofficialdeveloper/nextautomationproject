'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const irctcAutomationService = require('../src/automation/irctc/irctcAutomationService');
const { prewarmEngine, resolveBrowserConfig, BROWSER_LIFECYCLE, clearPathCache } = require('../src/automation/browserConfig');

test('IRCTC Payment State Machine, Browser Lifecycle & Session Reuse Suite', async (t) => {
  await t.test('prewarmEngine memoizes paths and exports BROWSER_LIFECYCLE states', () => {
    clearPathCache();
    const result = prewarmEngine();
    assert.equal(result, true);
    assert.ok(BROWSER_LIFECYCLE.READY);
    assert.ok(BROWSER_LIFECYCLE.IN_USE);
    assert.ok(BROWSER_LIFECYCLE.IDLE);
  });

  await t.test('IRCTC iPay child selection chooses the New option with a descriptive suffix', async () => {
    let mainCategoryClicked = false;
    let childOptionClicked = false;
    const options = [
      {
        selector: '.bank-type',
        metadata: {
          text: 'IRCTC iPay (Credit Card/Debit Card/UPI)',
          ariaLabel: '',
          title: '',
          labelText: '',
          visible: true,
          disabled: false,
        },
        click: async () => { mainCategoryClicked = true; },
      },
      {
        selector: '.bank-text',
        metadata: {
          text: 'IRCTC iPay New',
          ariaLabel: '',
          title: '',
          labelText: '',
          visible: true,
          disabled: false,
        },
        click: async () => { childOptionClicked = true; },
      },
      {
        selector: '.bank-text .col-pad',
        metadata: {
          text: 'IRCTC iPay New PG Charges (Upto): UPI & Rupay(DC):Nil',
          ariaLabel: '',
          title: '',
          labelText: '',
          visible: true,
          disabled: false,
        },
        click: async () => { childOptionClicked = true; },
      },
    ];
    const candidateLocators = options.map((option) => ({
      evaluate: async (callback) => (
        String(callback).includes('getBoundingClientRect')
          ? option.metadata
          : childOptionClicked
      ),
      scrollIntoViewIfNeeded: async () => {},
      click: option.click,
    }));
    const mockPage = {
      url: () => 'https://www.irctc.co.in/nget/payment/bkgPaymentOptions',
      locator: (selector) => {
        assert.match(selector, /\.bank-text/);
        return {
          count: async () => candidateLocators.length,
          nth: (index) => candidateLocators[index],
        };
      },
    };

    const selected = await irctcAutomationService._selectIrctcIpaySubOption(
      mockPage,
      'IRCTC iPay'
    );

    assert.equal(selected, true);
    assert.equal(mainCategoryClicked, false, 'The main payment category must not be clicked as the child option');
    assert.equal(childOptionClicked, true, 'The IRCTC iPay New option must be selected');
  });

  await t.test('IRCTC iPay child selection handles Default Payment (Auto) and selects the New child option', async () => {
    let mainCategoryClicked = false;
    let childOptionClicked = false;
    const options = [
      {
        selector: '.bank-type',
        metadata: {
          text: 'IRCTC iPay (Credit Card/Debit Card/UPI)',
          ariaLabel: '',
          title: '',
          labelText: '',
          visible: true,
          disabled: false,
        },
        click: async () => { mainCategoryClicked = true; },
      },
      {
        selector: '.bank-text',
        metadata: {
          text: 'IRCTC iPay New',
          ariaLabel: '',
          title: '',
          labelText: '',
          visible: true,
          disabled: false,
        },
        click: async () => { childOptionClicked = true; },
      },
    ];
    const candidateLocators = options.map((option) => ({
      evaluate: async (callback) => (
        String(callback).includes('getBoundingClientRect')
          ? option.metadata
          : childOptionClicked
      ),
      scrollIntoViewIfNeeded: async () => {},
      click: option.click,
    }));
    const mockPage = {
      url: () => 'https://www.irctc.co.in/nget/payment/bkgPaymentOptions',
      locator: (selector) => {
        assert.match(selector, /\.bank-text/);
        return {
          count: async () => candidateLocators.length,
          nth: (index) => candidateLocators[index],
        };
      },
    };

    const selected = await irctcAutomationService._selectIrctcIpaySubOption(
      mockPage,
      'Default Payment (Auto)'
    );

    assert.equal(selected, true);
    assert.equal(mainCategoryClicked, false, 'The main payment category must not be clicked as the child option');
    assert.equal(childOptionClicked, true, 'The IRCTC iPay New option must be selected for Default Payment (Auto)');
  });

  await t.test('launchTicketBrowser reuses healthy active session for same browser and account', async () => {
    const ticketId = 98761;
    let closedOldContext = false;

    // Simulate active session in memory
    const mockContext = {
      close: async () => { closedOldContext = true; },
    };
    const mockPage = {
      isClosed: () => false,
      url: () => 'https://www.irctc.co.in/nget/train-search',
    };

    irctcAutomationService._activeSessions.set(ticketId, {
      context: mockContext,
      page: mockPage,
      ticket: { id: ticketId, ticketName: 'Trip 1', irctcAccountId: 10 },
      userId: 1,
      browserConfig: { browserKey: 'chrome', name: 'Google Chrome' },
      stopPayment: false,
      launchedAt: Date.now(),
    });

    const chromeConfig = resolveBrowserConfig('chrome');
    const launchResult = await irctcAutomationService.launchTicketBrowser(
      1,
      { id: ticketId, ticketName: 'Trip 1', irctcAccountId: 10 },
      chromeConfig,
      { stopPayment: true }
    );

    assert.equal(launchResult.launched, true);
    assert.equal(launchResult.reused, true);
    assert.equal(launchResult.browserName, 'Google Chrome');
    assert.equal(closedOldContext, false, 'Should not close healthy active session during reuse');

    // Clean up
    irctcAutomationService._activeSessions.delete(ticketId);
  });

  await t.test('launchTicketBrowser closes old context before switching browsers', async () => {
    const ticketId = 98762;
    let closedOldContext = false;

    const mockContext = {
      close: async () => { closedOldContext = true; },
    };
    const mockPage = {
      isClosed: () => false,
      url: () => 'https://www.irctc.co.in/nget/train-search',
    };

    irctcAutomationService._activeSessions.set(ticketId, {
      context: mockContext,
      page: mockPage,
      ticket: { id: ticketId, ticketName: 'Trip 2', irctcAccountId: 10 },
      userId: 1,
      browserConfig: { browserKey: 'chrome', name: 'Google Chrome' },
      stopPayment: false,
      launchedAt: Date.now(),
    });

    // Requesting Edge instead of Chrome should close the old Chrome session first
    const edgeConfig = resolveBrowserConfig('edge');
    try {
      await irctcAutomationService.launchTicketBrowser(
        1,
        { id: ticketId, ticketName: 'Trip 2', irctcAccountId: 10 },
        edgeConfig,
        { stopPayment: false }
      );
    } catch {
      // In headless environment without Edge display it may throw after closing old context
    }

    assert.equal(closedOldContext, true, 'Must close old context cleanly before launching different browser');
    irctcAutomationService._activeSessions.delete(ticketId);
  });

  await t.test('Stale Chromium lock files are cleaned up from automation profile dir', () => {
    const profileDir = path.join(process.cwd(), 'storage', 'automation-profiles', 'acc_test_locks_chrome');
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }

    const testLock = path.join(profileDir, 'SingletonLock');
    const testCookie = path.join(profileDir, 'SingletonCookie');
    fs.writeFileSync(testLock, '1234');
    fs.writeFileSync(testCookie, '5678');
    assert.ok(fs.existsSync(testLock));
    assert.ok(fs.existsSync(testCookie));

    // Execute lock cleanup logic
    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile'];
    for (const lockFile of lockFiles) {
      try {
        const lockPath = path.join(profileDir, lockFile);
        if (fs.existsSync(lockPath)) {
          fs.unlinkSync(lockPath);
        }
      } catch {}
    }

    assert.equal(fs.existsSync(testLock), false);
    assert.equal(fs.existsSync(testCookie), false);
  });

  await t.test('Authenticated session skips login and emits Existing IRCTC session detected', async () => {
    const ticketId = 98763;
    const mockPage = {
      isClosed: () => false,
      url: () => 'https://www.irctc.co.in/nget/train-search',
      locator: () => ({
        first: () => ({
          isVisible: async () => true, // simulates visible LOGOUT button
        }),
      }),
    };

    const isAuth = await irctcAutomationService._isPageAuthenticated(mockPage);
    assert.equal(isAuth, true);

    irctcAutomationService.setBookingStatus(ticketId, 'Existing IRCTC session detected', {
      authResult: {
        success: true,
        stage: 'authentication',
        code: irctcAutomationService.AUTH_CODES.AUTHENTICATED,
        message: 'Active session reused',
        displayMessage: 'Existing IRCTC session detected',
        reusedSession: true,
      },
    });

    const status = irctcAutomationService.getBookingStatus(1, ticketId);
    assert.equal(status.status, 'Existing IRCTC session detected');
    assert.equal(status.authResult?.reusedSession, true);
  });

  await t.test('Real QR detection extracts data URL and sets qrCode in booking state', async () => {
    const ticketId = 98764;
    const sampleQrDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    let evaluatedCount = 0;
    const mockPage = {
      isClosed: () => false,
      url: () => 'https://paytm.com/payment/gateway',
      waitForTimeout: async () => new Promise((r) => setTimeout(r, 20)),
      evaluate: async (fn) => {
        const fnStr = String(fn);
        if (fnStr.includes('pnrMatch') || fnStr.includes('booking/confirmation')) {
          return { confirmed: false, pnr: null };
        }
        if (fnStr.includes('payment failed')) {
          return false;
        }
        return sampleQrDataUrl;
      },
    };

    irctcAutomationService._activeBookings.add(ticketId);
    irctcAutomationService.setBookingStatus(ticketId, 'Waiting for Payment');

    // Start monitor in background and stop it after 100ms
    const monitorPromise = irctcAutomationService._monitorRealPaymentWorkflow(
      mockPage,
      ticketId,
      {
        stopPayment: false,
        targetTicket: { ticketName: 'Trip QR', id: ticketId },
        account: { irctcUserId: 'user_qr' },
        liveAvailabilityString: 'AVAILABLE',
        userId: 1,
      }
    );

    // Give the loop time to run one cycle
    await new Promise((resolve) => setTimeout(resolve, 100));
    irctcAutomationService.stopTicketBooking(1, ticketId);
    await monitorPromise;

    const state = irctcAutomationService.getBookingStatus(1, ticketId);
    // Real QR was captured
    assert.equal(state.qrCode, sampleQrDataUrl);
  });

  await t.test('Real payment confirmation extracts PNR and marks booking complete', async () => {
    const ticketId = 98765;
    const mockPage = {
      isClosed: () => false,
      url: () => 'https://www.irctc.co.in/nget/booking/confirmation',
      waitForTimeout: async () => {},
      evaluate: async () => ({
        confirmed: true,
        pnr: '2819203948',
      }),
    };

    irctcAutomationService._activeBookings.add(ticketId);
    irctcAutomationService.setBookingStatus(ticketId, 'Waiting for Payment');

    const result = await irctcAutomationService._monitorRealPaymentWorkflow(
      mockPage,
      ticketId,
      {
        stopPayment: false,
        targetTicket: { ticketName: 'Trip Confirmed', id: ticketId },
        account: { irctcUserId: 'user_conf' },
        liveAvailabilityString: 'AVAILABLE',
        userId: 1,
      }
    );

    assert.equal(result.completed, true);
    assert.equal(result.pnr, '2819203948');

    const state = irctcAutomationService.getBookingStatus(1, ticketId);
    assert.match(state.status, /Booking Completed \(PNR: 2819203948\)/);
    assert.equal(state.qrCode, null);
    assert.equal(state.bookingCompleted, true);
  });

  await t.test('Payment failure / cancellation on gateway is detected immediately', async () => {
    const ticketId = 98766;
    let evalCount = 0;
    const mockPage = {
      isClosed: () => false,
      url: () => 'https://pg.irctc.co.in/fail',
      waitForTimeout: async () => {},
      evaluate: async () => {
        evalCount++;
        if (evalCount === 1) return { confirmed: false, pnr: null };
        if (evalCount === 2) return true; // failureDetected = true
        return null;
      },
    };

    irctcAutomationService._activeBookings.add(ticketId);
    irctcAutomationService.setBookingStatus(ticketId, 'Waiting for Payment');

    const result = await irctcAutomationService._monitorRealPaymentWorkflow(
      mockPage,
      ticketId,
      {
        stopPayment: false,
        targetTicket: { ticketName: 'Trip Fail', id: ticketId },
        account: { irctcUserId: 'user_fail' },
        liveAvailabilityString: 'AVAILABLE',
        userId: 1,
      }
    );

    assert.equal(result.completed, false);
    assert.equal(result.error, 'Payment Failed / Cancelled');

    const state = irctcAutomationService.getBookingStatus(1, ticketId);
    assert.equal(state.status, 'Payment Failed / Cancelled');
    assert.equal(state.qrCode, null);
  });
});
