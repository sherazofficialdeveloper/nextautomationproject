'use strict';

// Admin-side Seller account management.
//
// - Only ADMIN can reach these functions (routes enforce RBAC).
// - The created/updated account is ALWAYS role SELLER. A client can never
//   submit a role: it is not part of any allowlist.
// - Passwords: the approved Admin UI has no password field, so when no
//   password is supplied the backend generates a strong one-time initial
//   password (CSPRNG) and returns it ONCE in the creation response. An
//   optional password may be supplied by an admin client; it is validated
//   and hashed either way. Hashes are never returned.
// - Duplicate identifiers (case-insensitive email, generated username) are
//   prevented in the application and by DB constraints.

const authService = require('./authService');
const rules = require('./accountRules');
const repo = require('../repositories/accountRepository');
const { badRequest, notFound, conflict, internal } = require('../utils/httpError');
const { generateInitialPassword } = require('../utils/passwordUtils');

const MAX_USERNAME_CANDIDATES = 20;
const SELLER_ROLE = 'SELLER';
const CREATE_FIELDS = ['username', 'name', 'email', 'contact', 'password'];
const UPDATE_FIELDS = ['name', 'email', 'contact'];

function requireValidName(name) {
  const error = rules.validateName(name);
  if (error) throw badRequest(error);
  return String(name).trim();
}

function requireValidEmail(email) {
  const normalized = rules.normalizeEmail(email);
  if (!normalized) throw badRequest('Enter a valid email address.');
  return normalized;
}

function optionalContact(contact) {
  if (contact === undefined || contact === null || contact === '') return null;
  const error = rules.validateContact(contact);
  if (error) throw badRequest(error);
  return String(contact).trim();
}

// Returns { password, generated } — validates an optional client password.
function resolvePassword(password) {
  if (password === undefined || password === null || password === '') {
    return { password: generateInitialPassword(), generated: true };
  }
  const error = rules.validatePassword(password);
  if (error) throw badRequest(error);
  return { password, generated: false };
}

async function assertEmailAvailable(email, excludeId) {
  const owner = await repo.findEmailOwner(email, excludeId);
  if (owner) throw conflict('Email is already in use.');
}

async function createSeller(body, creatorId) {
  const data = rules.pickAllowed(rules.requireObject(body), CREATE_FIELDS);

  let username = null;
  let name = null;
  let email = null;
  const contact = optionalContact(data.contact);
  const { password, generated } = resolvePassword(data.password);

  if (data.username !== undefined && data.username !== null && String(data.username).trim() !== '') {
    const rawUsername = String(data.username).trim();
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(rawUsername)) {
      throw badRequest('Username must be 3-30 alphanumeric characters or underscores.');
    }
    const exists = await repo.usernameExists(rawUsername);
    if (exists) {
      throw conflict('Username is already in use.');
    }
    username = rawUsername;
    name = data.name ? requireValidName(data.name) : username;
    if (data.email) {
      email = requireValidEmail(data.email);
      await assertEmailAvailable(email, undefined);
    }
  } else {
    name = requireValidName(data.name);
    email = requireValidEmail(data.email);
    await assertEmailAvailable(email, undefined);
  }

  const roleId = await repo.findRoleIdByName(SELLER_ROLE);
  if (!roleId) throw internal('SELLER role is missing from the database.');

  const passwordHash = await authService.hashPassword(password);

  if (!username) {
    const base = rules.usernameCandidateFromEmail(email);
    const candidates = rules.usernameCandidates(base, MAX_USERNAME_CANDIDATES);

    let inserted = null;
    for (const candidate of candidates) {
      const taken = await repo.usernameExists(candidate);
      if (taken) continue;
      try {
        inserted = await repo.insertUser({
          username: candidate,
          email,
          passwordHash,
          roleId,
          status: 'active',
          name,
          contact,
          createdById: creatorId || null,
        });
        break;
      } catch (error) {
        if (error && error.uniqueViolation) {
          const emailOwner = await repo.findEmailOwner(email, undefined);
          if (emailOwner) throw conflict('Email is already in use.');
          continue;
        }
        throw error;
      }
    }

    if (!inserted) throw conflict('Could not allocate a unique username. Please retry.');

    const created = await repo.findSellerById(inserted.id);
    if (!created) throw internal('Seller creation failed.');

    const result = { account: rules.serializeSeller(created) };
    if (generated) result.initialPassword = password;
    return result;
  }

  const inserted = await repo.insertUser({
    username,
    email,
    passwordHash,
    roleId,
    status: 'active',
    name,
    contact,
    createdById: creatorId || null,
  });

  const created = await repo.findSellerById(inserted.id);
  if (!created) throw internal('Seller creation failed.');

  const result = { account: rules.serializeSeller(created) };
  if (generated) result.initialPassword = password;
  return result;
}

