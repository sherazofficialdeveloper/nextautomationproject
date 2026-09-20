'use strict';

const { getPool } = require('../config/database');
const { normalizeJourneyDate } = require('../utils/dateUtils');

/**
 * Service handling ticket validation, persistence, and ownership enforcement.
 */
class TicketService {
  /**
   * Save a new ticket configuration.
   * Strictly verifies ownership of the IRCTC account and enforces the 6-passenger limit.
   */
  async saveTicket(userId, ticketData, customPool = null) {
    if (!userId) {
      const err = new Error('Authentication required.');
      err.status = 401;
      throw err;
    }

    const {
      irctcAccountId,
      ticketName,
      fromStation,
      toStation,
      journeyDate,
      quota = 'General',
      selectedClass = '',
      trainNumber = '',
      trainName = '',
      boardingPoint = '',
      journeyTime = '',
      slotTime = '',
      passengers = [],
      mobileNumber = '',
      email = '',
      paymentMethod = 'Default Payment (Auto)',
    } = ticketData || {};

    // 1. Validate Ticket Name
    const cleanTicketName = typeof ticketName === 'string' ? ticketName.trim() : '';
    if (!cleanTicketName) {
      const err = new Error('Ticket Name is required.');
      err.status = 400;
      throw err;
    }

    // 2. Validate IRCTC account ID format
    const parsedAccountId = parseInt(irctcAccountId, 10);
    if (isNaN(parsedAccountId) || parsedAccountId <= 0) {
      const err = new Error('Valid IRCTC Account selection is required.');
      err.status = 400;
      throw err;
    }

    // 3. Validate Journey Details
    const cleanFrom = typeof fromStation === 'string' ? fromStation.trim().toUpperCase() : '';
    const cleanTo = typeof toStation === 'string' ? toStation.trim().toUpperCase() : '';

    if (!cleanFrom) {
      const err = new Error('From Station is required.');
      err.status = 400;
      throw err;
    }
    if (!cleanTo) {
      const err = new Error('To Station is required.');
      err.status = 400;
      throw err;
    }
    if (cleanFrom === cleanTo) {
      const err = new Error('From Station and To Station cannot be the same.');
      err.status = 400;
      throw err;
    }

    let cleanJourneyDate;
    try {
      cleanJourneyDate = normalizeJourneyDate(journeyDate);
    } catch (dateErr) {
      const err = new Error(dateErr.message || 'Valid Journey Date (YYYY-MM-DD) is required.');
      err.status = 400;
      throw err;
    }

    // 4. Validate Passenger Details (Quota-aware: Tatkal / Premium Tatkal max 4, General / Ladies max 6)
    const cleanQuota = String(quota || 'General').trim();
    const isTatkal = /^(tatkal|premium\s*tatkal|tq|pt)$/i.test(cleanQuota);
    const maxAllowedPassengers = isTatkal ? 4 : 6;

    if (!Array.isArray(passengers) || passengers.length === 0) {
      const err = new Error('At least one passenger is required.');
      err.status = 400;
      throw err;
    }
    if (passengers.length > maxAllowedPassengers) {
      const message = isTatkal
        ? `Maximum of 4 passengers allowed for ${/premium|pt/i.test(cleanQuota) ? 'Premium Tatkal' : 'Tatkal'} quota.`
        : 'Maximum of 6 passengers allowed per ticket.';
      const err = new Error(message);
      err.status = 400;
      throw err;
    }

    const validatedPassengers = passengers.map((p, idx) => {
      const pName = typeof p.name === 'string' ? p.name.trim() : '';
      if (!pName) {
        const err = new Error(`Passenger ${idx + 1} name is required.`);
        err.status = 400;
        throw err;
      }
      if (!/^[A-Za-z\s]+$/.test(pName)) {
        const err = new Error(`Passenger ${idx + 1} name must contain only letters and spaces.`);
        err.status = 400;
        throw err;
      }

      const rawAge = String(p.age != null ? p.age : '').trim();
      if (!/^\d{1,3}$/.test(rawAge)) {
        const err = new Error(`Passenger ${idx + 1} age must be a valid number between 1 and 125.`);
        err.status = 400;
        throw err;
      }
      const pAge = parseInt(rawAge, 10);
      if (isNaN(pAge) || pAge < 1 || pAge > 125) {
        const err = new Error(`Passenger ${idx + 1} age must be between 1 and 125.`);
        err.status = 400;
        throw err;
      }

      return {
        name: pName,
        age: pAge,
        sex: typeof p.sex === 'string' && p.sex.trim() ? p.sex.trim() : 'Male',
        berthPreference: p.berthPreference || 'No Preference',
        food: p.food || 'No Preference',
        idCardType: p.idCardType || '',
        idNumber: p.idNumber || '',
        child: Boolean(p.child),
      };
    });

    // 5. Validate Contact
    const cleanMobile = typeof mobileNumber === 'string' ? mobileNumber.trim() : '';
    if (!cleanMobile || !/^\+?[0-9]{10,15}$/.test(cleanMobile.replace(/[\s-]/g, ''))) {
      const err = new Error('Valid 10-digit mobile number is required.');
      err.status = 400;
      throw err;
    }

    const cleanEmail = typeof email === 'string' ? email.trim() : '';

    // 6. Validate Account Ownership
    const pool = customPool || getPool();
    const accountCheck = await pool.query(
      'SELECT id, username FROM target_accounts WHERE id = $1 AND user_id = $2;',
      [parsedAccountId, userId]
    );

    if (accountCheck.rows.length === 0) {
      const err = new Error('Selected IRCTC account not found or does not belong to you.');
      err.status = 403;
      throw err;
    }

    // 7. Insert into database
    const insertQuery = `
      INSERT INTO tickets (
        user_id,
        irctc_account_id,
        ticket_name,
        from_station,
        to_station,
        journey_date,
        quota,
        selected_class,
        train_number,
        train_name,
        boarding_point,
        journey_time,
        slot_time,
        passengers,
        mobile_number,
        email,
        payment_method,
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'saved')
      RETURNING
        id,
        user_id AS "userId",
        irctc_account_id AS "irctcAccountId",
        ticket_name AS "ticketName",
        from_station AS "fromStation",
        to_station AS "toStation",
        to_char(journey_date, 'YYYY-MM-DD') AS "journeyDate",
        quota,
        selected_class AS "selectedClass",
        train_number AS "trainNumber",
        train_name AS "trainName",
        boarding_point AS "boardingPoint",
        journey_time AS "journeyTime",
        slot_time AS "slotTime",
        passengers,
        mobile_number AS "mobileNumber",
        email,
        payment_method AS "paymentMethod",
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt";
    `;

    const values = [
      userId,
      parsedAccountId,
      cleanTicketName,
      cleanFrom,
      cleanTo,
      cleanJourneyDate,
      quota,
      selectedClass,
      trainNumber,
      trainName,
      boardingPoint,
      journeyTime,
      slotTime,
      JSON.stringify(validatedPassengers),
      cleanMobile,
      cleanEmail,
      paymentMethod,
    ];

    const { rows } = await pool.query(insertQuery, values);
    return rows[0];
  }

