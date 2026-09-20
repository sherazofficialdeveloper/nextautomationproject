'use strict';

// Thin HTTP controllers. Business rules live in services/licenseService.
// Mirrors the existing authController try/catch + next(error) convention.

const licenseService = require('../services/licenseService');

// ---------------- ADMIN ----------------

async function adminListLicenses(req, res, next) {
  try {
    res.status(200).json(await licenseService.listAdmin(req.query));
  } catch (error) {
    next(error);
  }
}

async function adminGetLicense(req, res, next) {
  try {
    res.status(200).json(await licenseService.getAdmin(req.params.id));
  } catch (error) {
    next(error);
  }
}

async function adminCreateLicense(req, res, next) {
  try {
    res.status(201).json(await licenseService.createAdmin(req.body));
  } catch (error) {
    next(error);
  }
}

async function adminExtendLicense(req, res, next) {
  try {
    res.status(200).json(await licenseService.extend(req.params.id, req.body));
  } catch (error) {
    next(error);
  }
}

async function adminRenewLicense(req, res, next) {
  try {
    res.status(200).json(await licenseService.renew(req.params.id, req.body));
  } catch (error) {
    next(error);
  }
}

async function adminRevokeLicense(req, res, next) {
  try {
    res.status(200).json(await licenseService.revoke(req.params.id));
  } catch (error) {
    next(error);
  }
}

async function adminSuspendLicense(req, res, next) {
  try {
    res.status(200).json(await licenseService.suspend(req.params.id));
  } catch (error) {
    next(error);
  }
}

// ---------------- SELLER ----------------

async function sellerListLicenses(req, res, next) {
  try {
    res.status(200).json(await licenseService.listSeller(req.query, req.user.id));
  } catch (error) {
    next(error);
  }
}

async function sellerGetLicense(req, res, next) {
  try {
    res.status(200).json(await licenseService.getSeller(req.params.id, req.user.id));
  } catch (error) {
    next(error);
  }
}

async function sellerCreateLicense(req, res, next) {
  try {
    res.status(201).json(await licenseService.createSeller(req.body, req.user.id));
  } catch (error) {
    next(error);
  }
}

module.exports = {
  adminListLicenses,
  adminGetLicense,
  adminCreateLicense,
  adminExtendLicense,
  adminRenewLicense,
  adminRevokeLicense,
  adminSuspendLicense,
  sellerListLicenses,
  sellerGetLicense,
  sellerCreateLicense,
};