'use strict';

const express = require('express');
const { authenticate } = require('../middleware/authMiddleware');
const bankController = require('../controllers/bankController');

const router = express.Router();

// Enforce authentication on all bank routes
router.use(authenticate);

router.get('/', bankController.listBanks);
router.post('/', bankController.createBank);
router.delete('/', bankController.deleteAllBanks);
router.put('/:id', bankController.updateBank);
router.patch('/:id', bankController.updateBank);
router.delete('/:id', bankController.deleteBank);

module.exports = router;
