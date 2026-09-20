import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../app/auth-context';
import ticketService from '../services/ticketService';
import toolService from '../services/toolService';
import irctcAccountService from '../services/irctcAccountService';
import { formatQuotaDisplay } from '../utils/quotaDisplay';
import '../styles/ticket.css';

/**
 * Open Ticket Detail Screen
 * Visual source of truth: media_1789660957910.png
 * Features:
 * - Text-only header with ticket name and close X.
 * - Auto-Booking Timer: Booking Time: 00:00:00 (starts ONLY when booking begins, not on window open or login).
 * - Auto-populated, disabled/read-only input fields from saved ticket.
 * - Single 'Login (Web)' button.
 * - 5-browser selection flow: Google Chrome, Microsoft Edge, Brave, Opera, Comet.
 * - Recording final booking duration in remarks of booking history.
 */

function formatDisplayDate(dateStr) {
  if (!dateStr) return '24-07-2026';
  const str = String(dateStr).trim();
  const ymd = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (ymd) {
    const [, y, m, d] = ymd;
    return `${d.padStart(2, '0')}-${m.padStart(2, '0')}-${y}`;
  }
  const dmy = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${d.padStart(2, '0')}-${m.padStart(2, '0')}-${y}`;
  }
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    const d = String(parsed.getDate()).padStart(2, '0');
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const y = parsed.getFullYear();
    return `${d}-${m}-${y}`;
  }
  return str;
}

function formatTimer(totalSeconds) {
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function formatSystemTime(now = new Date()) {
  return now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

const SUPPORTED_BROWSERS = [
  { key: 'chrome', name: 'Google Chrome' },
  { key: 'edge', name: 'Microsoft Edge' },
  { key: 'brave', name: 'Brave' },
  { key: 'opera', name: 'Opera' },
  { key: 'comet', name: 'Comet' },
];

export default function TicketWebSelectPage() {
  const { session } = useAuth();
  const [token, setToken] = useState(() => {
    if (session?.token) return session.token;
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem('netx_auth_session');
        if (stored) {
          const parsed = JSON.parse(stored);
          if (parsed?.token) return parsed.token;
        }
      } catch {
        // ignore
      }
    }
    return null;
  });

  const [ticket, setTicket] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [browserModalOpen, setBrowserModalOpen] = useState(false);
  const [activeBrowser, setActiveBrowser] = useState(null);
  const [isLaunching, setIsLaunching] = useState(false);
  const [bookingStatusText, setBookingStatusText] = useState('Ready - { Bkg Fare Limit: 0 }');
  const [authResult, setAuthResult] = useState(null);
  const [stopPayment, setStopPayment] = useState(false);
  const [availabilityText, setAvailabilityText] = useState('Checking...');
  const [isCheckingAvailability, setIsCheckingAvailability] = useState(false);
  const [browserAvailability, setBrowserAvailability] = useState(null);
  const [isTogglingBooking, setIsTogglingBooking] = useState(false);
  const [qrCode, setQrCode] = useState(null);

  // Auto-Booking Timer & Status Polling State
  const [systemTime, setSystemTime] = useState(() => formatSystemTime());
  const [isBookingActive, setIsBookingActive] = useState(false);
  const [bookingSeconds, setBookingSeconds] = useState(0);
  const timerRef = useRef(null);
  const secondsRef = useRef(0);
  secondsRef.current = bookingSeconds;
  const statusPollRef = useRef(null);

  // Live System Clock (continuous, 1s interval, never halts)
  useEffect(() => {
    const clockInterval = setInterval(() => {
      setSystemTime(formatSystemTime());
    }, 1000);
    return () => clearInterval(clockInterval);
  }, []);

  // Retrieve token & initial ticket data from Electron IPC
  useEffect(() => {
    let isMounted = true;
    const bridge = typeof window !== 'undefined' ? window.netx : null;

    if (!token && bridge?.app?.getTicketSession) {
      bridge.app
        .getTicketSession()
        .then((sess) => {
          if (isMounted && sess?.token) {
            setToken(sess.token);
          }
        })
        .catch(() => {});
    }

    if (bridge?.app?.getSelectedTicket) {
      bridge.app
        .getSelectedTicket()
        .then((t) => {
          if (isMounted && t) {
            setTicket(t);
            if (!token && (t.token || t.session?.token)) {
              setToken(t.token || t.session?.token);
            }
          }
        })
        .catch(() => {});
    }

    let unsubscribe = null;
    if (bridge?.app?.onSelectedTicketUpdated) {
      unsubscribe = bridge.app.onSelectedTicketUpdated((updatedTicket) => {
        if (isMounted && updatedTicket) {
          setTicket(updatedTicket);
          if (!token && (updatedTicket.token || updatedTicket.session?.token)) {
            setToken(updatedTicket.token || updatedTicket.session?.token);
          }
        }
      });
    }

    return () => {
      isMounted = false;
      if (unsubscribe) unsubscribe();
    };
  }, [token]);

  // Load IRCTC Accounts
  useEffect(() => {
    if (!token) return;
    irctcAccountService
      .listAccounts(token)
      .then((data) => {
        if (Array.isArray(data)) {
          setAccounts(data);
        }
      })
      .catch((err) => {
        console.warn('[OpenTicket] Could not fetch accounts:', err);
      });
  }, [token]);

  // Fetch real live seat availability from Ghumo.Live
  const fetchLiveAvailability = async (overrideToken, overrideTicketId) => {
    const activeToken = overrideToken || token || session?.token;
    const tId = overrideTicketId || ticket?.id;
    if (!activeToken || !tId) return;

    setIsCheckingAvailability(true);
    try {
      const res = await ticketService.getAvailability(activeToken, tId);
      if (res?.availability) {
        setAvailabilityText(res.availability);
      } else {
        setAvailabilityText('Unable to Check');
      }
    } catch {
      setAvailabilityText('Unable to Check');
    } finally {
      setIsCheckingAvailability(false);
    }
  };

  useEffect(() => {
    const activeToken = token || session?.token;
    if (activeToken && ticket?.id) {
      fetchLiveAvailability(activeToken, ticket.id);
    }
  }, [token, ticket?.id]);

  // Fetch real browser availability from backend
  const fetchBrowserAvailability = async (overrideToken) => {
    const activeToken = overrideToken || token || session?.token;
    if (!activeToken) return;
    try {
      const res = await ticketService.getBrowserAvailability(activeToken);
      if (res) {
        setBrowserAvailability(res);
      }
    } catch (err) {
      console.warn('[OpenTicket] Could not fetch browser availability:', err);
    }
  };

  useEffect(() => {
    const activeToken = token || session?.token;
    if (activeToken) {
      fetchBrowserAvailability(activeToken);
    }
  }, [token]);

  // Background Pre-Warming: Prepares the default browser persistent context on mount
  useEffect(() => {
    const activeToken = token || session?.token;
    if (!activeToken || !ticket?.id || activeBrowser || isLaunching) return;

    let isCancelled = false;
    const defaultKey = browserAvailability?.chrome?.isAvailable !== false ? 'chrome' : 'edge';
    const defaultName = defaultKey === 'chrome' ? 'Google Chrome' : 'Microsoft Edge';

    setBookingStatusText(`Preparing ${defaultName}...`);

    ticketService
      .prepareBrowser(activeToken, ticket.id, defaultKey)
      .then((res) => {
        if (!isCancelled && res) {
          const resolvedName = res.browserName || defaultName;
          setActiveBrowser(resolvedName);
          setBookingStatusText(`${resolvedName} Ready`);
        }
      })
      .catch((err) => {
        if (!isCancelled) {
          console.warn('[OpenTicket] Browser pre-warm notice:', err?.message);
          setBookingStatusText('Ready - { Bkg Fare Limit: 0 }');
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [token, ticket?.id, browserAvailability]);

  // Timer Tick Effect (starts ONLY when booking begins)
  useEffect(() => {
    if (isBookingActive) {
      timerRef.current = setInterval(() => {
        setBookingSeconds((prev) => prev + 1);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isBookingActive]);

  const handleClose = () => {
    const activeToken = token || session?.token;
    if (activeToken && ticket?.id) {
      ticketService.stopBooking(activeToken, ticket.id).catch(() => {});
    }
    if (typeof window !== 'undefined' && window.netx?.app?.closeCurrentWindow) {
      window.netx.app.closeCurrentWindow();
    } else if (typeof window !== 'undefined') {
      window.close();
    }
  };

  // Unmount cleanup for status polling
  useEffect(() => {
    return () => {
      if (statusPollRef.current) {
        clearInterval(statusPollRef.current);
        statusPollRef.current = null;
      }
    };
  }, []);

  // Launch Selected Browser via backend Patchright Core only in background
  const handleSelectBrowser = async (browserKey, browserName) => {
    if (isLaunching) return;
    const activeToken = token || session?.token;
    if (!activeToken) {
      setBookingStatusText('Notice: Authentication session not found. Please log in.');
      setBrowserModalOpen(false);
      return;
    }
    if (!ticket?.id) {
      setBookingStatusText('Notice: Ticket data not loaded.');
      setBrowserModalOpen(false);
      return;
    }

    setIsLaunching(true);
    setBookingStatusText(`Launching ${browserName}...`);
    setBookingStatusText(`Preparing ${browserName}...`);
    try {
      await ticketService.launchBrowser(activeToken, ticket.id, browserKey, { stopPayment });

      setActiveBrowser(browserName);
      setBrowserModalOpen(false);
      setBookingStatusText(`Ready - [ ${browserName} Active ]`);
      setBookingStatusText(`${browserName} Ready`);
    } catch (err) {
      console.error('[OpenTicket] Launch error:', err);
      const errMsg = err?.response?.data?.error || err?.message || `${browserName} is not installed or cannot be launched for automation.`;
      setBookingStatusText(`Error: ${errMsg}`);
      setBrowserModalOpen(false);
    } finally {
      setIsLaunching(false);
    }
  };

  // Start / Stop Auto-Booking
  const handleToggleBooking = async () => {
    if (isTogglingBooking) return;
    const activeToken = token || session?.token;
    if (!activeToken || !ticket?.id) {
      setBookingStatusText('Notice: Missing authentication session or ticket information.');
      return;
    }

    setIsTogglingBooking(true);
    try {
      if (!isBookingActive) {
        // Start booking process
        setIsBookingActive(true);
        setBookingSeconds(0);
        setAuthResult(null);
        setQrCode(null);
        setBookingStatusText('Starting...');
        setBookingStatusText('Starting Booking...');

        // Notify backend automation service
        try {
          await ticketService.startBooking(activeToken, ticket.id, { stopPayment });
        } catch (err) {
          console.warn('[OpenTicket] startBooking error:', err?.message);
          setBookingStatusText(`Error: ${err?.message || 'Failed to start booking'}`);
          setIsBookingActive(false);
          return;
        }

      // Start periodic status polling
      if (statusPollRef.current) clearInterval(statusPollRef.current);
      statusPollRef.current = setInterval(async () => {
        try {
          const statusRes = await ticketService.getBookingStatus(activeToken, ticket.id);
          if (statusRes?.status) {
            if (statusRes.authResult && statusRes.authResult.success === false) {
              setAuthResult(statusRes.authResult);
              if (statusRes.authResult.displayMessage) {
                setBookingStatusText(statusRes.authResult.displayMessage);
              } else {
                setBookingStatusText(statusRes.status);
              }
            } else {
              setAuthResult(statusRes.authResult || null);
              setBookingStatusText(statusRes.status);
            }

            // Real QR code handling (displayed ONLY when payment gateway produces one)
            if (statusRes.qrCode) {
              setQrCode(statusRes.qrCode);
            } else if (statusRes.qrCode === null || statusRes.bookingCompleted) {
              setQrCode(null);
            }

            if (statusRes.availability) {
              setAvailabilityText(statusRes.availability);
            } else if (statusRes.status.includes('Checking Availability')) {
              fetchLiveAvailability(activeToken, ticket.id);
            }

            const isTerminal =
              statusRes.status === 'Booking Completed' ||
              statusRes.status.startsWith('Booking Completed') ||
              statusRes.status === 'Stopped' ||
              statusRes.status.startsWith('Login Failed') ||
              statusRes.status.startsWith('Error') ||
              statusRes.status === 'Payment Timed Out' ||
              statusRes.status === 'Payment Failed / Cancelled' ||
              statusRes.status === 'Passenger Details Ready' ||
              statusRes.passengerPageReady === true ||
              statusRes.authResult?.success === false;

            if (isTerminal) {
              setIsBookingActive(false);
              if (statusRes.status === 'Payment Timed Out' || statusRes.status === 'Payment Failed / Cancelled' || statusRes.status.startsWith('Booking Completed')) {
                setQrCode(null);
              }
              if (statusPollRef.current) {
                clearInterval(statusPollRef.current);
                statusPollRef.current = null;
              }
            }
          }
        } catch {
          // Keep local state
        }
      }, 800);
    } else {
      // Stop booking process and record duration
      setIsBookingActive(false);
      setQrCode(null);
      if (statusPollRef.current) {
        clearInterval(statusPollRef.current);
        statusPollRef.current = null;
      }
      setBookingStatusText('Stopped');

      ticketService.stopBooking(activeToken, ticket.id).catch(() => {});

      const elapsed = secondsRef.current;
      const formattedDuration = formatTimer(elapsed);

      // Record duration in booking_history
      try {
        const account = accounts.find((a) => String(a.id) === String(ticket?.irctcAccountId));
        await toolService.createBookingHistory(activeToken, {
          ticket_name: ticket?.ticketName || 'Open Ticket',
          irctc_id: account?.irctcUserId || ticket?.irctcUserId || 'N/A',
          from_station: ticket?.fromStation || 'NDLS',
          to_station: ticket?.toStation || 'CSMT',
          journey_date: ticket?.journeyDate || new Date().toISOString().split('T')[0],
          remarks: `Auto-Booking Stopped (Duration: ${formattedDuration})`,
        });
      } catch (err) {
        console.warn('[OpenTicket] Could not record booking duration:', err);
      }
    }
    } finally {
      setIsTogglingBooking(false);
    }
  };

  // Resolve Ticket Display Data
  const ticketName = ticket?.ticketName || 'NDLS_CSMT';
  const fromStation = ticket?.fromStation || 'NDLS';
  const toStation = ticket?.toStation || 'CSMT';
  const trainNumber = ticket?.trainNumber || '12312';
  const selectedClass = ticket?.selectedClass || '3A';
  const quota = formatQuotaDisplay(ticket?.quota || 'Tatkal');
  const journeyDate = formatDisplayDate(ticket?.journeyDate);
  const slot = ticket?.slotSelection || ticket?.slotTime || 'S1';
  const matchedAccount = accounts.find((a) => String(a.id) === String(ticket?.irctcAccountId));
  const irctcId = matchedAccount?.irctcUserId || ticket?.irctcUserId || 'ID-1';
  const payment = ticket?.paymentMethod || 'SBI - UPI QR';

  return (
    <div className="tws-container" data-testid="open-ticket-detail-window">
      {/* 1. Header: Ticket Name + Close X (media_1789660957910.png) */}
      <header className="tws-titlebar">
        <span className="tws-title-text" data-testid="tws-ticket-title">
          {ticketName}
        </span>
        <button
          type="button"
          className="tws-close-btn"
          onClick={handleClose}
          aria-label="Close"
          title="Close Window"
          data-testid="btn-close-ticket-web"
        >
          ✕
        </button>
      </header>

      {/* 1b. Dynamic Booking Status Strip */}
      <div
        className={`tws-status-strip ${authResult?.code === 'IRCTC_CLIENT_IP_ERROR' ? 'tws-status-strip--client-ip' : ''} ${authResult?.code === 'IRCTC_INVALID_CREDENTIALS' ? 'tws-status-strip--invalid-creds' : ''}`}
        data-testid="tws-booking-status-strip"
      >
        <span className="tws-status-text" data-testid="tws-booking-status-text">
          {bookingStatusText}
        </span>
        {authResult?.clientIp && (
          <span className="tws-status-badge tws-status-badge--ip" title={`Rejected Client IP: ${authResult.clientIp}`}>
            Client IP: {authResult.clientIp}
          </span>
        )}
      </div>

      {/* 2. Dual Clocks: Live System Time & Auto-Booking Timer */}
      <div className={`tws-timer-strip ${isBookingActive ? 'tws-timer-strip--running' : ''}`} data-testid="tws-booking-timer">
        <span className="tws-timer-label">System Time:</span>
        <span className="tws-timer-value tws-system-time-value" data-testid="system-time-value">{systemTime}</span>
        <span className="tws-timer-divider" style={{ margin: '0 4px', color: '#cbd5e1' }}>|</span>
        <span className="tws-timer-label">Booking Time:</span>
        <span className="tws-timer-value" data-testid="timer-value">{formatTimer(bookingSeconds)}</span>
        {isBookingActive && <span className="tws-timer-badge">RUNNING</span>}
      </div>

      {/* 3. Ticket Fields Grid (Text-only, auto-populated, disabled/read-only) */}
      <div className="tws-grid-container">
        {/* Row 1: From <-> To */}
        <div className="tws-card-row tws-row-stations">
          <div className="tws-field-group">
            <label className="tws-label">From</label>
            <input
              type="text"
              className="tws-input"
              value={fromStation}
              readOnly
              disabled
              data-testid="field-from-station"
            />
          </div>

          <div className="tws-swap-separator" aria-hidden="true">
            ⇄
          </div>

          <div className="tws-field-group">
            <label className="tws-label">To</label>
            <input
              type="text"
              className="tws-input"
              value={toStation}
              readOnly
              disabled
              data-testid="field-to-station"
            />
          </div>
        </div>

        {/* Row 2: Train | Class */}
        <div className="tws-card-row tws-row-train">
          <div className="tws-field-group">
            <label className="tws-label">Train</label>
            <input
              type="text"
              className="tws-input"
              value={trainNumber}
              readOnly
              disabled
              data-testid="field-train-number"
            />
          </div>

          <div className="tws-field-group">
            <label className="tws-label">Class</label>
            <input
              type="text"
              className="tws-input"
              value={selectedClass}
              readOnly
              disabled
              data-testid="field-class"
            />
          </div>
        </div>

        {/* Row 3: Quota | Date */}
        <div className="tws-card-row tws-row-quota-date">
          <div className="tws-field-group">
            <label className="tws-label">Quota</label>
            <input
              type="text"
              className="tws-input"
              value={quota}
              readOnly
              disabled
              data-testid="field-quota"
            />
          </div>

          <div className="tws-field-group">
            <label className="tws-label">Date</label>
            <input
              type="text"
              className="tws-input"
              value={journeyDate}
              readOnly
              disabled
              data-testid="field-journey-date"
            />
          </div>
        </div>

        {/* Row 4: Slot | IRCTC ID */}
        <div className="tws-card-row tws-row-slot-id">
          <div className="tws-field-group">
            <label className="tws-label">Slot</label>
            <input
              type="text"
              className="tws-input"
              value={slot}
              readOnly
              disabled
              data-testid="field-slot"
            />
          </div>

          <div className="tws-field-group">
            <label className="tws-label">IRCTC ID</label>
            <input
              type="text"
              className="tws-input"
              value={irctcId}
              readOnly
              disabled
              data-testid="field-irctc-id"
            />
          </div>
        </div>

        {/* Row 5: Payment */}
        <div className="tws-card-row tws-row-payment">
          <div className="tws-field-group tws-payment-field-group">
            <label className="tws-label">Payment</label>
            <input
              type="text"
              className="tws-input"
              value={payment}
              readOnly
              disabled
              data-testid="field-payment-method"
            />
          </div>
          <label className="tws-stop-checkbox-label" title="Stop automation at payment stage">
            <input
              type="checkbox"
              className="tws-stop-checkbox"
              checked={stopPayment}
              onChange={(e) => setStopPayment(e.target.checked)}
              data-testid="checkbox-stop-payment"
            />
            <span>Stop</span>
          </label>
        </div>
      </div>

      {/* 4. Action Area: Login (Web) / Booking controls */}
      <div className="tws-action-area">
        {/* Real Seat Availability Display Strip */}
        <div className="tws-availability-strip" data-testid="tws-seat-availability-strip">
          <span className="tws-availability-label">Availability:</span>
          <span
            className={`tws-availability-value ${String(availabilityText).includes('AVAILABLE') ? 'tws-availability-value--avail' : ''}`}
            data-testid="tws-seat-availability-value"
          >
            {isCheckingAvailability ? 'Checking...' : availabilityText}
          </span>
          <button
            type="button"
            className="tws-availability-refresh-btn"
            onClick={() => fetchLiveAvailability()}
            disabled={isCheckingAvailability}
            title="Refresh Seat Availability"
            data-testid="btn-refresh-availability"
          >
            ↻
          </button>
        </div>

        {!activeBrowser ? (
          <button
            type="button"
            className="tws-btn-primary-login"
            onClick={() => setBrowserModalOpen(true)}
            disabled={isLaunching}
            data-testid="btn-login-web"
          >
            Login (Web)
          </button>
        ) : (
          <div className="tws-booking-actions">
            <button
              type="button"
              className={`tws-btn-booking ${isBookingActive ? 'tws-btn-booking--stop' : 'tws-btn-booking--start'}`}
              onClick={handleToggleBooking}
              data-testid="btn-toggle-booking"
            >
              {isBookingActive ? 'Stop Booking' : 'Start Booking'}
            </button>
            <button
              type="button"
              className="tws-btn-change-browser"
              onClick={() => setBrowserModalOpen(true)}
              disabled={isBookingActive}
              title="Change Browser"
              data-testid="btn-change-browser"
            >
              {activeBrowser} (Switch)
            </button>
          </div>
        )}
      </div>

      {/* 5. 5-Browser Selection Modal Flow */}
      {browserModalOpen && (
        <div className="tws-modal-overlay" onClick={() => setBrowserModalOpen(false)}>
          <div className="tws-browser-modal" onClick={(e) => e.stopPropagation()} data-testid="browser-selection-modal">
            <div className="tws-modal-header">
              <h3 className="tws-modal-title">Select Browser to Launch</h3>
              <button
                type="button"
                className="tws-modal-close"
                onClick={() => setBrowserModalOpen(false)}
              >
                ✕
              </button>
            </div>

            <p className="tws-modal-desc">Choose one of the 5 supported browsers for automation:</p>

            <div className="tws-browser-list">
              {SUPPORTED_BROWSERS.map((b) => {
                const avail = browserAvailability?.[b.key];
                const statusText = avail?.status || 'Available';
                const isAvail = avail ? avail.isAvailable : true;
                return (
                  <button
                    key={b.key}
                    type="button"
                    className="tws-browser-btn"
                    onClick={() => handleSelectBrowser(b.key, b.name)}
                    disabled={isLaunching}
                    data-testid={`btn-select-browser-${b.key}`}
                  >
                    <span className="tws-browser-btn-name">{b.name}</span>
                    <span
                      className="tws-browser-btn-status"
                      style={{
                        fontSize: '11px',
                        color: isAvail ? '#16a34a' : '#dc2626',
                        marginLeft: 'auto',
                        marginRight: '8px',
                        fontWeight: 500,
                      }}
                    >
                      {statusText}
                    </span>
                    <span className="tws-browser-btn-arrow">➔</span>
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              className="tws-modal-cancel"
              onClick={() => setBrowserModalOpen(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* 6. Real Payment QR Code Modal (Rendered ONLY when the payment gateway provides a real QR code) */}
      {qrCode && (
        <div className="tws-qr-overlay" onClick={() => setQrCode(null)} data-testid="tws-qr-modal-overlay">
          <div className="tws-qr-dialog" onClick={(e) => e.stopPropagation()} data-testid="tws-qr-dialog">
            <div className="tws-qr-header">
              <h3 className="tws-qr-title">Scan QR Code to Pay</h3>
              <button
                type="button"
                className="tws-qr-close-btn"
                onClick={() => setQrCode(null)}
                aria-label="Close QR Modal"
                title="Dismiss QR View"
                data-testid="btn-close-qr-modal"
              >
                ✕
              </button>
            </div>
            <div className="tws-qr-body">
              <img
                src={qrCode}
                alt="Payment Gateway QR Code"
                className="tws-qr-img"
                data-testid="tws-payment-qr-image"
              />
              <p className="tws-qr-instruction">
                Scan with your UPI App (GPay, PhonePe, Paytm, BHIM) to complete payment on the gateway.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
