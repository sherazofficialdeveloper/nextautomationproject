import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../app/auth-context';
import toolService from '../services/toolService';
import '../styles/proxySetting.css';

export default function ProxySettingPage() {
  const { session } = useAuth();
  const [token, setToken] = useState(() => session?.token || null);

  // Form Fields: Private IP
  const [ip, setIp] = useState('');
  const [port, setPort] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  // Proxies List & Selection
  const [proxies, setProxies] = useState([]);
  const [selectedProxyId, setSelectedProxyId] = useState('');

  // Proxy Limit
  const [proxyPairLimit, setProxyPairLimit] = useState(4);

  // Status & Feedback
  const [statusMessage, setStatusMessage] = useState('');
  const [loading, setLoading] = useState(false);

  // 1. Session Token Fetch
  useEffect(() => {
    let isMounted = true;
    if (token) return;

    const bridge = typeof window !== 'undefined' ? window.netx : null;
    if (bridge?.app?.getProxySettingSession) {
      bridge.app
        .getProxySettingSession()
        .then((sess) => {
          if (isMounted && sess?.token) {
            setToken(sess.token);
          }
        })
        .catch(() => {});
    }

    return () => {
      isMounted = false;
    };
  }, [token]);

  // 2. Load Proxies and Preferences
  const loadData = useCallback(async (authToken) => {
    if (!authToken) return;
    setLoading(true);
    try {
      const [proxyList, prefs] = await Promise.all([
        toolService.getProxies(authToken),
        toolService.getPreferences(authToken),
      ]);
      setProxies(Array.isArray(proxyList) ? proxyList : []);
      if (prefs?.proxy_pair_limit) {
        setProxyPairLimit(prefs.proxy_pair_limit);
      }
      if (proxyList && proxyList.length > 0 && !selectedProxyId) {
        setSelectedProxyId(String(proxyList[0].id));
      }
    } catch (err) {
      console.error('Failed to load proxy settings:', err);
    } finally {
      setLoading(false);
    }
  }, [selectedProxyId]);

  useEffect(() => {
    if (token) {
      loadData(token);
    }
  }, [token, loadData]);

  const showToast = (msg) => {
    setStatusMessage(msg);
    setTimeout(() => setStatusMessage(''), 3000);
  };

  // 3. Save Private IP
  const handleSaveProxy = async (e) => {
    e?.preventDefault();
    if (!token) return;

    if (!ip.trim()) {
      showToast('Please enter IP address');
      return;
    }
    const parsedPort = parseInt(port, 10);
    if (isNaN(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
      showToast('Please enter valid port (1-65535)');
      return;
    }

    try {
      const saved = await toolService.createProxy(token, {
        ip: ip.trim(),
        port: parsedPort,
        username: username.trim(),
        password: password.trim(),
      });

      showToast(`Proxy ${saved.ip}:${saved.port} saved`);
      setIp('');
      setPort('');
      setUsername('');
      setPassword('');
      loadData(token);
    } catch (err) {
      showToast(err?.message || 'Failed to save proxy');
    }
  };

  // 4. Delete Selected Proxy
  const handleDeleteProxy = async () => {
    if (!token || !selectedProxyId) {
      showToast('Select a proxy to delete');
      return;
    }

    try {
      await toolService.deleteProxy(token, parseInt(selectedProxyId, 10));
      showToast('Proxy deleted');
      setSelectedProxyId('');
      loadData(token);
    } catch (err) {
      showToast(err?.message || 'Failed to delete proxy');
    }
  };

  // 6. Delete ALL Proxies
  const handleDeleteAll = async () => {
    if (!token) return;
    const confirm = window.confirm('Are you sure you want to delete ALL proxies?');
    if (!confirm) return;

    try {
      await toolService.deleteAllProxies(token);
      showToast('All proxies deleted');
      setSelectedProxyId('');
      setProxies([]);
    } catch (err) {
      showToast(err?.message || 'Failed to delete all proxies');
    }
  };

  // 7. Save Proxy Limit
  const handleSaveLimit = async () => {
    if (!token) return;
    const limitNum = parseInt(proxyPairLimit, 10);
    if (isNaN(limitNum) || limitNum <= 0) {
      showToast('Please enter a valid limit number');
      return;
    }

    try {
      await toolService.updatePreferences(token, { proxy_pair_limit: limitNum });
      showToast('Proxy limit saved');
    } catch (err) {
      showToast(err?.message || 'Failed to save limit');
    }
  };

  // Close Window
  const handleClose = () => {
    if (typeof window !== 'undefined' && window.netx?.app?.closeCurrentWindow) {
      window.netx.app.closeCurrentWindow();
    }
  };

  return (
    <div className="proxy-window" data-testid="proxy-setting-window">
      {/* Purple Titlebar (media_1789626740845.png) */}
      <header className="proxy-titlebar">
        <span className="proxy-titlebar-title">Proxy IP Setting</span>
        <button
          type="button"
          className="proxy-close-btn"
          onClick={handleClose}
          title="Close"
          data-testid="btn-close-proxy"
        >
          ✕
        </button>
      </header>

      {/* Main Body with 2 Cards */}
      <main className="proxy-body">
        {/* Top Card: PRIVATE IP & Proxy IP List */}
        <section className="proxy-card">
          <h2 className="proxy-card-header">PRIVATE IP</h2>

          {/* 4 Inputs Row */}
          <div className="proxy-inputs-row">
            <div className="proxy-field">
              <label htmlFor="proxy-ip-input">IP</label>
              <input
                id="proxy-ip-input"
                type="text"
                value={ip}
                onChange={(e) => setIp(e.target.value)}
                placeholder="0.0.0.0"
                data-testid="input-proxy-ip"
              />
            </div>

            <div className="proxy-field">
              <label htmlFor="proxy-port-input">Port</label>
              <input
                id="proxy-port-input"
                type="text"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="8080"
                data-testid="input-proxy-port"
              />
            </div>

            <div className="proxy-field">
              <label htmlFor="proxy-username-input">Username</label>
              <input
                id="proxy-username-input"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                data-testid="input-proxy-username"
              />
            </div>

            <div className="proxy-field">
              <label htmlFor="proxy-password-input">Password</label>
              <input
                id="proxy-password-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                data-testid="input-proxy-password"
              />
            </div>
          </div>

          {/* Save Button Row */}
          <div className="proxy-save-row">
            <button
              type="button"
              className="proxy-btn-save"
              onClick={handleSaveProxy}
              data-testid="btn-save-proxy"
            >
              Save
            </button>
          </div>

          {/* Sub-section: Proxy IP */}
          <div className="proxy-select-section">
            <h3 className="proxy-select-title">Proxy IP</h3>

            <div className="proxy-select-row">
              <select
                className="proxy-dropdown"
                value={selectedProxyId}
                onChange={(e) => setSelectedProxyId(e.target.value)}
                data-testid="select-proxy-dropdown"
              >
                <option value="">Select Proxy</option>
                {proxies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.ip}:{p.port} {p.status === 'active' ? '✓' : ''}
                  </option>
                ))}
              </select>

              <button
                type="button"
                className="proxy-btn-action"
                onClick={handleDeleteProxy}
                data-testid="btn-delete-proxy"
              >
                Delete
              </button>
            </div>

            {/* Red Delete ALL Button */}
            <div className="proxy-delete-all-row">
              <button
                type="button"
                className="proxy-btn-delete-all"
                onClick={handleDeleteAll}
                data-testid="btn-delete-all-proxies"
              >
                Delete ALL
              </button>
            </div>
          </div>
        </section>

        {/* Bottom Card: Se Proxy Limit */}
        <section className="proxy-limit-card">
          <h2 className="proxy-limit-header">Se Proxy Limit</h2>

          <div className="proxy-limit-row">
            <span className="proxy-limit-label">Per Proxy Pair Limit</span>

            <input
              type="text"
              className="proxy-limit-input"
              value={proxyPairLimit}
              onChange={(e) => setProxyPairLimit(e.target.value)}
              data-testid="input-proxy-pair-limit"
            />

            <button
              type="button"
              className="proxy-btn-save-limit"
              onClick={handleSaveLimit}
              data-testid="btn-save-proxy-limit"
            >
              SAVE
            </button>
          </div>
        </section>

        {statusMessage && <div className="proxy-status-toast">{statusMessage}</div>}
      </main>
    </div>
  );
}

