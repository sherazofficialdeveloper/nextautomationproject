'use strict';

// Self-account service for BOTH roles (ADMIN and SELLER).
//
// - Identity ALWAYS comes from the authenticated token (req.user.id).
//   A client-supplied id/sellerId is never used to select the account.
// - Editable fields are an explicit allowlist ({ name }). Role, status,
//   email, and ownership are never editable through self-service.
// - Password change verifies the current password and stores only a
//   bcrypt hash. Passwords are never logged and hashes never returned.

const authService = require('./authService');
const rules = require('./accountRules');
const repo = require('../repositories/accountRepository');
const { badRequest, unauthorized } = require('../utils/httpError');

async function getOwnAccount(userId) {
  const row = await repo.findById(userId);
  if (!row) {
    // The token referenced an account that no longer exists.
    throw unauthorized('Account not found.');
  }
  return rules.serializeAccount(row);
}

// body allowlist: { name }
async function updateOwnAccount(userId, body) {
  const data = rules.pickAllowed(rules.requireObject(body), ['name']);
  if (data.name === undefined) throw badRequest('name is required.');
  const nameError = rules.validateName(data.name);
  if (nameError) throw badRequest(nameError);

  const updated = await repo.updateProfileById(userId, data.name.trim());
  if (!updated) throw unauthorized('Account not found.');
  return getOwnAccount(userId);
}

// body allowlist: { currentPassword, newPassword }
async function changeOwnPassword(userId, body) {
  const data = rules.pickAllowed(rules.requireObject(body), ['currentPassword', 'newPassword']);
  if (typeof data.currentPassword !== 'string' || data.currentPassword.length === 0) {
    throw badRequest('Current password is required.');
  }
  const newPasswordError = rules.validatePassword(data.newPassword);
  if (newPasswordError) throw badRequest(newPasswordError);

  const row = await repo.findByIdWithHash(userId);
  if (!row) throw unauthorized('Account not found.');

  const currentOk = await authService.comparePassword(data.currentPassword, row.password_hash);
  if (!currentOk) throw badRequest('Current password is incorrect.');

  const newHash = await authService.hashPassword(data.newPassword);
  const updated = await repo.updatePasswordById(userId, newHash);
  if (!updated) throw unauthorized('Account not found.');

  return { message: 'Password updated.' };
}

module.exports = {
  getOwnAccount,
  updateOwnAccount,
  changeOwnPassword,
};
