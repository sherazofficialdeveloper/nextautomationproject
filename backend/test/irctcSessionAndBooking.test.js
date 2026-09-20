'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const irctcAutomationService = require('../src/automation/irctc/irctcAutomationService');
const { resolveBrowserConfig, OPTIMIZED_LAUNCH_ARGS, clearPathCache } = require('../src/automation/browserConfig');

test('IRCTC Session Persistence & Booking Pipeline Suite', async (t) => {
  await t.test('OPTIMIZED_LAUNCH_ARGS provides fast-startup headless arguments', () => {
    assert.ok(Array.isArray(OPTIMIZED_LAUNCH_ARGS));
    assert.ok(OPTIMIZED_LAUNCH_ARGS.includes('--disable-extensions'));
    assert.ok(OPTIMIZED_LAUNCH_ARGS.includes('--disable-sync'));
    assert.ok(OPTIMIZED_LAUNCH_ARGS.includes('--no-first-run'));
  });

  await t.test('browserConfig caches resolved paths and can clear cache', () => {
    clearPathCache();
    const c1 = resolveBrowserConfig('chrome');
    assert.ok(c1);
    const c2 = resolveBrowserConfig('chrome');
    assert.equal(c1.executablePath, c2.executablePath);
    clearPathCache();
  });

  await t.test('setBookingStatus deletes authResult when authResult: null is provided', () => {
    const ticketId = 77771;
    // Set initial authResult
    irctcAutomationService.setBookingStatus(ticketId, 'Login successful', {
      authResult: { success: true, message: 'Login successful' },
    });
    let state = irctcAutomationService.getBookingStatus(1, ticketId);
    assert.equal(state.status, 'Login successful');
    assert.ok(state.authResult);

    // Transition to post-login stage with authResult: null
    irctcAutomationService.setBookingStatus(ticketId, 'Searching Train...', { authResult: null });
    state = irctcAutomationService.getBookingStatus(1, ticketId);
    assert.equal(state.status, 'Searching Train...');
    assert.equal(state.authResult, undefined, 'authResult must be deleted to prevent UI freeze');
  });

  await t.test('setBookingStatus sets and updates live availability', () => {
    const ticketId = 77772;
    irctcAutomationService.setBookingStatus(ticketId, 'Checking Availability... [ AVAILABLE-0042 ]', {
      authResult: null,
      availability: 'AVAILABLE-0042',
    });
    const state = irctcAutomationService.getBookingStatus(1, ticketId);
    assert.equal(state.availability, 'AVAILABLE-0042');
    assert.match(state.status, /AVAILABLE-0042/);
  });

  await t.test('_isPageAuthenticated returns true when LOGOUT button is visible in page', async () => {
    const mockPage = {
      isClosed: () => false,
      locator: () => ({
        first: () => ({
          isVisible: async () => true,
        }),
      }),
    };
    const isAuth = await irctcAutomationService._isPageAuthenticated(mockPage);
    assert.equal(isAuth, true);
  });

  await t.test('_isPageAuthenticated returns false when LOGOUT button is absent', async () => {
    const mockPage = {
      isClosed: () => false,
      locator: () => ({
        first: () => ({
          isVisible: async () => false,
        }),
      }),
    };
    const isAuth = await irctcAutomationService._isPageAuthenticated(mockPage);
    assert.equal(isAuth, false);
  });

  await t.test('_fillPassengerDetails fills DOM inputs safely without throwing', async () => {
    const filledNames = [];
    const filledAges = [];
    const selectedGenders = [];

    const mockPage = {
      isClosed: () => false,
      locator: (sel) => {
        if (sel.includes('passengerName') || sel.includes('Passenger Name')) {
          return {
            count: async () => 2,
            nth: (i) => ({
              fill: async (val) => { filledNames[i] = val; },
            }),
          };
        }
        if (sel.includes('passengerAge') || sel.includes('Age')) {
          return {
            count: async () => 2,
            nth: (i) => ({
              fill: async (val) => { filledAges[i] = val; },
            }),
          };
        }
        if (sel.includes('passengerGender')) {
          return {
            count: async () => 2,
            nth: (i) => ({
              selectOption: async (val) => { selectedGenders[i] = val; },
            }),
          };
        }
        return {
          first: () => ({
            isVisible: async () => false,
            click: async () => {},
          }),
        };
      },
      waitForTimeout: async () => {},
    };

    const passengers = [
      { name: 'John Doe', age: 32, gender: 'M' },
      { name: 'Jane Doe', age: 28, gender: 'F' },
    ];

    await irctcAutomationService._fillPassengerDetails(mockPage, passengers);
    assert.equal(filledNames[0], 'John Doe');
    assert.equal(filledNames[1], 'Jane Doe');
    assert.equal(filledAges[0], '32');
    assert.equal(filledAges[1], '28');
    assert.equal(selectedGenders[0], 'M');
    assert.equal(selectedGenders[1], 'F');
  });

  await t.test('clearUserSessions cleans disk profiles for specific account and all accounts', () => {
    const profilesDir = path.join(process.cwd(), 'storage', 'automation-profiles');
    if (!fs.existsSync(profilesDir)) {
      fs.mkdirSync(profilesDir, { recursive: true });
    }

    // Create test account profile folders
    const acc1Dir = path.join(profilesDir, 'acc_901_chrome');
    const acc2Dir = path.join(profilesDir, 'acc_902_edge');
    fs.mkdirSync(acc1Dir, { recursive: true });
    fs.mkdirSync(acc2Dir, { recursive: true });
    fs.writeFileSync(path.join(acc1Dir, 'cookies.json'), '{"test":1}');
    fs.writeFileSync(path.join(acc2Dir, 'cookies.json'), '{"test":2}');

    assert.ok(fs.existsSync(acc1Dir));
    assert.ok(fs.existsSync(acc2Dir));

    // Clear specific account 901
    irctcAutomationService.clearUserSessions(1, 901);
    assert.equal(fs.existsSync(acc1Dir), false, 'Account 901 profile must be deleted');
    assert.equal(fs.existsSync(acc2Dir), true, 'Account 902 profile must remain intact');

    // Clear all profiles
    irctcAutomationService.clearUserSessions(1);
    assert.equal(fs.existsSync(acc2Dir), false, 'All account profiles must be deleted');
  });
});

