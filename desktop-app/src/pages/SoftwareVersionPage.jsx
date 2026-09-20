import { useState, useEffect } from 'react';
import { useAuth } from '../app/auth-context';
import toolService from '../services/toolService';
import '../styles/softwareVersion.css';

// Strict visual parity with media_1789804180715.png
// Shows real PostgreSQL-calculated remaining days, license key (MS1/username),
// application version (2026.07.16.0), key type (monthly), and OK button.

export default function SoftwareVersionPage() {
  const { session } = useAuth();
  const [token, setToken] = useState(() => session?.token || null);
  const [loading, setLoading] = useState(true);
  const [licenseData, setLicenseData] = useState({
    licenseKey: session?.user?.username || '—',
    expiryLeftDays: '—',
    applicationVersion: '2026.07.16.0',
    keyType: 'monthly',
  });

  // Retrieve auth session if opened in separate child window
  useEffect(() => {
    let isMounted = true;
    if (token) return;

    const bridge = typeof window !== 'undefined' ? window.netx : null;
    if (bridge?.app?.getVersionCheckSession) {
      bridge.app
        .getVersionCheckSession()
        .then((sess) => {
          if (isMounted && sess?.token) {
            setToken(sess.token);
            if (sess?.user?.username) {
              setLicenseData((prev) => ({
                ...prev,
                licenseKey: sess.user.username,
              }));
            }
          }
        })
        .catch(() => {});
    }

    if (bridge?.app?.onVersionCheckSessionUpdated) {
      const unsub = bridge.app.onVersionCheckSessionUpdated((sess) => {
        if (isMounted && sess?.token) {
          setToken(sess.token);
          if (sess?.user?.username) {
            setLicenseData((prev) => ({
              ...prev,
              licenseKey: sess.user.username,
            }));
          }
        }
      });
      return () => {
        isMounted = false;
        if (unsub) unsub();
      };
    }

    return () => {
      isMounted = false;
    };
  }, [token]);

  // Fetch real license info from backend
  useEffect(() => {
    let isMounted = true;
    async function loadLicense() {
      if (!token) return;
      setLoading(true);
      try {
        const res = await toolService.getLicenseInfo(token);
        if (isMounted && res && res.ok) {
          setLicenseData({
            licenseKey: res.licenseKey || session?.user?.username || '—',
            expiryLeftDays: res.expiryLeftDays !== undefined ? res.expiryLeftDays : '—',
            applicationVersion: res.applicationVersion || '2026.07.16.0',
            keyType: res.keyType || 'monthly',
          });
        }
      } catch (err) {
        console.error('Failed to load license info:', err);
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    loadLicense();
    return () => {
      isMounted = false;
    };
  }, [token, session]);

  const handleClose = () => {
    if (typeof window !== 'undefined' && window.netx?.app?.closeCurrentWindow) {
      window.netx.app.closeCurrentWindow();
    } else if (typeof window !== 'undefined') {
      window.close();
    }
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="version-dialog" data-testid="version-check-window">
      <div className="version-content">
        <div className="version-row">
          <span className="version-label">Your License Key</span>
          <span className="version-value" data-testid="license-key-val">
            {licenseData.licenseKey}
          </span>
        </div>

        <div className="version-row">
          <span className="version-label">Expiry (Left Days)</span>
          <span className="version-value" data-testid="license-expiry-days-val">
            {licenseData.expiryLeftDays}
          </span>
        </div>

        <div className="version-row">
          <span className="version-label">Application Version</span>
          <span className="version-value" data-testid="application-version-val">
            {licenseData.applicationVersion}
          </span>
        </div>

        <div className="version-row">
          <span className="version-label">Key Type</span>
          <span className="version-value" data-testid="key-type-val">
            {licenseData.keyType}
          </span>
        </div>
      </div>

      <footer className="version-footer">
        <button
          type="button"
          className="version-ok-btn"
          onClick={handleClose}
          data-testid="btn-version-ok"
          autoFocus
        >
          OK
        </button>
      </footer>
    </div>
  );
}
