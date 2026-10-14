const authService = require('../services/authService');
const { isValidEmail, isValidPassword } = require('../utils/validation');
const { loginSchema } = require('../validation/schemas');
const { validate } = require('../validation/validate');

async function login(req, res, next) {
  const payload = {
    identifier: req.body?.identifier || req.body?.username || '',
    password: req.body?.password || '',
  };

  const validation = validate(loginSchema, payload);
  if (!validation.success) {
    return res.status(400).json({ error: validation.error });
  }

  const cleanIdentifier = validation.data.identifier.trim();

  if (!isValidEmail(cleanIdentifier) && !/^[a-zA-Z0-9_]+(\s+[a-zA-Z0-9_]+)*$/.test(cleanIdentifier)) {
    return res.status(400).json({ error: 'Invalid identifier format.' });
  }
  const password = validation.data.password ? String(validation.data.password).trim() : '';

  try {
    const user = await authService.findUserByCredentials(cleanIdentifier);

    if (!user) {
      // Use a generic message to prevent account enumeration
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ error: 'Account is inactive.' });
    }

    // If password provided, verify password hash
    if (password) {
      if (!user.password_hash || !(await authService.comparePassword(password, user.password_hash))) {
        return res.status(401).json({ error: 'Invalid credentials.' });
      }
    }

    // Verify license status and expiry from PostgreSQL for desktop client users only
    // Administrative roles (SUPER_ADMIN, ADMIN, SELLER) manage the platform and must not be blocked by client license checks
    if (user.role_name === 'USER') {
      const { getPool } = require('../config/database');
      const pool = getPool();
      const licenseRes = await pool.query(
        `SELECT id, status, starts_at, expires_at FROM licenses
         WHERE user_id = $1
         ORDER BY expires_at DESC
         LIMIT 1;`,
        [user.id]
      );

      if (licenseRes.rows.length > 0) {
        const license = licenseRes.rows[0];
        const todayStr = new Date().toISOString().split('T')[0];
        const expiryStr = license.expires_at instanceof Date
          ? license.expires_at.toISOString().split('T')[0]
          : String(license.expires_at).split('T')[0];

        if (license.status === 'REVOKED' || license.status === 'SUSPENDED') {
          return res.status(403).json({ error: `License is ${license.status.toLowerCase()}.` });
        }

        if (expiryStr < todayStr || license.status === 'EXPIRED') {
          return res.status(403).json({ error: 'License has expired.' });
        }
      }
    }

    const token = authService.generateToken(user);

    // Return safe user information
    res.status(200).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        name: user.name || user.username,
        email: user.email,
        role: user.role_name,
      },
    });
  } catch (error) {
    next(error);
  }
}

// For stateless JWT, logout is primarily a client-side action
// This endpoint can be used to acknowledge logout or clear http-only cookies if implemented
function logout(req, res) {
  // If using httpOnly cookies, you'd clear them here:
  // res.clearCookie('jwt');
  res.status(200).json({ message: 'Logged out successfully.' });
}

async function getProfile(req, res, next) {
  // req.user is set by authenticate middleware
  try {
    const user = await authService.findUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    res.status(200).json({
      id: user.id,
      username: user.username,
      name: user.name || user.username,
      email: user.email,
      role: user.role_name,
      status: user.status,
    });
  } catch (error) {
    next(error);
  }
}

async function getAdminDashboard(req, res, next) {
  const { getPool } = require('../config/database');
  const pool = getPool();
  const client = await pool.connect();
  try {
    const sellerCountRes = await client.query(
      `SELECT count(*)::int AS count FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'SELLER'`
    );
    const activeKeyRes = await client.query(
      `SELECT count(*)::int AS count FROM licenses WHERE status = 'ACTIVE' AND expires_at >= CURRENT_DATE`
    );
    const inactiveKeyRes = await client.query(
      `SELECT count(*)::int AS count FROM licenses WHERE status != 'ACTIVE' OR expires_at < CURRENT_DATE`
    );

    const recentSellersRes = await client.query(
      `SELECT u.id, u.username, u.status, u.created_at AS "createdAt"
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE r.name = 'SELLER'
       ORDER BY u.id DESC
       LIMIT 5`
    );
    const recentKeysRes = await client.query(
      `SELECT l.id, l.access_key AS "key", l.status,
              to_char(l.starts_at, 'YYYY-MM-DD') AS "startsAt",
              to_char(l.expires_at, 'YYYY-MM-DD') AS "expiresAt",
              l.duration_value AS "durationValue",
              l.duration_unit AS "durationUnit",
              u.username AS "sellerUsername"
       FROM licenses l
       LEFT JOIN users u ON u.id = l.seller_id
       ORDER BY l.id DESC
       LIMIT 5`
    );

    res.status(200).json({
      message: `Welcome to the Admin Dashboard, ${req.user.role}!`,
      totalSellers: sellerCountRes.rows[0].count,
      activeKeys: activeKeyRes.rows[0].count,
      inactiveKeys: inactiveKeyRes.rows[0].count,
      recentSellers: recentSellersRes.rows,
      recentKeys: recentKeysRes.rows,
    });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
}

async function getSellerDashboard(req, res, next) {
  const { getPool } = require('../config/database');
  const pool = getPool();
  const client = await pool.connect();
  try {
    const sellerId = req.user.id;
    const totalRes = await client.query(
      `SELECT count(*)::int AS count FROM licenses WHERE seller_id = $1`,
      [sellerId]
    );
    const activeRes = await client.query(
      `SELECT count(*)::int AS count FROM licenses WHERE seller_id = $1 AND status = 'ACTIVE' AND expires_at >= CURRENT_DATE`,
      [sellerId]
    );
    const inactiveRes = await client.query(
      `SELECT count(*)::int AS count FROM licenses WHERE seller_id = $1 AND (status != 'ACTIVE' OR expires_at < CURRENT_DATE)`,
      [sellerId]
    );
    const usedRes = await client.query(
      `SELECT count(*)::int AS count FROM licenses WHERE seller_id = $1 AND user_id IS NOT NULL`,
      [sellerId]
    );

    res.status(200).json({
      message: `Welcome to the Seller Dashboard, ${req.user.role}!`,
      totalKeys: totalRes.rows[0].count,
      activeKeys: activeRes.rows[0].count,
      deactivatedKeys: inactiveRes.rows[0].count,
      usedKeys: usedRes.rows[0].count,
    });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
}

module.exports = {
  login,
  logout,
  getProfile,
  getAdminDashboard,
  getSellerDashboard,
};