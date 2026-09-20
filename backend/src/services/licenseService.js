'use strict';

// License / Access Key management service. Authoritative business layer.
//
// Authorization model:
// - ADMIN  : system-wide license management (list, view, create, extend,
//            renew, revoke, suspend).
// - SELLER : may only create licenses and view/manage ONLY the licenses whose
//            seller_id equals the authenticated user id. A client-supplied
//            sellerId is NEVER read from query or body.
//
// Security rules applied here (never delegated to the frontend):
//   - Access keys are generated server side (crypto CSPRNG) and never logged.
//   - Expiry is computed server side; a client-supplied expiry is impossible.
//   - Status transitions are enforced by business rules + conditional SQL.
//   - Unknown body fields are rejected (allow-lists only).

const { badRequest, notFound, conflict, internal } = require('../utils/httpError');
const { parsePositiveInt, isValidDateString } = require('../utils/validation');
const dateUtils = require('../utils/dateUtils');
const { generateAccessKey } = require('../utils/accessKey');
const rules = require('./licenseRules');
const repo = require('../repositories/licenseRepository');

const MAX_KEY_GENERATION_ATTEMPTS = 5;

const ADMIN_CREATE_FIELDS = ['sellerId', 'userId', 'durationValue', 'durationUnit', 'startDate'];
const SELLER_CREATE_FIELDS = ['userId', 'durationValue', 'durationUnit', 'startDate'];
const ACTION_FIELDS = ['durationValue', 'durationUnit'];

function requireId(value, label) {
  const n = parsePositiveInt(value);
  if (n === null) throw badRequest(`${label} must be a valid positive integer.`);
  return n;
}

// Extracts and validates duration fields. Returns { value, unit }.
function requireDuration(data) {
  const { durationValue, durationUnit } = data;
  if (durationValue === undefined || durationUnit === undefined) {
    throw badRequest('durationValue and durationUnit are required.');
  }
  const error = rules.validateDuration(durationValue, durationUnit);
  if (error) throw badRequest(error);
  return { durationValue: Number(durationValue), durationUnit };
}

function resolveOptionalUserId(value) {
  if (value === undefined || value === null || value === '') return null;
  return requireId(value, 'userId');
}

function todayString() {
  return dateUtils.today();
}

// Shared license creation. `sellerId` is always determined by the caller:
// Admin must select an existing SELLER; Seller identity comes from the
// authenticated session (req.user.id). Never from untrusted input.
async function createLicense(data) {
  const userId = resolveOptionalUserId(data.userId);
  if (userId !== null) {
    const user = await repo.findUserById(userId);
    if (!user) throw badRequest('User not found.');
  }

  const duration = requireDuration(data);
  if (data.sellerRestricted && !rules.isSellerAllowedDuration(duration.durationValue, duration.durationUnit)) {
    throw badRequest('Selected duration is not permitted for Sellers.');
  }

  const startResolution = rules.resolveStartDate(data.startDate, todayString());
  if (!startResolution.ok) throw badRequest(startResolution.error);
  const startsAt = startResolution.date;
  const expiresAt = rules.calculateExpiry(startsAt, duration.durationValue, duration.durationUnit);

  const insertedId = await insertWithUniqueKey({
    status: 'ACTIVE',
    durationValue: duration.durationValue,
    durationUnit: duration.durationUnit,
    startsAt,
    expiresAt,
    sellerId: data.sellerId,
    userId,
  });

  return getAdmin(insertedId);
  return getAdmin(insertedId && typeof insertedId === 'object' ? insertedId.id : insertedId);
}

async function insertWithUniqueKey(baseData) {
  for (let attempt = 1; attempt <= MAX_KEY_GENERATION_ATTEMPTS; attempt += 1) {
    const accessKey = generateAccessKey();
    try {
      return await repo.insertLicense({ ...baseData, accessKey });
    } catch (error) {
      // Extremely unlikely access-key collision: retry with a fresh key.
      if (error && error.uniqueViolation && attempt < MAX_KEY_GENERATION_ATTEMPTS) {
        continue;
      }
      if (error && error.uniqueViolation) {
        throw internal('Could not allocate a unique access key. Please retry.');
      }
      throw error;
    }
  }
  throw internal('Could not allocate a unique access key. Please retry.');
}

