'use strict';

// License data access layer. Parameterized queries only.
// Follows the existing backend convention (authService): one pooled client per
// operation, released in finally.

const { getPool } = require('../config/database');

const LICENSE_SELECT = `
  SELECT
    l.id,
    l.access_key,
    l.status,
    l.duration_value,
    l.duration_unit,
    l.starts_at::text AS starts_at,
    l.expires_at::text AS expires_at,
    l.created_at,
    l.updated_at,
    l.seller_id,
    seller.username AS seller_name,
    l.user_id,
    license_user.username AS user_name
  FROM licenses l
  JOIN users seller ON seller.id = l.seller_id
  LEFT JOIN users license_user ON license_user.id = l.user_id
`;

// Escape LIKE wildcards so search input is matched literally. Backslash is the
// default LIKE escape character in PostgreSQL, so % _ \\ are escaped with it.
function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

async function findById(id) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`${LICENSE_SELECT} WHERE l.id = $1`, [id]);
    return rows[0] || null;
  } finally {
    client.release();
  }
}

async function findBySellerAndId(id, sellerId) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `${LICENSE_SELECT} WHERE l.id = $1 AND l.seller_id = $2`,
      [id, sellerId]
    );
    return rows[0] || null;
  } finally {
    client.release();
  }
}

// Seller ownership check. `sellerId` must reference a users row with role SELLER.
async function findSellerById(sellerId) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT u.id, u.username
         FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE u.id = $1 AND r.name = 'SELLER'`,
      [sellerId]
    );
    return rows[0] || null;
  } finally {
    client.release();
  }
}

async function findUserById(userId) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      'SELECT id, username FROM users WHERE id = $1',
      [userId]
    );
    return rows[0] || null;
  } finally {
    client.release();
  }
}

async function insertLicense(data) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `INSERT INTO licenses
         (access_key, status, duration_value, duration_unit, starts_at, expires_at, seller_id, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        data.accessKey,
        data.status,
        data.durationValue,
        data.durationUnit,
        data.startsAt,
        data.expiresAt,
        data.sellerId,
        data.userId,
      ]
    );
    return rows[0];
  } catch (error) {
    // Mark unique violations so the service can retry key generation.
    if (error && error.code === '23505') {
      error.uniqueViolation = true;
    }
    throw error;
  } finally {
    client.release();
  }
}

// Filters object: { page, pageSize, today, sellerId, userId, search, status,
// fromDate, toDate, expiringBefore } — a null/undefined filter is ignored.
// Seller listing isolation is enforced here: the caller MUST pass the
// authenticated seller id; a client-supplied sellerId is never read.
async function listLicenses(filters) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const where = [];
    const params = [];
    let n = 0;

    if (filters.sellerId != null) {
      params.push(filters.sellerId);
      n += 1;
      where.push(`l.seller_id = $${n}`);
    }
    if (filters.userId != null) {
      params.push(filters.userId);
      n += 1;
      where.push(`l.user_id = $${n}`);
    }
    if (typeof filters.search === 'string' && filters.search !== '') {
      params.push(`%${escapeLike(filters.search)}%`);
      n += 1;
      where.push(`l.access_key ILIKE $${n}`);
    }
    if (typeof filters.status === 'string' && filters.status !== '') {
      if (filters.status === 'ACTIVE') {
        params.push(filters.today);
        n += 1;
        where.push(`l.status = 'ACTIVE' AND l.expires_at >= $${n}::date`);
      } else if (filters.status === 'EXPIRED') {
        params.push(filters.today);
        n += 1;
        where.push(`(l.status = 'EXPIRED' OR (l.status = 'ACTIVE' AND l.expires_at < $${n}::date))`);
      } else {
        params.push(filters.status);
        n += 1;
        where.push(`l.status = $${n}`);
      }
    }
    if (typeof filters.fromDate === 'string' && filters.fromDate !== '') {
      params.push(filters.fromDate);
      n += 1;
      where.push(`l.starts_at >= $${n}::date`);
    }
    if (typeof filters.toDate === 'string' && filters.toDate !== '') {
      params.push(filters.toDate);
      n += 1;
      where.push(`l.starts_at <= $${n}::date`);
    }
    if (typeof filters.expiringBefore === 'string' && filters.expiringBefore !== '') {
      params.push(filters.expiringBefore);
      n += 1;
      where.push(`l.expires_at < $${n}::date`);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const countResult = await client.query(
      `SELECT count(*)::int AS total FROM licenses l ${whereSql}`,
      params
    );
    const total = countResult.rows[0].total;

    params.push(filters.pageSize, (filters.page - 1) * filters.pageSize);
    const itemsResult = await client.query(
      `${LICENSE_SELECT} ${whereSql} ORDER BY l.id DESC LIMIT $${n + 1} OFFSET $${n + 2}`,
      params
    );

    return {
      items: itemsResult.rows,
      total,
    };
  } finally {
    client.release();
  }
}

// Conditional state transition. `allowedStatuses` is a fixed application
// allow-list (not user input) that makes the transition atomic.
async function updateStatus(id, newStatus, allowedStatuses) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const placeholders = allowedStatuses.map((_, i) => `$${i + 3}`).join(', ');
    const { rows } = await client.query(
      `UPDATE licenses
          SET status = $2, updated_at = now()
        WHERE id = $1 AND status IN (${placeholders})
        RETURNING id`,
      [id, newStatus, ...allowedStatuses]
    );
    return rows[0] || null;
  } finally {
    client.release();
  }
}

async function updateExpiry(id, newExpiry) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `UPDATE licenses
          SET expires_at = $2::date, status = 'ACTIVE', updated_at = now()
        WHERE id = $1 AND status IN ('ACTIVE', 'EXPIRED')
        RETURNING id`,
      [id, newExpiry]
    );
    return rows[0] || null;
  } finally {
    client.release();
  }
}

async function updateRenewal(id, newStart, newExpiry) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `UPDATE licenses
          SET starts_at = $2::date, expires_at = $3::date, status = 'ACTIVE', updated_at = now()
        WHERE id = $1 AND status IN ('ACTIVE', 'EXPIRED')
        RETURNING id`,
      [id, newStart, newExpiry]
    );
    return rows[0] || null;
  } finally {
    client.release();
  }
}

module.exports = {
  findById,
  findBySellerAndId,
  findSellerById,
  findUserById,
  insertLicense,
  listLicenses,
  updateStatus,
  updateExpiry,
  updateRenewal,
};
