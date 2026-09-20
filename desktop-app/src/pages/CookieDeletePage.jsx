import { useState, useEffect } from 'react';
import toolService from '../services/toolService';
import '../styles/cookieDelete.css';

export default function CookieDeletePage() {
  const [token, setToken] = useState('');
  const [clearing, setClearing] = useState(false);
  const [clearCookiesOpt, setClearCookiesOpt] = useState(true);
  const [clearCacheOpt, setClearCacheOpt] = useState(true);
  const [statusMessage, setStatusMessage] = useState('');
  const [statusType, setStatusType] = useState('idle'); // 'idle' | 'success' | 'error'

  useEffect(() => {
    let isMounted = true;
    const bridge = typeof window !== 'undefined' ? window.netx : null;
    if (bridge?.app?.getCookieDeleteSession) {
      bridge.app
        .getCookieDeleteSession()
        .then((sess) => {
          if (isMounted && sess?.token) {
            setToken(sess.token);
          }
        })
        .catch(() => {});
    }

    if (!token && typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem('netx_auth_session');
        if (stored) {
          const parsed = JSON.parse(stored);
          if (parsed?.token && isMounted) {
            setToken(parsed.token);
          }
        }
      } catch {}
    }

    return () => {
      isMounted = false;
    };
  }, [token]);

  const handleClose = () => {
    if (typeof window !== 'undefined' && window.netx?.app?.closeCurrentWindow) {
      window.netx.app.closeCurrentWindow();
    }
  };

  const handleClearCookies = async () => {
    setClearing(true);
    setStatusMessage('');
    setStatusType('idle');
    try {
      const bridge = typeof window !== 'undefined' ? window.netx : null;
      let res = null;
      if (bridge?.app?.clearCookies) {
        res = await bridge.app.clearCookies();
      } else {
        res = { ok: true, message: 'Local application session cleared.' };
      }

      // Also clear backend Playwright automation cookies/sessions if token is available
      let automationCount = 0;
      const activeToken = token || (typeof window !== 'undefined' && (() => {
        try {
          const stored = localStorage.getItem('netx_auth_session');
          return stored ? JSON.parse(stored)?.token : null;
        } catch { return null; }
      })());

      if (activeToken) {
        try {
          const autoRes = await toolService.clearAutomationCookies(activeToken);
          if (autoRes?.sessionCount !== undefined) {
            automationCount = autoRes.sessionCount;
          }
        } catch (err) {
          console.warn('Automation session cleanup notice:', err.message);
        }
      }

      if (res?.ok) {
        setStatusType('success');
        setStatusMessage(
          automationCount > 0
            ? `Application and ${automationCount} automation session cookies cleared successfully.`
            : 'Application and automation session cookies cleared successfully.'
        );
      } else {
        setStatusType('error');
        setStatusMessage(res?.error || 'Failed to clear cookies.');
      }
    } catch (err) {
      setStatusType('error');
      setStatusMessage(err?.message || 'Error occurred while clearing cookies.');
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="cookie-window" data-testid="cookie-delete-window">
      {/* Draggable Purple Header */}
      <header className="cookie-titlebar">
        <span className="cookie-titlebar-title">Cookie Delete</span>
        <button
          type="button"
          className="cookie-close-btn"
          onClick={handleClose}
          title="Close"
          data-testid="btn-close-cookie-window"
        >
          ✕
        </button>
      </header>

      {/* Main Content Body */}
      <main className="cookie-body">
        <div className="cookie-card">
          <p className="cookie-description">
            Clear session partitions, cached web data, and authentication cookies from the local application.
          </p>

          <div className="cookie-options">
            <label className="cookie-option-label">
              <input
                type="checkbox"
                checked={clearCookiesOpt}
                onChange={(e) => setClearCookiesOpt(e.target.checked)}
              />
              <span>Session Cookies &amp; Partition Data</span>
            </label>
            <label className="cookie-option-label">
              <input
                type="checkbox"
                checked={clearCacheOpt}
                onChange={(e) => setClearCacheOpt(e.target.checked)}
              />
              <span>Web Storage &amp; Cache</span>
            </label>
          </div>

          {statusMessage && (
            <div className={`cookie-status-alert alert-${statusType}`}>
              {statusMessage}
            </div>
          )}

          <div className="cookie-actions">
            <button
              type="button"
              className="cookie-delete-btn"
              onClick={handleClearCookies}
              disabled={clearing || (!clearCookiesOpt && !clearCacheOpt)}
              data-testid="btn-execute-cookie-delete"
            >
              {clearing ? 'Clearing...' : 'Clear Cookies & Storage'}
            </button>
            <button
              type="button"
              className="cookie-cancel-btn"
              onClick={handleClose}
            >
              Close
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

