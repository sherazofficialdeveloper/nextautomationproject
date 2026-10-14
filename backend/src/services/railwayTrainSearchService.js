'use strict';

const fs = require('fs');
const path = require('path');
const { request } = require('undici');
const { PNG } = require('pngjs');
const ort = require('onnxruntime-node');
const ghumoTrainSearchService = require('./ghumoTrainSearchService');

/**
 * Railway Train Search & Real Seat Availability Service.
 * Ported from verified Red Box (Erail.in schedules + Indian Railways live enquiry workflow with CRNN ONNX OCR).
 * Uses local lightweight ONNX inference to solve Indian Rail math captchas in ~15ms and retrieves real live availability.
 */

const ERAIL_TRAIN_LIST_URL = 'https://erail.in/rail/getTrains.aspx';
const INDIAN_RAIL_HOME = 'https://www.indianrail.gov.in/enquiry/StaticPages/StaticEnquiry.jsp?lang=en';
const INDIAN_RAIL_CAPTCHA_URL = 'https://www.indianrail.gov.in/enquiry/captchaDraw.png';
const INDIAN_RAIL_API_URL = 'https://www.indianrail.gov.in/enquiry/CommonCaptcha';

const OCR_MODEL_PATH = path.join(__dirname, '../data/crnn_ir_48x160_int8.onnx');
const OCR_H = 48, OCR_W = 160;
const OCR_VOCAB = '0123456789+- '.split('');
const OCR_BLANK_IDX = OCR_VOCAB.length;
const OCR_MEAN = [0.694, 0.695, 0.693];
const OCR_STD = [0.299, 0.296, 0.301];

let cachedOnnxSession = null;
let sessionLoadingPromise = null;

async function getOnnxSession() {
  if (cachedOnnxSession) return cachedOnnxSession;
  if (sessionLoadingPromise) return sessionLoadingPromise;

  sessionLoadingPromise = (async () => {
    if (!fs.existsSync(OCR_MODEL_PATH)) {
      throw new Error(`CRNN ONNX model not found at ${OCR_MODEL_PATH}`);
    }
    const session = await ort.InferenceSession.create(OCR_MODEL_PATH);
    cachedOnnxSession = session;
    console.log('[Railway Availability] CRNN ONNX model loaded successfully.');
    return session;
  })();

  return sessionLoadingPromise;
}

function autocontrastGray(gray, cutoffPct = 2) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const n = gray.length;
  const cut = Math.floor((n * cutoffPct) / 100);
  let lo = 0, hi = 255, c = 0;
  for (let i = 0; i < 256; i++) {
    c += hist[i];
    if (c > cut) { lo = i; break; }
  }
  c = 0;
  for (let i = 255; i >= 0; i--) {
    c += hist[i];
    if (c > cut) { hi = i; break; }
  }
  if (hi <= lo) return gray;
  const scale = 255 / (hi - lo);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let v = Math.round((gray[i] - lo) * scale);
    out[i] = Math.max(0, Math.min(255, v));
  }
  return out;
}

function resizeBilinear(srcGray, w0, h0, targetW, targetH) {
  const out = new Uint8Array(targetW * targetH);
  const xRatio = (w0 - 1) / targetW;
  const yRatio = (h0 - 1) / targetH;
  for (let y = 0; y < targetH; y++) {
    const yL = Math.floor(y * yRatio);
    const yH = Math.min(yL + 1, h0 - 1);
    const yWeight = (y * yRatio) - yL;
    for (let x = 0; x < targetW; x++) {
      const xL = Math.floor(x * xRatio);
      const xH = Math.min(xL + 1, w0 - 1);
      const xWeight = (x * xRatio) - xL;
      const a = srcGray[yL * w0 + xL];
      const b = srcGray[yL * w0 + xH];
      const c = srcGray[yH * w0 + xL];
      const d = srcGray[yH * w0 + xH];
      const val = (a * (1 - xWeight) * (1 - yWeight)) +
                  (b * xWeight * (1 - yWeight)) +
                  (c * yWeight * (1 - xWeight)) +
                  (d * xWeight * yWeight);
      out[y * targetW + x] = Math.round(val);
    }
  }
  return out;
}

