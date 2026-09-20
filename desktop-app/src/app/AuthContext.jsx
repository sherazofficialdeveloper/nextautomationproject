import { useCallback, useMemo, useState } from 'react';
import { AuthContext } from './auth-context.js';
import { login as loginService, logout as logoutService } from '../services/authService';

// In-memory authenticated session for the desktop renderer.
//
// - The session lives only in memory; nothing (and especially no password)
//   is persisted. Token/session persistence is a later decision made with
//   the backend contract.
// - There is NO dev bypass and NO fake login. The only way to a session is a
//   real successful backend response.

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null); // { token, user } | null
  const [status, setStatus] = useState('idle'); // 'idle' | 'submitting' | 'error'
  const [error, setError] = useState(null);

  const login = useCallback(async (credentials) => {
    setStatus('submitting');
    setError(null);
    try {
      const data = await loginService(credentials);
      if (!data || typeof data !== 'object' || !data.token || !data.user) {
        throw new Error('Invalid authentication response from the server.');
      }
      setSession({ token: data.token, user: data.user });
      setStatus('idle');
      return { ok: true };
    } catch (err) {
      const safe = {
        type: err && err.type ? err.type : 'unknown',
        status: err && err.status ? err.status : null,
        code: err && err.code ? err.code : null,
        message:
          err && typeof err.message === 'string'
            ? err.message
            : 'Unable to sign in.',
      };
      setError(safe);
      setStatus('error');
      return { ok: false, error: safe };
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await logoutService();
    } catch {
      // Server-side logout acknowledgment is optional for stateless tokens.
    }
    setSession(null);
    setError(null);
    setStatus('idle');
  }, []);

  const value = useMemo(
    () => ({
      session,
      user: session ? session.user : null,
      isAuthenticated: Boolean(session && session.token),
      status,
      error,
      login,
      logout,
    }),
    [session, status, error, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