// ---------------------------------------------------------------------------
// Admin capabilities
// ---------------------------------------------------------------------------

async function createAdmin(body) {
  const data = rules.pickAllowed(body, ADMIN_CREATE_FIELDS);
  const sellerId = requireId(data.sellerId, 'sellerId');
  const seller = await repo.findSellerById(sellerId);
  if (!seller) throw badRequest('Seller not found or not a SELLER account.');
  return createLicense({ ...data, sellerId, sellerRestricted: false });
}

async function listAdmin(query) {
  const today = todayString();
  const pageRes = rules.resolvePage(query.page, 1, 1000000);
  const sizeRes = rules.resolvePage(query.pageSize, 20, 100);
  if (!pageRes.ok) throw badRequest(pageRes.error);
  if (!sizeRes.ok) throw badRequest(sizeRes.error);

  const filters = {
    page: pageRes.value,
    pageSize: sizeRes.value,
    today,
    sellerId: null,
    userId: null,
    search: '',
    status: null,
    fromDate: null,
    toDate: null,
    expiringBefore: null,
  };

  if (typeof query.search === 'string' && query.search !== '') {
    if (query.search.length > 80) throw badRequest('Search value is too long.');
    filters.search = query.search;
  }
  if (typeof query.status === 'string' && query.status !== '') {
    const normalized = query.status.toUpperCase();
    if (!rules.LICENSE_STATUSES.includes(normalized)) throw badRequest('Invalid status filter.');
    filters.status = normalized;
  }
  if (typeof query.sellerId === 'string' && query.sellerId !== '') {
    filters.sellerId = requireId(query.sellerId, 'sellerId');
  }
  if (typeof query.userId === 'string' && query.userId !== '') {
    filters.userId = requireId(query.userId, 'userId');
  }
  if (typeof query.expiringBefore === 'string' && query.expiringBefore !== '') {
    if (!isValidDateString(query.expiringBefore)) throw badRequest('Invalid expiringBefore date.');
    filters.expiringBefore = query.expiringBefore;
  }

  const result = await repo.listLicenses(filters);
  return serializeList(result, filters, today);
}

async function getAdmin(id) {
  const licenseId = requireId(id, 'license id');
  const row = await repo.findById(licenseId);
  if (!row) throw notFound('License not found.');
  return rules.serializeLicense(row, todayString());
}

// ---------------------------------------------------------------------------
// Seller capabilities (strictly limited)
// ---------------------------------------------------------------------------

async function createSeller(body, sellerId) {
  // sellerId is NOT in the allow-list: a client-sent sellerId is rejected.
  const data = rules.pickAllowed(body, SELLER_CREATE_FIELDS);
  return createLicense({ ...data, sellerId, sellerRestricted: true });
}

async function listSeller(query, sellerId) {
  const today = todayString();
  const pageRes = rules.resolvePage(query.page, 1, 1000000);
  const sizeRes = rules.resolvePage(query.limit, 20, 100);
  if (!pageRes.ok) throw badRequest(pageRes.error);
  if (!sizeRes.ok) throw badRequest(sizeRes.error);

  const filters = {
    page: pageRes.value,
    pageSize: sizeRes.value,
    today,
    // Object-level isolation: identity comes from the authenticated session.
    sellerId,
    userId: null,
    search: '',
    status: null,
    fromDate: null,
    toDate: null,
    expiringBefore: null,
  };

  if (typeof query.search === 'string' && query.search !== '') {
    if (query.search.length > 80) throw badRequest('Search value is too long.');
    filters.search = query.search;
  }
  if (typeof query.status === 'string' && query.status !== '') {
    const normalized = query.status.toUpperCase();
    if (!rules.LICENSE_STATUSES.includes(normalized)) throw badRequest('Invalid status filter.');
    filters.status = normalized;
  }
  if (typeof query.from === 'string' && query.from !== '') {
    if (!isValidDateString(query.from)) throw badRequest('Invalid from date.');
    filters.fromDate = query.from;
  }
  if (typeof query.to === 'string' && query.to !== '') {
    if (!isValidDateString(query.to)) throw badRequest('Invalid to date.');
    filters.toDate = query.to;
  }
  if (filters.fromDate && filters.toDate && filters.fromDate > filters.toDate) {
    throw badRequest('from date cannot be after to date.');
  }

  const result = await repo.listLicenses(filters);
  return serializeList(result, filters, today);
}

