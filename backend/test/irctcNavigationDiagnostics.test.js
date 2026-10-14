'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const irctcAutomationService = require('../src/automation/irctc/irctcAutomationService');

function createPage({ goto }) {
  const page = new EventEmitter();
  page.url = () => 'about:blank';
  page.mainFrame = () => ({ url: () => page.url() });
  page.goto = goto;
  page.off = page.removeListener.bind(page);
  return page;
}

test('IRCTC navigation diagnostics', async (t) => {
  await t.test('uses headed mode by default and requires explicit opt-in for headless mode', () => {
    assert.equal(irctcAutomationService.resolveHeadlessMode(undefined), false);
    assert.equal(irctcAutomationService.resolveHeadlessMode(''), false);
    assert.equal(irctcAutomationService.resolveHeadlessMode('false'), false);
    assert.equal(irctcAutomationService.resolveHeadlessMode('true'), true);
  });

  await t.test('captures successful navigation response and final URL', async () => {
    const page = createPage({
      goto: async () => {
        page.url = () => 'https://www.irctc.co.in/nget/train-search';
        page.emit('request', { isNavigationRequest: () => true, url: () => 'https://www.irctc.co.in/nget/train-search', method: () => 'GET' });
        page.emit('response', { url: () => 'https://www.irctc.co.in/nget/train-search', status: () => 200 });
        return { status: () => 200 };
      },
    });

    const result = await irctcAutomationService._gotoWithDiagnostics(page, 'https://www.irctc.co.in/nget/train-search', {
      ticketId: 57,
      accountId: 130,
      browser: 'Google Chrome',
      sessionKey: '130_chrome',
      profileIdentifier: 'test-profile',
      timeout: 20000,
    });

    assert.equal(result.status, 200);
    assert.equal(result.finalUrl, 'https://www.irctc.co.in/nget/train-search');
    assert.equal(result.correlationId.startsWith('nav_'), true);
    assert.equal(result.events.some((event) => event.type === 'response' && event.status === 200), true);
  });

  await t.test('preserves ERR_HTTP2_PROTOCOL_ERROR and requestfailed evidence', async () => {
    const page = createPage({
      goto: async () => {
        const request = {
          url: () => 'https://www.irctc.co.in/nget/train-search',
          failure: () => ({ errorText: 'net::ERR_HTTP2_PROTOCOL_ERROR' }),
        };
        page.emit('requestfailed', request);
        throw new Error('page.goto: net::ERR_HTTP2_PROTOCOL_ERROR');
      },
    });

    await assert.rejects(
      () => irctcAutomationService._navigateWithFallback(
        page,
        'https://www.irctc.co.in/nget/train-search',
        'https://www.irctc.co.in/nget/train-search',
        { ticketId: 57, accountId: 130, sessionKey: '130_chrome' }
      ),
      (error) => {
        assert.equal(error.code, 'IRCTC_NAVIGATION_TRANSPORT_ERROR');
        assert.match(error.message, /ERR_HTTP2_PROTOCOL_ERROR/);
        assert.equal(error.navigationDiagnostics.events[0].failure, 'net::ERR_HTTP2_PROTOCOL_ERROR');
        return true;
      }
    );
  });

  await t.test('tries a genuinely distinct secondary URL once', async () => {
    const urls = [];
    const page = createPage({
      goto: async (url) => {
        urls.push(url);
        throw new Error('page.goto: net::ERR_CONNECTION_RESET');
      },
    });

    await assert.rejects(
      () => irctcAutomationService._navigateWithFallback(
        page,
        'https://primary.example.test',
        'https://secondary.example.test',
        {}
      ),
      /ERR_CONNECTION_RESET/
    );
    assert.deepEqual(urls, ['https://primary.example.test', 'https://secondary.example.test']);
  });

  await t.test('classifies an HTTP 403 response as non-retryable access denial', async () => {
    const urls = [];
    const page = createPage({
      goto: async (url) => {
        urls.push(url);
        page.url = () => url;
        return {
          status: () => 403,
        };
      },
    });

    await assert.rejects(
      () => irctcAutomationService._navigateWithFallback(
        page,
        'https://primary.example.test',
        'https://secondary.example.test',
        {}
      ),
      (error) => {
        assert.equal(error.code, 'IRCTC_ACCESS_DENIED');
        assert.equal(error.status, 403);
        assert.equal(error.nonRetryableNavigation, true);
        assert.equal(error.navigationDiagnostics.status, 403);
        return true;
      }
    );
    assert.deepEqual(urls, ['https://primary.example.test']);
  });

  await t.test('normalizes IRCTC class codes from control metadata', () => {
    assert.equal(irctcAutomationService.normalizeIrctcClassCode('1A Available - 12'), '1A');
    assert.equal(irctcAutomationService.normalizeIrctcClassCode('aria-label: 3A fare'), '3A');
    assert.equal(irctcAutomationService.normalizeIrctcClassCode('AC First Class'), '1A');
    assert.equal(irctcAutomationService.normalizeIrctcClassCode('AC 3 Tier'), '3A');
    assert.equal(irctcAutomationService.normalizeIrctcClassCode('Train 12302 Available'), null);
  });

  await t.test('normalizes IRCTC availability card dates without timezone conversion', () => {
    assert.equal(
      irctcAutomationService.extractIrctcAvailabilityDate('Tue, 22 Sep AVAILABLE-0108', '2026'),
      '2026-09-22'
    );
    assert.equal(
      irctcAutomationService.extractIrctcAvailabilityDate('Saturday, 26 Sep RAC 48', '2026'),
      '2026-09-26'
    );
  });
});
