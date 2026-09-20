'use strict';

const https = require('https');
const { request } = require('undici');

/**
 * Ghumo.Live Train Search & Seat Availability Provider.
 * Public, no-login data source fetching live Indian Railways train schedules and seat availability.
 * Powered by high-performance Undici HTTP client.
 */

const SUPPORTED_QUOTAS = {
  GN: 'General',
  LD: 'Ladies',
  TQ: 'Tatkal',
  PT: 'Premium Tatkal',
};

const QUOTA_CODE_MAP = {
  GN: 'GN',
  GENERAL: 'GN',
  LD: 'LD',
  LADIES: 'LD',
  TQ: 'TQ',
  TATKAL: 'TQ',
  PT: 'PT',
  'PREMIUM TATKAL': 'PT',
  PREMIUM_TATKAL: 'PT',
};

const SUPPORTED_CLASSES = ['1A', '2A', '3A', '3E', 'SL', 'CC', 'EC', '2S'];

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.ghumo.live/',
};

function normalizeQuotaCode(quota) {
  if (!quota) return 'GN';
  const clean = String(quota).trim().toUpperCase();
  return QUOTA_CODE_MAP[clean] || 'GN';
}

function normalizeClass(travelClass) {
  if (!travelClass) return null;
  const clean = String(travelClass).trim().toUpperCase();
  return SUPPORTED_CLASSES.includes(clean) ? clean : null;
}

async function fetchJson(url, timeoutMs = 15000) {
  try {
    const res = await request(url, {
      method: 'GET',
      headers: DEFAULT_HEADERS,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });

    if (res.statusCode === 404 || res.statusCode === 400) {
      return null;
    }
    if (res.statusCode !== 200) {
      throw new Error(`Ghumo.Live returned HTTP ${res.statusCode}`);
    }

    const data = await res.body.json();
    return data;
  } catch (err) {
    if (
      err.name === 'HeadersTimeoutError' ||
      err.name === 'BodyTimeoutError' ||
      err.code === 'UND_ERR_HEADERS_TIMEOUT' ||
      err.code === 'UND_ERR_BODY_TIMEOUT'
    ) {
      throw new Error('Ghumo.Live request timed out.');
    }
    throw err;
  }
}

class GhumoTrainSearchService {
  /**
   * Search trains and real-time seat availability on Ghumo.Live without IRCTC login.
   * @param {Object} criteria
   * @param {string} criteria.fromStation
   * @param {string} criteria.toStation
   * @param {string} criteria.journeyDate YYYY-MM-DD
   * @param {string} [criteria.quota] General, Ladies, Tatkal, Premium Tatkal
   * @param {string} [criteria.travelClass] 1A, 2A, 3A, 3E, SL, CC, EC, 2S
   */
  async searchTrains({ fromStation, toStation, journeyDate, quota, travelClass }) {
    const from = String(fromStation || '').trim().toUpperCase();
    const to = String(toStation || '').trim().toUpperCase();
    const date = String(journeyDate || '').trim();

    if (!from || !to) {
      const err = new Error('From Station and To Station are required.');
      err.status = 400;
      throw err;
    }

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const err = new Error('A valid journey date (YYYY-MM-DD) is required.');
      err.status = 400;
      throw err;
    }

    const quotaCode = normalizeQuotaCode(quota);
    const quotaLabel = SUPPORTED_QUOTAS[quotaCode] || 'General';
    const targetClass = normalizeClass(travelClass);

    // 1. Fetch train schedules on route from Ghumo.Live
    const trainsUrl = `https://www.ghumo.live/api/trains?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&date=${encodeURIComponent(date)}`;
    let trainsData = null;
    try {
      trainsData = await fetchJson(trainsUrl);
    } catch (fetchErr) {
      console.error('[Ghumo Service] Route search error:', fetchErr.message);
      const err = new Error(`Failed to search trains on Ghumo.Live: ${fetchErr.message}`);
      err.status = 502;
      err.code = 'SOURCE_UNAVAILABLE';
      throw err;
    }

    const rawTrains = Array.isArray(trainsData?.trains) ? trainsData.trains : [];
    if (rawTrains.length === 0) {
      return [];
    }

    // 2. Fetch live seat availability for trains with concurrency limit (3-4 concurrent probes)
    const concurrencyLimit = 4;
    const normalizedTrains = [];

