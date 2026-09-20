'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const irctcAutomationService = require('../src/automation/irctc/irctcAutomationService');

test('IRCTC Auth Detection Suite', async (t) => {
  const { AUTH_CODES } = irctcAutomationService;

  await t.test('AUTH_CODES enum defines all required structured states', () => {
    assert.equal(AUTH_CODES.AUTHENTICATED, 'AUTHENTICATED');
    assert.equal(AUTH_CODES.CLIENT_IP_ERROR, 'IRCTC_CLIENT_IP_ERROR');
    assert.equal(AUTH_CODES.INVALID_CREDENTIALS, 'IRCTC_INVALID_CREDENTIALS');
    assert.equal(AUTH_CODES.CAPTCHA_REQUIRED, 'IRCTC_CAPTCHA_REQUIRED');
    assert.equal(AUTH_CODES.OTP_REQUIRED, 'IRCTC_OTP_REQUIRED');
    assert.equal(AUTH_CODES.LOGIN_FORM_STILL_PRESENT, 'IRCTC_LOGIN_FORM_STILL_PRESENT');
    assert.equal(AUTH_CODES.UNKNOWN_AUTH_STATE, 'IRCTC_UNKNOWN_AUTH_STATE');
  });

  await t.test('_checkForClientIpRejection parses real multi-line IRCTC error and extracts client IP', async () => {
    const multiLineIrctcError = `
      Unable to Process Request !!

      Client IP: 103.181.196.183

      Server: 2026-09-19 20:45:12

      Please try after some time.
    `;

    const mockPage = {
      isClosed: () => false,
      evaluate: async (fn) => {
        // Run with mock document.body containing multiLineIrctcError
        const mockDoc = { body: { innerText: multiLineIrctcError } };
        const originalDoc = global.document;
        global.document = mockDoc;
        try {
          return await fn();
        } finally {
          global.document = originalDoc;
        }
      },
    };

    const result = await irctcAutomationService._checkForClientIpRejection(mockPage);
    assert.ok(result, 'Expected client IP rejection to be detected');
    assert.equal(result.clientIp, '103.181.196.183');
    assert.match(result.raw, /Unable to Process Request/i);
    assert.match(result.displayMessage, /Client IP/i);
  });

  await t.test('_checkForClientIpRejection returns null when no Client IP error is present', async () => {
    const normalPageText = 'Welcome to Indian Railways Passenger Reservation System Book Ticket From NDLS To CSMT';
    const mockPage = {
      isClosed: () => false,
      evaluate: async (fn) => {
        const mockDoc = { body: { innerText: normalPageText } };
        const originalDoc = global.document;
        global.document = mockDoc;
        try {
          return await fn();
        } finally {
          global.document = originalDoc;
        }
      },
    };

    const result = await irctcAutomationService._checkForClientIpRejection(mockPage);
    assert.equal(result, null);
  });

  await t.test('getBookingStatus returns structured authResult when set in booking state', () => {
    const ticketId = 99991;
    const authResultPayload = {
      success: false,
      stage: 'authentication',
      code: AUTH_CODES.CLIENT_IP_ERROR,
      message: 'The IRCTC website rejected the current client IP/session.',
      displayMessage: 'The IRCTC website returned a Client IP error. Please try again later or check the network/IP.',
      clientIp: '103.181.196.183',
      retryable: true,
      details: { rawError: 'Unable to Process Request !! Client IP: 103.181.196.183' },
    };

    irctcAutomationService.setBookingStatus(ticketId, 'Login Failed: Client IP rejected by IRCTC', {
      authResult: authResultPayload,
    });

    const status = irctcAutomationService.getBookingStatus(1, ticketId);
    assert.ok(status.authResult, 'Expected authResult to be populated in status');
    assert.equal(status.authResult.code, AUTH_CODES.CLIENT_IP_ERROR);
    assert.equal(status.authResult.clientIp, '103.181.196.183');
    assert.equal(status.authResult.success, false);
    assert.match(status.authResult.displayMessage, /Client IP error/i);
  });

  await t.test('setBookingStatus correctly stores AUTHENTICATED success result', () => {
    const ticketId = 99992;
    const authResultPayload = {
      success: true,
      stage: 'authentication',
      code: AUTH_CODES.AUTHENTICATED,
      message: 'Authentication successful',
      displayMessage: 'Login successful',
      retryable: false,
    };

    irctcAutomationService.setBookingStatus(ticketId, 'Login successful', {
      authResult: authResultPayload,
    });

    const status = irctcAutomationService.getBookingStatus(1, ticketId);
    assert.ok(status.authResult);
    assert.equal(status.authResult.code, AUTH_CODES.AUTHENTICATED);
    assert.equal(status.authResult.success, true);
  });

  await t.test('setBookingStatus correctly stores INVALID_CREDENTIALS error with exact description', () => {
    const ticketId = 99993;
    const authResultPayload = {
      success: false,
      stage: 'authentication',
      code: AUTH_CODES.INVALID_CREDENTIALS,
      message: 'IRCTC authentication rejected: Invalid User',
      displayMessage: 'Invalid IRCTC Credentials (Invalid User)',
      raw: 'Invalid User',
      retryable: false,
    };

    irctcAutomationService.setBookingStatus(ticketId, 'Login Failed: Invalid User', {
      authResult: authResultPayload,
    });

    const status = irctcAutomationService.getBookingStatus(1, ticketId);
    assert.ok(status.authResult);
    assert.equal(status.authResult.code, AUTH_CODES.INVALID_CREDENTIALS);
    assert.equal(status.authResult.success, false);
    assert.equal(status.authResult.displayMessage, 'Invalid IRCTC Credentials (Invalid User)');
  });
});