function ctcGreedyDecode(logits, T, C) {
  let prev = OCR_BLANK_IDX;
  const chars = [];
  for (let t = 0; t < T; t++) {
    const off = t * C;
    let maxLogit = -Infinity, argmax = 0;
    for (let c = 0; c < C; c++) {
      const v = logits[off + c];
      if (v > maxLogit) { maxLogit = v; argmax = c; }
    }
    const p = argmax;
    if (p !== prev && p !== OCR_BLANK_IDX && p < OCR_VOCAB.length) chars.push(OCR_VOCAB[p]);
    prev = p;
  }
  return chars.join('').trim();
}

function evalMath(text) {
  let raw = String(text || '').trim().replace(/\s/g, '');
  if (raw.includes('=')) raw = raw.split('=', 1)[0];
  raw = raw.replace(/[^0-9+\-]/g, '');
  if (raw.includes('+')) {
    const parts = raw.split('+');
    return parseInt(parts[0], 10) + parseInt(parts[1], 10);
  }
  if (raw.slice(1).includes('-')) {
    const i = raw.indexOf('-', 1);
    return parseInt(raw.slice(0, i), 10) - parseInt(raw.slice(i + 1), 10);
  }
  return parseInt(raw, 10);
}

async function solveCaptcha(session, pngBuf) {
  const png = PNG.sync.read(pngBuf);
  const w0 = png.width, h0 = png.height;
  const rgba = png.data;
  const gray = new Uint8Array(w0 * h0);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    const a = rgba[i + 3] / 255;
    const r = Math.round(rgba[i] * a + 255 * (1 - a));
    const g = Math.round(rgba[i + 1] * a + 255 * (1 - a));
    const b = Math.round(rgba[i + 2] * a + 255 * (1 - a));
    gray[p] = 255 - Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  const contrasted = autocontrastGray(gray, 2);
  const resized = resizeBilinear(contrasted, w0, h0, OCR_W, OCR_H);
  const out = new Float32Array(3 * OCR_H * OCR_W);
  const planeR = 0, planeG = OCR_H * OCR_W, planeB = 2 * OCR_H * OCR_W;
  for (let y = 0; y < OCR_H; y++) {
    for (let x = 0; x < OCR_W; x++) {
      const idx = y * OCR_W + x;
      const v = resized[idx];
      out[planeR + idx] = (v / 255 - OCR_MEAN[0]) / (OCR_STD[0] + 1e-8);
      out[planeG + idx] = (v / 255 - OCR_MEAN[1]) / (OCR_STD[1] + 1e-8);
      out[planeB + idx] = (v / 255 - OCR_MEAN[2]) / (OCR_STD[2] + 1e-8);
    }
  }
  const tensor = new ort.Tensor('float32', out, [1, 3, OCR_H, OCR_W]);
  const results = await session.run({ input: tensor });
  const dims = results.logits.dims;
  const T = dims.length >= 3 ? dims[1] : dims[0];
  const C = dims.length >= 3 ? dims[2] : dims[1];
  const text = ctcGreedyDecode(results.logits.data, T, C);
  return { text, answer: evalMath(text) };
}

