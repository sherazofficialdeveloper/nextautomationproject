'use strict';

// Admin seller-management service tests with an in-memory fake repository
// (require.cache seeding). Real bcrypt hashing is exercised.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const authService = require('../src/services/authService');

const state = {
  nextId: 100,
  users: new Map(),
  insertedRoleIds: [],
};

function seed() {
  state.users.clear();
  state.nextId = 100;
  state.insertedRoleIds = [];
  state.users.set(1, {
    id: 1, username: 'admin', email: 'admin@example.com', name: 'Platform Admin',
    contact: null, status: 'active', role_name: 'ADMIN',
    created_at: new Date('2026-01-01T00:00:00Z'), updated_at: new Date('2026-01-01T00:00:00Z'),
    password_hash: 'x',
  });
  state.users.set(2, {
    id: 2, username: 'seller_one', email: 'seller1@example.com', name: 'Seller One',
    contact: null, status: 'active', role_name: 'SELLER',
    created_at: new Date('2026-02-01T00:00:00Z'), updated_at: new Date('2026-02-01T00:00:00Z'),
    password_hash: 'x',
  });
}

const repoPath = require.resolve('../src/repositories/accountRepository');
require.cache[repoPath] = {
  id: repoPath,
  filename: repoPath,
  loaded: true,
  exports: {
    findById: async (id) => state.users.get(id) || null,
    findByIdWithHash: async (id) => state.users.get(id) || null,
    findSellerById: async (id) => {
      const u = state.users.get(id);
      return u && u.role_name === 'SELLER' ? u : null;
    },
    usernameExists: async (username) =>
      Array.from(state.users.values()).some((u) => u.username === username),
    findEmailOwner: async (email, excludeId) =>
      Array.from(state.users.values()).find(
        (u) => u.email.toLowerCase() === String(email).toLowerCase() && u.id !== excludeId
      ) || null,
    insertUser: async (data) => {
      state.insertedRoleIds.push(data.roleId);
      const id = state.nextId;
      state.nextId += 1;
      state.users.set(id, {
        id,
        username: data.username,
        email: data.email,
        name: data.name,
        contact: data.contact === undefined ? null : data.contact,
        status: data.status,
        role_name: data.roleId === 1 ? 'ADMIN' : 'SELLER',
        created_at: new Date(),
        updated_at: new Date(),
        password_hash: data.passwordHash,
      });
      return { id };
    },
    listSellers: async (filters) => {
      let rows = Array.from(state.users.values()).filter((u) => u.role_name === 'SELLER');
      if (filters.search) {
        const s = filters.search.toLowerCase();
        rows = rows.filter(
          (u) => u.name.toLowerCase().includes(s) || u.email.toLowerCase().includes(s)
        );
      }
      if (filters.status) rows = rows.filter((u) => u.status === filters.status);
      const total = rows.length;
      const start = (filters.page - 1) * filters.pageSize;
      return { items: rows.slice(start, start + filters.pageSize), total };
    },
    updateProfileById: async () => ({ id: 1 }),
    updatePasswordById: async () => ({ id: 1 }),
    updateSellerById: async (id, fields) => {
      const u = state.users.get(id);
      if (!u) return null;
      if (fields.name !== undefined) u.name = fields.name;
      if (fields.email !== undefined) u.email = fields.email;
      if (fields.contact !== undefined) u.contact = fields.contact === undefined ? null : fields.contact;
      return { id };
    },
    updateStatusById: async (id, status) => {
      const u = state.users.get(id);
      if (!u) return null;
      u.status = status;
      return { id };
    },
    findRoleIdByName: async (roleName) => (roleName === 'ADMIN' ? 1 : 2),
  },
};

const sellerManagementService = require('../src/services/sellerManagementService');

beforeEach(async () => {
  seed();
});

