const { Pool } = require('pg');
const bcrypt = require('bcrypt');
require('dotenv').config();

async function verifyAll() {
  console.log('=== 1. POSTGRESQL DATABASE CHECKS ===');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT id, username, email, name, password_hash, status FROM users WHERE username = $1', ['Rai Sheraz']);
    console.log('User count for Rai Sheraz:', res.rows.length);
    const user = res.rows[0];
    console.log('User ID:', user.id);
    console.log('Username:', user.username);
    console.log('Status:', user.status);
    console.log('Password is hashed with bcrypt?', user.password_hash.startsWith('$2b$'));
    const matches = await bcrypt.compare('Rai@1234', user.password_hash);
    console.log('Password Rai@1234 matches hash?', matches);
  } finally {
    client.release();
    await pool.end();
  }

  console.log('\n=== 2. BACKEND API CHECKS ===');
  const url = 'http://localhost:3000/api/auth/login';

  // Correct
  const r1 = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'Rai Sheraz', password: 'Rai@1234' })
  });
  const d1 = await r1.json();
  console.log('Valid login status:', r1.status, '| User:', d1.user?.username, '| Token present:', Boolean(d1.token));

  // Wrong password
  const r2 = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'Rai Sheraz', password: 'WrongPassword123' })
  });
  const d2 = await r2.json();
  console.log('Wrong password status:', r2.status, '| Error:', d2.error);

  // Unknown username
  const r3 = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'UnknownUser', password: 'Rai@1234' })
  });
  const d3 = await r3.json();
  console.log('Unknown user status:', r3.status, '| Error:', d3.error);

  // Bad identifier
  const r4 = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'bad!ident', password: 'Rai@1234' })
  });
  const d4 = await r4.json();
  console.log('Bad identifier status:', r4.status, '| Error:', d4.error);
}

verifyAll().catch(console.error);