class CookieJar {
  constructor() { this.cookies = new Map(); }
  ingest(res) {
    const headers = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
    for (const h of headers) {
      if (!h) continue;
      const parts = h.split(';');
      const [k, v] = parts[0].split('=');
      if (k && v !== undefined) this.cookies.set(k.trim(), v.trim());
    }
  }
  header() {
    return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

function parseJourneyDate(input) {
  const str = String(input || '').trim();
  if (!str) return { iso: '', api: '', day: '' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [y, m, d] = str.split('-');
    return { iso: str, api: `${d}-${m}-${y}`, day: d };
  }
  if (/^\d{2}-\d{2}-\d{4}$/.test(str)) {
    const [d, m, y] = str.split('-');
    return { iso: `${y}-${m}-${d}`, api: str, day: d };
  }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) {
    const [d, m, y] = str.split('/');
    return { iso: `${y}-${m}-${d}`, api: `${d}-${m}-${y}`, day: d };
  }
  const dt = new Date(str);
  if (!Number.isNaN(dt.getTime())) {
    const d = String(dt.getDate()).padStart(2, '0');
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const y = dt.getFullYear();
    return { iso: `${y}-${m}-${d}`, api: `${d}-${m}-${y}`, day: d };
  }
  return { iso: str, api: str, day: '' };
}

function normalizeQuota(quota) {
  const q = String(quota || '').trim().toUpperCase();
  if (q === 'TATKAL' || q === 'TQ') return 'TQ';
  if (q === 'PREMIUM TATKAL' || q === 'PT') return 'PT';
  if (q === 'LADIES' || q === 'LD') return 'LD';
  if (q === 'SENIOR CITIZEN' || q === 'SS' || q === 'LOWER BERTH') return 'SS';
  return 'GN';
}

function cleanAvailabilityStatus(raw) {
  if (!raw) return 'Availability unavailable';
  return String(raw)
    .replace(/\s+/g, ' ')
    .replace(/\s*\/\s*/g, ' / ')
    .trim();
}

const CLASS_SORT = ['1A', '2A', '3A', 'CC', 'FC', 'SL', '2S', '3E'];

function classSortKey(cls) {
  const i = CLASS_SORT.indexOf(cls);
  return i === -1 ? 999 : i;
}

// Load static station list into memory for ultra-fast station resolution
let stationsMap = new Map();
let stationsList = [];

function initStations() {
  try {
    const filePath = path.join(__dirname, '../data/stationlist.json');
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      stationsList = JSON.parse(raw);
      for (const s of stationsList) {
        if (s.code) stationsMap.set(s.code.toUpperCase(), s.name);
      }
      console.log(`[Railway Search] Loaded ${stationsMap.size} railway stations.`);
    }
  } catch (err) {
    console.warn('[Railway Search] Failed to load stationlist.json:', err.message);
  }
}

initStations();

function getStationNameAndCode(input) {
  const raw = String(input || '').trim();
  if (!raw) return { name: '', code: '' };

  // Format: "LOKMANYATILAK T - LTT" or "NEW DELHI - NDLS"
  const m = raw.match(/^(.*)\s+-\s+([A-Z0-9]{2,5})$/i);
  if (m) {
    const name = m[1].trim().toUpperCase();
    const code = m[2].trim().toUpperCase();
    return { name: stationsMap.get(code) || name, code };
  }

  // Format: bare station code like "NDLS" or "LTT"
  if (/^[A-Z0-9]{2,5}$/i.test(raw)) {
    const code = raw.toUpperCase();
    return { name: stationsMap.get(code) || code, code };
  }

  // Format: Station Name like "NEW DELHI" or "LOKMANYA TILAK"
  const up = raw.toUpperCase();
  const directCode = Array.from(stationsMap.entries()).find(([code, name]) => name.toUpperCase() === up);
  if (directCode) {
    return { name: directCode[1], code: directCode[0] };
  }

  // Partial match fallback
  const partial = Array.from(stationsMap.entries()).find(([code, name]) => name.toUpperCase().includes(up));
  if (partial) {
    return { name: partial[1], code: partial[0] };
  }

  return { name: raw, code: raw.slice(0, 5).toUpperCase() };
}

function cleanTime(t) {
  const s = String(t || '').trim();
  return s.includes('.') ? s.replace(/\./g, ':') : s;
}

