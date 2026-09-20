const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { getPool } = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';

const SALT_ROUNDS = 10; // For bcrypt

async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function generateToken(user) {
  const payload = {
    id: user.id,
    role: user.role_name, // Assuming role_name is joined from roles table
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null; // Token is invalid or expired
  }
}

async function findUserByCredentials(identifier) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const query = `
      SELECT
        u.id, u.username, u.email, u.name, u.password_hash, u.status, u.created_at,
        r.name AS role_name
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE lower(trim(u.username)) = lower(trim($1)) OR (u.email IS NOT NULL AND lower(trim(u.email)) = lower(trim($1)));
    `;
    const { rows } = await client.query(query, [identifier]);
    return rows[0] || null;
  } finally {
    client.release();
  }
}

async function findUserById(id) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const query = `
      SELECT
        u.id, u.username, u.email, u.name, u.status,
        r.name AS role_name
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE u.id = $1;
    `;
    const { rows } = await client.query(query, [id]);
    return rows[0] || null;
  } finally {
    client.release();
  }
}

module.exports = {
  hashPassword,
  comparePassword,
  generateToken,
  verifyToken,
  findUserByCredentials,
  findUserById,
};