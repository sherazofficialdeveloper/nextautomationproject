// Renderer environment configuration.
// Only frontend-safe values live here. Backend secrets NEVER belong in the
// desktop application. The API base URL is operator-configured, not hardcoded.

const rawBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:3000';

const env = {
  appName: import.meta.env.VITE_APP_NAME || 'NETX',
  appEnv: import.meta.env.VITE_APP_ENV || 'development',
  // Empty means "not configured": the UI surfaces a clear, safe error
  // instead of pretending anything about authentication.
  apiBaseUrl: rawBaseUrl,
  apiTimeoutMs: Number(import.meta.env.VITE_API_TIMEOUT_MS || 15000),
};

export default env;
