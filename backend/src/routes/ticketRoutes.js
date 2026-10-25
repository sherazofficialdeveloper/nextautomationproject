'use strict';

const express = require('express');
const { authenticate, optionalAuthenticate } = require('../middleware/authMiddleware');
const ticketController = require('../controllers/ticketController');

const router = express.Router();

// Enforce authentication on all ticket routes
router.use(authenticate);

// IRCTC train schedule search route
router.post('/search', ticketController.searchTrains);

// Browser availability
router.get('/browsers/availability', ticketController.getBrowserAvailability);

// CRUD routes for tickets
router.get('/', ticketController.list);
router.post('/', ticketController.save);
router.put('/:id', ticketController.update);
router.delete('/', ticketController.removeAll);
router.get('/:id', ticketController.getById);
router.delete('/:id', ticketController.remove);
router.post('/:id/launch-browser', ticketController.launchBrowser);
router.post('/:id/prepare-browser', ticketController.prepareBrowser);
router.post('/:id/start-booking', ticketController.startBooking);
router.post('/:id/stop-booking', ticketController.stopBooking);
router.get('/:id/booking-status', ticketController.getBookingStatus);
router.get('/:id/availability', ticketController.getAvailability);
router.post('/check-availability', ticketController.checkAvailabilityDirect);

module.exports = router;


