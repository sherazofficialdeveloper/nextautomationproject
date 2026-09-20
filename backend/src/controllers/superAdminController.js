'use strict';

const { getPool } = require('../config/database');
const authService = require('../services/authService');
const { badRequest, notFound, conflict } = require('../utils/httpError');

async function getDashboard(req, res, next) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const adminCountRes = await client.query(
      `SELECT count(*)::int AS count FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'ADMIN'`
    );
    const sellerCountRes = await client.query(
      `SELECT count(*)::int AS count FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'SELLER'`
    );
    const keyCountRes = await client.query(
      `SELECT count(*)::int AS count FROM licenses`
    );

    res.status(200).json({
      totalAdmins: adminCountRes.rows[0].count,
      totalSellers: sellerCountRes.rows[0].count,
      totalKeys: keyCountRes.rows[0].count,
    });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
}

async function listAdmins(req, res, next) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT u.id, u.username, u.name, u.email, u.contact, u.status, u.created_at, u.updated_at,
              c.username AS created_by_username,
              (SELECT count(*)::int FROM users s WHERE s.created_by_id = u.id) AS sellers_count
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN users c ON c.id = u.created_by_id
       WHERE r.name = 'ADMIN'
       ORDER BY u.id DESC`
    );
    res.status(200).json({ items: rows, total: rows.length });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
}

async function createAdmin(req, res, next) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { username, password, name, email, contact } = req.body || {};
    if (!username || typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,30}$/.test(username.trim())) {
      throw badRequest('Username must be 3-30 alphanumeric characters or underscores.');
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      throw badRequest('Password must be at least 8 characters long.');
    }

    const cleanUsername = username.trim();

    // Check username uniqueness
    const { rows: existingUser } = await client.query(
      'SELECT id FROM users WHERE lower(username) = lower($1)',
      [cleanUsername]
    );
    if (existingUser.length > 0) {
      throw conflict('Username is already in use.');
    }

    // Check email uniqueness if email provided
    let cleanEmail = null;
    if (email && typeof email === 'string' && email.trim() !== '') {
      cleanEmail = email.trim().toLowerCase();
      const { rows: existingEmail } = await client.query(
        'SELECT id FROM users WHERE lower(email) = lower($1)',
        [cleanEmail]
      );
      if (existingEmail.length > 0) {
        throw conflict('Email is already in use.');
      }
    }

    const { rows: roleRows } = await client.query(
      "SELECT id FROM roles WHERE name = 'ADMIN'"
    );
    if (roleRows.length === 0) {
      throw badRequest('ADMIN role not configured in system.');
    }

    const passwordHash = await authService.hashPassword(password);
    const displayName = (name && typeof name === 'string' && name.trim()) || cleanUsername;
    const cleanContact = (contact && typeof contact === 'string' && contact.trim()) || null;

    const { rows: created } = await client.query(
      `INSERT INTO users (username, email, password_hash, role_id, status, name, contact, created_by_id)
       VALUES ($1, $2, $3, $4, 'active', $5, $6, $7)
       RETURNING id, username, name, email, contact, status, created_at`,
      [cleanUsername, cleanEmail, passwordHash, roleRows[0].id, displayName, cleanContact, req.user.id]
    );

    res.status(201).json({
      message: 'Admin account created successfully.',
      admin: created[0],
    });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
}

async function updateAdminStatus(req, res, next) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const adminId = parseInt(req.params.id, 10);
    if (isNaN(adminId) || adminId <= 0) {
      throw badRequest('Valid admin id is required.');
    }

    const { status } = req.body || {};
    if (!['active', 'inactive', 'blocked'].includes(status)) {
      throw badRequest('Invalid status. Allowed values: active, inactive, blocked.');
    }

    const { rows: target } = await client.query(
      `SELECT u.id, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
      [adminId]
    );
    if (target.length === 0 || target[0].role_name !== 'ADMIN') {
      throw notFound('Admin account not found.');
    }

    const { rows: updated } = await client.query(
      `UPDATE users SET status = $1, updated_at = now() WHERE id = $2 RETURNING id, username, status, updated_at`,
      [status, adminId]
    );

    res.status(200).json({
      message: `Admin status updated to ${status}.`,
      admin: updated[0],
    });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
}

async function deleteAdmin(req, res, next) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const adminId = parseInt(req.params.id, 10);
    if (isNaN(adminId) || adminId <= 0) {
      throw badRequest('Valid admin id is required.');
    }

    if (req.user.id === adminId) {
      throw badRequest('You cannot delete your own account.');
    }

    const { rows: target } = await client.query(
      `SELECT u.id, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
      [adminId]
    );
    if (target.length === 0 || target[0].role_name !== 'ADMIN') {
      throw notFound('Admin account not found.');
    }

    // Preserve sellers created by this admin by unsetting created_by_id
    await client.query(`UPDATE users SET created_by_id = NULL WHERE created_by_id = $1`, [adminId]);
    await client.query(`DELETE FROM users WHERE id = $1`, [adminId]);

    res.status(200).json({ message: 'Admin deleted successfully.' });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
}

async function listSellers(req, res, next) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const search = req.query.search ? `%${req.query.search.trim()}%` : null;
    let query = `
      SELECT u.id, u.username, u.name, u.email, u.contact, u.status, u.created_at,
             c.username AS created_by_username,
             (SELECT count(*)::int FROM licenses l WHERE l.seller_id = u.id) AS keys_count
      FROM users u
      JOIN roles r ON r.id = u.role_id
      LEFT JOIN users c ON c.id = u.created_by_id
      WHERE r.name = 'SELLER'
    `;
    const params = [];
    if (search) {
      params.push(search);
      query += ` AND (u.username ILIKE $1 OR u.name ILIKE $1 OR u.email ILIKE $1)`;
    }
    query += ` ORDER BY u.id DESC`;

    const { rows } = await client.query(query, params);
    res.status(200).json({ items: rows, total: rows.length });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
}

async function listKeys(req, res, next) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const search = req.query.search ? `%${req.query.search.trim()}%` : null;
    const status = req.query.status || null;
    let query = `
      SELECT l.id, l.access_key, l.status, l.duration_value, l.duration_unit,
             l.starts_at, l.expires_at, l.created_at, l.user_id,
             s.username AS seller_username, s.name AS seller_name
      FROM licenses l
      JOIN users s ON s.id = l.seller_id
      WHERE 1=1
    `;
    const params = [];
    let pIdx = 1;
    if (search) {
      params.push(search);
      query += ` AND (l.access_key ILIKE $${pIdx} OR s.username ILIKE $${pIdx})`;
      pIdx += 1;
    }
    if (status) {
      params.push(status.toUpperCase());
      query += ` AND l.status = $${pIdx}`;
      pIdx += 1;
    }
    query += ` ORDER BY l.id DESC LIMIT 100`;

    const { rows } = await client.query(query, params);
    res.status(200).json({ items: rows, total: rows.length });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
}

module.exports = {
  getDashboard,
  listAdmins,
  createAdmin,
  updateAdminStatus,
  deleteAdmin,
  listSellers,
  listKeys,
};

