'use strict';

/**
 * IRCTC Network CDP Token Capture & DNR-parity Header Rewriter
 * Matches Red Box architecture:
 * 1. CDP Network monitoring to capture access_token, refresh_token (bmiyek), and CSRF tokens.
 * 2. CDP Fetch interception to enforce correct Referer/Origin headers for mapps1/wps/ipay requests.
 */

const MAPPS_REFERERS = [
  [/validateUser/i, 'https://www.irctc.co.in/nget/train-search'],
  [/altAvlEnq/i, 'https://www.irctc.co.in/nget/train-search'],
  [/avlFarenquiry/i, 'https://www.irctc.co.in/nget/booking/train-list'],
  [/boardingStationEnq/i, 'https://www.irctc.co.in/nget/booking/train-list'],
  [/allLapAvlFareEnq/i, 'https://www.irctc.co.in/nget/booking/psgninput'],
  [/addonServices/i, 'https://www.irctc.co.in/nget/booking/reviewBooking'],
  [/bookingInitPayment/i, 'https://www.irctc.co.in/nget/payment/bkgPaymentOptions'],
  [/mapps1\//i, 'https://www.irctc.co.in/nget/train-search'],
];

function refererForUrl(url, activePageUrl = '') {
  const isEticket = String(activePageUrl || '').includes('/eticket');
  const base = isEticket ? 'https://www.irctc.co.in/eticket' : 'https://www.irctc.co.in/nget';
  const u = String(url || '');
  if (/avlFarenquiry|boardingStationEnq/i.test(u)) return `${base}/booking/train-list`;
  if (/allLapAvlFareEnq/i.test(u)) return `${base}/booking/psgninput`;
  if (/addonServices/i.test(u)) return `${base}/booking/reviewBooking`;
  if (/bookingInitPayment/i.test(u)) return `${base}/payment/bkgPaymentOptions`;
  return `${base}/train-search`;
}

function acceptLanguageFromList(languages) {
  const list = Array.isArray(languages) ? languages.filter(Boolean) : [];
  if (!list.length) return 'en-US,en;q=0.9';
  return list
    .map((lang, i) => {
      const code = String(lang).trim();
      if (!code) return null;
      if (i === 0) return code;
      const q = Math.max(0.1, 1 - i * 0.1).toFixed(1);
      return `${code};q=${q}`;
    })
    .filter(Boolean)
    .join(',');
}

function browserLikeHeaders(referer, acceptLanguage) {
  return {
    'Accept-Language': acceptLanguage || 'en-US,en;q=0.9',
    'Content-Language': 'en',
    Origin: 'https://www.irctc.co.in',
    Referer: referer,
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
  };
}

function mergeHeaderArray(existing, extra) {
  const map = new Map();
  for (const h of existing || []) {
    if (!h || !h.name) continue;
    map.set(String(h.name).toLowerCase(), { name: h.name, value: h.value });
  }
  for (const [name, value] of Object.entries(extra || {})) {
    map.set(name.toLowerCase(), { name, value });
  }
  map.delete('x-requested-with');
  map.delete('sec-fetch-storage-access');
  return [...map.values()];
}

function extractTokensFromHeaders(headers) {
  const out = {};
  if (!headers) return out;
  const norm = {};
  if (Array.isArray(headers)) {
    for (const h of headers) {
      if (h && h.name) norm[String(h.name).toLowerCase()] = h.value;
    }
  } else {
    for (const [k, v] of Object.entries(headers)) norm[String(k).toLowerCase()] = v;
  }
  const auth = norm.authorization || '';
  const m = auth.match(/^bearer\s+(.+)/i);
  if (m) out.access_token = m[1];
  if (norm.bmiyek) out.refresh_token = norm.bmiyek;
  if (norm.greq) out.greq = norm.greq;
  if (norm['spa-csrf-token'] || norm['csrf-token']) {
    out.csrf = norm['spa-csrf-token'] || norm['csrf-token'];
  }
  return out;
}

/**
 * Attaches CDP network listening and fetch rewrite to the given Playwright / Patchright page.
 */
async function attachChromeIrctcNetwork(page) {
  if (!page || page.__oceanIrctcNet) return;
  page.__oceanIrctcNet = true;

  let client = null;
  try {
    if (typeof page.createCDPSession === 'function') {
      client = await page.createCDPSession();
    } else if (page.context && typeof page.context().newCDPSession === 'function') {
      client = await page.context().newCDPSession(page);
    }
  } catch (e) {
    console.warn('[IRCTC Net] CDP session creation notice:', e.message || e);
    return;
  }

  if (!client) {
    console.warn('[IRCTC Net] CDP client could not be initialized.');
    return;
  }

  let acceptLanguage = 'en-US,en;q=0.9';
  try {
    acceptLanguage = await page.evaluate(() => {
      try {
        const langs =
          navigator.languages && navigator.languages.length
            ? [...navigator.languages]
            : [navigator.language || 'en-US'];
        return langs
          .map((lang, i) => {
            const code = String(lang || '').trim();
            if (!code) return null;
            if (i === 0) return code;
            const q = Math.max(0.1, 1 - i * 0.1).toFixed(1);
            return `${code};q=${q}`;
          })
          .filter(Boolean)
          .join(',');
      } catch (_) {
        return 'en-US,en;q=0.9';
      }
    });
  } catch (_) {}

  const pushTokens = async (partial) => {
    if (!partial || !Object.keys(partial).length) return;
    try {
      page.__capturedTokens = Object.assign(page.__capturedTokens || {}, partial);
      await page.evaluate((obj) => {
        try {
          const LS = 'ir:tokens';
          const cur = JSON.parse(localStorage.getItem(LS) || '{}');
          const next = Object.assign({}, cur, obj, {
            lastUpdated: new Date().toISOString(),
            source: 'cdp',
          });
          localStorage.setItem(LS, JSON.stringify(next));
        } catch (_) {}
      }, partial).catch(() => {});
      if (partial.access_token) {
        console.log('[IRCTC Net] Captured access_token successfully via CDP.');
      }
      if (partial.csrf) {
        console.log('[IRCTC Net] Captured CSRF successfully via CDP:', String(partial.csrf).slice(0, 10) + '...');
      }
    } catch (e2) {
      console.warn('[IRCTC Net] Push tokens notice:', e2.message || e2);
    }
  };

  try {
    await client.send('Network.enable');
  } catch (e) {
    console.warn('[IRCTC Net] Network.enable notice:', e.message || e);
  }

  const irctcRequestUrls = new Map();

  client.on('Network.requestWillBeSent', (ev) => {
    try {
      const url = ev.request && ev.request.url;
      if (!url || !/irctc\.co\.in/i.test(url)) return;
      irctcRequestUrls.set(ev.requestId, url);
      if (!/mapps1|authprovider\/webtoken/i.test(url)) return;
      const toks = extractTokensFromHeaders(ev.request.headers);
      if (Object.keys(toks).length) {
        pushTokens(toks);
      }
    } catch (_) {}
  });

  client.on('Network.responseReceived', async (ev) => {
    try {
      const url = ev.response && ev.response.url;
      if (!url || !/irctc\.co\.in/i.test(url)) return;
      const headers = ev.response.headers || {};
      const partial = extractTokensFromHeaders(headers);
      const csrf = headers['csrf-token'] || headers['Csrf-Token'] || headers['spa-csrf-token'];
      if (csrf) partial.csrf = csrf;
      if (/authprovider\/webtoken/i.test(url)) {
        try {
          const body = await client.send('Network.getResponseBody', { requestId: ev.requestId });
          let text = body.body || '';
          if (body.base64Encoded) text = Buffer.from(text, 'base64').toString('utf8');
          const j = JSON.parse(text);
          if (j.access_token) partial.access_token = j.access_token;
          if (j.refresh_token) partial.refresh_token = j.refresh_token;
          if (j.scope) partial.scope = j.scope;
        } catch (_) {}
      }
      if (Object.keys(partial).length) {
        await pushTokens(partial);
      }
    } catch (_) {}
  });

  client.on('Network.responseReceivedExtraInfo', async (ev) => {
    try {
      const headers = ev.headers || {};
      const csrf =
        headers['csrf-token'] ||
        headers['Csrf-Token'] ||
        headers['spa-csrf-token'] ||
        extractTokensFromHeaders(headers).csrf;
      if (csrf) {
        console.log('[IRCTC Net] Captured CSRF from responseReceivedExtraInfo:', csrf.slice(0, 10) + '...');
        await pushTokens({ csrf });
      }
    } catch (_) {}
  });

  const clearTrackedRequest = (ev) => {
    if (ev && ev.requestId) irctcRequestUrls.delete(ev.requestId);
  };
  client.on('Network.loadingFinished', clearTrackedRequest);
  client.on('Network.loadingFailed', clearTrackedRequest);

  // Enable Fetch pattern interception for header rewriting
  try {
    await client.send('Fetch.enable', {
      patterns: [
        { urlPattern: '*://www.irctc.co.in/eticketing/protected/mapps1/*', requestStage: 'Request' },
        { urlPattern: '*://www.wps.irctc.co.in/*', requestStage: 'Request' },
        { urlPattern: '*://www.irctcipay.com/*', requestStage: 'Request' },
      ],
    });
    console.log('[IRCTC Net] DNR-parity Fetch rules enabled for mapps1/wps/ipay.');
  } catch (e) {
    console.warn('[IRCTC Net] Fetch.enable notice:', e.message || e);
    return;
  }

  client.on('Fetch.requestPaused', async (ev) => {
    const { requestId, request } = ev;
    try {
      const url = request.url || '';
      let headers = request.headers || {};
      const asArray = Object.entries(headers).map(([name, value]) => ({ name, value }));

      if (/www\.wps\.irctc\.co\.in/i.test(url)) {
        headers = mergeHeaderArray(asArray, {
          Origin: 'https://www.irctc.co.in',
          Referer: 'https://www.irctc.co.in/nget/payment/bkgPaymentOptions',
        });
        await client.send('Fetch.continueRequest', {
          requestId,
          headers,
        });
      } else if (/irctcipay\.com/i.test(url)) {
        headers = mergeHeaderArray(asArray, {
          Origin: 'https://www.irctcipay.com',
          Referer: 'https://www.irctcipay.com/pgui/jsp/surchargePaymentPage.jsp',
        });
        await client.send('Fetch.continueRequest', {
          requestId,
          headers,
        });
      } else if (/mapps1/i.test(url)) {
        let pageUrl = '';
        try {
          pageUrl = (typeof page.url === 'function' ? page.url() : '') || '';
        } catch (_) {}
        headers = mergeHeaderArray(asArray, browserLikeHeaders(refererForUrl(url, pageUrl), acceptLanguage));
        const toks = extractTokensFromHeaders(
          Array.isArray(headers)
            ? Object.fromEntries(headers.map((h) => [h.name, h.value]))
            : headers
        );
        if (Object.keys(toks).length) pushTokens(toks);

        await client.send('Fetch.continueRequest', {
          requestId,
          headers: Array.isArray(headers) ? headers : asArray,
        });
      } else {
        const toks = extractTokensFromHeaders(headers);
        if (Object.keys(toks).length) pushTokens(toks);

        await client.send('Fetch.continueRequest', {
          requestId,
        });
      }
    } catch (e) {
      try {
        await client.send('Fetch.continueRequest', { requestId });
      } catch (_) {}
    }
  });
}

module.exports = {
  attachChromeIrctcNetwork,
  refererForUrl,
  browserLikeHeaders,
  acceptLanguageFromList,
  extractTokensFromHeaders,
};
