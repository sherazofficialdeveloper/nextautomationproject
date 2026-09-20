'use strict';

const express = require('express');
const router = express.Router();
const controller = require('../controllers/sellerManagementController');
const { authenticate, authorize } = require('../middleware/authMiddleware');

// ADMIN-only Seller account management.
router.use(authenticate, authorize(['ADMIN']));

router.get('/', controller.listSellers);
router.post('/', controller.createSeller);
router.get('/:id', controller.getSeller);
router.put('/:id', controller.updateSeller);
router.patch('/:id/status', controller.updateSellerStatus);

module.exports = router;
