'use strict';

const express = require('express');
const router = express.Router();
const controller = require('../controllers/licenseController');
const { authenticate, authorize } = require('../middleware/authMiddleware');

// Seller license routes.
// The Seller identity ALWAYS comes from the authenticated session; a
// client-supplied sellerId is never read. Only ADMIN actions exist for
// extend / renew / revoke / suspend — Sellers have no such endpoints.
router.use(authenticate, authorize(['SELLER']));

router.get('/', controller.sellerListLicenses);
router.post('/', controller.sellerCreateLicense);
router.get('/:id', controller.sellerGetLicense);

module.exports = router;