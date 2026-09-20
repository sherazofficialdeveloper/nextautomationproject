import { useState } from 'react';
import '../styles/browserCheck.css';

export default function BrowserCheckPage() {
  const [tokenCount, setTokenCount] = useState(0);
  const [checkingBrowser, setCheckingBrowser] = useState(null);
  const [results, setResults] = useState({});
  const [statusToast, setStatusToast] = useState('');

  const showToast = (msg) => {
    setStatusToast(msg);
    setTimeout(() => setStatusToast(''), 4000);
  };

  const handleClose = () => {
    if (typeof window !== 'undefined' && window.netx?.app?.closeCurrentWindow) {
      window.netx.app.closeCurrentWindow();
    }
  };

  const handleCheckIPBlock = async (browserKey, displayName) => {
    setCheckingBrowser(browserKey);
    try {
      const bridge = typeof window !== 'undefined' ? window.netx : null;
      let checkRes = null;

      if (bridge?.app?.checkBrowserIPBlock) {
        checkRes = await bridge.app.checkBrowserIPBlock(browserKey);
      } else {
        // Fallback simulation when run outside Electron
        await new Promise((r) => setTimeout(r, 400));
        checkRes = {
          ok: true,
          browserKey,
          installed: false,
          blocked: false,
          latencyMs: null,
          message: 'Unable to check (Electron bridge not connected)',
        };
      }

      setResults((prev) => ({
        ...prev,
        [browserKey]: checkRes,
      }));

      if (checkRes.blocked) {
        showToast(`[${displayName}] ${checkRes.message || 'IP Blocked'}`);
      } else {
        const installStatus = checkRes.installed ? 'Installed' : 'Path not detected';
        showToast(`[${displayName}] ${checkRes.message} (${installStatus})`);
      }
    } catch (err) {
      showToast(`Error checking ${displayName}: ${err?.message || 'Check failed'}`);
    } finally {
      setCheckingBrowser(null);
    }
  };

  const handleGetTokenFromApk = async () => {
    setCheckingBrowser('apk');
    try {
      const bridge = typeof window !== 'undefined' ? window.netx : null;
      let tokenRes = null;

      if (bridge?.app?.getApkToken) {
        tokenRes = await bridge.app.getApkToken();
      } else {
        tokenRes = { ok: false, error: 'APK token service is not configured.' };
      }

      if (tokenRes.ok && tokenRes.token) {
        setTokenCount((prev) => prev + 1);
        showToast(`New Token: ${tokenRes.token.slice(0, 16)}...`);
      } else {
        showToast(tokenRes.error || 'APK token service is not configured.');
      }
    } catch (err) {
      showToast(`APK Token error: ${err?.message || 'APK token service is not configured.'}`);
    } finally {
      setCheckingBrowser(null);
    }
  };

  return (
    <div className="browser-window-frame" data-testid="browser-check-window">
      {/* Purple Titlebar */}
      <header className="browser-titlebar">
        <span className="browser-titlebar-title">Web Login Settings</span>
        <button
          type="button"
          className="browser-close-btn"
          onClick={handleClose}
          title="Close"
          data-testid="btn-close-browser-check"
        >
          ✕
        </button>
      </header>

      {/* Main Content Area: Clean layout without emblem/QR visuals */}
      <div className="browser-main-body">
        <main className="browser-content-panel">
          {/* Action Rows */}
          <section className="browser-actions-container" aria-label="Web Browser Controls">
            {/* 1. Web- 2 ( Google Chrome ) */}
            <div className="browser-action-row">
              <div className="browser-row-info">
                <span className="browser-row-label">Web- 2 ( Google Chrome )</span>
                {results.chrome && (
                  <span className={`browser-status-badge ${results.chrome.blocked ? 'badge-blocked' : results.chrome.installed ? 'badge-installed' : 'badge-neutral'}`}>
                    {results.chrome.installed ? 'Installed' : 'Not Detected'} &bull; {results.chrome.message}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="browser-btn browser-btn--peach"
                onClick={() => handleCheckIPBlock('chrome', 'Google Chrome')}
                disabled={checkingBrowser === 'chrome'}
                data-testid="btn-check-chrome"
              >
                {checkingBrowser === 'chrome' ? 'Checking...' : 'Check IP Block'}
              </button>
            </div>

            {/* 2. Web- 3 ( Microsoft Edge ) - Yellow button */}
            <div className="browser-action-row">
              <div className="browser-row-info">
                <span className="browser-row-label">Web- 3 ( Microsoft Edge )</span>
                {results.edge && (
                  <span className={`browser-status-badge ${results.edge.blocked ? 'badge-blocked' : results.edge.installed ? 'badge-installed' : 'badge-neutral'}`}>
                    {results.edge.installed ? 'Installed' : 'Not Detected'} &bull; {results.edge.message}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="browser-btn browser-btn--yellow"
                onClick={() => handleCheckIPBlock('edge', 'Microsoft Edge')}
                disabled={checkingBrowser === 'edge'}
                data-testid="btn-check-edge"
              >
                {checkingBrowser === 'edge' ? 'Checking...' : 'Check IP Block'}
              </button>
            </div>

            {/* 3. Web ( Brave ) */}
            <div className="browser-action-row">
              <div className="browser-row-info">
                <span className="browser-row-label">Web ( Brave )</span>
                {results.brave && (
                  <span className={`browser-status-badge ${results.brave.blocked ? 'badge-blocked' : results.brave.installed ? 'badge-installed' : 'badge-neutral'}`}>
                    {results.brave.installed ? 'Installed' : 'Not Detected'} &bull; {results.brave.message}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="browser-btn browser-btn--peach"
                onClick={() => handleCheckIPBlock('brave', 'Brave')}
                disabled={checkingBrowser === 'brave'}
                data-testid="btn-check-brave"
              >
                {checkingBrowser === 'brave' ? 'Checking...' : 'Check IP Block'}
              </button>
            </div>

            {/* 4. Web ( Opera ) */}
            <div className="browser-action-row">
              <div className="browser-row-info">
                <span className="browser-row-label">Web ( Opera )</span>
                {results.opera && (
                  <span className={`browser-status-badge ${results.opera.blocked ? 'badge-blocked' : results.opera.installed ? 'badge-installed' : 'badge-neutral'}`}>
                    {results.opera.installed ? 'Installed' : 'Not Detected'} &bull; {results.opera.message}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="browser-btn browser-btn--peach"
                onClick={() => handleCheckIPBlock('opera', 'Opera')}
                disabled={checkingBrowser === 'opera'}
                data-testid="btn-check-opera"
              >
                {checkingBrowser === 'opera' ? 'Checking...' : 'Check IP Block'}
              </button>
            </div>

            {/* 5. Web ( Comet ) */}
            <div className="browser-action-row">
              <div className="browser-row-info">
                <span className="browser-row-label">Web ( Comet )</span>
                {results.comet && (
                  <span className={`browser-status-badge ${results.comet.blocked ? 'badge-blocked' : results.comet.installed ? 'badge-installed' : 'badge-neutral'}`}>
                    {results.comet.installed ? 'Installed' : 'Not Detected'} &bull; {results.comet.message}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="browser-btn browser-btn--peach"
                onClick={() => handleCheckIPBlock('comet', 'Comet')}
                disabled={checkingBrowser === 'comet'}
                data-testid="btn-check-comet"
              >
                {checkingBrowser === 'comet' ? 'Checking...' : 'Check IP Block'}
              </button>
            </div>

            {/* 6. APK Token Get & Token Count */}
            <div className="browser-action-row browser-action-row--apk">
              <div className="browser-apk-left">
                <span className="browser-row-label">APK Token Get</span>
                <span className="browser-token-count" data-testid="token-count-display">
                  Token Count :- <strong className="browser-token-count-number">{tokenCount}</strong>
                </span>
              </div>
              <button
                type="button"
                className="browser-btn browser-btn--peach"
                onClick={handleGetTokenFromApk}
                disabled={checkingBrowser === 'apk'}
                data-testid="btn-get-apk-token"
              >
                {checkingBrowser === 'apk' ? 'Checking...' : 'Get Token From Apk'}
              </button>
            </div>
          </section>
        </main>

        {/* Bottom Pink Notice Box */}
        <footer className="browser-notice-box" aria-label="IP Block Notice">
          <p className="browser-notice-text">
            Software Install hone ke Baaad Ek Baar IP Block Check Karna Jaroori Hai, Achche Result ke liye Aapko Local System Istemal Karna ahi, VPS PE IP Block ka isse jyada aata hai, Booking se pahle aapko apna mobile ek baar Flight mode daalke wapas net Connet karna hai, agar broad abad use kar rahe hain to router ko 2 minut ke liye band karke wapas chaalu karna hai
          </p>
        </footer>

        {/* Toast Feedback */}
        {statusToast && <div className="browser-toast">{statusToast}</div>}
      </div>
    </div>
  );
}
