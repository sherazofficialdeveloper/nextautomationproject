'use strict';

const { getPool } = require('../config/database');

async function getHistory(userId) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT id, ticket_name, irctc_id, from_station, to_station, journey_date,
            bank_name, pnr, fare, TO_CHAR(booking_date, 'YYYY-MM-DD') as booking_date,
            remarks, created_at
     FROM booking_history
     WHERE user_id = $1
     ORDER BY id DESC`,
    [userId]
  );
  return res.rows;
}

async function addHistory(userId, data) {
  const pool = getPool();
  const {
    ticket_name,
    irctc_id,
    from_station,
    to_station,
    journey_date,
    bank_name,
    pnr,
    fare,
    remarks,
  } = data;

  if (!ticket_name || !from_station || !to_station || !journey_date) {
    const err = new Error('Ticket name, from station, to station, and journey date are required.');
    err.status = 400;
    throw err;
  }

  const res = await pool.query(
    `INSERT INTO booking_history
      (user_id, ticket_name, irctc_id, from_station, to_station, journey_date,
       bank_name, pnr, fare, remarks)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, ticket_name, irctc_id, from_station, to_station, journey_date,
               bank_name, pnr, fare, TO_CHAR(booking_date, 'YYYY-MM-DD') as booking_date,
               remarks, created_at`,
    [
      userId,
      ticket_name.trim(),
      irctc_id ? irctc_id.trim() : null,
      from_station.trim(),
      to_station.trim(),
      journey_date.trim(),
      bank_name ? bank_name.trim() : null,
      pnr ? pnr.trim() : null,
      parseFloat(fare) || 0.0,
      remarks ? remarks.trim() : 'Booking Success',
    ]
  );

  return res.rows[0];
}

async function clearHistory(userId) {
  const pool = getPool();
  await pool.query('DELETE FROM booking_history WHERE user_id = $1', [userId]);
  return { ok: true };
}

async function getRetentionSetting(userId) {
  const pool = getPool();
  const res = await pool.query(
    'SELECT history_retention_days FROM user_preferences WHERE user_id = $1',
    [userId]
  );
  if (res.rows.length > 0) {
    return res.rows[0].history_retention_days;
  }
  return 30; // default 30 days
}

async function setRetentionSetting(userId, days) {
  const pool = getPool();
  const parsedDays = parseInt(days, 10);
  if (isNaN(parsedDays) || parsedDays <= 0) {
    const err = new Error('Retention days must be a positive integer.');
    err.status = 400;
    throw err;
  }

  await pool.query(
    `INSERT INTO user_preferences (user_id, history_retention_days)
     VALUES ($1, $2)
     ON CONFLICT (user_id)
     DO UPDATE SET history_retention_days = EXCLUDED.history_retention_days, updated_at = now()`,
    [userId, parsedDays]
  );

  // Clean up records older than retention period
  await pool.query(
    `DELETE FROM booking_history
     WHERE user_id = $1 AND booking_date < (CURRENT_DATE - INTERVAL '1 day' * $2)`,
    [userId, parsedDays]
  );

  return { ok: true, history_retention_days: parsedDays };
}

module.exports = {
  getHistory,
  addHistory,
  clearHistory,
  getRetentionSetting,
  setRetentionSetting,
};
