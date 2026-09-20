'use strict';

const express = require('express');
const router = express.Router();
const controller = require('../controllers/superAdminController');
const { authenticate, authorize } = require('../middleware/authMiddleware');

router.use(authenticate, authorize(['SUPER_ADMIN']));

router.get('/dashboard', controller.getDashboard);
router.get('/admins', controller.listAdmins);
router.post('/admins', controller.createAdmin);
router.patch('/admins/:id/status', controller.updateAdminStatus);
router.delete('/admins/:id', controller.deleteAdmin);
router.get('/sellers', controller.listSellers);
router.get('/keys', controller.listKeys);

module.exports = router;

