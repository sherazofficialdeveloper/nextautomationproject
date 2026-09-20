'use strict';

const express = require('express');
const { authenticate } = require('../middleware/authMiddleware');
const targetAccountController = require('../controllers/targetAccountController');

const router = express.Router();

// Enforce authentication on all target account routes
// Enforce authentication on all IRCTC account routes
router.use(authenticate);

router.get('/', targetAccountController.list);
router.post('/', targetAccountController.create);
router.patch('/:id', targetAccountController.update);
router.put('/:id', targetAccountController.update);
router.delete('/:id', targetAccountController.remove);

module.exports = router;

