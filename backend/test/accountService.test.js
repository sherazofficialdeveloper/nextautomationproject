'use strict';

// Self-account service tests. The repository is replaced through require.cache
// with an in-memory fake, so no PostgreSQL is needed. Real bcrypt is used.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const authService = require('../src/services/authService');

const state = {
  users: new Map(),
};

function makeUser(overrides) {
  return Object.assign({
    id: 1,
    username: 'admin',
    email: 'admin@example.com',
    name: 'Platform Admin',
    contact: null,
    status: 'active',
    role_name: 'ADMIN',
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    password_hash: null,
  }, overrides);
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
      const id = Math.max(0, ...state.users.keys()) + 1;
      const user = makeUser({
        id,
        username: data.username,
        email: data.email,
        name: data.name,
        contact: data.contact === undefined ? null : data.contact,
        status: data.status,
        role_name: data.roleId === 1 ? 'ADMIN' : 'SELLER',
        password_hash: data.passwordHash,
      });
      state.users.set(id, user);
      return { id };
    },
    listSellers: async () => ({ items: [], total: 0 }),
    updateProfileById: async (id, name) => {
      const u = state.users.get(id);
      if (!u) return null;
      u.name = name;
      return { id };
    },
    updatePasswordById: async (id, passwordHash) => {
      const u = state.users.get(id);
      if (!u) return null;
      u.password_hash = passwordHash;
      return { id };
    },
    updateSellerById: async () => ({ id: 1 }),
    updateStatusById: async () => ({ id: 1 }),
    findRoleIdByName: async (roleName) => (roleName === 'ADMIN' ? 1 : 2),
  },
};

const accountService = require('../src/services/accountService');

beforeEach(async () => {
  state.users.clear();
  state.users.set(1, makeUser({}));
  state.users.get(1).password_hash = await authService.hashPassword('currentPass1');
});

test('getOwnAccount returns the safe account for the authenticated id', async () => {
  const me = await accountService.getOwnAccount(1);
  assert.equal(me.id, 1);
  assert.equal(me.name, 'Platform Admin');
  assert.equal(me.email, 'admin@example.com');
  assert.equal(me.role, 'ADMIN');
  assert.equal(me.status, 'active');
  assert.equal(me.password_hash, undefined);
  assert.equal(JSON.stringify(me).includes('$2'), false);
});

test('getOwnAccount rejects unknown ids (no client-controlled identity)', async () => {
  await assert.rejects(() => accountService.getOwnAccount(999), (e) => e.statusCode === 401);
});

test('updateOwnAccount edits only the allowlisted name', async () => {
  const updated = await accountService.updateOwnAccount(1, { name: 'Renamed Admin' });
  assert.equal(updated.name, 'Renamed Admin');
  assert.equal(state.users.get(1).name, 'Renamed Admin');
});

test('updateOwnAccount rejects privileged fields (role/status/email/id)', async () => {
  await assert.rejects(
    () => accountService.updateOwnAccount(1, { name: 'x', role: 'ADMIN' }),
    (e) => e.statusCode === 400 && /role/.test(e.message)
  );
  await assert.rejects(
    () => accountService.updateOwnAccount(1, { name: 'x', status: 'blocked' }),
    (e) => e.statusCode === 400 && /status/.test(e.message)
  );
  await assert.rejects(
    () => accountService.updateOwnAccount(1, { name: 'x', email: 'new@x.com' }),
    (e) => e.statusCode === 400 && /email/.test(e.message)
  );
  // Nothing was changed
  assert.equal(state.users.get(1).name, 'Platform Admin');
});

test('updateOwnAccount rejects invalid names', async () => {
  await assert.rejects(() => accountService.updateOwnAccount(1, {}), (e) => e.statusCode === 400);
  await assert.rejects(() => accountService.updateOwnAccount(1, { name: '' }), (e) => e.statusCode === 400);
});

test('updateOwnAccount stores SQL-injection text literally (parameterized queries)', async () => {
  const evil = "Robert'); DROP TABLE users;--";
  const updated = await accountService.updateOwnAccount(1, { name: evil });
  assert.equal(updated.name, evil);
  assert.equal(state.users.get(1).name, evil);
});

test('changeOwnPassword rejects a wrong current password and changes nothing', async () => {
  const before = state.users.get(1).password_hash;
  await assert.rejects(
    () => accountService.changeOwnPassword(1, { currentPassword: 'wrongPass9', newPassword: 'newSecurePass1' }),
    (e) => e.statusCode === 400 && /Current password/.test(e.message)
  );
  assert.equal(state.users.get(1).password_hash, before);
});

test('changeOwnPassword hashes and stores the new password, never returns it', async () => {
  const result = await accountService.changeOwnPassword(1, {
    currentPassword: 'currentPass1',
    newPassword: 'newSecurePass1',
  });
  assert.equal(result.message, 'Password updated.');
  assert.equal(JSON.stringify(result).includes('newSecurePass1'), false);
  assert.equal(JSON.stringify(result).includes('$2'), false);
  const stored = state.users.get(1).password_hash;
  assert.notEqual(stored, 'newSecurePass1');
  assert.match(stored, /^\$2[aby]\$/);
  assert.equal(await authService.comparePassword('newSecurePass1', stored), true);
  assert.equal(await authService.comparePassword('currentPass1', stored), false);
});

test('changeOwnPassword enforces the password policy', async () => {
  await assert.rejects(
    () => accountService.changeOwnPassword(1, { currentPassword: 'currentPass1', newPassword: 'short1' }),
    (e) => e.statusCode === 400 && /at least 8/.test(e.message)
  );
});

test('changeOwnPassword rejects unexpected fields', async () => {
  await assert.rejects(
    () => accountService.changeOwnPassword(1, { currentPassword: 'currentPass1', newPassword: 'newSecurePass1', role: 'ADMIN' }),
    (e) => e.statusCode === 400 && /role/.test(e.message)
  );
});