test('createSeller forces role SELLER and never accepts a client role', async () => {
  await assert.rejects(
    () => sellerManagementService.createSeller({ name: 'X', email: 'x@example.com', role: 'ADMIN' }),
    (e) => e.statusCode === 400 && /role/.test(e.message)
  );
  const result = await sellerManagementService.createSeller({ name: 'Acme', email: 'acme@example.com' });
  assert.equal(result.account.role, 'SELLER');
  assert.equal(state.insertedRoleIds[state.insertedRoleIds.length - 1], 2); // SELLER role id
  const created = state.users.get(result.account.id);
  assert.equal(created.role_name, 'SELLER');
});

test('createSeller generates a one-time initial password and stores only its hash', async () => {
  const result = await sellerManagementService.createSeller({ name: 'Acme', email: 'acme@example.com' });
  assert.equal(typeof result.initialPassword, 'string');
  assert.ok(result.initialPassword.length >= 8);
  const created = state.users.get(result.account.id);
  assert.notEqual(created.password_hash, result.initialPassword);
  assert.match(created.password_hash, /^\$2[aby]\$/);
  assert.equal(await authService.comparePassword(result.initialPassword, created.password_hash), true);
  assert.equal(JSON.stringify(result.account).includes('$2'), false);
  assert.equal(result.account.password_hash, undefined);
});

test('createSeller accepts an admin-provided password and returns no initialPassword', async () => {
  const result = await sellerManagementService.createSeller({
    name: 'Acme', email: 'acme@example.com', password: 'adminSetPass1',
  });
  assert.equal(result.initialPassword, undefined);
  const created = state.users.get(result.account.id);
  assert.equal(await authService.comparePassword('adminSetPass1', created.password_hash), true);
});

test('createSeller rejects weak admin-provided passwords and invalid input', async () => {
  await assert.rejects(
    () => sellerManagementService.createSeller({ name: 'X', email: 'x@example.com', password: 'short1' }),
    (e) => e.statusCode === 400 && /at least 8/.test(e.message)
  );
  await assert.rejects(
    () => sellerManagementService.createSeller({ name: '', email: 'x@example.com' }),
    (e) => e.statusCode === 400 && /Name/.test(e.message)
  );
  await assert.rejects(
    () => sellerManagementService.createSeller({ name: 'X', email: 'not-an-email' }),
    (e) => e.statusCode === 400 && /email/.test(e.message)
  );
  await assert.rejects(
    () => sellerManagementService.createSeller({ name: 'X' }),
    (e) => e.statusCode === 400
  );
});

test('createSeller prevents duplicate identifiers (case-insensitive email)', async () => {
  await assert.rejects(
    () => sellerManagementService.createSeller({ name: 'Dupe', email: 'SELLER1@EXAMPLE.com' }),
    (e) => e.statusCode === 409 && /Email/.test(e.message)
  );
  // Cannot collide with an ADMIN email either
  await assert.rejects(
    () => sellerManagementService.createSeller({ name: 'Dupe', email: 'Admin@Example.com' }),
    (e) => e.statusCode === 409 && /Email/.test(e.message)
  );
});

test('createSeller generates a unique username when the derived one is taken', async () => {
  // seller1@example.com already exists with username seller_one.
  const result = await sellerManagementService.createSeller({ name: 'Second', email: 'seller_one@example.com' });
  const created = state.users.get(result.account.id);
  assert.notEqual(created.username, 'seller_one');
  assert.match(created.username, /^seller_one(_\d+)?$/);
  assert.ok(created.username.length > 'seller_one'.length);
});

test('listSellers returns only sellers with pagination metadata', async () => {
  const page = await sellerManagementService.listSellers({ page: 1, pageSize: 1 });
  assert.equal(page.total, 1);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].role, 'SELLER');
  assert.equal(page.totalPages, 1);
  assert.equal(page.items[0].password_hash, undefined);
});