async function listSellers(query) {
  const pageRes = resolvePage(query.page, 1, 1000000);
  const sizeRes = resolvePage(query.pageSize, 20, 100);
  if (!pageRes.ok) throw badRequest(pageRes.error);
  if (!sizeRes.ok) throw badRequest(sizeRes.error);

  const filters = { page: pageRes.value, pageSize: sizeRes.value, search: '', status: null };

  if (typeof query.search === 'string' && query.search !== '') {
    if (query.search.length > 100) throw badRequest('Search value is too long.');
    filters.search = query.search;
  }
  if (typeof query.status === 'string' && query.status !== '') {
    if (!rules.isValidStatus(query.status)) throw badRequest('Invalid status filter.');
    filters.status = query.status;
  }

  const result = await repo.listSellers(filters);
  return {
    items: result.items.map((row) => rules.serializeSeller(row)),
    total: result.total,
    totalPages: Math.max(1, Math.ceil(result.total / filters.pageSize)),
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

function resolvePage(raw, fallback, max) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: fallback };
  const { parsePositiveInt } = require('../utils/validation');
  const n = parsePositiveInt(raw);
  if (n === null || n > max) return { ok: false, error: 'Invalid pagination value.' };
  return { ok: true, value: n };
}

async function getSeller(id) {
  const sellerId = requireId(id);
  const row = await repo.findSellerById(sellerId);
  if (!row) throw notFound('Seller not found.');
  return rules.serializeSeller(row);
}

// body allowlist: { name, email, contact } — role/status/ownership are never
// editable here. Email is normalized and checked for duplicates (excluding self).
async function updateSeller(id, body) {
  const sellerId = requireId(id);
  const data = rules.pickAllowed(rules.requireObject(body), UPDATE_FIELDS);
  if (data.name === undefined && data.email === undefined && data.contact === undefined) {
    throw badRequest('Nothing to update.');
  }

  const fields = {};
  if (data.name !== undefined) fields.name = requireValidName(data.name);
  if (data.email !== undefined) fields.email = requireValidEmail(data.email);
  if (data.contact !== undefined) fields.contact = optionalContact(data.contact);

  const target = await repo.findSellerById(sellerId);
  if (!target) throw notFound('Seller not found.');

  if (fields.email !== undefined) {
    await assertEmailAvailable(fields.email, sellerId);
  }

  const updated = await repo.updateSellerById(sellerId, fields);
  if (!updated) throw notFound('Seller not found.');

  const row = await repo.findSellerById(sellerId);
  if (!row) throw notFound('Seller not found.');
  return rules.serializeSeller(row);
}

// body allowlist: { status } with exactly active | inactive | blocked.
async function updateSellerStatus(id, body) {
  const sellerId = requireId(id);
  const data = rules.pickAllowed(rules.requireObject(body), ['status']);
  if (typeof data.status !== 'string' || !rules.isValidStatus(data.status)) {
    throw badRequest('Invalid status. Allowed values: active, inactive, blocked.');
  }

  const target = await repo.findSellerById(sellerId);
  if (!target) throw notFound('Seller not found.');

  const updated = await repo.updateStatusById(sellerId, data.status);
  if (!updated) throw notFound('Seller not found.');

  const row = await repo.findSellerById(sellerId);
  if (!row) throw notFound('Seller not found.');
  return rules.serializeSeller(row);
}

function requireId(value) {
  const { parsePositiveInt } = require('../utils/validation');
  const n = parsePositiveInt(value);
  if (n === null) throw badRequest('Seller id must be a valid positive integer.');
  return n;
}

module.exports = {
  createSeller,
  listSellers,
  getSeller,
  updateSeller,
  updateSellerStatus,
};
