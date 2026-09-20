'use strict';

// Account data access layer. Parameterized queries only.
// Follows the existing backend convention: one pooled client per operation,
// released in finally. Never returns password hashes to callers above unless
// explicitly requested for credential verification.

const { getPool } = require('../config/database');

const ACCOUNT_SELECT = `
  SELECT
    u.id,
    u.username,
    u.email,
    u.name,
    u.contact,
    u.status,
    u.created_at,
    u.updated_at,
    r.name AS role_name
  FROM users u
  JOIN roles r ON r.id = u.role_id
`;

// Includes password_hash — ONLY for credential verification paths.
const ACCOUNT_WITH_HASH_SELECT = `
  SELECT
    u.id,
    u.username,
    u.email,
    u.name,
    u.contact,
    u.status,
    u.created_at,
    u.updated_at,
    u.password_hash,
    r.name AS role_name
  FROM users u
  JOIN roles r ON r.id = u.role_id
`;

async function findById(id) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`${ACCOUNT_SELECT} WHERE u.id = $1`, [id]);
    return rows[0] || null;
  } finally {
    client.release();
  }
}

// Credential verification lookup (includes password_hash). Never serialized.
async function findByIdWithHash(id) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`${ACCOUNT_WITH_HASH_SELECT} WHERE u.id = $1`, [id]);
    return rows[0] || null;
  } finally {
    client.release();
  }
}

// Seller lookup by id (role must be SELLER).
async function findSellerById(id) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `${ACCOUNT_SELECT} WHERE u.id = $1 AND r.name = 'SELLER'`,
      [id]
    );
    return rows[0] || null;
  } finally {
    client.release();
  }
}

async function usernameExists(username) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      'SELECT 1 FROM users WHERE username = $1 LIMIT 1',
      [username]
    );
    return rows.length > 0;
  } finally {
    client.release();
  }
}

// Case-insensitive email ownership check. excludeId avoids self-matches on update.
async function findEmailOwner(email, excludeId) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id FROM users WHERE lower(email) = lower($1) AND id <> $2 LIMIT 1`,
      [email, excludeId === undefined ? -1 : excludeId]
    );
    return rows[0] || null;
  } finally {
    client.release();
  }
}

async function insertUser(data) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `INSERT INTO users (username, email, password_hash, role_id, status, name, contact, created_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        data.username,
        data.email === undefined ? null : data.email,
        data.passwordHash,
        data.roleId,
        data.status,
        data.name,
        data.contact === undefined ? null : data.contact,
        data.createdById === undefined ? null : data.createdById,
      ]
    );
    return rows[0];
  } catch (error) {
    if (error && error.code === '23505') {
      error.uniqueViolation = true;
    }
    throw error;
  } finally {
    client.release();
  }
}

// Filters: { search, status } — both optional.
async function listSellers(filters) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const where = [`r.name = 'SELLER'`];
    const params = [];
    let n = 0;

    if (typeof filters.search === 'string' && filters.search !== '') {
      params.push(`%${filters.search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
      n += 1;
      where.push(`(u.name ILIKE $${n} OR u.email ILIKE $${n})`);
    }
    if (typeof filters.status === 'string' && filters.status !== '') {
      params.push(filters.status);
      n += 1;
      where.push(`u.status = $${n}`);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;

    const countResult = await client.query(
      `SELECT count(*)::int AS total FROM users u JOIN roles r ON r.id = u.role_id ${whereSql}`,
      params
    );
    const total = countResult.rows[0].total;

    params.push(filters.pageSize, (filters.page - 1) * filters.pageSize);
    const itemsResult = await client.query(
      `${ACCOUNT_SELECT} ${whereSql} ORDER BY u.id DESC LIMIT $${n + 1} OFFSET $${n + 2}`,
      params
    );

    return { items: itemsResult.rows, total };
  } finally {
    client.release();
  }
}

async function updateProfileById(id, name) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `UPDATE users SET name = $2, updated_at = now() WHERE id = $1 RETURNING id`,
      [id, name]
    );
    return rows[0] || null;
  } finally {
    client.release();
  }
}

async function updatePasswordById(id, passwordHash) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1 RETURNING id`,
      [id, passwordHash]
    );
    return rows[0] || null;
  } finally {
    client.release();
  }
}

// Explicit field allow-list object built by the service: { name, email, contact }.
async function updateSellerById(id, fields) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const sets = [];
    const params = [id];
    let n = 1;
    if (Object.prototype.hasOwnProperty.call(fields, 'name')) {
      params.push(fields.name);
      n += 1;
      sets.push(`name = $${n}`);
    }
    if (Object.prototype.hasOwnProperty.call(fields, 'email')) {
      params.push(fields.email);
      n += 1;
      sets.push(`email = $${n}`);
    }
    if (Object.prototype.hasOwnProperty.call(fields, 'contact')) {
      params.push(fields.contact === undefined ? null : fields.contact);
      n += 1;
      sets.push(`contact = $${n}`);
    }
    if (sets.length === 0) return { unchanged: true };
    sets.push('updated_at = now()');
    const { rows } = await client.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING id`,
      params
    );
    return rows[0] || null;
  } catch (error) {
    if (error && error.code === '23505') {
      error.uniqueViolation = true;
    }
    throw error;
  } finally {
    client.release();
  }
}

async function updateStatusById(id, status) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `UPDATE users SET status = $2, updated_at = now() WHERE id = $1 RETURNING id`,
      [id, status]
    );
    return rows[0] || null;
  } finally {
    client.release();
  }
}

async function findRoleIdByName(roleName) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      'SELECT id FROM roles WHERE name = $1',
      [roleName]
    );
    return rows[0] ? rows[0].id : null;
  } finally {
    client.release();
  }
}

module.exports = {
  findById,
  findByIdWithHash,
  findSellerById,
  usernameExists,
  findEmailOwner,
  insertUser,
  listSellers,
  updateProfileById,
  updatePasswordById,
  updateSellerById,
  updateStatusById,
  findRoleIdByName,
};
