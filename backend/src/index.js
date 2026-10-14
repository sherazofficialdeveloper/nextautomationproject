require('dotenv').config();
const app = require('./app');
const { connectDB } = require('./config/database');
const { initCrypto } = require('./utils/credentialCrypto');

const PORT = Number(process.env.PORT || 3000);

function validateStartupConfig() {
  const required = ['DATABASE_URL', 'JWT_SECRET'];
  const missing = required.filter((key) => !String(process.env[key] || '').trim());
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (String(process.env.JWT_SECRET).length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters in production.');
  }
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error('PORT must be a valid TCP port.');
  }
}

async function startServer() {
  let server;
  try {
    validateStartupConfig();
    await initCrypto();
    await connectDB();
    try {
      const { prewarmEngine } = require('./automation/browserConfig');
      prewarmEngine();
    } catch (warmErr) {
      console.warn('[Server Startup] Engine prewarm notice:', warmErr.message);
    }
    server = app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });

    const shutdown = async (signal) => {
      console.log(`[Server Shutdown] Received ${signal}; draining HTTP and automation resources...`);
      server.close(async () => {
        try {
          const automation = require('./automation/irctc/irctcAutomationService');
          await automation.shutdown();
        } catch (err) {
          console.warn('[Server Shutdown] Automation cleanup notice:', err.message);
        }
        try {
          const { getPool } = require('./config/database');
          await getPool().end();
        } catch (err) {
          console.warn('[Server Shutdown] Database cleanup notice:', err.message);
        }
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 15000).unref();
    };

    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();