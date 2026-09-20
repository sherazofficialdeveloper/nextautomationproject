'use strict';

// Thin Admin seller-management controllers.

const sellerManagementService = require('../services/sellerManagementService');

async function listSellers(req, res, next) {
  try {
    res.status(200).json(await sellerManagementService.listSellers(req.query));
  } catch (error) {
    next(error);
  }
}

async function createSeller(req, res, next) {
  try {
    res.status(201).json(await sellerManagementService.createSeller(req.body));
    const creatorId = req.user ? req.user.id : null;
    res.status(201).json(await sellerManagementService.createSeller(req.body, creatorId));
  } catch (error) {
    next(error);
  }
}

async function getSeller(req, res, next) {
  try {
    res.status(200).json(await sellerManagementService.getSeller(req.params.id));
  } catch (error) {
    next(error);
  }
}

async function updateSeller(req, res, next) {
  try {
    res.status(200).json(await sellerManagementService.updateSeller(req.params.id, req.body));
  } catch (error) {
    next(error);
  }
}

async function updateSellerStatus(req, res, next) {
  try {
    if (req.user && req.user.role === 'ADMIN' && req.body && req.body.status === 'blocked') {
      return res.status(403).json({ error: 'Admins cannot block sellers.' });
    }
    res.status(200).json(await sellerManagementService.updateSellerStatus(req.params.id, req.body));
  } catch (error) {
    next(error);
  }
}

module.exports = { listSellers, createSeller, getSeller, updateSeller, updateSellerStatus };
