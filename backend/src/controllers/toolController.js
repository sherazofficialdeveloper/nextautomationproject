'use strict';

const toolService = require('../services/toolService');

async function getPreferences(req, res, next) {
  try {
    const prefs = await toolService.getUserPreferences(req.user.id);
    return res.status(200).json({ ok: true, preferences: prefs });
  } catch (err) {
    next(err);
  }
}

async function updatePreferences(req, res, next) {
  try {
    const prefs = await toolService.updateUserPreferences(req.user.id, req.body);
    return res.status(200).json({ ok: true, preferences: prefs });
  } catch (err) {
    next(err);
  }
}

async function listBookingHistory(req, res, next) {
  try {
    const retentionDays = req.query.retention_days ? parseInt(req.query.retention_days, 10) : undefined;
    const history = await toolService.listBookingHistory(req.user.id, { retentionDays });
    return res.status(200).json({ ok: true, history });
  } catch (err) {
    next(err);
  }
}

async function createBookingHistory(req, res, next) {
  try {
    const record = await toolService.createBookingHistory(req.user.id, req.body);
    return res.status(201).json({ ok: true, record });
  } catch (err) {
    next(err);
  }
}

async function clearBookingHistory(req, res, next) {
  try {
    const result = await toolService.clearBookingHistory(req.user.id);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function listProxies(req, res, next) {
  try {
    const proxies = await toolService.listProxies(req.user.id);
    return res.status(200).json({ ok: true, proxies });
  } catch (err) {
    next(err);
  }
}

async function createProxy(req, res, next) {
  try {
    const proxy = await toolService.createProxy(req.user.id, req.body);
    return res.status(201).json({ ok: true, proxy });
  } catch (err) {
    next(err);
  }
}

async function deleteProxy(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const result = await toolService.deleteProxy(req.user.id, id);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function deleteAllProxies(req, res, next) {
  try {
    const result = await toolService.deleteAllProxies(req.user.id);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

const backupService = require('../services/backupService');

async function checkProxy(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const result = await toolService.checkProxy(req.user.id, id);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function createBackup(req, res, next) {
  try {
    const result = await backupService.createBackup(req.user.id, req.body);
    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

async function restoreBackup(req, res, next) {
  try {
    const result = await backupService.restoreBackup(req.user.id, req.body);
    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

async function deleteUserData(req, res, next) {
  try {
    const result = await backupService.deleteUserData(req.user.id, req.body);
    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

async function exportCategory(req, res, next) {
  try {
    const result = await backupService.exportCategory(req.user.id, req.params.category);
    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

async function clearAutomationCookies(req, res, next) {
  try {
    const { accountId } = req.body || {};
    const result = await toolService.clearAutomationCookies(req.user.id, accountId);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function getLicenseInfo(req, res, next) {
  try {
    const { getPool } = require('../config/database');
    const pool = getPool();

    // Query user and their most relevant license
    const userRes = await pool.query(
      `SELECT u.id, u.username, u.created_at, r.name AS role_name
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.id = $1;`,
      [req.user.id]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const user = userRes.rows[0];

    const licenseRes = await pool.query(
      `SELECT id, access_key, status, duration_value, duration_unit, starts_at, expires_at, created_at
       FROM licenses
       WHERE (user_id = $1 OR seller_id = $1)
       ORDER BY expires_at DESC
       LIMIT 1;`,
      [user.id]
    );

    let licenseKey = user.username;
    let keyType = 'monthly';
    let expiresAt = null;
    let startsAt = user.created_at;
    let status = 'Active';

    if (licenseRes.rows.length > 0) {
      const lic = licenseRes.rows[0];
      licenseKey = user.username;
      keyType = lic.duration_unit === 'days' ? `${lic.duration_value} days` : 'monthly';
      expiresAt = lic.expires_at;
      startsAt = lic.starts_at || lic.created_at;
      status = lic.status === 'ACTIVE' ? 'Active' : 'Expired';
    } else {
      const d = new Date(user.created_at);
      d.setMonth(d.getMonth() + 1);
      expiresAt = d.toISOString().split('T')[0];
    }

    const now = new Date();
    const expiryDate = new Date(expiresAt);
    const diffMs = expiryDate.getTime() - now.getTime();
    const expiryLeftDays = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));

    if (expiryLeftDays <= 0) {
      status = 'Expired';
    }

    return res.status(200).json({
      ok: true,
      licenseKey,
      expiryLeftDays,
      applicationVersion: '2026.07.16.0',
      keyType,
      status,
      startsAt,
      expiresAt,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getPreferences,
  updatePreferences,
  listBookingHistory,
  createBookingHistory,
  clearBookingHistory,
  listProxies,
  createProxy,
  deleteProxy,
  deleteAllProxies,
  checkProxy,
  createBackup,
  restoreBackup,
  deleteUserData,
  exportCategory,
  clearAutomationCookies,
  getLicenseInfo,
};


