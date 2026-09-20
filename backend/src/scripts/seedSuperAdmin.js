'use strict';

require('dotenv').config();
const bcrypt = require('bcrypt');
const { getPool } = require('../config/database');

async function seedSuperAdmin() {
  const pool = getPool();
  try {
    const roleRes = await pool.query(`SELECT id FROM roles WHERE name = 'SUPER_ADMIN';`);
    if (roleRes.rows.length === 0) {
      await pool.query(`INSERT INTO roles (name) VALUES ('SUPER_ADMIN');`);
    }
    const roleIdRes = await pool.query(`SELECT id FROM roles WHERE name = 'SUPER_ADMIN';`);
    const roleId = roleIdRes.rows[0].id;

    const existing = await pool.query(`SELECT id, username FROM users WHERE username = 'superadmin';`);
    if (existing.rows.length === 0) {
      const hash = await bcrypt.hash('SuperAdmin123!', 10);
      const insertQuery = `
        INSERT INTO users (username, name, email, password_hash, role_id, status)
        VALUES ($1, $2, $3, $4, $5, 'active')
        RETURNING id, username;
      `;
      const inserted = await pool.query(insertQuery, [
        'superadmin',
        'Super Admin',
        'superadmin@netx.local',
        hash,
        roleId,
      ]);
      console.log('Seeded superadmin account:', inserted.rows[0]);
    } else {
      console.log('Superadmin account already exists:', existing.rows[0]);
    }

    // Also ensure default admin exists for testing
    const adminRoleRes = await pool.query(`SELECT id FROM roles WHERE name = 'ADMIN';`);
    if (adminRoleRes.rows.length > 0) {
      const adminRoleId = adminRoleRes.rows[0].id;
      const adminExisting = await pool.query(`SELECT id, username FROM users WHERE username = 'admin';`);
      if (adminExisting.rows.length === 0) {
        const adminHash = await bcrypt.hash('Admin123!', 10);
        const insertAdminQuery = `
          INSERT INTO users (username, name, email, password_hash, role_id, status)
          VALUES ($1, $2, $3, $4, $5, 'active')
          RETURNING id, username;
        `;
        const insertedAdmin = await pool.query(insertAdminQuery, [
          'admin',
          'Platform Admin',
          'admin@netx.local',
          adminHash,
          adminRoleId,
        ]);
        console.log('Seeded default admin account:', insertedAdmin.rows[0]);
      } else {
        console.log('Default admin account already exists:', adminExisting.rows[0]);
      }
    }

    process.exit(0);
  } catch (error) {
    console.error('Seeding error:', error);
    process.exit(1);
  }
}

seedSuperAdmin();