  /**
   * Update an existing ticket configuration.
   * Strictly verifies ticket ownership (user_id = userId) and account ownership.
   */
  async updateTicket(userId, ticketId, ticketData, customPool = null) {
    if (!userId) {
      const err = new Error('Authentication required.');
      err.status = 401;
      throw err;
    }

    const parsedTicketId = parseInt(ticketId, 10);
    if (isNaN(parsedTicketId) || parsedTicketId <= 0) {
      const err = new Error('Valid Ticket ID is required.');
      err.status = 400;
      throw err;
    }

    const pool = customPool || getPool();

    // 1. Verify Ticket Exists and belongs to authenticated user
    const existingTicketCheck = await pool.query(
      'SELECT id, user_id FROM tickets WHERE id = $1 AND user_id = $2;',
      [parsedTicketId, userId]
    );

    if (existingTicketCheck.rows.length === 0) {
      const err = new Error('Ticket not found or does not belong to you.');
      err.status = 404;
      throw err;
    }

    const {
      irctcAccountId,
      ticketName,
      fromStation,
      toStation,
      journeyDate,
      quota = 'General',
      selectedClass = '',
      trainNumber = '',
      trainName = '',
      boardingPoint = '',
      journeyTime = '',
      slotTime = '',
      passengers = [],
      mobileNumber = '',
      email = '',
      paymentMethod = 'Default Payment (Auto)',
    } = ticketData || {};

    // 2. Validate Ticket Name
    const cleanTicketName = typeof ticketName === 'string' ? ticketName.trim() : '';
    if (!cleanTicketName) {
      const err = new Error('Ticket Name is required.');
      err.status = 400;
      throw err;
    }

    // 3. Validate IRCTC account ID format & ownership
    const parsedAccountId = parseInt(irctcAccountId, 10);
    if (isNaN(parsedAccountId) || parsedAccountId <= 0) {
      const err = new Error('Valid IRCTC Account selection is required.');
      err.status = 400;
      throw err;
    }

    const accountCheck = await pool.query(
      'SELECT id, username FROM target_accounts WHERE id = $1 AND user_id = $2;',
      [parsedAccountId, userId]
    );

    if (accountCheck.rows.length === 0) {
      const err = new Error('Selected IRCTC account not found or does not belong to you.');
      err.status = 403;
      throw err;
    }

    // 4. Validate Journey Details
    const cleanFrom = typeof fromStation === 'string' ? fromStation.trim().toUpperCase() : '';
    const cleanTo = typeof toStation === 'string' ? toStation.trim().toUpperCase() : '';

    if (!cleanFrom) {
      const err = new Error('From Station is required.');
      err.status = 400;
      throw err;
    }
    if (!cleanTo) {
      const err = new Error('To Station is required.');
      err.status = 400;
      throw err;
    }
    if (cleanFrom === cleanTo) {
      const err = new Error('From Station and To Station cannot be the same.');
      err.status = 400;
      throw err;
    }

    let cleanJourneyDate;
    try {
      cleanJourneyDate = normalizeJourneyDate(journeyDate);
    } catch (dateErr) {
      const err = new Error(dateErr.message || 'Valid Journey Date (YYYY-MM-DD) is required.');
      err.status = 400;
      throw err;
    }

    // 5. Validate Passenger Details (Quota-aware)
    const cleanQuota = String(quota || 'General').trim();
    const isTatkal = /^(tatkal|premium\s*tatkal|tq|pt)$/i.test(cleanQuota);
    const maxAllowedPassengers = isTatkal ? 4 : 6;

    if (!Array.isArray(passengers) || passengers.length === 0) {
      const err = new Error('At least one passenger is required.');
      err.status = 400;
      throw err;
    }
    if (passengers.length > maxAllowedPassengers) {
      const message = isTatkal
        ? `Maximum of 4 passengers allowed for ${/premium|pt/i.test(cleanQuota) ? 'Premium Tatkal' : 'Tatkal'} quota.`
        : 'Maximum of 6 passengers allowed per ticket.';
      const err = new Error(message);
      err.status = 400;
      throw err;
    }

    const validatedPassengers = passengers.map((p, idx) => {
      const pName = typeof p.name === 'string' ? p.name.trim() : '';
      if (!pName) {
        const err = new Error(`Passenger ${idx + 1} name is required.`);
        err.status = 400;
        throw err;
      }
      if (!/^[A-Za-z\s]+$/.test(pName)) {
        const err = new Error(`Passenger ${idx + 1} name must contain only letters and spaces.`);
        err.status = 400;
        throw err;
      }

      const rawAge = String(p.age != null ? p.age : '').trim();
      if (!/^\d{1,3}$/.test(rawAge)) {
        const err = new Error(`Passenger ${idx + 1} age must be a valid number between 1 and 125.`);
        err.status = 400;
        throw err;
      }
      const pAge = parseInt(rawAge, 10);
      if (isNaN(pAge) || pAge < 1 || pAge > 125) {
        const err = new Error(`Passenger ${idx + 1} age must be between 1 and 125.`);
        err.status = 400;
        throw err;
      }

      return {
        name: pName,
        age: pAge,
        sex: typeof p.sex === 'string' && p.sex.trim() ? p.sex.trim() : 'Male',
        berthPreference: p.berthPreference || 'No Preference',
        food: p.food || 'No Preference',
        idCardType: p.idCardType || '',
        idNumber: p.idNumber || '',
        child: Boolean(p.child),
      };
    });

    // 6. Validate Contact
    const cleanMobile = typeof mobileNumber === 'string' ? mobileNumber.trim() : '';
    if (!cleanMobile || !/^\+?[0-9]{10,15}$/.test(cleanMobile.replace(/[\s-]/g, ''))) {
      const err = new Error('Valid 10-digit mobile number is required.');
      err.status = 400;
      throw err;
    }

    const cleanEmail = typeof email === 'string' ? email.trim() : '';

    // 7. Update ticket in database
    const updateQuery = `
      UPDATE tickets SET
        irctc_account_id = $1,
        ticket_name = $2,
        from_station = $3,
        to_station = $4,
        journey_date = $5,
        quota = $6,
        selected_class = $7,
        train_number = $8,
        train_name = $9,
        boarding_point = $10,
        journey_time = $11,
        slot_time = $12,
        passengers = $13,
        mobile_number = $14,
        email = $15,
        payment_method = $16,
        updated_at = NOW()
      WHERE id = $17 AND user_id = $18
      RETURNING
        id,
        user_id AS "userId",
        irctc_account_id AS "irctcAccountId",
        ticket_name AS "ticketName",
        from_station AS "fromStation",
        to_station AS "toStation",
        to_char(journey_date, 'YYYY-MM-DD') AS "journeyDate",
        quota,
        selected_class AS "selectedClass",
        train_number AS "trainNumber",
        train_name AS "trainName",
        boarding_point AS "boardingPoint",
        journey_time AS "journeyTime",
        slot_time AS "slotTime",
        passengers,
        mobile_number AS "mobileNumber",
        email,
        payment_method AS "paymentMethod",
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt";
    `;

    const updateValues = [
      parsedAccountId,
      cleanTicketName,
      cleanFrom,
      cleanTo,
      cleanJourneyDate,
      quota,
      selectedClass,
      trainNumber,
      trainName,
      boardingPoint,
      journeyTime,
      slotTime,
      JSON.stringify(validatedPassengers),
      cleanMobile,
      cleanEmail,
      paymentMethod,
      parsedTicketId,
      userId,
    ];

    const { rows } = await pool.query(updateQuery, updateValues);
    return rows[0];
  }

