require('dotenv').config();
const bcrypt = require('bcrypt');
const { getPool } = require('../config/database');

const DEV_USERNAME = 'Rai Sheraz';
const DEV_PASSWORD = process.env.DEV_USER_PASSWORD || 'Rai@1234';

async function seedDevUser() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    console.log('[seed] Checking existing user in PostgreSQL...');
    const existing = await client.query(
      'SELECT id, username, email, role_id, status FROM users WHERE username = $1',
      [DEV_USERNAME]
    );

    const passwordHash = await bcrypt.hash(DEV_PASSWORD, 10);

    if (existing.rows.length > 0) {
      const user = existing.rows[0];
      console.log(`[seed] User '${DEV_USERNAME}' found (ID: ${user.id}). Updating password hash and ensuring status is active...`);
      await client.query(
        'UPDATE users SET password_hash = $1, status = $2 WHERE id = $3',
        [passwordHash, 'active', user.id]
      );
      console.log(`[seed] Updated user ID ${user.id} successfully.`);
    } else {
      console.log(`[seed] User '${DEV_USERNAME}' not found. Creating new development user...`);
      // Find default role ID (e.g. SELLER or ADMIN)
      const roleRes = await client.query("SELECT id FROM roles WHERE name = 'SELLER' LIMIT 1");
      const roleId = roleRes.rows[0] ? roleRes.rows[0].id : 2;

      const insertRes = await client.query(
        `INSERT INTO users (username, name, email, password_hash, role_id, status)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, username, email, status`,
        [DEV_USERNAME, DEV_USERNAME, 'sheraz@example.com', passwordHash, roleId, 'active']
      );
      console.log(`[seed] Created user ID ${insertRes.rows[0].id} successfully.`);
    }

    // Verification
    const verifyRes = await client.query(
      'SELECT id, username, password_hash, status FROM users WHERE username = $1',
      [DEV_USERNAME]
    );
    const matches = await bcrypt.compare(DEV_PASSWORD, verifyRes.rows[0].password_hash);
    console.log(`[seed] Verification: User exists? ${Boolean(verifyRes.rows[0])}, Password matches? ${matches}`);

    return { success: true, verified: matches };
  } catch (error) {
    console.error('[seed] Error during dev user seeding:', error);
    throw error;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  seedDevUser()
    .then(() => {
      console.log('[seed] Dev user seed completed successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[seed] Failed:', err);
      process.exit(1);
    });
}

module.exports = seedDevUser;

