import { useEffect, useState } from 'react';
import { useAuth } from '../app/auth-context';
import '../styles/login.css';

// NETX Login screen — the first screen of the desktop software.
//
// - UI validation only (non-empty fields). Server authentication is a real
//   backend call; the UI never fakes success.
// - Credentials are associated with a license/access credential created on
//   the management side. The backend is the authority.
// - Original design restored with integrated in-input password toggle icon.

function validate({ identifier }) {
  const errors = {};
  if (!identifier || !identifier.trim()) {
    errors.identifier = 'Username is required.';
  }
  return errors;
}

function LoginPage() {
  const { login, status, error } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [version, setVersion] = useState(null);

  const submitting = status === 'submitting';

  useEffect(() => {
    let cancelled = false;
    const bridge = typeof window !== 'undefined' ? window.netx : null;
    if (bridge && bridge.app && typeof bridge.app.getVersion === 'function') {
      bridge.app
        .getVersion()
        .then((value) => {
          if (!cancelled) setVersion(value);
        })
        .catch(() => {
          // Version display is cosmetic; never blocks sign-in.
        });
    }
    return () => {
      cancelled = true;
    };
  }, []);

  const handleClose = () => {
    const bridge = typeof window !== 'undefined' ? window.netx : null;
    if (bridge?.app?.closeCurrentWindow) {
      bridge.app.closeCurrentWindow();
    } else if (bridge?.app?.close) {
      bridge.app.close();
    } else if (typeof window !== 'undefined') {
      window.close();
    }
  };

  const onSubmit = async (event) => {
    event.preventDefault();
    if (submitting) return; // duplicate submission guard

    const errors = validate({ identifier });
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const result = await login({ identifier: identifier.trim() });
    if (result.ok) {
      return;
    }
  };

  const bannerError = status === 'error' ? error : null;

  return (
    <div className="login-window-wrapper">
      <header className="login-header-drag">
        <span className="login-window-title">NETX</span>
        <button
          type="button"
          className="window-close-btn"
          onClick={handleClose}
          aria-label="Close window"
          title="Close window"
          data-testid="btn-close-login"
        >
          ✕
        </button>
      </header>

      <main className="login-screen">
        <section className="login-card" aria-labelledby="login-heading">

        <header className="login-brand">
          <h1 id="login-heading" className="login-wordmark">
            <span className="login-wordmark__base">NET</span>
            <span className="login-wordmark__accent">X</span>
          </h1>
          <p className="login-subtitle">Sign in with your license credentials</p>
        </header>

        <form className="login-form" onSubmit={onSubmit} noValidate>
          <div className="field">
            <label className="field__label" htmlFor="identifier">
              Username
            </label>
            <input
              id="identifier"
              name="identifier"
              type="text"
              className={'field__input' + (fieldErrors.identifier ? ' field__input--error' : '')}
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              autoComplete="username"
              autoFocus
              required
              disabled={submitting}
              aria-invalid={fieldErrors.identifier ? 'true' : 'false'}
              aria-describedby={fieldErrors.identifier ? 'identifier-error' : undefined}
            />
            {fieldErrors.identifier && (
              <p className="field-error" id="identifier-error">
                {fieldErrors.identifier}
              </p>
            )}
          </div>

          {bannerError && (
            <div className="login-alert" role="alert">
              {bannerError.message}
            </div>
          )}

          <button className="login-button" type="submit" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Login'}
          </button>
        </form>

        <footer className="login-footer">
          <span className="login-footer__version" data-testid="app-version">
            Version {version || '—'}
          </span>
        </footer>
      </section>
    </main>
  </div>
  );
}

export default LoginPage;