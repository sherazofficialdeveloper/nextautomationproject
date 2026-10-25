'use strict';

const fs = require('fs');
const { PNG } = require('pngjs');
const ort = require('onnxruntime-node');

const H = 48, W = 160;
const VOCAB = '0123456789+- '.split('');
const BLANK_IDX = VOCAB.length;
const MEAN = [0.694, 0.695, 0.693];
const STD = [0.299, 0.296, 0.301];

function autocontrastGray(gray, cutoffPct) {
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
  let prev = BLANK_IDX;
  const chars = [];
  for (let t = 0; t < T; t++) {
    const off = t * C;
    let maxLogit = -Infinity, argmax = 0;
    for (let c = 0; c < C; c++) {
      const v = logits[off + c];
      if (v > maxLogit) { maxLogit = v; argmax = c; }
    }
    const p = argmax;
    if (p !== prev && p !== BLANK_IDX && p < VOCAB.length) chars.push(VOCAB[p]);
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
  const resized = resizeBilinear(contrasted, w0, h0, W, H);
  const out = new Float32Array(3 * H * W);
  const planeR = 0, planeG = H * W, planeB = 2 * H * W;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      const v = resized[idx];
      out[planeR + idx] = (v / 255 - MEAN[0]) / (STD[0] + 1e-8);
      out[planeG + idx] = (v / 255 - MEAN[1]) / (STD[1] + 1e-8);
      out[planeB + idx] = (v / 255 - MEAN[2]) / (STD[2] + 1e-8);
    }
  }
  const tensor = new ort.Tensor('float32', out, [1, 3, H, W]);
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

async function testWithCookieJar() {
  const session = await ort.InferenceSession.create('src/data/crnn_ir_48x160_int8.onnx');
  const jar = new CookieJar();

  const homeRes = await fetch('https://www.indianrail.gov.in/enquiry/StaticPages/StaticEnquiry.jsp?lang=en', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' }
  });
  jar.ingest(homeRes);

  for (let attempt = 1; attempt <= 6; attempt++) {
    const captchaRes = await fetch('https://www.indianrail.gov.in/enquiry/captchaDraw.png?' + Date.now(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': jar.header(),
        'Referer': 'https://www.indianrail.gov.in/enquiry/StaticPages/StaticEnquiry.jsp?lang=en'
      }
    });
    jar.ingest(captchaRes);
    const captchaBuf = Buffer.from(await captchaRes.arrayBuffer());
    let text = '', answer = 0;
    try {
      const res = await solveCaptcha(session, captchaBuf);
      text = res.text;
      answer = res.answer;
    } catch (e) {
      console.warn(`Attempt ${attempt} OCR error:`, e.message);
      continue;
    }
    console.log(`Attempt ${attempt}: text='${text}' answer=${answer}`);

    const params = new URLSearchParams({
      inputCaptcha: String(answer),
      inputPage: 'TBIS_CALL_FOR_FARE',
      trainNo: '12952',
      dt: '15-10-2026',
      sourceStation: 'NDLS',
      destinationStation: 'MMCT',
      classc: '3A',
      quota: 'GN',
      traintype: 'EXP',
      language: 'en',
      _: String(Date.now()),
    });

    const avlRes = await fetch('https://www.indianrail.gov.in/enquiry/CommonCaptcha?' + params.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': jar.header(),
        'Referer': 'https://www.indianrail.gov.in/enquiry/StaticPages/StaticEnquiry.jsp?lang=en',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01'
      }
    });
    jar.ingest(avlRes);

    const jsonText = await avlRes.text();
    console.log('Result:', jsonText.slice(0, 400));
    if (jsonText.includes('avlDayList')) {
      console.log('SUCCESS! GOT REAL LIVE AVAILABILITY DATA!');
      const parsed = JSON.parse(jsonText);
      console.log('Sample day:', parsed.avlDayList[0]);
      console.log('Total Fare:', parsed.totalFare);
      break;
    }
    await new Promise(r => setTimeout(r, 600));
  }
}

testWithCookieJar().catch(console.error);

