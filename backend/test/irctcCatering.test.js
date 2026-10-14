'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ticketService = require('../src/services/ticketService');
const irctcAutomationService = require('../src/automation/irctc/irctcAutomationService');

const newTicketPageSource = fs.readFileSync(
  path.join(__dirname, '../../desktop-app/src/pages/NewTicketPage.jsx'),
  'utf8'
);

function ticketData(food) {
  return {
    irctcAccountId: 1,
    ticketName: 'Catering test',
    fromStation: 'NDLS',
    toStation: 'HWH',
    journeyDate: '2026-09-22',
    passengers: [{ name: 'Test Passenger', age: 30, food }],
    mobileNumber: '9876543210',
  };
}

test('catering defaults and explicit food values remain stable through save persistence', async () => {
  assert.match(newTicketPageSource, /food:\s*'Non-Veg'/);
  assert.match(newTicketPageSource, /<option value="Non-Veg">Non-Veg<\/option>/);
  assert.match(newTicketPageSource, /<option value="Non">Non<\/option>/);

  for (const food of [undefined, 'Veg', 'Non', 'Non-Veg']) {
    let insertedPassengers = null;
    const pool = {
      query: async (sql, values) => {
        if (sql.includes('SELECT id, username FROM target_accounts')) {
          return { rows: [{ id: 1, username: 'test-account' }] };
        }
        if (sql.includes('INSERT INTO tickets')) {
          insertedPassengers = JSON.parse(values[13]);
          return { rows: [{ passengers: insertedPassengers }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    await ticketService.saveTicket(1, ticketData(food), pool);
    assert.equal(insertedPassengers[0].food, food || 'Non-Veg');
  }
});

test('automation resolves the saved passenger food value', () => {
  for (const [saved, expected] of [
    ['Veg', 'VEGETARIAN'],
    ['Non', 'NON'],
    ['Non-Veg', 'NON-VEGETARIAN'],
  ]) {
    assert.equal(
      irctcAutomationService._resolveConfiguredFoodChoice({ passengers: [{ food: saved }] }),
      expected
    );
  }
});

test('multi-passenger catering uses each passenger food value independently', () => {
  const serviceSource = fs.readFileSync(
    path.join(__dirname, '../src/automation/irctc/irctcAutomationService.js'),
    'utf8'
  );
  assert.match(serviceSource, /const configuredFood = p\.food/);
  assert.match(serviceSource, /await this\._selectCateringChoice\(cateringField, configuredFood, \{/);
  assert.doesNotMatch(serviceSource, /await this\._selectCateringChoice\(page, configuredFood\)/);
});

test('automation selects and verifies the matching native IRCTC catering option', async () => {
  const options = [
    { label: 'Veg', value: 'V' },
    { label: 'Non Veg', value: 'NV' },
    { label: 'Jain Meal', value: 'JM' },
    { label: 'Veg (Diabetic)', value: 'VD' },
    { label: 'Non Veg (Diabetic)', value: 'NVD' },
  ];
  let selected = null;
  const field = {
    isVisible: async () => true,
    locator: () => ({
      evaluateAll: async () => options.map((option) => ({
        ...option,
        selected: option.value === selected,
      })),
    }),
    evaluate: async (callback) => callback({
      tagName: selected === null ? 'SELECT' : 'SELECT',
      options: options.map((option) => ({ ...option, selected: option.value === selected })),
      selectedIndex: options.findIndex((option) => option.value === selected),
      checkValidity: () => selected !== null,
      getAttribute: () => null,
      dispatchEvent: () => {},
    }),
    selectOption: async ({ value }) => {
      selected = value;
    },
  };
  await irctcAutomationService._selectCateringChoice(field, 'Non-Veg', {
    passengerIndex: 1,
    expectedControlId: 'FOOD_1',
  });
  assert.equal(selected, 'NV');
});

test('automation rejects a catering control from another passenger container', async () => {
  const foreignField = {
    isVisible: async () => true,
    locator: () => ({ evaluateAll: async () => [] }),
    evaluate: async (callback) => callback({
      tagName: 'SELECT',
      id: 'FOOD_0',
      options: [],
      selectedIndex: -1,
      checkValidity: () => true,
      getAttribute: (name) => (name === 'id' ? 'FOOD_0' : ''),
    }),
  };

  await assert.rejects(
    () => irctcAutomationService._selectCateringChoice(foreignField, 'Non-Veg', {
      passengerIndex: 1,
      expectedControlId: 'FOOD_1',
    }),
    /PASSENGER_CATERING_SCOPE_MISMATCH: passengerIndex=1; expectedControlId=FOOD_1; actualControlId=FOOD_0/
  );
});