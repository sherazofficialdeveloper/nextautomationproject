'use strict';

const express = require('express');
const router = express.Router();
const controller = require('../controllers/licenseController');
const { authenticate, authorize } = require('../middleware/authMiddleware');

// Admin-only license management. Server-side RBAC; frontend route protection
// is never relied upon.
router.use(authenticate, authorize(['ADMIN']));

router.get('/', controller.adminListLicenses);
router.post('/', controller.adminCreateLicense);
router.get('/:id', controller.adminGetLicense);
router.post('/:id/extend', controller.adminExtendLicense);
router.post('/:id/renew', controller.adminRenewLicense);
router.post('/:id/revoke', controller.adminRevokeLicense);
router.post('/:id/suspend', controller.adminSuspendLicense);

module.exports = router;