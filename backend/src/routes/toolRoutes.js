'use strict';

const express = require('express');
const { authenticate } = require('../middleware/authMiddleware');
const toolController = require('../controllers/toolController');

const router = express.Router();

router.use(authenticate);

// Preferences
router.get('/preferences', toolController.getPreferences);
router.put('/preferences', toolController.updatePreferences);

// Booking History
router.get('/history', toolController.listBookingHistory);
router.post('/history', toolController.createBookingHistory);
router.delete('/history', toolController.clearBookingHistory);

// Proxies
router.get('/proxies', toolController.listProxies);
router.post('/proxies', toolController.createProxy);
router.delete('/proxies', toolController.deleteAllProxies);
router.delete('/proxies/:id', toolController.deleteProxy);
router.post('/proxies/:id/check', toolController.checkProxy);

// Backup & Restore
router.post('/backup', toolController.createBackup);
router.post('/restore', toolController.restoreBackup);
router.post('/delete-data', toolController.deleteUserData);
router.get('/export/:category', toolController.exportCategory);

// Cookie Delete (Clear Automation Sessions)
router.post('/clear-cookies', toolController.clearAutomationCookies);

// License Info (Software Version Check)
router.get('/license-info', toolController.getLicenseInfo);

module.exports = router;