test('listSellers filters by search and status', async () => {
  await sellerManagementService.createSeller({ name: 'Beta Trader', email: 'beta@example.com' });
  const byName = await sellerManagementService.listSellers({ search: 'Beta' });
  assert.equal(byName.total, 1);
  assert.equal(byName.items[0].name, 'Beta Trader');
  const byStatus = await sellerManagementService.listSellers({ status: 'active' });
  assert.equal(byStatus.total, 2);
  const byBadStatus = sellerManagementService.listSellers({ status: 'suspended' });
  await assert.rejects(() => byBadStatus, (e) => e.statusCode === 400);
});

test('getSeller returns sellers only (an ADMIN id is 404)', async () => {
  const seller = await sellerManagementService.getSeller(2);
  assert.equal(seller.name, 'Seller One');
  await assert.rejects(() => sellerManagementService.getSeller(1), (e) => e.statusCode === 404);
  await assert.rejects(() => sellerManagementService.getSeller('abc'), (e) => e.statusCode === 400);
});

test('updateSeller edits only allowlisted fields', async () => {
  const updated = await sellerManagementService.updateSeller(2, {
    name: 'Seller One Renamed',
    contact: '+1 555 0100',
  });
  assert.equal(updated.name, 'Seller One Renamed');
  assert.equal(updated.contact, '+1 555 0100');
  assert.equal(state.users.get(2).status, 'active'); // status untouched

  await assert.rejects(
    () => sellerManagementService.updateSeller(2, { name: 'x', role: 'ADMIN' }),
    (e) => e.statusCode === 400 && /role/.test(e.message)
  );
  await assert.rejects(
    () => sellerManagementService.updateSeller(2, { name: 'x', status: 'blocked' }),
    (e) => e.statusCode === 400 && /status/.test(e.message)
  );
  await assert.rejects(
    () => sellerManagementService.updateSeller(2, { password: 'newPass123' }),
    (e) => e.statusCode === 400 && /password/.test(e.message)
  );
  await assert.rejects(
    () => sellerManagementService.updateSeller(2, {}),
    (e) => e.statusCode === 400 && /Nothing to update/.test(e.message)
  );
});

test('updateSeller prevents duplicate emails but allows keeping the current one', async () => {
  await assert.rejects(
    () => sellerManagementService.updateSeller(2, { email: 'ADMIN@Example.com' }),
    (e) => e.statusCode === 409 && /Email/.test(e.message)
  );
  const updated = await sellerManagementService.updateSeller(2, { email: 'seller1@example.com' });
  assert.equal(updated.email, 'seller1@example.com');
  const changed = await sellerManagementService.updateSeller(2, { email: 'renamed@example.com' });
  assert.equal(changed.email, 'renamed@example.com');
});

test('updateSellerStatus enforces the exact status set and seller-only targets', async () => {
  const deactivated = await sellerManagementService.updateSellerStatus(2, { status: 'inactive' });
  assert.equal(deactivated.status, 'inactive');
  const blocked = await sellerManagementService.updateSellerStatus(2, { status: 'blocked' });
  assert.equal(blocked.status, 'blocked');
  const reactivated = await sellerManagementService.updateSellerStatus(2, { status: 'active' });
  assert.equal(reactivated.status, 'active');

  await assert.rejects(
    () => sellerManagementService.updateSellerStatus(2, { status: 'suspended' }),
    (e) => e.statusCode === 400 && /Invalid status/.test(e.message)
  );
  await assert.rejects(
    () => sellerManagementService.updateSellerStatus(2, { status: 'ACTIVE' }),
    (e) => e.statusCode === 400
  );
  await assert.rejects(
    () => sellerManagementService.updateSellerStatus(2, {}),
    (e) => e.statusCode === 400
  );
  // An ADMIN account is not a valid target
  await assert.rejects(
    () => sellerManagementService.updateSellerStatus(1, { status: 'blocked' }),
    (e) => e.statusCode === 404
  );
  assert.equal(state.users.get(1).status, 'active');
});
