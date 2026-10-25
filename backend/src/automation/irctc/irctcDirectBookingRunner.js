'use strict';

const fs = require('fs');
const path = require('path');
const railwayTrainSearchService = require('../../services/railwayTrainSearchService');

const INJECT_DIR = path.join(__dirname, 'inject');

function readInject(name) {
  const file = path.join(INJECT_DIR, name);
  if (fs.existsSync(file)) {
    return fs.readFileSync(file, 'utf8');
  }
  return '';
}

async function evaluateSource(page, source) {
  if (!source) return;
  try {
    await page.evaluate(source);
    return;
  } catch (_) {}
  try {
    let client = null;
    if (typeof page.createCDPSession === 'function') {
      client = await page.createCDPSession();
    } else if (page.context && typeof page.context().newCDPSession === 'function') {
      client = await page.context().newCDPSession(page);
    }
    if (client) {
      await client.send('Runtime.evaluate', {
        expression: `${source}\n;void 0;`,
        returnByValue: true,
        awaitPromise: false,
      });
      return;
    }
  } catch (err) {
    console.warn('[IRCTC DirectBooking] evaluateSource fallback error:', err.message);
  }
}

function extractStationCode(stationString) {
  if (!stationString) return '';
  const s = String(stationString).trim();
  if (!s) return '';
  let m = s.match(/\s*[-–—]\s*([A-Z0-9]{2,5})\s*$/i);
  if (m) return m[1].toUpperCase();
  m = s.match(/\(([A-Z0-9]{2,5})\)\s*$/i);
  if (m) return m[1].toUpperCase();
  m = s.match(/^([A-Z0-9]{2,5})\s*[-–—]/i);
  if (m) return m[1].toUpperCase();
  if (/^[A-Z0-9]{2,5}$/i.test(s)) return s.toUpperCase();
  return s.slice(0, 5).toUpperCase();
}

function resolveStationCode(stn) {
  if (!stn) return '';
  const resolved = railwayTrainSearchService.getStationNameAndCode(stn);
  if (resolved && resolved.code) return resolved.code.toUpperCase();
  return extractStationCode(stn);
}

