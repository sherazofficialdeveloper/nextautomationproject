const express = require('express');
const errorHandler = require('./utils/errorHandler');
const healthRoutes = require('./routes/healthRoutes');
const authRoutes = require('./routes/authRoutes');
const adminLicenseRoutes = require('./routes/adminLicenseRoutes');
const sellerLicenseRoutes = require('./routes/sellerLicenseRoutes');
const adminSellerRoutes = require('./routes/adminSellerRoutes');
const adminAccountRoutes = require('./routes/adminAccountRoutes');
const sellerAccountRoutes = require('./routes/sellerAccountRoutes');
const targetAccountRoutes = require('./routes/targetAccountRoutes');
const ticketRoutes = require('./routes/ticketRoutes');
const bankRoutes = require('./routes/bankRoutes');
const cardRoutes = require('./routes/cardRoutes');
const superAdminRoutes = require('./routes/superAdminRoutes');
const toolRoutes = require('./routes/toolRoutes');

const app = express();

// Middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});
app.use(express.json({ limit: '10mb' })); // Body parser for JSON requests up to 10MB
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Routes
app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/admin/licenses', adminLicenseRoutes);
app.use('/api/seller/licenses', sellerLicenseRoutes);
app.use('/api/admin/sellers', adminSellerRoutes);
app.use('/api/admin', adminAccountRoutes);
app.use('/api/seller', sellerAccountRoutes);
app.use('/api/irctc-accounts', targetAccountRoutes);
app.use('/api/target-accounts', targetAccountRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/tools', toolRoutes);
app.use('/api/banks', bankRoutes);
app.use('/api/cards', cardRoutes);

// Centralized Error Handling
app.use(errorHandler);

module.exports = app;