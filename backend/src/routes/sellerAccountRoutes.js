'use strict';

const express = require('express');
const router = express.Router();
const controller = require('../controllers/accountController');
const { authenticate, authorize } = require('../middleware/authMiddleware');

// Authenticated SELLER's own account. Identity from the token only.
router.use(authenticate, authorize(['SELLER']));

router.get('/me', controller.getMe);
router.patch('/me', controller.updateMe);
router.patch('/me/password', controller.changeMyPassword);

module.exports = router;