function formatJourneyDateCompact(journeyDate) {
  const s = String(journeyDate || '').trim();
  if (/^\d{8}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.replace(/-/g, '');
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}${m[2]}${m[3]}`;
  const dm = s.match(/(\d{2})[/-](\d{2})[/-](\d{4})/);
  if (dm) return `${dm[3]}${dm[2]}${dm[1]}`;
  return s.replace(/\D/g, '').slice(0, 8);
}

function normalizeQuota(quota) {
  const q = String(quota || 'General').trim().toUpperCase();
  if (q === 'TATKAL' || q === 'TQ') return 'TQ';
  if (q === 'PREMIUM TATKAL' || q === 'PREMIUM_TATKAL' || q === 'PT') return 'PT';
  if (q === 'LADIES' || q === 'LD') return 'LD';
  if (q === 'LOWER BERTH' || q === 'SR. CITIZEN' || q === 'SS') return 'SS';
  return 'GN';
}

function resolvePaymentMethodKey(ticket) {
  const combined = [
    ticket?.paymentMethod,
    ticket?.bankName,
    ticket?.priorBank,
    ticket?.paymentBank,
    ticket?.bank,
  ].filter(Boolean).join(' ').toUpperCase();

  if (/PHONEPE|PHONE PE|PHONE_PE|116/.test(combined)) return 'PHONEPEUPIQR';
  if (/PAYTM|PAY TM|PAY_TM|117/.test(combined)) return 'PAYTMUPIQR';
  if (/IPAY|I_PAY|113/.test(combined)) return 'IRCUPIQR';
  if (/UPI|QR/.test(combined)) return 'IRCUPIQR';
  return 'IRCUPIQR';
}

class IrctcDirectBookingRunner {
  async executeDirectBooking(page, ticketId, targetTicket, account, { stopPayment = false, automationService, capturedTokens = null } = {}) {
    const id = Number(ticketId);

    // 0. RESET in-page direct booking flags so fresh run never gets blocked
    await page.evaluate(() => {
      try { delete window.__OCEAN_DIRECT_BOOT__; } catch (_) {}
      try { delete window.__OCEAN_DIRECT_PIPELINE_DONE__; } catch (_) {}
      try { delete window.__OCEAN_DIRECT_TOKEN_WATCH__; } catch (_) {}
      try { delete window.__OCEAN_POST_LOGIN_FIRED__; } catch (_) {}
      window.__OCEAN_DIRECT_BOOT__ = false;
      window.__OCEAN_DIRECT_PIPELINE_DONE__ = false;
      window.__OCEAN_DIRECT_SEAT_STOP__ = '';
      window.__OCEAN_DIRECT_BOOKED_PNR__ = '';
      if (typeof window.__oceanResetDirectState === 'function') {
        window.__oceanResetDirectState();
      }
    }).catch(() => {});

    // 1. Resolve tokens: captured from CDP or login
    const directTokens = Object.assign({}, page?.__capturedTokens || {}, capturedTokens || {});
    if (directTokens && directTokens.access_token) {
      await page.evaluate((toks) => {
        try {
          const cur = JSON.parse(localStorage.getItem('ir:tokens') || '{}');
          localStorage.setItem('ir:tokens', JSON.stringify({ ...cur, ...toks }));
        } catch (_) {}
      }, directTokens).catch(() => {});
    }

    // 2. Resolve station codes, train number, date, passengers
    const fromCode = resolveStationCode(targetTicket?.fromStation);
    const toCode = resolveStationCode(targetTicket?.toStation);
    const boardCode = targetTicket?.boardingPoint ? resolveStationCode(targetTicket.boardingPoint) : fromCode;
    const trainNo = String(targetTicket?.trainNumber || '').replace(/\D/g, '').slice(0, 5);
    const dateCompact = formatJourneyDateCompact(targetTicket?.journeyDate);
    const selectedClass = String(targetTicket?.selectedClass || '').trim().toUpperCase();
    const quota = normalizeQuota(targetTicket?.quota);
    const payMethodKey = resolvePaymentMethodKey(targetTicket);
    const mobile = String(targetTicket?.mobileNumber || '9999999999').replace(/\D/g, '').slice(-10);

    const rawPassengers = Array.isArray(targetTicket?.passengers) ? targetTicket.passengers : [];
    const passengers = rawPassengers.map((p) => ({
      name: String(p.name || '').trim(),
      age: Number(p.age || 30),
      gender: String(p.gender || 'M').trim().toUpperCase(),
      berth: p.berthPreference || p.berth || '',
      food: p.foodPreference || p.food || '',
      childBerth: Boolean(p.childBerth),
    }));

    if (!passengers.length) {
      passengers.push({ name: 'PASSENGER', age: 30, gender: 'M', berth: '', food: '', childBerth: false });
    }

    console.log(`[IRCTC DirectBooking] Ticket ${id}: Train=${trainNo}, Date=${dateCompact}, From=${fromCode}, To=${toCode}, Cls=${selectedClass}, Quota=${quota}, Gateway=${payMethodKey}`);

    // 3. Build Red Box window.__OCEAN_STORAGE__
    const oceanStorage = {
      irctc_credentials: {
        user_name: account.irctcUserId || '',
        password: account.password || '',
      },
      journey_details: {
        from: fromCode,
        destination: toCode,
        boarding: boardCode,
        date: dateCompact,
        class: selectedClass,
        quota: quota,
        'train-no': trainNo,
      },
      passenger_details: passengers,
      infant_details: [],
      travel_preferences: {
        AvailabilityCheck: 'A',
        bookOnlyIfCnf: targetTicket?.options?.confirmBerths !== false,
      },
      other_preferences: {
        paymentmethod: payMethodKey,
        backup_payment_method: '',
        acbooktime: '09:59:59',
        slbooktime: '10:59:59',
        gnbooktime: '07:59:59',
        CaptchaSubmitMode: 'A',
        manualLogin: false,
        mobileNumber: mobile,
        email: '',
      },
      vpa: targetTicket?.vpa || '',
      fare_limit: {
        enableFareLimit: false,
        maxFareAmount: '',
        bookInPopup: false,
      },
      true_captcha_credentials: {
        enabled: false,
        userId: '',
        apiKey: '',
      },
      skipTimingWait: Boolean(targetTicket?.skipTimingWait),
    };

    // 4. Attach Red Box console stream router and CDP Runtime listener
    page.__activeDirectTicketId = id;
    page.__activeAutomationService = automationService;

    if (!page.__oceanConsoleRouterAttached) {
      page.__oceanConsoleRouterAttached = true;
      page.on('console', (msg) => {
        try {
          const text = msg.text();
          const curId = page.__activeDirectTicketId || id;
          const svc = page.__activeAutomationService || automationService;

          if (/\[OCEAN|\[JS-Direct|\[IRCTC-Direct|\[iPay-Direct|\[PhonePe-Direct|\[Paytm-Direct|Passenger Submit|altAvlEnq|avlFare|boardingStation|addonServices|bookingInit|Direct API start/i.test(text)) {
            const clean = text
              .replace(/\[(?:OCEAN Direct|JS-Direct|IRCTC-Direct|iPay-Direct|PhonePe-Direct|Paytm-Direct|OCEAN DirectHost)\]\s*/g, '')
              .replace(/^\[.*?\]\s*/g, '')
              .trim();
            if (clean) {
              console.log(`[IRCTC DirectBooking][Ticket ${curId}] ${clean}`);
              if (svc && typeof svc.setBookingStatus === 'function') {
                svc.setBookingStatus(curId, clean);
              }
            }
          }
        } catch (_) {}
      });
    }

    try {
      let cdpClient = null;
      if (typeof page.createCDPSession === 'function') {
        cdpClient = await page.createCDPSession();
      } else if (page.context && typeof page.context().newCDPSession === 'function') {
        cdpClient = await page.context().newCDPSession(page);
      }
      if (cdpClient && !page.__oceanCdpConsoleAttached) {
        page.__oceanCdpConsoleAttached = true;
        await cdpClient.send('Runtime.enable').catch(() => {});
        cdpClient.on('Runtime.consoleAPICalled', (ev) => {
          try {
            const raw = (ev.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || ''))).join(' ');
            const curId = page.__activeDirectTicketId || id;
            const svc = page.__activeAutomationService || automationService;
            if (/\[OCEAN|\[JS-Direct|\[IRCTC-Direct|\[iPay-Direct|\[PhonePe-Direct|\[Paytm-Direct|Passenger Submit|altAvlEnq|avlFare|boardingStation|addonServices|bookingInit|Direct API start/i.test(raw)) {
              const clean = raw
                .replace(/\[(?:OCEAN Direct|JS-Direct|IRCTC-Direct|iPay-Direct|PhonePe-Direct|Paytm-Direct|OCEAN DirectHost)\]\s*/g, '')
                .replace(/^\[.*?\]\s*/g, '')
                .trim();
              if (clean) {
                console.log(`[IRCTC DirectBooking][Ticket ${curId}] ${clean}`);
                if (svc && typeof svc.setBookingStatus === 'function') {
                  svc.setBookingStatus(curId, clean);
                }
              }
            }
          } catch (_) {}
        });
      }
    } catch (_) {}

    // 5. Expose Node Bridges with dynamic active ticket handler
    page.__oceanDirectStatusHandler = (msg) => {
      const text = String(msg || '').trim();
      if (!text) return;
      const curId = page.__activeDirectTicketId || id;
      const svc = page.__activeAutomationService || automationService;
      console.log(`[IRCTC DirectBooking][Ticket ${curId}] ${text}`);
      if (svc && typeof svc.setBookingStatus === 'function') {
        svc.setBookingStatus(curId, text);
      }
    };

    try {
      await page.exposeFunction('__oceanDirectPushStatus', (msg) => {
        if (typeof page.__oceanDirectStatusHandler === 'function') {
          page.__oceanDirectStatusHandler(msg);
        }
      });
    } catch (_) {}

    try {
      await page.exposeFunction('__oceanDirectShowQr', async (qrBase64) => {
        try {
          let src = String(qrBase64 || '').trim();
          if (!src) return;
          if (!src.startsWith('data:')) {
            src = `data:image/png;base64,${src.replace(/^data:image\/[a-zA-Z+]+;base64,/, '')}`;
          }
          const savedPath = automationService._saveQrToDisk(src, id, `direct-engine-${payMethodKey}`);
          console.log('[IRCTC Automation][QR_RENDERED_PROMPTLY]', JSON.stringify({
            ticketId: id,
            filePath: savedPath,
            gateway: payMethodKey,
          }));
          automationService.setBookingStatus(id, 'QR Code Available — Scan to Pay', {
            authResult: null,
            qrCode: src,
            qrFilePath: savedPath,
            qrSourceType: `direct-${payMethodKey}`,
            qrCapturedAt: new Date().toISOString(),
            paymentStopped: Boolean(stopPayment),
          });
        } catch (qrErr) {
          console.warn('[IRCTC DirectBooking] Show QR error:', qrErr.message);
        }
      });
    } catch (_) {}

    try {
      await page.exposeFunction('__oceanDirectSolveCaptcha', async (base64) => {
        try {
          let cleanB64 = String(base64 || '');
          if (cleanB64.startsWith('data:')) {
            const idx = cleanB64.indexOf(',');
            if (idx !== -1) cleanB64 = cleanB64.slice(idx + 1);
          }
          const buf = Buffer.from(cleanB64, 'base64');
          const solved = await railwayTrainSearchService.solveCaptchaBuffer(buf);
          console.log(`[IRCTC DirectBooking] Solved booking captcha in ONNX: "${solved}"`);
          return solved || '';
        } catch (solveErr) {
          console.warn('[IRCTC DirectBooking] Captcha solve notice:', solveErr.message);
          return '';
        }
      });
    } catch (_) {}

    try {
      await page.exposeFunction('__oceanReportBookingFull', async (fullData) => {
        console.log(`[IRCTC DirectBooking] Full booking data received for ticket ${id}:`, JSON.stringify(fullData || {}).slice(0, 300));
      });
    } catch (_) {}

    // 6. Setup in-page globals, storage, and bridge handlers BEFORE injecting scripts
    await page.evaluate(({ storage, stopPaymentFlag }) => {
      try {
        Object.defineProperty(window, '__OCEAN_STORAGE__', {
          value: storage, writable: true, configurable: true, enumerable: false
        });
      } catch (_) { window.__OCEAN_STORAGE__ = storage; }

      try {
        Object.defineProperty(window, '__OCEAN_DIRECT_BOOK__', {
          value: true, writable: false, configurable: true, enumerable: false
        });
      } catch (_) { window.__OCEAN_DIRECT_BOOK__ = true; }

      try {
        Object.defineProperty(window, '__OCEAN_LOGIN_OK__', {
          value: true, writable: true, configurable: true, enumerable: false
        });
      } catch (_) { window.__OCEAN_LOGIN_OK__ = true; }

      window.oceanDirectHost = window.oceanDirectHost || {};
      window.oceanDirectHost.status = (msg) => {
        try { window.__oceanDirectPushStatus(msg); } catch (_) {}
      };
      window.oceanDirectHost.showQr = (qr) => {
        try { window.__oceanDirectShowQr(qr); } catch (_) {}
      };
      window.oceanDirectHost.hideQr = () => {};

      window.__oceanPushPanelStatus = (msg) => {
        try { window.__oceanDirectPushStatus(msg); } catch (_) {}
      };
      window.__oceanNodeSolveCaptcha = async (b64) => {
        try { return await window.__oceanDirectSolveCaptcha(b64); } catch (_) { return null; }
      };

      // Native direct gateway bridge for PhonePe, Paytm, and iPay
      window.__oceanNativeDirectBook = async function (payload) {
        const mode = (payload && payload.mode) || 'phonepe';
        let EngineClass = null;
        let label = '';
        if (mode === 'paytm') {
          EngineClass = (typeof PaytmQRHandlerJS !== 'undefined' && PaytmQRHandlerJS) || window.PaytmQRHandlerJS || null;
          label = 'Paytm QR';
        } else if (mode === 'phonepe') {
          EngineClass = (typeof PhonePeQRHandlerJS !== 'undefined' && PhonePeQRHandlerJS) || window.PhonePeQRHandlerJS || null;
          label = 'PhonePe QR';
        } else {
          EngineClass = (typeof IpayQRHandlerJS !== 'undefined' && IpayQRHandlerJS) || window.IpayQRHandlerJS || null;
          label = 'IRCTC iPay QR';
        }

        if (!EngineClass) {
          throw new Error(`${label || mode} engine class is not loaded in page context`);
        }

        const uiLog = (msg) => {
          try { window.__oceanDirectPushStatus(String(msg || '')); } catch (_) {}
        };

        uiLog(`${label} starting...`);
        const engine = new EngineClass(payload.wsUser, payload.clientTxnId, payload.tokens, uiLog);
        const finalResult = await engine.start_process();

        if (stopPaymentFlag) {
          uiLog(`${label} generated — payment stopped by user preference`);
          return { ok: true, stopped: true };
        }

        return finalResult;
      };

      return true;
    }, { storage: oceanStorage, stopPaymentFlag: Boolean(stopPayment) });

    // 7. Inject all Red Box engine scripts globally via evaluateSource (bypasses CSP)
    console.log('[IRCTC DirectBooking] Injecting direct engine scripts into page context...');
    const injectScripts = [
      { name: 'chrome-shim.js', content: readInject('chrome-shim.js') },
      { name: 'token-injector.js', content: readInject('token-injector.js') },
      { name: 'qr_flow_filelog.js', content: readInject('qr_flow_filelog.js') },
      { name: 'booking_direct.js', content: readInject('booking_direct.js') },
      { name: 'ewallet_direct.js', content: readInject('ewallet_direct.js') },
      { name: 'phonepe_qr.js', content: readInject('phonepe_qr.js') },
      { name: 'paytm_qr.js', content: readInject('paytm_qr.js') },
      { name: 'ipay_qr.js', content: readInject('ipay_qr.js') },
      { name: 'direct_book_boot.js', content: readInject('direct_book_boot.js') },
    ];

    for (const item of injectScripts) {
      if (item.content) {
        await evaluateSource(page, item.content);
      }
    }

    // Verify in-page readyState
    let hasBoot = await page.evaluate(() => typeof window.__oceanStartDirectBook === 'function').catch(() => false);
    if (!hasBoot) {
      console.warn('[IRCTC DirectBooking] __oceanStartDirectBook not detected initially, re-evaluating direct_book_boot.js via evaluateSource...');
      const bootScr = readInject('direct_book_boot.js');
      await evaluateSource(page, bootScr);
      hasBoot = await page.evaluate(() => typeof window.__oceanStartDirectBook === 'function').catch(() => false);
    }

    const readyCheck = await page.evaluate(() => ({
      hasBoot: typeof window.__oceanStartDirectBook === 'function',
      hasTryStart: typeof window.__oceanTryStartDirect === 'function',
      hasDirectApi: typeof window.IrctcDirectBookingJS === 'function',
      hasPhonePe: typeof window.PhonePeQRHandlerJS === 'function',
      hasPaytm: typeof window.PaytmQRHandlerJS === 'function',
      hasIpay: typeof window.IpayQRHandlerJS === 'function',
    })).catch(() => ({}));
    console.log('[IRCTC DirectBooking] In-page engine readyState:', JSON.stringify(readyCheck));

    // 8. Execute the Direct Booking pipeline inside the tab
    console.log('[IRCTC DirectBooking] Starting direct booking pipeline in page context...');
    automationService.setBookingStatus(id, 'Starting Direct Booking...');

    try {
      const pipelineResult = await page.evaluate(async () => {
        if (typeof window.__oceanStartDirectBook === 'function') {
          return await window.__oceanStartDirectBook(true);
        }
        if (typeof window.__oceanTryStartDirect === 'function') {
          window.__oceanTryStartDirect('runner');
          return { ok: true, note: 'Direct started via __oceanTryStartDirect' };
        }
        throw new Error('__oceanStartDirectBook function not found in page');
      });

      console.log(`[IRCTC DirectBooking] Pipeline completed:`, JSON.stringify(pipelineResult || {}));

      if (pipelineResult && pipelineResult.pnr) {
        automationService.setBookingStatus(id, `BOOKED PNR=${pipelineResult.pnr}`, {
          pnr: pipelineResult.pnr,
          authResult: null,
        });
      } else if (pipelineResult && pipelineResult.note) {
        automationService.setBookingStatus(id, pipelineResult.note);
      } else if (pipelineResult && pipelineResult.error) {
        automationService.setBookingStatus(id, pipelineResult.error);
      } else if (!pipelineResult || !pipelineResult.ok) {
        automationService.setBookingStatus(id, 'Direct booking stopped');
      }

      return {
        handled: true,
        success: Boolean(pipelineResult && pipelineResult.ok),
        result: pipelineResult,
      };
    } catch (runErr) {
      const errMsg = runErr.message || String(runErr);
      console.warn(`[IRCTC DirectBooking] Pipeline notice:`, errMsg);
      automationService.setBookingStatus(id, errMsg.replace(/Error:\s*/i, ''));
      return { handled: true, success: false, error: errMsg };
    }
  }
}

module.exports = new IrctcDirectBookingRunner();
