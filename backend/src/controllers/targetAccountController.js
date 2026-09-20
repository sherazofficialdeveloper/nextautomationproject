'use strict';

const targetAccountService = require('../services/targetAccountService');

async function list(req, res, next) {
  try {
    const accounts = await targetAccountService.listAccounts(req.user.id);
    return res.status(200).json({
      success: true,
      data: accounts,
    });
  } catch (error) {
    next(error);
  }
}

async function create(req, res, next) {
  try {
    const body = req.body || {};
    const irctcUserId = (body.irctcUserId || body.username || '').trim();
    const password = typeof body.password === 'string' ? body.password : '';

    if (!irctcUserId) {
      return res.status(400).json({ error: 'IRCTC User ID is required.' });
    }
    if (!password) {
      return res.status(400).json({ error: 'Password is required.' });
    }

    const newAccount = await targetAccountService.createAccount(
      req.user.id,
      irctcUserId,
      password
    );

    return res.status(201).json({
      success: true,
      message: 'IRCTC account saved successfully.',
      data: newAccount,
    });
  } catch (error) {
    next(error);
  }
}

async function update(req, res, next) {
  try {
    const accountId = parseInt(req.params.id, 10);
    if (isNaN(accountId) || accountId <= 0) {
      return res.status(400).json({ error: 'Invalid account ID.' });
    }

    const body = req.body || {};
    const irctcUserId = (body.irctcUserId || body.username || '').trim();
    const password = typeof body.password === 'string' ? body.password : undefined;

    if (!irctcUserId) {
      return res.status(400).json({ error: 'IRCTC User ID is required.' });
    }

    const updated = await targetAccountService.updateAccount(
      req.user.id,
      accountId,
      irctcUserId,
      password
    );

    if (!updated) {
      return res.status(404).json({ error: 'IRCTC account not found or access denied.' });
    }

    return res.status(200).json({
      success: true,
      message: 'IRCTC account updated successfully.',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
}

async function remove(req, res, next) {
  try {
    const accountId = parseInt(req.params.id, 10);
    if (isNaN(accountId) || accountId <= 0) {
      return res.status(400).json({ error: 'Invalid account ID.' });
    }

    const deleted = await targetAccountService.deleteAccount(req.user.id, accountId);
    if (!deleted) {
      return res.status(404).json({ error: 'IRCTC account not found or access denied.' });
    }

    return res.status(200).json({
      success: true,
      message: 'IRCTC account deleted successfully.',
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  list,
  create,
  update,
  remove,
};