  /**
   * List all saved tickets for the authenticated user.
   */
  async listTickets(userId, customPool = null) {
    const pool = customPool || getPool();
    const query = `
      SELECT
        t.id,
        t.user_id AS "userId",
        t.irctc_account_id AS "irctcAccountId",
        a.username AS "irctcUserId",
        t.ticket_name AS "ticketName",
        t.from_station AS "fromStation",
        t.to_station AS "toStation",
        to_char(t.journey_date, 'YYYY-MM-DD') AS "journeyDate",
        t.quota,
        t.selected_class AS "selectedClass",
        t.train_number AS "trainNumber",
        t.train_name AS "trainName",
        t.boarding_point AS "boardingPoint",
        t.journey_time AS "journeyTime",
        t.slot_time AS "slotTime",
        t.passengers,
        t.mobile_number AS "mobileNumber",
        t.email,
        t.payment_method AS "paymentMethod",
        t.status,
        t.created_at AS "createdAt",
        t.updated_at AS "updatedAt"
      FROM tickets t
      LEFT JOIN target_accounts a ON t.irctc_account_id = a.id
      WHERE t.user_id = $1
      ORDER BY t.id DESC;
    `;
    const { rows } = await pool.query(query, [userId]);
    return rows;
  }

  /**
   * Get single ticket by ID.
   */
  async getTicketById(userId, ticketId, customPool = null) {
    const pool = customPool || getPool();
    const query = `
      SELECT
        t.id,
        t.user_id AS "userId",
        t.irctc_account_id AS "irctcAccountId",
        a.username AS "irctcUserId",
        t.ticket_name AS "ticketName",
        t.from_station AS "fromStation",
        t.to_station AS "toStation",
        to_char(t.journey_date, 'YYYY-MM-DD') AS "journeyDate",
        t.quota,
        t.selected_class AS "selectedClass",
        t.train_number AS "trainNumber",
        t.train_name AS "trainName",
        t.boarding_point AS "boardingPoint",
        t.journey_time AS "journeyTime",
        t.slot_time AS "slotTime",
        t.passengers,
        t.mobile_number AS "mobileNumber",
        t.email,
        t.payment_method AS "paymentMethod",
        t.status,
        t.created_at AS "createdAt",
        t.updated_at AS "updatedAt"
      FROM tickets t
      LEFT JOIN target_accounts a ON t.irctc_account_id = a.id
      WHERE t.id = $1 AND t.user_id = $2;
    `;
    const { rows } = await pool.query(query, [ticketId, userId]);
    return rows[0] || null;
  }

  /**
   * Delete a saved ticket.
   */
  async deleteTicket(userId, ticketId, customPool = null) {
    const pool = customPool || getPool();
    const { rows } = await pool.query(
      'DELETE FROM tickets WHERE id = $1 AND user_id = $2 RETURNING id;',
      [ticketId, userId]
    );
    return rows.length > 0;
  }

  /**
   * Delete all saved tickets for the authenticated user.
   */
  async deleteAllTickets(userId, customPool = null) {
    if (!userId) {
      const err = new Error('Authentication required.');
      err.status = 401;
      throw err;
    }
    const pool = customPool || getPool();
    const result = await pool.query(
      'DELETE FROM tickets WHERE user_id = $1;',
      [userId]
    );
    return result.rowCount || 0;
  }
}

module.exports = new TicketService();