    for (let i = 0; i < rawTrains.length; i += concurrencyLimit) {
      const batch = rawTrains.slice(i, i + concurrencyLimit);
      const batchResults = await Promise.all(
        batch.map(async (t) => {
          const trainNumber = String(t.number || '').trim();
          const trainName = String(t.name || `Train ${trainNumber}`).trim();
          const departure = t.departure || '—';
          const arrival = t.arrival || '—';
          const duration = t.duration || '—';
          const availableClasses = Array.isArray(t.classes)
            ? t.classes.filter((c) => SUPPORTED_CLASSES.includes(c))
            : [];
          const fares = t.fares || {};

          // Determine probe class: either user-selected class or primary class on train
          let probeClass = targetClass;
          if (!probeClass || !availableClasses.includes(probeClass)) {
            probeClass = availableClasses.find((c) => c === '3A' || c === 'SL') || availableClasses[0] || '3A';
          }

          let availabilityStatus = 'NOT AVAILABLE';

          // If train does NOT carry the selected class, mark NOT AVAILABLE directly
          if (targetClass && !availableClasses.includes(targetClass)) {
            availabilityStatus = 'NOT AVAILABLE';
          } else {
            try {
              const avlUrl = `https://www.ghumo.live/api/availability?train=${encodeURIComponent(trainNumber)}&from=${encodeURIComponent(t.from_code || from)}&to=${encodeURIComponent(t.to_code || to)}&date=${encodeURIComponent(date)}&classes=${encodeURIComponent(probeClass)}&quota=${encodeURIComponent(quotaCode)}`;
              const avlData = await fetchJson(avlUrl, 8000);

              const quotaList = avlData?.availability?.[probeClass]?.[quotaCode];
              if (Array.isArray(quotaList) && quotaList.length > 0) {
                const dateEntry = quotaList.find((entry) => entry.date === date) || quotaList[0];
                availabilityStatus = dateEntry?.status || 'NOT AVAILABLE';
              } else if (avlData?.unavailable_quotas?.includes(quotaCode)) {
                availabilityStatus = 'NOT AVAILABLE';
              }
            } catch (avlErr) {
              console.warn(`[Ghumo Service] Avail fetch failed for train ${trainNumber}:`, avlErr.message);
              availabilityStatus = 'AVL-PENDING';
            }
          }

          return {
            trainNumber,
            trainName,
            departureTime: departure,
            arrivalTime: arrival,
            duration,
            classes: availableClasses.length > 0 ? availableClasses : SUPPORTED_CLASSES,
            fares,
            quota: quotaLabel,
            selectedClass: probeClass,
            availability: availabilityStatus,
            fromStation: t.from_code || from,
            toStation: t.to_code || to,
          };
        })
      );

      normalizedTrains.push(...batchResults);
    }

    return normalizedTrains;
  }

  /**
   * Check live seat availability for a specific train from Ghumo.Live.
   * @param {Object} params
   * @param {string} params.trainNumber
   * @param {string} params.fromStation
   * @param {string} params.toStation
   * @param {string} params.journeyDate YYYY-MM-DD
   * @param {string} [params.travelClass]
   * @param {string} [params.quota]
   */
  async checkAvailability({ trainNumber, fromStation, toStation, journeyDate, travelClass, quota }) {
    const tNum = String(trainNumber || '').trim();
    const from = String(fromStation || '').trim().toUpperCase();
    const to = String(toStation || '').trim().toUpperCase();
    const date = String(journeyDate || '').trim();
    const quotaCode = normalizeQuotaCode(quota);
    const targetClass = normalizeClass(travelClass) || '3A';

    if (!tNum || !from || !to || !date) {
      return {
        availability: 'Unable to Check',
        quota: SUPPORTED_QUOTAS[quotaCode] || 'General',
        selectedClass: targetClass,
        trainNumber: tNum,
        lastChecked: new Date().toISOString(),
      };
    }

    try {
      const avlUrl = `https://www.ghumo.live/api/availability?train=${encodeURIComponent(tNum)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&date=${encodeURIComponent(date)}&classes=${encodeURIComponent(targetClass)}&quota=${encodeURIComponent(quotaCode)}`;
      const avlData = await fetchJson(avlUrl, 8000);

      let availabilityStatus = 'Unable to Check';
      const quotaList = avlData?.availability?.[targetClass]?.[quotaCode];
      if (Array.isArray(quotaList) && quotaList.length > 0) {
        const dateEntry = quotaList.find((entry) => entry.date === date) || quotaList[0];
        availabilityStatus = dateEntry?.status || 'NOT AVAILABLE';
      } else if (avlData?.unavailable_quotas?.includes(quotaCode)) {
        availabilityStatus = 'NOT AVAILABLE';
      }

      return {
        availability: availabilityStatus,
        quota: SUPPORTED_QUOTAS[quotaCode] || 'General',
        selectedClass: targetClass,
        trainNumber: tNum,
        lastChecked: new Date().toISOString(),
      };
    } catch (err) {
      console.warn(`[Ghumo Service] checkAvailability error for train ${tNum}:`, err.message);
      return {
        availability: 'Unable to Check',
        quota: SUPPORTED_QUOTAS[quotaCode] || 'General',
        selectedClass: targetClass,
        trainNumber: tNum,
        lastChecked: new Date().toISOString(),
      };
    }
  }

  normalizeQuotaCode(quota) {
    return normalizeQuotaCode(quota);
  }

  normalizeClass(travelClass) {
    return normalizeClass(travelClass);
  }

  get SUPPORTED_QUOTAS() {
    return SUPPORTED_QUOTAS;
  }

  get SUPPORTED_CLASSES() {
    return SUPPORTED_CLASSES;
  }
}

module.exports = new GhumoTrainSearchService();

