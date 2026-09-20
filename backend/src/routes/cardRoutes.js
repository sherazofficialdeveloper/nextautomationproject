'use strict';

const express = require('express');
const { authenticate } = require('../middleware/authMiddleware');
const bankController = require('../controllers/bankController');

const router = express.Router();

// Enforce authentication on all card routes
router.use(authenticate);

router.get('/', bankController.listCards);
router.post('/', bankController.createCard);
router.delete('/', bankController.deleteAllCards);
router.put('/:id', bankController.updateCard);
router.patch('/:id', bankController.updateCard);
router.delete('/:id', bankController.deleteCard);

module.exports = router;