function runsOnDate(daysBits, isoDate) {
  if (!daysBits || daysBits.length !== 7 || !/^[01]{7}$/.test(daysBits)) return true;
  const parsed = parseJourneyDate(isoDate);
  const dateStr = parsed.iso || isoDate;
  const d = new Date(`${dateStr}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return true;
  const dow = (d.getUTCDay() + 6) % 7; // 0=Mon, 6=Sun
  return daysBits[dow] === '1';
}

function findClassesFromRaw(raw) {
  const found = new Set();
  const chunk = String(raw || '');
  const re = /(^|[|:,~])([123]A|2S|SL|CC|3E|FC)(?=[:|,|~])/g;
  let m;
  while ((m = re.exec(chunk)) !== null) {
    found.add(m[2]);
  }
  const re2 = /(?<![A-Z])(1A|2A|3A|3E|SL|2S|CC|FC)(?=[:,\s|~])/g;
  while ((m = re2.exec(chunk)) !== null) {
    found.add(m[0]);
  }
  if (found.size === 0) {
    return [];
  }
  return [...found].sort((a, b) => classSortKey(a) - classSortKey(b));
}

function guessTrainType(chunk) {
  const up = String(chunk || '').toUpperCase().replace(/\s+/g, '_');
  const cats = [
    'SUPERFAST',
    'MAIL_&_EXPRESS',
    'MAIL_EXPRESS',
    'HUMSAFAR',
    'ANTYODAYA',
    'RAJDHANI',
    'SHATABDI',
    'DURONTO',
    'JAN_SHATABDI',
    'SPECIAL',
    'PASSENGER',
    'ORDINARY',
  ];
  for (const c of cats) {
    if (up.includes(c)) return c.replace(/_/g, ' ');
  }
  return 'EXPRESS';
}

function parseErailTrainRecords(text, isoDate) {
  const parts = String(text || '').trim().split('^');
  const trains = [];

  for (const rec of parts.slice(1)) {
    const row = rec.trim();
    if (!row) continue;
    const fields = row.split('~');
    if (fields.length < 13) continue;

    try {
      const trainNo = fields[0].trim();
      const name = fields[1].trim();
      const boardCode = fields[7].trim();
      const alightCode = fields[9].trim();
      let daysBits = '1111111';
      if (fields.length > 13 && /^[01]{7}$/.test(fields[13] || '')) {
        daysBits = fields[13];
      }

      const runsToday = isoDate ? runsOnDate(daysBits, isoDate) : true;
      const listedClasses = findClassesFromRaw(row);
      const rawDuration = fields[12].trim();
      let formattedDuration = rawDuration;
      if (rawDuration && rawDuration.includes('.')) {
        const [dh, dm] = rawDuration.split('.');
        formattedDuration = `${parseInt(dh, 10)}h ${dm}m`;
      }

      trains.push({
        trainNumber: trainNo,
        trainName: name,
        fromStation: boardCode,
        toStation: alightCode,
        departureTime: cleanTime(fields[10]),
        arrivalTime: cleanTime(fields[11]),
        duration: formattedDuration,
        daysBits,
        runsOn: daysBits === '1111111' ? 'Daily' : 'Selected Days',
        runsToday,
        type: guessTrainType(row),
        classes: listedClasses,
        quota: 'General',
        availability: null,
      });
    } catch (_) {
      // Ignore malformed record
    }
  }

  return trains;
}

class RailwayTrainSearchService {
  /**
   * Search trains using Red Box's Erail.in railway workflow.
   * Seamlessly resolves station codes, queries railway schedules, and filters by running date.
   * If Erail is temporarily unreachable, transparently falls back to Ghumo.Live so searches never fail.
   */
  async searchTrains({ fromStation, toStation, journeyDate, quota = 'General', travelClass }) {
    const fromObj = getStationNameAndCode(fromStation);
    const toObj = getStationNameAndCode(toStation);
    const date = String(journeyDate || '').trim();

    if (!fromObj.code || !toObj.code) {
      throw new Error('From Station and To Station are required.');
    }

    const t0 = Date.now();
    try {
      const params = new URLSearchParams({
        Station_From: fromObj.code,
        Station_To: toObj.code,
        DataSource: '0',
        Language: '0',
        Cache: 'true',
      });
      const url = `${ERAIL_TRAIN_LIST_URL}?${params.toString()}`;

      const res = await request(url, {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          Accept: '*/*',
          Referer: `https://erail.in/trains-between-stations/${fromObj.code}/${toObj.code}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        headersTimeout: 12000,
        bodyTimeout: 12000,
      });

      if (res.statusCode === 200) {
        const text = await res.body.text();
        const allTrains = parseErailTrainRecords(text, date);
        let trains = allTrains;
        if (date) {
          const matchingDate = allTrains.filter((t) => t.runsToday);
          if (matchingDate.length > 0) {
            trains = matchingDate;
          }
        }

        const elapsed = Date.now() - t0;
        console.log(`[Railway Search] Erail returned ${trains.length} trains in ${elapsed}ms for ${fromObj.code} -> ${toObj.code}`);

        if (trains.length > 0) {
          return trains;
        }
      }
    } catch (erailErr) {
      console.warn(`[Railway Search] Erail search notice (${fromObj.code} -> ${toObj.code}):`, erailErr.message);
    }

    // Graceful fallback to Ghumo service so that queries always return results
    console.log(`[Railway Search] Trying secondary railway provider for ${fromObj.code} -> ${toObj.code}...`);
    try {
      const fallbackTrains = await ghumoTrainSearchService.searchTrains({
        fromStation: fromObj.code,
        toStation: toObj.code,
        journeyDate: date,
        quota,
        travelClass,
      });
      return fallbackTrains || [];
    } catch (fallbackErr) {
      console.warn('[Railway Search] Secondary provider error:', fallbackErr.message);
      return [];
    }
  }

  /**
   * Check live seat availability for a specific train using Indian Railways enquiry + CRNN ONNX OCR.
   * Matches Red Box behavior: solves captcha in ~15ms, queries CommonCaptcha, returns real waitlist/RAC/confirmed status.
   */
  async checkAvailability({ trainNumber, fromStation, toStation, journeyDate, travelClass = '3A', quota = 'GN', trainType = 'EXP' }) {
    const fromObj = getStationNameAndCode(fromStation);
    const toObj = getStationNameAndCode(toStation);
    const cleanTrainNo = String(trainNumber || '').replace(/\D/g, '');
    const cleanClass = String(travelClass || '3A').trim().toUpperCase();
    const cleanQuota = normalizeQuota(quota);
    const dateParsed = parseJourneyDate(journeyDate);

    if (!cleanTrainNo || !fromObj.code || !toObj.code || !dateParsed.api) {
      return {
        success: false,
        status: 'Availability unavailable',
        formattedDisplay: 'Availability unavailable',
        error: 'Train number, stations, and date are required.',
        trainNumber: cleanTrainNo,
        fromStation: fromObj.code,
        toStation: toObj.code,
        journeyDate: dateParsed.iso,
        fetchedAt: new Date().toISOString(),
      };
    }

    try {
      const session = await getOnnxSession();
      const jar = new CookieJar();

      // Bootstrap Indian Rail enquiry session
      const homeRes = await fetch(INDIAN_RAIL_HOME, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      jar.ingest(homeRes);

      let lastError = null;

      for (let attempt = 1; attempt <= 6; attempt++) {
        try {
          const captchaRes = await fetch(`${INDIAN_RAIL_CAPTCHA_URL}?${Date.now()}_${attempt}`, {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
              Cookie: jar.header(),
              Referer: INDIAN_RAIL_HOME,
            },
          });
          jar.ingest(captchaRes);

          if (!captchaRes.ok) throw new Error(`Captcha download HTTP ${captchaRes.status}`);

          const captchaBuf = Buffer.from(await captchaRes.arrayBuffer());
          const { text, answer } = await solveCaptcha(session, captchaBuf);

          const params = new URLSearchParams({
            inputCaptcha: String(answer),
            inputPage: 'TBIS_CALL_FOR_FARE',
            trainNo: cleanTrainNo,
            dt: dateParsed.api,
            sourceStation: fromObj.code,
            destinationStation: toObj.code,
            classc: cleanClass,
            quota: cleanQuota,
            traintype: String(trainType || 'EXP').toUpperCase(),
            language: 'en',
            _: String(Date.now()),
          });

          const avlRes = await fetch(`${INDIAN_RAIL_API_URL}?${params.toString()}`, {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
              Cookie: jar.header(),
              Referer: INDIAN_RAIL_HOME,
              'X-Requested-With': 'XMLHttpRequest',
              Accept: 'application/json, text/javascript, */*; q=0.01',
            },
          });
          jar.ingest(avlRes);

          const bodyText = await avlRes.text();
          let parsed = null;
          try {
            parsed = JSON.parse(bodyText);
          } catch (_) {}

          if (parsed && Array.isArray(parsed.avlDayList) && parsed.avlDayList.length > 0) {
            const dayInfo = parsed.avlDayList.find((d) => d.availablityDate === dateParsed.iso) || parsed.avlDayList[0];
            const cleanStatus = cleanAvailabilityStatus(dayInfo.availablityStatus);
            const fare =
              typeof parsed.totalFare === 'number'
                ? parsed.totalFare
                : typeof parsed.totalCollectibleAmount === 'number'
                ? parsed.totalCollectibleAmount
                : null;
            const dayNum = dateParsed.day || (dayInfo.availablityDate ? dayInfo.availablityDate.slice(-2) : '');
            const formattedDisplay = dayNum ? `${dayNum} — ${cleanStatus}` : cleanStatus;

            return {
              success: true,
              trainNumber: cleanTrainNo,
              fromStation: fromObj.code,
              toStation: toObj.code,
              journeyDate: dateParsed.iso,
              day: dayNum,
              travelClass: cleanClass,
              quota: cleanQuota,
              status: cleanStatus,
              formattedDisplay,
              fare: fare ? `₹${fare}` : null,
              fareAmount: fare || 0,
              rawStatus: dayInfo.availablityStatus,
              avlDayList: parsed.avlDayList,
              fetchedAt: new Date().toISOString(),
            };
          }

          if (parsed && parsed.errorMessage) {
            const msg = String(parsed.errorMessage).trim();
            const low = msg.toLowerCase();
            if (low.includes('captcha') || low.includes('session out')) {
              lastError = msg;
              await new Promise((r) => setTimeout(r, 250));
              continue;
            }
            return {
              success: false,
              trainNumber: cleanTrainNo,
              fromStation: fromObj.code,
              toStation: toObj.code,
              journeyDate: dateParsed.iso,
              status: msg,
              formattedDisplay: msg,
              error: msg,
              fare: null,
              avlDayList: [],
              fetchedAt: new Date().toISOString(),
            };
          }
        } catch (attemptErr) {
          lastError = attemptErr.message;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    } catch (err) {
      lastError = err.message || lastError;
      console.warn(`[Railway Availability] Indian Rail check notice for train ${cleanTrainNo}:`, err.message);
    }

    const finalErrorMsg = lastError || 'Availability unavailable';
    return {
      success: false,
      trainNumber: cleanTrainNo,
      fromStation: fromObj.code,
      toStation: toObj.code,
      journeyDate: dateParsed.iso,
      status: finalErrorMsg,
      formattedDisplay: finalErrorMsg,
      error: finalErrorMsg,
      fare: null,
      avlDayList: [],
      fetchedAt: new Date().toISOString(),
    };
  }

  getStationNameAndCode(input) {
    return getStationNameAndCode(input);
  }

  async solveCaptchaBuffer(pngBuf) {
    const session = await getOnnxSession();
    const res = await solveCaptcha(session, pngBuf);
    return String(res?.answer != null ? res.answer : (res?.text || '')).trim();
  }
}

module.exports = new RailwayTrainSearchService();
