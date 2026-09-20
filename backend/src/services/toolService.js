'use strict';

const net = require('net');
const { getPool } = require('../config/database');
const irctcAutomationService = require('../automation/irctc/irctcAutomationService');

function sanitizeString(val) {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

/**
 * Get user preferences (retention days, proxy pair limit).
 * Automatically initializes defaults if not yet created.
 */
async function getUserPreferences(userId) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT id, user_id, history_retention_days, proxy_pair_limit, updated_at
     FROM user_preferences
     WHERE user_id = $1`,
    [userId]
  );

  if (res.rows.length > 0) {
    return res.rows[0];
  }

  // Insert default row
  const insertRes = await pool.query(
    `INSERT INTO user_preferences (user_id, history_retention_days, proxy_pair_limit)
     VALUES ($1, 30, 4)
     ON CONFLICT (user_id) DO UPDATE SET updated_at = now()
     RETURNING id, user_id, history_retention_days, proxy_pair_limit, updated_at`,
    [userId]
  );
  return insertRes.rows[0];
}

/**
 * Update user preferences.
 */
async function updateUserPreferences(userId, data = {}) {
  const pool = getPool();
  const current = await getUserPreferences(userId);

  const retentionDays = data.history_retention_days !== undefined
    ? parseInt(data.history_retention_days, 10)
    : current.history_retention_days;
  const proxyLimit = data.proxy_pair_limit !== undefined
    ? parseInt(data.proxy_pair_limit, 10)
    : current.proxy_pair_limit;

  const validRetention = !isNaN(retentionDays) && retentionDays > 0 ? retentionDays : 30;
  const validLimit = !isNaN(proxyLimit) && proxyLimit > 0 ? proxyLimit : 4;

  const res = await pool.query(
    `INSERT INTO user_preferences (user_id, history_retention_days, proxy_pair_limit, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE
     SET history_retention_days = EXCLUDED.history_retention_days,
         proxy_pair_limit = EXCLUDED.proxy_pair_limit,
         updated_at = now()
     RETURNING id, user_id, history_retention_days, proxy_pair_limit, updated_at`,
    [userId, validRetention, validLimit]
  );

  return res.rows[0];
}

/**
 * List booking history for user with optional retention limit applied.
 */
async function listBookingHistory(userId, options = {}) {
  const pool = getPool();
  const prefs = await getUserPreferences(userId);
  const retentionDays = options.retentionDays || prefs.history_retention_days || 30;

  // Query records within retention days
  const query = `
    SELECT id, user_id, ticket_name, irctc_id, from_station, to_station,
           journey_date, bank_name, pnr, fare,
           TO_CHAR(booking_date, 'YYYY-MM-DD') as date,
           remarks, created_at
    FROM booking_history
    WHERE user_id = $1
      AND booking_date >= CURRENT_DATE - ($2 || ' days')::interval
    ORDER BY created_at DESC, id DESC
  `;

  const res = await pool.query(query, [userId, retentionDays]);
  return res.rows;
}

/**
 * Create a new booking history record.
 */
async function createBookingHistory(userId, data) {
  const pool = getPool();

  const ticketName = sanitizeString(data.ticket_name || data.ticketName);
  const irctcId = sanitizeString(data.irctc_id || data.irctcId || data.id);
  const fromStation = sanitizeString(data.from_station || data.fromStation || data.from);
  const toStation = sanitizeString(data.to_station || data.toStation || data.to);
  const journeyDate = sanitizeString(data.journey_date || data.journeyDate);
  const bankName = sanitizeString(data.bank_name || data.bankName);
  const pnr = sanitizeString(data.pnr);
  const fare = data.fare !== undefined && data.fare !== null ? parseFloat(data.fare) : 0.0;
  const bookingDate = data.date || data.booking_date || new Date().toISOString().split('T')[0];
  const remarks = sanitizeString(data.remarks) || 'Booking Success';

  if (!ticketName) {
    const err = new Error('Ticket Name is required');
    err.status = 400;
    throw err;
  }

  const query = `
    INSERT INTO booking_history (
      user_id, ticket_name, irctc_id, from_station, to_station,
      journey_date, bank_name, pnr, fare, booking_date, remarks
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING id, user_id, ticket_name, irctc_id, from_station, to_station,
              journey_date, bank_name, pnr, fare,
              TO_CHAR(booking_date, 'YYYY-MM-DD') as date,
              remarks, created_at
  `;

  const res = await pool.query(query, [
    userId,
    ticketName,
    irctcId,
    fromStation,
    toStation,
    journeyDate,
    bankName,
    pnr,
    isNaN(fare) ? 0.0 : fare,
    bookingDate,
    remarks,
  ]);

  return res.rows[0];
}

/**
 * Clear all booking history for user.
 */
async function clearBookingHistory(userId) {
  const pool = getPool();
  const res = await pool.query(
    `DELETE FROM booking_history WHERE user_id = $1 RETURNING id`,
    [userId]
  );
  return { deletedCount: res.rowCount };
}

/**
 * List all saved proxies for user.
 */
async function listProxies(userId) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT id, user_id, ip, port, username, check_irctc, status, created_at
     FROM proxies
     WHERE user_id = $1
     ORDER BY id ASC`,
    [userId]
  );
  return res.rows;
}

/**
 * Create a new proxy record for user.
 */
async function createProxy(userId, data) {
  const pool = getPool();

  const ip = sanitizeString(data.ip);
  const port = parseInt(data.port, 10);
  const username = sanitizeString(data.username);
  const password = sanitizeString(data.password);
  const checkIrctc = Boolean(data.check_irctc || data.checkIrctc);

  if (!ip) {
    const err = new Error('IP Address is required');
    err.status = 400;
    throw err;
  }

  if (isNaN(port) || port <= 0 || port > 65535) {
    const err = new Error('Valid Port between 1 and 65535 is required');
    err.status = 400;
    throw err;
  }

  const query = `
    INSERT INTO proxies (user_id, ip, port, username, password, check_irctc, status)
    VALUES ($1, $2, $3, $4, $5, $6, 'untested')
    RETURNING id, user_id, ip, port, username, check_irctc, status, created_at
  `;

  const res = await pool.query(query, [
    userId,
    ip,
    port,
    username || null,
    password || null,
    checkIrctc,
  ]);

  return res.rows[0];
}

/**
 * Delete a specific proxy.
 */
async function deleteProxy(userId, proxyId) {
  const pool = getPool();
  const res = await pool.query(
    `DELETE FROM proxies WHERE id = $1 AND user_id = $2 RETURNING id`,
    [proxyId, userId]
  );
  if (res.rowCount === 0) {
    const err = new Error('Proxy not found or not owned by user');
    err.status = 404;
    throw err;
  }
  return { ok: true, id: proxyId };
}

/**
 * Delete all proxies for user.
 */
async function deleteAllProxies(userId) {
  const pool = getPool();
  const res = await pool.query(
    `DELETE FROM proxies WHERE user_id = $1 RETURNING id`,
    [userId]
  );
  return { deletedCount: res.rowCount };
}

/**
 * Test proxy connectivity.
 */
async function checkProxy(userId, proxyId) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT id, ip, port, check_irctc FROM proxies WHERE id = $1 AND user_id = $2`,
    [proxyId, userId]
  );

  if (res.rows.length === 0) {
    const err = new Error('Proxy not found');
    err.status = 404;
    throw err;
  }

  const proxy = res.rows[0];
  const startTime = Date.now();

  const isAlive = await new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;

    socket.setTimeout(3500);

    socket.on('connect', () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(true);
      }
    });

    socket.on('timeout', () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(false);
      }
    });

    socket.on('error', () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(false);
      }
    });

    try {
      socket.connect(proxy.port, proxy.ip);
    } catch {
      resolve(false);
    }
  });

  const latencyMs = Date.now() - startTime;
  const status = isAlive ? 'active' : 'failed';

  await pool.query(
    `UPDATE proxies SET status = $1 WHERE id = $2`,
    [status, proxyId]
  );

  return {
    id: proxyId,
    ip: proxy.ip,
    port: proxy.port,
    status,
    latencyMs: isAlive ? latencyMs : null,
    message: isAlive ? `Proxy responded in ${latencyMs}ms` : 'Connection timed out or refused',
  };
}

async function clearAutomationCookies(userId, accountId = null) {
  const clearedCount = irctcAutomationService.clearUserSessions(userId, accountId);
  return {
    cleared: true,
    sessionCount: clearedCount,
    message: 'Automation session cookies cleared successfully.',
  };
}

module.exports = {
  getUserPreferences,
  updateUserPreferences,
  listBookingHistory,
  createBookingHistory,
  clearBookingHistory,
  listProxies,
  createProxy,
  deleteProxy,
  deleteAllProxies,
  checkProxy,
  clearAutomationCookies,
};

