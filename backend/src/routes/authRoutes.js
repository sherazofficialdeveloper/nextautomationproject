const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticate, authorize } = require('../middleware/authMiddleware');

// Public routes
router.post('/login', authController.login);
router.post('/logout', authController.logout); // Client-side logout if using stateless JWT

// Authenticated user routes (accessible by both ADMIN and SELLER)
router.get('/profile', authenticate, authController.getProfile);

// Admin-only routes
router.get('/admin/dashboard', authenticate, authorize(['ADMIN']), authController.getAdminDashboard);

// Seller-only routes
router.get('/seller/dashboard', authenticate, authorize(['SELLER']), authController.getSellerDashboard);

module.exports = router;