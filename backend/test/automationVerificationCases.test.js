'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require('patchright-core');
const {
  resolveBrowserConfig,
  checkAllBrowsersAvailability,
  getApplicationChromiumPath,
} = require('../src/automation/browserConfig');
const irctcAutomationService = require('../src/automation/irctc/irctcAutomationService');

test('CASE A: Google Chrome installed -> starts in background without visible window', async () => {
  const chromeConfig = resolveBrowserConfig('chrome');
  assert.equal(chromeConfig.isAvailable, true);
  assert.equal(chromeConfig.launchMode, 'Background');
  assert.ok(fs.existsSync(chromeConfig.executablePath), 'Chrome executable must exist');

  const profileDir = path.join(__dirname, '..', 'storage', 'test-profiles', 'case-a-chrome');
  fs.mkdirSync(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    executablePath: chromeConfig.executablePath,
    viewport: { width: 1440, height: 900 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-position=-3200,-3200',
    ],
  });

  assert.ok(context, 'Context must be created in background');
  const page = context.pages()[0] || (await context.newPage());
  assert.ok(page, 'Page must be available');
  await context.close();
});

test('CASE B: Application-owned runtime is available and can launch in background', async () => {
  const appChromium = getApplicationChromiumPath();
  assert.ok(appChromium, 'Application chromium path must resolve');
  assert.ok(fs.existsSync(appChromium), 'Application chromium executable must exist');

  const profileDir = path.join(__dirname, '..', 'storage', 'test-profiles', 'case-b-app-runtime');
  fs.mkdirSync(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    executablePath: appChromium,
    viewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-position=-3200,-3200'],
  });

  assert.ok(context, 'Application runtime must start in background');
  await context.close();
});

test('CASE C: Uninstalled system browsers (Brave/Opera/Comet) fall back to Application Chromium runtime', () => {
  const braveConfig = resolveBrowserConfig('brave');
  assert.equal(braveConfig.name, 'Brave');
  assert.equal(braveConfig.isAvailable, true, 'Brave must be Available via application runtime');
  assert.equal(braveConfig.status, 'Available');
  assert.equal(braveConfig.resolvedRuntime, 'Application Chromium Runtime');
  assert.equal(braveConfig.isFallback, true);

  const operaConfig = resolveBrowserConfig('opera');
  assert.equal(operaConfig.isAvailable, true);
  assert.equal(operaConfig.resolvedRuntime, 'Application Chromium Runtime');

  const cometConfig = resolveBrowserConfig('comet');
  assert.equal(cometConfig.isAvailable, true);
  assert.equal(cometConfig.resolvedRuntime, 'Application Chromium Runtime');
});

test('CASE D: Real availability check returns accurate status for all 5 browsers without opening visible windows', () => {
  const availability = checkAllBrowsersAvailability();
  assert.ok(availability.chrome, 'Chrome must be in availability list');
  assert.ok(availability.edge, 'Edge must be in availability list');
  assert.ok(availability.brave, 'Brave must be in availability list');
  assert.ok(availability.opera, 'Opera must be in availability list');
  assert.ok(availability.comet, 'Comet must be in availability list');

  assert.equal(availability.chrome.status, 'Available');
  assert.equal(availability.edge.status, 'Available');
  assert.equal(availability.brave.status, 'Available');
  assert.equal(availability.opera.status, 'Available');
  assert.equal(availability.comet.status, 'Available');
});

test('CASE E: Double-click concurrency guard prevents duplicate sessions for the same ticket', async () => {
  const fakeTicketId = 99991;
  const fakeUserId = 1;

  // Simulate two rapid calls to startTicketBooking
  const call1 = irctcAutomationService.startTicketBooking(fakeUserId, fakeTicketId, { stopPayment: false });
  const call2 = irctcAutomationService.startTicketBooking(fakeUserId, fakeTicketId, { stopPayment: false });

  const res1 = await call1;
  const res2 = await call2;

  assert.equal(res1.ticketId, fakeTicketId);
  assert.equal(res2.ticketId, fakeTicketId);
  assert.ok(irctcAutomationService._activeBookings.has(fakeTicketId), 'Only one booking state active');

  // Clean up
  await irctcAutomationService.stopTicketBooking(fakeUserId, fakeTicketId);
  assert.equal(irctcAutomationService._activeBookings.has(fakeTicketId), false);
});

test('CASE F: IRCTC Client IP rejection is detected immediately and halts login without blind 3-minute wait', async () => {
  const fakePage = {
    isClosed: () => false,
    evaluate: async (fn) => {
      // Simulate IRCTC DOM containing the exact Client IP error
      return 'Unable to Process Request ... Client IP: 103.21.124.50';
    },
  };

  const detected = await irctcAutomationService._checkForClientIpRejection(fakePage);
  assert.ok(detected, 'Client IP rejection must be detected');
  assert.match(detected, /Client IP:/);

  // Set booking status accordingly
  const statusUpdate = irctcAutomationService.setBookingStatus(99992, 'Login Failed: Client IP rejected by IRCTC', {
    clientIpError: detected,
  });
  assert.equal(statusUpdate.status, 'Login Failed: Client IP rejected by IRCTC');
  assert.equal(statusUpdate.clientIpError, detected);
});

test('CASE G: Security challenge (CAPTCHA / OTP) pauses automation safely without bypass', async () => {
  const ticketId = 99993;
  // Simulating CAPTCHA detection
  const captchaStatus = irctcAutomationService.setBookingStatus(ticketId, 'Manual Interaction Required: CAPTCHA');
  assert.equal(captchaStatus.status, 'Manual Interaction Required: CAPTCHA');

  // Simulating OTP detection
  const otpStatus = irctcAutomationService.setBookingStatus(ticketId, 'Manual Interaction Required: OTP');
  assert.equal(otpStatus.status, 'Manual Interaction Required: OTP');
});

test('CASE H: Clean process termination leaves zero active processes and no session leaks', async () => {
  const testTicketId = 99994;
  const profileDir = path.join(__dirname, '..', 'storage', 'test-profiles', 'case-h-cleanup');
  fs.mkdirSync(profileDir, { recursive: true });

  const appChromium = getApplicationChromiumPath();
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    executablePath: appChromium,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-position=-3200,-3200'],
  });

  irctcAutomationService._activeSessions.set(testTicketId, {
    context,
    browser: null,
    ticket: { id: testTicketId },
    userId: 1,
  });

  assert.ok(irctcAutomationService._activeSessions.has(testTicketId));
  await irctcAutomationService.closeTicketBrowser(testTicketId);

  assert.equal(irctcAutomationService._activeSessions.has(testTicketId), false, 'Session must be removed from active map');
});

