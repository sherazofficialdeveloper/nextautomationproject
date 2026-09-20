const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function connectDB() {
  try {
    await pool.query('SELECT 1');
    console.log('Database connected successfully.');
  } catch (error) {
    console.error('Database connection failed:', error);
    throw error;
  }
}

function getPool() {
  return pool;
}

module.exports = {
  connectDB,
  getPool,
};