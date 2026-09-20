import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../app/auth-context';
import toolService from '../services/toolService';
import '../styles/bookingHistory.css';

export default function BookingHistoryPage() {
  const { session } = useAuth();
  const [token, setToken] = useState(() => session?.token || null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [retentionDays, setRetentionDays] = useState(30);
  const [statusMessage, setStatusMessage] = useState('');

  // 1. Retrieve session token from Electron IPC or AuthContext
  useEffect(() => {
    let isMounted = true;
    if (token) return;

    const bridge = typeof window !== 'undefined' ? window.netx : null;
    if (bridge?.app?.getBookingHistorySession) {
      bridge.app
        .getBookingHistorySession()
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

  // 2. Fetch User Preferences and Booking History
  const loadData = useCallback(async (authToken, days) => {
    if (!authToken) return;
    setLoading(true);
    try {
      const prefs = await toolService.getPreferences(authToken);
      const activeDays = days || prefs?.history_retention_days || 30;
      setRetentionDays(activeDays);

      const list = await toolService.getBookingHistory(authToken, activeDays);
      setHistory(Array.isArray(list) ? list : []);
    } catch (err) {
      console.error('Failed to load booking history:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (token) {
      loadData(token);
    }
  }, [token, loadData]);

  // 3. Save Retention Days
  const handleSaveRetention = async () => {
    if (!token) return;
    try {
      await toolService.updatePreferences(token, { history_retention_days: retentionDays });
      setStatusMessage('Retention preference saved.');
      setTimeout(() => setStatusMessage(''), 2500);
      loadData(token, retentionDays);
    } catch (err) {
      setStatusMessage('Error saving preference.');
      setTimeout(() => setStatusMessage(''), 2500);
    }
  };

  // 4. Clear All History
  const handleClearHistory = async () => {
    if (!token) return;
    const confirm = window.confirm('Are you sure you want to clear all booking history?');
    if (!confirm) return;

    try {
      await toolService.clearBookingHistory(token);
      setHistory([]);
      setStatusMessage('All booking history cleared.');
      setTimeout(() => setStatusMessage(''), 2500);
    } catch (err) {
      setStatusMessage('Error clearing history.');
      setTimeout(() => setStatusMessage(''), 2500);
    }
  };

  // 5. Close Window
  const handleClose = () => {
    if (typeof window !== 'undefined' && window.netx?.app?.closeCurrentWindow) {
      window.netx.app.closeCurrentWindow();
    }
  };

  return (
    <div className="history-window" data-testid="history-window">
      {/* Purple Titlebar (media_1789626756741.png) */}
      <header className="history-titlebar">
        <span className="history-titlebar-title">HiSTORY</span>
        <div className="history-titlebar-actions">
          <button
            type="button"
            className="history-close-btn"
            onClick={handleClose}
            title="Close"
            data-testid="btn-close-history"
          >
            ✕
          </button>
        </div>
      </header>

      {/* Main Table Area */}
      <main className="history-body">
        <div className="history-table-container">
          <table className="history-table" data-testid="history-table">
            <thead>
              <tr>
                <th>Ticket Name</th>
                <th>ID</th>
                <th>From</th>
                <th>To</th>
                <th>Journey_Date</th>
                <th>Bank_Name</th>
                <th>PNR</th>
                <th>Fare</th>
                <th>Date</th>
                <th>Remarks</th>
              </tr>
            </thead>
            <tbody>
              {history.length === 0 ? (
                <tr>
                  <td colSpan={10} className="history-empty-row">
                    {loading ? 'Loading history records...' : 'No booking history records found.'}
                  </td>
                </tr>
              ) : (
                history.map((row) => (
                  <tr key={row.id}>
                    <td>{row.ticket_name || '-'}</td>
                    <td>{row.irctc_id || '-'}</td>
                    <td>{row.from_station || '-'}</td>
                    <td>{row.to_station || '-'}</td>
                    <td>{row.journey_date || '-'}</td>
                    <td>{row.bank_name || '-'}</td>
                    <td>{row.pnr || '-'}</td>
                    <td>{row.fare !== null && row.fare !== undefined ? row.fare : '-'}</td>
                    <td>{row.date || row.booking_date || '-'}</td>
                    <td>{row.remarks || 'Booking Success'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {statusMessage && <div className="history-status-toast">{statusMessage}</div>}
      </main>

      {/* Bottom Retention & Clear Bar */}
      <footer className="history-bottom-bar">
        <label htmlFor="history-retention-select" className="history-retention-label">
          Keep Only Days History :
        </label>
        <select
          id="history-retention-select"
          className="history-retention-select"
          value={retentionDays}
          onChange={(e) => setRetentionDays(parseInt(e.target.value, 10))}
          data-testid="select-retention-days"
        >
          <option value={7}>7</option>
          <option value={15}>15</option>
          <option value={30}>30</option>
          <option value={60}>60</option>
          <option value={90}>90</option>
          <option value={180}>180</option>
          <option value={365}>365</option>
        </select>

        <button
          type="button"
          className="history-save-btn"
          onClick={handleSaveRetention}
          data-testid="btn-save-retention"
        >
          Save
        </button>

        <button
          type="button"
          className="history-clear-btn"
          onClick={handleClearHistory}
          data-testid="btn-clear-history"
        >
          Clear All History
        </button>
      </footer>
    </div>
  );
}