async function getSeller(id, sellerId) {
  const licenseId = requireId(id, 'license id');
  // Object-level authorization. Returns the same 404 as "not found" on purpose
  // so the existence of another Seller's license is never leaked.
  const row = await repo.findBySellerAndId(licenseId, sellerId);
  if (!row) throw notFound('License not found.');
  return rules.serializeLicense(row, todayString());
}

function serializeList(result, filters, today) {
  return {
    items: result.items.map((row) => rules.serializeLicense(row, today)),
    total: result.total,
    totalPages: Math.max(1, Math.ceil(result.total / filters.pageSize)),
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

// ---------------------------------------------------------------------------
// Admin-only license mutations
// ---------------------------------------------------------------------------

// Reads the target, validates the state transition, then applies a conditional
// UPDATE so a concurrent status change cannot be overwritten.
async function loadForMutation(id, action) {
  const licenseId = requireId(id, 'license id');
  const row = await repo.findById(licenseId);
  if (!row) throw notFound('License not found.');
  if (!rules.isTransitionAllowed(row.status, action)) {
    throw conflict(`License cannot be ${action}ed in its current state.`);
  }
  return { licenseId, row };
}

async function assertStillMutable(licenseId, action) {
  const row = await repo.findById(licenseId);
  if (!row) throw notFound('License not found.');
  throw conflict(`License state changed; cannot ${action}.`);
}

// payload: { durationValue, durationUnit }
// Extension adds the duration to the CURRENT expiry date.
async function extend(id, body) {
  const data = rules.pickAllowed(body, ACTION_FIELDS);
  const duration = requireDuration(data);
  const { licenseId, row } = await loadForMutation(id, 'extend');
  const newExpiry = rules.calculateExpiry(row.expires_at, duration.durationValue, duration.durationUnit);
  const updated = await repo.updateExpiry(licenseId, newExpiry);
  if (!updated) return assertStillMutable(licenseId, 'extend');
  return getAdmin(licenseId);
}

// payload: { durationValue, durationUnit }
// Renewal starts a NEW licensing period from "today".
async function renew(id, body) {
  const data = rules.pickAllowed(body, ACTION_FIELDS);
  const duration = requireDuration(data);
  const { licenseId } = await loadForMutation(id, 'renew');
  const today = todayString();
  const newExpiry = rules.calculateExpiry(today, duration.durationValue, duration.durationUnit);
  const updated = await repo.updateRenewal(licenseId, today, newExpiry);
  if (!updated) return assertStillMutable(licenseId, 'renew');
  return getAdmin(licenseId);
}

async function revoke(id) {
  const { licenseId } = await loadForMutation(id, 'revoke');
  const updated = await repo.updateStatus(licenseId, 'REVOKED', ['ACTIVE', 'EXPIRED', 'SUSPENDED']);
  if (!updated) return assertStillMutable(licenseId, 'revoke');
  return getAdmin(licenseId);
}

async function suspend(id) {
  const { licenseId } = await loadForMutation(id, 'suspend');
  const updated = await repo.updateStatus(licenseId, 'SUSPENDED', ['ACTIVE', 'EXPIRED']);
  if (!updated) return assertStillMutable(licenseId, 'suspend');
  return getAdmin(licenseId);
}

module.exports = {
  createAdmin,
  createSeller,
  listAdmin,
  listSeller,
  getAdmin,
  getSeller,
  extend,
  renew,
  revoke,
  suspend,
};
