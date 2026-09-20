'use strict';

// Thin self-account controllers (shared by ADMIN /me and SELLER /me routes).
// Identity always comes from req.user.id (set by the authenticate middleware).

const accountService = require('../services/accountService');

async function getMe(req, res, next) {
  try {
    res.status(200).json(await accountService.getOwnAccount(req.user.id));
  } catch (error) {
    next(error);
  }
}

async function updateMe(req, res, next) {
  try {
    res.status(200).json(await accountService.updateOwnAccount(req.user.id, req.body));
  } catch (error) {
    next(error);
  }
}

async function changeMyPassword(req, res, next) {
  try {
    res.status(200).json(await accountService.changeOwnPassword(req.user.id, req.body));
  } catch (error) {
    next(error);
  }
}

module.exports = { getMe, updateMe, changeMyPassword };
