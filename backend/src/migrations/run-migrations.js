require('dotenv').config({ path: './.env' });
const { getPool } = require('../config/database');
const fs = require('fs');
const path = require('path');

const migrationsDir = path.join(__dirname);

async function runMigrations() {
  const pool = getPool();
  try {
    const client = await pool.connect();
    console.log('Starting migrations...');

    const migrationFiles = fs.readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort();

    for (const file of migrationFiles) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');
      console.log(`Running migration: ${file}`);
      await client.query(sql);
      console.log(`Migration ${file} completed.`);
    }

    console.log('All migrations finished.');
    client.release();
  } catch (error) {
    console.error('Error running migrations:', error);
    process.exit(1);
  } finally {
    // Ensure the pool is ended if you want to explicitly close the connection
    // pool.end();
  }
}

runMigrations();