'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');
const ticketService = require('../src/services/ticketService');
const irctcAutomationService = require('../src/automation/irctc/irctcAutomationService');

async function withServer(fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.on('listening', resolve);
    server.on('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

async function apiRequest(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

test('ticket routes reject unauthenticated requests with 401', async () => {
  await withServer(async (base) => {
    const listRes = await apiRequest(base, 'GET', '/api/tickets');
    assert.equal(listRes.status, 401);

    const searchRes = await apiRequest(base, 'POST', '/api/tickets/search', {
      accountId: 1,
      fromStation: 'NDLS',
      toStation: 'HWH',
      journeyDate: '2026-07-24',
    });
    assert.equal(searchRes.status, 401);

    const saveRes = await apiRequest(base, 'POST', '/api/tickets', {
      ticketName: 'Test',
    });
    assert.equal(saveRes.status, 401);
    const deleteAllRes = await apiRequest(base, 'DELETE', '/api/tickets');
    assert.equal(deleteAllRes.status, 401);

    const launchRes = await apiRequest(base, 'POST', '/api/tickets/1/launch-browser', { webId: 'web1' });
    assert.equal(launchRes.status, 401);

    const startRes = await apiRequest(base, 'POST', '/api/tickets/1/start-booking', { stopPayment: true });
    assert.equal(startRes.status, 401);

    const stopRes = await apiRequest(base, 'POST', '/api/tickets/1/stop-booking', {});
    assert.equal(stopRes.status, 401);

    const statusRes = await apiRequest(base, 'GET', '/api/tickets/1/booking-status');
    assert.equal(statusRes.status, 401);

    const updateRes = await apiRequest(base, 'PUT', '/api/tickets/1', { ticketName: 'Updated' });
    assert.equal(updateRes.status, 401);
  });
});

test('deleteAllTickets unit test', async () => {
  const mockPool = {
    query: async (query, values) => {
      assert.match(query, /DELETE FROM tickets WHERE user_id = \$1/);
      assert.deepEqual(values, [42]);
      return { rowCount: 3 };
    },
  };
  const count = await ticketService.deleteAllTickets(42, mockPool);
  assert.equal(count, 3);
});

test('updateTicket unit tests', async (t) => {
  await t.test('rejects unauthenticated caller', async () => {
    await assert.rejects(
      async () => {
        await ticketService.updateTicket(null, 1, {});
      },
      { status: 401 }
    );
  });

  await t.test('rejects non-existent or non-owned ticket with 404', async () => {
    const mockPool = {
      query: async (sql) => {
        if (sql.includes('FROM tickets WHERE id = $1 AND user_id = $2')) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    await assert.rejects(
      async () => {
        await ticketService.updateTicket(10, 999, {
          ticketName: 'Test',
          irctcAccountId: 1,
          fromStation: 'NDLS',
          toStation: 'HWH',
          journeyDate: '2026-07-24',
          passengers: [{ name: 'RAFE', age: 30, gender: 'M' }],
        }, mockPool);
      },
      { status: 404 }
    );
  });

  await t.test('updates ticket when ownership is verified', async () => {
    const mockPool = {
      query: async (sql, params) => {
        if (sql.includes('FROM tickets WHERE id = $1 AND user_id = $2')) {
          return { rows: [{ id: 1, user_id: 10, ticket_name: 'OldName' }] };
        }
        if (sql.includes('FROM target_accounts')) {
          return { rows: [{ id: 1, user_id: 10, username: 'rafe123' }] };
        }
        if (sql.includes('UPDATE tickets SET')) {
          return {
            rows: [{
              id: 1,
              user_id: 10,
              ticketName: 'UpdatedName',
              from_station: 'NDLS',
              to_station: 'HWH',
              journey_date: '2026-07-24',
              irctc_account_id: 1,
              passengers: JSON.stringify([{ name: 'RAFE', age: 30, gender: 'M' }]),
            }],
          };
        }
        return { rows: [] };
      },
    };

    const updated = await ticketService.updateTicket(10, 1, {
      ticketName: 'UpdatedName',
      irctcAccountId: 1,
      fromStation: 'NDLS',
      toStation: 'HWH',
      journeyDate: '2026-07-24',
      mobileNumber: '9876543210',
      passengers: [{ name: 'RAFE', age: 30, gender: 'M' }],
    }, mockPool);

    assert.equal(updated.ticketName, 'UpdatedName');
  });
});

test('resolveBrowserConfig browser resolution', () => {
  const { resolveBrowserConfig } = require('../src/automation/browserConfig');

  const web1 = resolveBrowserConfig('web1');
  assert.equal(web1.webId, 'web1');
  assert.equal(web1.channel, 'chrome');

  const web2 = resolveBrowserConfig('web2');
  assert.equal(web2.webId, 'web2');
  assert.equal(web2.channel, 'msedge');

  const web3 = resolveBrowserConfig('web3');
  assert.equal(web3.webId, 'web3');

  assert.throws(
    () => resolveBrowserConfig('safari'),
    /Invalid web identifier/
  );
  assert.throws(
    () => resolveBrowserConfig('invalid'),
    /Invalid web identifier/
  );
});


test('saveTicket validation rules', async (t) => {
  await t.test('rejects unauthenticated call', async () => {
    await assert.rejects(
      async () => {
        await ticketService.saveTicket(null, {});
      },
      { status: 401 }
    );
  });

  await t.test('rejects missing ticket name', async () => {
    await assert.rejects(
      async () => {
        await ticketService.saveTicket(1, {
          irctcAccountId: 1,
          ticketName: '',
        });
      },
      { status: 400, message: 'Ticket Name is required.' }
    );
  });

  await t.test('rejects missing or invalid accountId', async () => {
    await assert.rejects(
      async () => {
        await ticketService.saveTicket(1, {
          ticketName: 'Trip 1',
          irctcAccountId: 'invalid',
        });
      },
      { status: 400, message: 'Valid IRCTC Account selection is required.' }
    );
  });

  await t.test('rejects same From and To stations', async () => {
    await assert.rejects(
      async () => {
        await ticketService.saveTicket(1, {
          irctcAccountId: 1,
          ticketName: 'Test Trip',
          fromStation: 'NDLS',
          toStation: 'ndls',
          journeyDate: '2026-07-24',
          passengers: [{ name: 'John Doe', age: 30 }],
          mobileNumber: '9876543210',
        });
      },
      { status: 400, message: 'From Station and To Station cannot be the same.' }
    );
  });

  await t.test('enforces passenger count between 1 and 6', async () => {
    // 0 passengers
    await assert.rejects(
      async () => {
        await ticketService.saveTicket(1, {
          irctcAccountId: 1,
          ticketName: 'Trip 1',
          fromStation: 'NDLS',
          toStation: 'HWH',
          journeyDate: '2026-07-24',
          passengers: [],
          mobileNumber: '9876543210',
        });
      },
      { status: 400, message: 'At least one passenger is required.' }
    );

    // 7 passengers (more than 6)
    const sevenPassengers = ['Alice', 'Bob', 'Charlie', 'David', 'Emma', 'Frank', 'Grace'].map((name, i) => ({
      name,
      age: 20 + i,
    }));
    await assert.rejects(
      async () => {
        await ticketService.saveTicket(1, {
          irctcAccountId: 1,
          ticketName: 'Trip 1',
          fromStation: 'NDLS',
          toStation: 'HWH',
          journeyDate: '2026-07-24',
          passengers: sevenPassengers,
          mobileNumber: '9876543210',
        });
      },
      { status: 400, message: 'Maximum of 6 passengers allowed per ticket.' }
    );
  });

  await t.test('enforces quota-aware passenger limits (Tatkal max 4, General max 6)', async () => {
    const NAMES = ['Alice Smith', 'Bob Jones', 'Charlie Brown', 'David Miller', 'Emma Watson', 'Frank Castle', 'Grace Hopper'];
    const makePassengers = (count) =>
      Array.from({ length: count }, (_, i) => ({ name: NAMES[i % NAMES.length], age: 25 + i }));

    // Tatkal with 5 passengers must be rejected
    await assert.rejects(
      async () => {
        await ticketService.saveTicket(1, {
          irctcAccountId: 1,
          ticketName: 'Tatkal 5',
          fromStation: 'NDLS',
          toStation: 'HWH',
          journeyDate: '2026-07-24',
          quota: 'Tatkal',
          passengers: makePassengers(5),
          mobileNumber: '9876543210',
        });
      },
      { status: 400, message: 'Maximum of 4 passengers allowed for Tatkal quota.' }
    );

    // Premium Tatkal with 6 passengers must be rejected
    await assert.rejects(
      async () => {
        await ticketService.saveTicket(1, {
          irctcAccountId: 1,
          ticketName: 'PT 6',
          fromStation: 'NDLS',
          toStation: 'HWH',
          journeyDate: '2026-07-24',
          quota: 'Premium Tatkal',
          passengers: makePassengers(6),
          mobileNumber: '9876543210',
        });
      },
      { status: 400, message: 'Maximum of 4 passengers allowed for Premium Tatkal quota.' }
    );

    // Tatkal code "TQ" with 5 passengers must be rejected
    await assert.rejects(
      async () => {
        await ticketService.saveTicket(1, {
          irctcAccountId: 1,
          ticketName: 'TQ 5',
          fromStation: 'NDLS',
          toStation: 'HWH',
          journeyDate: '2026-07-24',
          quota: 'TQ',
          passengers: makePassengers(5),
          mobileNumber: '9876543210',
        });
      },
      { status: 400, message: 'Maximum of 4 passengers allowed for Tatkal quota.' }
    );

    // Tatkal with 4 passengers passes quota validation (and proceeds to account check)
    const mockPool = {
      query: async (sql) => {
        if (sql.includes('SELECT id, username FROM target_accounts')) {
          return { rows: [{ id: 1, username: 'tester' }] };
        }
        if (sql.includes('INSERT INTO tickets')) {
          return { rows: [{ id: 101, ticketName: 'Tatkal 4' }] };
        }
        return { rows: [] };
      },
    };

    const tatkalResult = await ticketService.saveTicket(
      1,
      {
        irctcAccountId: 1,
        ticketName: 'Tatkal 4',
        fromStation: 'NDLS',
        toStation: 'HWH',
        journeyDate: '2026-07-24',
        quota: 'Tatkal',
        passengers: makePassengers(4),
        mobileNumber: '9876543210',
      },
      mockPool
    );
    assert.equal(tatkalResult.id, 101);

    // General with 6 passengers passes quota validation
    const generalResult = await ticketService.saveTicket(
      1,
      {
        irctcAccountId: 1,
        ticketName: 'General 6',
        fromStation: 'NDLS',
        toStation: 'HWH',
        journeyDate: '2026-07-24',
        quota: 'General',
        passengers: makePassengers(6),
        mobileNumber: '9876543210',
      },
      mockPool
    );
    assert.equal(generalResult.id, 101);

    // Ladies with 6 passengers passes quota validation
    const ladiesResult = await ticketService.saveTicket(
      1,
      {
        irctcAccountId: 1,
        ticketName: 'Ladies 6',
        fromStation: 'NDLS',
        toStation: 'HWH',
        journeyDate: '2026-07-24',
        quota: 'Ladies',
        passengers: makePassengers(6),
        mobileNumber: '9876543210',
      },
      mockPool
    );
    assert.equal(ladiesResult.id, 101);
  });

  await t.test('rejects non-letter passenger name', async () => {
    await assert.rejects(
      async () => {
        await ticketService.saveTicket(1, {
          irctcAccountId: 1,
          ticketName: 'Invalid Name Trip',
          fromStation: 'NDLS',
          toStation: 'HWH',
          journeyDate: '2026-07-24',
          passengers: [{ name: 'John123', age: 30 }],
          mobileNumber: '9876543210',
        });
      },
      { status: 400, message: 'Passenger 1 name must contain only letters and spaces.' }
    );

    await assert.rejects(
      async () => {
        await ticketService.saveTicket(1, {
          irctcAccountId: 1,
          ticketName: 'Special Char Trip',
          fromStation: 'NDLS',
          toStation: 'HWH',
          journeyDate: '2026-07-24',
          passengers: [{ name: 'John@Doe', age: 30 }],
          mobileNumber: '9876543210',
        });
      },
      { status: 400, message: 'Passenger 1 name must contain only letters and spaces.' }
    );
  });

  await t.test('rejects non-numeric and out-of-range passenger age', async () => {
    await assert.rejects(
      async () => {
        await ticketService.saveTicket(1, {
          irctcAccountId: 1,
          ticketName: 'Non-numeric Age Trip',
          fromStation: 'NDLS',
          toStation: 'HWH',
          journeyDate: '2026-07-24',
          passengers: [{ name: 'John Doe', age: 'abc' }],
          mobileNumber: '9876543210',
        });
      },
      { status: 400, message: 'Passenger 1 age must be a valid number between 1 and 125.' }
    );

    await assert.rejects(
      async () => {
        await ticketService.saveTicket(1, {
          irctcAccountId: 1,
          ticketName: 'Zero Age Trip',
          fromStation: 'NDLS',
          toStation: 'HWH',
          journeyDate: '2026-07-24',
          passengers: [{ name: 'John Doe', age: 0 }],
          mobileNumber: '9876543210',
        });
      },
      { status: 400, message: 'Passenger 1 age must be between 1 and 125.' }
    );

    await assert.rejects(
      async () => {
        await ticketService.saveTicket(1, {
          irctcAccountId: 1,
          ticketName: 'Over-age Trip',
          fromStation: 'NDLS',
          toStation: 'HWH',
          journeyDate: '2026-07-24',
          passengers: [{ name: 'John Doe', age: 150 }],
          mobileNumber: '9876543210',
        });
      },
      { status: 400, message: 'Passenger 1 age must be between 1 and 125.' }
    );
  });

  await t.test('rejects non-owned account with custom pool mock', async () => {
    const mockPool = {
      query: async () => ({ rows: [] }),
    };

    await assert.rejects(
      async () => {
        await ticketService.saveTicket(
          1,
          {
            irctcAccountId: 999,
            ticketName: 'Valid Trip',
            fromStation: 'NDLS',
            toStation: 'HWH',
            journeyDate: '2026-07-24',
            passengers: [{ name: 'John Doe', age: 30 }],
            mobileNumber: '9876543210',
          },
          mockPool
        );
      },
      { status: 403, message: 'Selected IRCTC account not found or does not belong to you.' }
    );
  });
});

test('booking automation lifecycle and stopPayment handling', async (t) => {
  await t.test('initial booking status defaults to Ready - { Bkg Fare Limit: 0 }', () => {
    const status = irctcAutomationService.getBookingStatus(1, 99999);
    assert.equal(status.status, 'Ready - { Bkg Fare Limit: 0 }');
    assert.equal(status.stopPayment, false);
  });

  await t.test('startTicketBooking with stopPayment: true progresses to Waiting for Payment (Stopped)', async () => {
    const mockSession = {
      page: { isClosed: () => false },
      context: {},
      browserConfig: { name: 'Google Chrome' }
    };
    irctcAutomationService._activeSessions.set(88888, mockSession);
    const origRun = irctcAutomationService._runRealBookingWorkflow;
    irctcAutomationService._runRealBookingWorkflow = async (userId, id, sess, opts) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      irctcAutomationService.setBookingStatus(id, opts.stopPayment ? 'Waiting for Payment (Stopped)' : 'Waiting for Payment', {
        paymentStopped: Boolean(opts.stopPayment),
      });
    };
    try {
      const started = await irctcAutomationService.startTicketBooking(1, 88888, { stopPayment: true });
      assert.equal(started.status, 'Starting...');
      assert.equal(started.stopPayment, true);

      await new Promise((resolve) => setTimeout(resolve, 50));
      const finalStatus = irctcAutomationService.getBookingStatus(1, 88888);
      assert.equal(finalStatus.status, 'Waiting for Payment (Stopped)');
      assert.equal(finalStatus.paymentStopped, true);
    } finally {
      irctcAutomationService._runRealBookingWorkflow = origRun;
      irctcAutomationService._activeSessions.delete(88888);
    }
  });

  await t.test('startTicketBooking with stopPayment: false progresses to Waiting for Payment', async () => {
    const mockSession = {
      page: { isClosed: () => false },
      context: {},
      browserConfig: { name: 'Google Chrome' }
    };
    irctcAutomationService._activeSessions.set(77777, mockSession);
    const origRun = irctcAutomationService._runRealBookingWorkflow;
    irctcAutomationService._runRealBookingWorkflow = async (userId, id, sess, opts) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      irctcAutomationService.setBookingStatus(id, opts.stopPayment ? 'Waiting for Payment (Stopped)' : 'Waiting for Payment', {
        paymentStopped: Boolean(opts.stopPayment),
      });
    };
    try {
      const started = await irctcAutomationService.startTicketBooking(1, 77777, { stopPayment: false });
      assert.equal(started.status, 'Starting...');
      assert.equal(started.stopPayment, false);

      await new Promise((resolve) => setTimeout(resolve, 50));
      const finalStatus = irctcAutomationService.getBookingStatus(1, 77777);
      assert.equal(finalStatus.status, 'Waiting for Payment');
      assert.equal(finalStatus.paymentStopped, false);
    } finally {
      irctcAutomationService._runRealBookingWorkflow = origRun;
      irctcAutomationService._activeSessions.delete(77777);
    }
  });

  await t.test('stopTicketBooking immediately halts booking', async () => {
    await irctcAutomationService.startTicketBooking(1, 66666, { stopPayment: true });
    const stopped = await irctcAutomationService.stopTicketBooking(1, 66666);
    assert.equal(stopped.status, 'Stopped');
  });

  await t.test('launchTicketBrowser rejects missing browser executable', async () => {
    await assert.rejects(
      async () => {
        await irctcAutomationService.launchTicketBrowser(1, { id: 1, ticketName: 'Trip' }, {
          browserKey: 'comet',
          name: 'Comet',
          executablePath: null,
          isAvailable: false,
        });
      },
      (err) => {
        assert.equal(err.status, 404);
        assert.match(err.message, /Comet is not installed or cannot be launched for automation/);
        return true;
      }
    );
  });
});


