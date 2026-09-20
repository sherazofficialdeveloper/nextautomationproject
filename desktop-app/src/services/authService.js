import apiClient, { ApiError } from './apiClient';

// Authentication service foundation for the desktop software.
//
// Intended production flow (implemented later without UI rewrites):
//   Login UI -> authService -> Backend API -> server-side authentication
//            -> license/user validation -> authenticated session
//
// Contract notes:
// - The login call targets the REAL existing backend endpoint
//   POST /api/auth/login with { identifier, password }.
// - No fake users, fake tokens, fake license validation, or local
//   authentication exist here. Failures surface as real errors.
// - The desktop app is never the source of truth for license validity or
//   identity; the backend decides everything.

const LOGIN_PATH = '/api/auth/login';

export async function login({ identifier, password }) {
  if (typeof identifier !== 'string' || !identifier.trim()) {
    throw new ApiError({ type: 'client', message: 'Username is required.' });
  }
  const payload = { identifier: identifier.trim() };
  if (password && typeof password === 'string' && password.trim()) {
    payload.password = password;
  }
  return apiClient.post(LOGIN_PATH, payload);
}

// Logout/session-revocation semantics will be defined with the backend
// authentication contract. Deliberately a no-op for now.
export async function logout() {
  return null;
}

export { ApiError };
