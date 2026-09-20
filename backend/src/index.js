require('dotenv').config();
const app = require('./app');
const { connectDB } = require('./config/database');
const { initCrypto } = require('./utils/credentialCrypto');

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await initCrypto();
    await connectDB();
    try {
      const { prewarmEngine } = require('./automation/browserConfig');
      prewarmEngine();
    } catch (warmErr) {
      console.warn('[Server Startup] Engine prewarm notice:', warmErr.message);
    }
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();