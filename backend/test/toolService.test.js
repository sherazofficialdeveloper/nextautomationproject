'use strict';

require('dotenv').config({ path: './.env' });
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const toolService = require('../src/services/toolService');
const { getPool } = require('../src/config/database');

describe('Tool Service Tests', () => {
  let pool;
  let testUserId1;
  let testUserId2;

  before(async () => {
    pool = getPool();
    const userRes = await pool.query(`SELECT id FROM users LIMIT 2;`);
    if (userRes.rows.length >= 2) {
      testUserId1 = userRes.rows[0].id;
      testUserId2 = userRes.rows[1].id;
    } else {
      testUserId1 = userRes.rows[0]?.id || 1;
      testUserId2 = 999999;
    }

    // Clean up test data
    await pool.query(`DELETE FROM booking_history WHERE ticket_name LIKE 'TEST_TOOL_%';`);
    await pool.query(`DELETE FROM proxies WHERE ip LIKE '192.0.2.%';`);
  });

  after(async () => {
    if (pool) {
      await pool.query(`DELETE FROM booking_history WHERE ticket_name LIKE 'TEST_TOOL_%';`);
      await pool.query(`DELETE FROM proxies WHERE ip LIKE '192.0.2.%';`);
    }
  });

  describe('User Preferences', () => {
    test('getUserPreferences returns default values', async () => {
      const prefs = await toolService.getUserPreferences(testUserId1);
      assert.ok(prefs);
      assert.equal(typeof prefs.history_retention_days, 'number');
      assert.equal(typeof prefs.proxy_pair_limit, 'number');
    });

    test('updateUserPreferences persists changes', async () => {
      const updated = await toolService.updateUserPreferences(testUserId1, {
        history_retention_days: 60,
        proxy_pair_limit: 8,
      });
      assert.equal(updated.history_retention_days, 60);
      assert.equal(updated.proxy_pair_limit, 8);

      const fetched = await toolService.getUserPreferences(testUserId1);
      assert.equal(fetched.history_retention_days, 60);
      assert.equal(fetched.proxy_pair_limit, 8);
    });
  });

  describe('Booking History', () => {
    test('createBookingHistory validates required fields', async () => {
      await assert.rejects(
        async () => {
          await toolService.createBookingHistory(testUserId1, { ticket_name: '' });
        },
        (err) => {
          assert.equal(err.status, 400);
          assert.match(err.message, /Ticket Name is required/);
          return true;
        }
      );
    });

    test('createBookingHistory persists entry and listBookingHistory returns it', async () => {
      const created = await toolService.createBookingHistory(testUserId1, {
        ticket_name: 'TEST_TOOL_TICKET_1',
        irctc_id: 'test_user_irctc',
        from_station: 'NDLS',
        to_station: 'BCT',
        journey_date: '25/08/2026',
        bank_name: 'PayTM-QR_paytm@apl',
        pnr: '1234567890',
        fare: 1540.5,
        date: '2026-08-20',
        remarks: 'Booking Success',
      });

      assert.ok(created.id);
      assert.equal(created.ticket_name, 'TEST_TOOL_TICKET_1');
      assert.equal(created.pnr, '1234567890');

      const history = await toolService.listBookingHistory(testUserId1, { retentionDays: 90 });
      const found = history.find((h) => h.ticket_name === 'TEST_TOOL_TICKET_1');
      assert.ok(found, 'Created booking history entry should be listed');
      assert.equal(found.irctc_id, 'test_user_irctc');
      assert.equal(found.from_station, 'NDLS');
    });

    test('clearBookingHistory clears user records', async () => {
      await toolService.createBookingHistory(testUserId1, {
        ticket_name: 'TEST_TOOL_TICKET_TO_CLEAR',
      });

      const res = await toolService.clearBookingHistory(testUserId1);
      assert.ok(res.deletedCount >= 1);

      const history = await toolService.listBookingHistory(testUserId1);
      assert.equal(history.length, 0);
    });
  });

  describe('Proxies', () => {
    test('createProxy validates IP and Port', async () => {
      await assert.rejects(
        async () => {
          await toolService.createProxy(testUserId1, { ip: '', port: 8080 });
        },
        (err) => {
          assert.equal(err.status, 400);
          return true;
        }
      );

      await assert.rejects(
        async () => {
          await toolService.createProxy(testUserId1, { ip: '192.0.2.1', port: 999999 });
        },
        (err) => {
          assert.equal(err.status, 400);
          return true;
        }
      );
    });

    test('createProxy and listProxies works correctly', async () => {
      const p1 = await toolService.createProxy(testUserId1, {
        ip: '192.0.2.10',
        port: 8080,
        username: 'user1',
        password: 'secretPassword',
        check_irctc: true,
      });

      assert.ok(p1.id);
      assert.equal(p1.ip, '192.0.2.10');
      assert.equal(p1.port, 8080);
      assert.equal(p1.check_irctc, true);

      const list = await toolService.listProxies(testUserId1);
      assert.ok(list.length >= 1);
      const found = list.find((x) => x.id === p1.id);
      assert.ok(found);

      // deleteProxy
      const delRes = await toolService.deleteProxy(testUserId1, p1.id);
      assert.equal(delRes.ok, true);

      const afterList = await toolService.listProxies(testUserId1);
      assert.ok(!afterList.some((x) => x.id === p1.id));
    });

    test('deleteAllProxies clears all user proxies', async () => {
      await toolService.createProxy(testUserId1, { ip: '192.0.2.11', port: 8081 });
      await toolService.createProxy(testUserId1, { ip: '192.0.2.12', port: 8082 });

      const delAll = await toolService.deleteAllProxies(testUserId1);
      assert.ok(delAll.deletedCount >= 2);

      const list = await toolService.listProxies(testUserId1);
      assert.equal(list.length, 0);
    });
  });

  describe('Cookie Delete (Automation Session Cache)', () => {
    test('clearAutomationCookies clears user sessions from cache without touching database', async () => {
      const irctcAutomationService = require('../src/automation/irctc/irctcAutomationService');
      
      // Seed test session in cache
      irctcAutomationService.setSessionState(testUserId1, 101, {
        storageState: { cookies: [{ name: 'test_cookie', value: '123' }] },
      });
      irctcAutomationService.setSessionState(testUserId1, 102, {
        storageState: { cookies: [{ name: 'test_cookie_2', value: '456' }] },
      });
      irctcAutomationService.setSessionState(99999, 101, {
        storageState: { cookies: [{ name: 'other_user_cookie', value: '999' }] },
      });

      assert.ok(irctcAutomationService.getSessionState(testUserId1, 101));
      assert.ok(irctcAutomationService.getSessionState(testUserId1, 102));

      // Execute clear
      const res = await toolService.clearAutomationCookies(testUserId1);
      assert.equal(res.cleared, true);
      assert.ok(res.sessionCount >= 2);

      // Verify user's session cache is cleared
      assert.equal(irctcAutomationService.getSessionState(testUserId1, 101), null);
      assert.equal(irctcAutomationService.getSessionState(testUserId1, 102), null);

      // Verify other user's session is untouched
      assert.ok(irctcAutomationService.getSessionState(99999, 101));

      // Cleanup
      irctcAutomationService.clearSessionState(99999, 101);
    });
  });
});

