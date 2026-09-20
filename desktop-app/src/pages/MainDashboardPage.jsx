import { useEffect, useState, useRef } from 'react';
import { useAuth } from '../app/auth-context';
import '../styles/dashboard.css';

// NETX Post-Login Main Screen
// Clean, simplified layout with 4 text-based module options: ID, Bank, Ticket, Tool.
// TEXT-ONLY: Zero icon libraries, SVG icons, or emoji icons on module cards.
// Native OS window controls only.

function formatDateTime(now = new Date()) {
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });

  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

  return { timeStr, dateStr };
}

function MainDashboardPage() {
  const { session } = useAuth();

  const [version, setVersion] = useState('1.0.0');

  const [{ timeStr, dateStr }, setDateTime] = useState(() =>
    formatDateTime()
  );

  const [ticketMenuOpen, setTicketMenuOpen] = useState(false);
  const ticketWrapperRef = useRef(null);

  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const toolWrapperRef = useRef(null);

  const [infoModal, setInfoModal] = useState(null);

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (
        ticketWrapperRef.current &&
        !ticketWrapperRef.current.contains(event.target)
      ) {
        setTicketMenuOpen(false);
      }

      if (
        toolWrapperRef.current &&
        !toolWrapperRef.current.contains(event.target)
      ) {
        setToolMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Compact window size and version fetch
  useEffect(() => {
    const bridge =
      typeof window !== 'undefined' ? window.netx : null;

    if (bridge && bridge.app) {
      if (typeof bridge.app.setWindowSize === 'function') {
        bridge.app.setWindowSize(800, 185);
      }

      if (typeof bridge.app.getVersion === 'function') {
        bridge.app
          .getVersion()
          .then((v) => {
            if (v) setVersion(v);
          })
          .catch(() => {});
      }
    }

    // Keep clock updated every second
    const timer = setInterval(() => {
      setDateTime(formatDateTime());
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  const handleCardClick = (cardName) => {
    if (cardName === 'ID') {
      setTicketMenuOpen(false);
      setToolMenuOpen(false);

      if (
        typeof window !== 'undefined' &&
        window.netx?.app?.openAccountWindow
      ) {
        window.netx.app.openAccountWindow(session);
      }

      return;
    }

    if (cardName === 'Bank') {
      setTicketMenuOpen(false);
      setToolMenuOpen(false);

      if (
        typeof window !== 'undefined' &&
        window.netx?.app?.openBankWindow
      ) {
        window.netx.app.openBankWindow(session);
      }

      return;
    }

    if (cardName === 'Ticket') {
      setToolMenuOpen(false);
      setTicketMenuOpen((prev) => !prev);
      return;
    }

    if (cardName === 'Tool') {
      setTicketMenuOpen(false);
      setToolMenuOpen((prev) => !prev);
      return;
    }

    setTicketMenuOpen(false);
    setToolMenuOpen(false);
  };

  const handleClose = () => {
    const bridge =
      typeof window !== 'undefined' ? window.netx : null;

    if (bridge?.app?.closeCurrentWindow) {
      bridge.app.closeCurrentWindow();
    } else if (typeof window !== 'undefined') {
      window.close();
    }
  };

  return (
    <main className="dashboard-screen">
      <section
        className="dashboard-card"
        aria-label="NETX Main Dashboard"
      >
        {/* Top Header */}
        <header className="dashboard-header">
          <div className="dashboard-brand">
            <span className="brand-badge" aria-hidden="true">
              RAIL
            </span>

            <span
              className="brand-divider"
              aria-hidden="true"
            />

            <h1 className="dashboard-wordmark">
              <span className="dashboard-wordmark__base">
                NET
              </span>

              <span className="dashboard-wordmark__accent">
                X
              </span>
            </h1>
          </div>

          <div className="dashboard-header-right">
            <div
              className="datetime-pill"
              aria-label="Current time and date"
            >
              <span className="datetime-pill__time">
                {timeStr}
              </span>

              <span className="datetime-pill__date">
                {dateStr}
              </span>
            </div>

            <button
              type="button"
              className="window-close-btn"
              onClick={handleClose}
              aria-label="Close window"
              title="Close window"
              data-testid="main-dashboard-close-btn"
            >
              ✕
            </button>
          </div>
        </header>

        {/* 4 Main Action Cards */}
        <nav
          className="action-grid"
          aria-label="Main Navigation"
        >
          {/* 1. ID */}
          <button
            type="button"
            className="action-card action-card--id"
            onClick={() => handleCardClick('ID')}
            aria-label="ID module"
            data-testid="id-module-button"
          >
            <span className="action-label">ID</span>
          </button>

          {/* 2. Bank */}
          <button
            type="button"
            className="action-card action-card--bank"
            onClick={() => handleCardClick('Bank')}
            aria-label="Bank module"
            data-testid="bank-module-button"
          >
            <span className="action-label">Bank</span>
          </button>

          {/* 3. Ticket */}
          <div
            className="ticket-card-wrapper"
            ref={ticketWrapperRef}
          >
            <button
              type="button"
              data-testid="ticket-module-button"
              className={`action-card action-card--ticket ${
                ticketMenuOpen
                  ? 'action-card--active'
                  : ''
              }`}
              onClick={() => handleCardClick('Ticket')}
              aria-label="Ticket module"
              aria-haspopup="true"
              aria-expanded={ticketMenuOpen}
            >
              <span className="action-label">Ticket</span>
            </button>

            {ticketMenuOpen && (
              <div
                className="ticket-dropdown-menu"
                role="menu"
                data-testid="ticket-options-menu"
              >
                <button
                  type="button"
                  data-testid="btn-new-ticket-option"
                  className="ticket-dropdown-item"
                  role="menuitem"
                  onClick={() => {
                    setTicketMenuOpen(false);

                    if (
                      typeof window !== 'undefined' &&
                      window.netx?.app?.openTicketWindow
                    ) {
                      window.netx.app.openTicketWindow(
                        session
                      );
                    }
                  }}
                >
                  <span
                    className="ticket-dropdown-item__icon"
                    aria-hidden="true"
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                    >
                      <path d="M8 0a8 8 0 1 0 8 8A8.01 8.01 0 0 0 8 0zm3 8.75H8.75V11.5a.75.75 0 0 1-1.5 0V8.75H4.5a.75.75 0 0 1 0-1.5h2.75V4.5a.75.75 0 0 1 1.5 0v2.75H11a.75.75 0 0 1 0 1.5z" />
                    </svg>
                  </span>

                  <span>New Ticket</span>
                </button>

                <button
                  type="button"
                  data-testid="btn-open-tickets-option"
                  className="ticket-dropdown-item"
                  role="menuitem"
                  onClick={() => {
                    setTicketMenuOpen(false);

                    if (
                      typeof window !== 'undefined' &&
                      window.netx?.app
                        ?.openOpenTicketsWindow
                    ) {
                      window.netx.app.openOpenTicketsWindow(
                        session
                      );
                    }
                  }}
                >
                  <span
                    className="ticket-dropdown-item__icon"
                    aria-hidden="true"
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                    >
                      <path
                        fillRule="evenodd"
                        d="M2.5 12a.75.75 0 0 1 .75-.75h10a.75.75 0 0 1 0 1.5h-10A.75.75 0 0 1 2.5 12zm0-4a.75.75 0 0 1 .75-.75h10a.75.75 0 0 1 0 1.5h-10A.75.75 0 0 1 2.5 8zm0-4a.75.75 0 0 1 .75-.75h10a.75.75 0 0 1 0 1.5h-10A.75.75 0 0 1 2.5 4z"
                      />
                    </svg>
                  </span>

                  <span>Open Tickets</span>
                </button>
              </div>
            )}
          </div>

          {/* 4. Tool */}
          <div
            className="tool-card-wrapper"
            ref={toolWrapperRef}
          >
            <button
              type="button"
              data-testid="tool-module-button"
              className={`action-card action-card--tool ${
                toolMenuOpen
                  ? 'action-card--active'
                  : ''
              }`}
              onClick={() => handleCardClick('Tool')}
              aria-label="Tool module"
              aria-haspopup="true"
              aria-expanded={toolMenuOpen}
            >
              <span className="action-label">Tool</span>
            </button>

            {toolMenuOpen && (
              <div
                className="ticket-dropdown-menu tool-dropdown-menu"
                role="menu"
                data-testid="tools-options-menu"
              >
                {/* Booking History */}
                <button
                  type="button"
                  data-testid="btn-booking-history-option"
                  className="ticket-dropdown-item"
                  role="menuitem"
                  onClick={() => {
                    setToolMenuOpen(false);

                    if (
                      typeof window !== 'undefined' &&
                      window.netx?.app
                        ?.openBookingHistoryWindow
                    ) {
                      window.netx.app.openBookingHistoryWindow(
                        session
                      );
                    }
                  }}
                >
                  <span
                    className="ticket-dropdown-item__icon"
                    aria-hidden="true"
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                    >
                      <path d="M8.515 1.019A7 7 0 0 0 8 1V0a8 8 0 0 1 .589.022l-.074.997zm2.004.45a7.003 7.003 0 0 0-.985-.299l.219-.976c.383.086.753.203 1.107.349l-.341.926zm-4.038.299a7.003 7.003 0 0 0-.985.299l-.341-.926A7.95 7.95 0 0 1 6.262.294l.219.976zM8 3.5a.5.5 0 0 0-1 0V9a.5.5 0 0 0 .252.434l3.5 2a.5.5 0 0 0 .496-.868L8 8.71V3.5z" />
                      <path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm7-8A7 7 0 1 1 1 8a7 7 0 0 1 14 0z" />
                    </svg>
                  </span>

                  <span>Booking History</span>
                </button>

                {/* Add Proxy IP */}
                <button
                  type="button"
                  data-testid="btn-add-proxy-option"
                  className="ticket-dropdown-item"
                  role="menuitem"
                  onClick={() => {
                    setToolMenuOpen(false);

                    if (
                      typeof window !== 'undefined' &&
                      window.netx?.app
                        ?.openProxySettingWindow
                    ) {
                      window.netx.app.openProxySettingWindow(
                        session
                      );
                    }
                  }}
                >
                  <span
                    className="ticket-dropdown-item__icon"
                    aria-hidden="true"
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                    >
                      <path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm7.5-6.923c-.67.204-1.335.82-1.887 1.855A7.97 7.97 0 0 0 5.145 4H7.5V1.077zM4.09 4a9.267 9.267 0 0 1 .64-1.539 6.7 6.7 0 0 1 .597-.933A7.025 7.025 0 0 0 2.255 4H4.09zm-.582 3.5c.03-.877.138-1.718.312-2.5H1.67A6.974 6.974 0 0 0 1 7.5h2.508zM8 8H4.5a13.3 13.3 0 0 0 .195 2.5h3.305V8zm0-1.5H4.695A13.3 13.3 0 0 1 4.5 4H8v2.5zm0 5V14.923c.67-.204 1.335-.82 1.887-1.855.36-.667.64-1.418.815-2.222H8zm-3.387 1.068c.36.667.64 1.418.815 2.222A7.97 7.97 0 0 1 8 14.923V12H5.145a9.27 9.27 0 0 1-.532-.932z" />
                    </svg>
                  </span>

                  <span>Add Proxy IP</span>
                </button>

                {/* Cookie Delete */}
                <button
                  type="button"
                  data-testid="btn-cookie-delete-option"
                  className="ticket-dropdown-item"
                  role="menuitem"
                  onClick={() => {
                    setToolMenuOpen(false);

                    if (
                      typeof window !== 'undefined' &&
                      window.netx?.app
                        ?.openCookieDeleteWindow
                    ) {
                      window.netx.app.openCookieDeleteWindow(
                        session
                      );
                    } else {
                      window.location.hash =
                        '#cookie-delete';
                    }
                  }}
                >
                  <span
                    className="ticket-dropdown-item__icon"
                    aria-hidden="true"
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                    >
                      <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z" />
                      <path
                        fillRule="evenodd"
                        d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"
                      />
                    </svg>
                  </span>

                  <span>Cookie Delete</span>
                </button>

                {/* Software Version Check */}
                <button
                  type="button"
                  data-testid="btn-version-check-option"
                  className="ticket-dropdown-item"
                  role="menuitem"
                  onClick={() => {
                    setToolMenuOpen(false);

                    if (
                      typeof window !== 'undefined' &&
                      window.netx?.app
                        ?.openVersionCheckWindow
                    ) {
                      window.netx.app.openVersionCheckWindow(
                        session
                      );
                    } else {
                      window.location.hash =
                        '#version-check';
                    }
                  }}
                >
                  <span
                    className="ticket-dropdown-item__icon"
                    aria-hidden="true"
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                    >
                      <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z" />
                      <path d="M10.97 4.97a.235.235 0 0 0-.02.022L7.477 9.417 5.384 7.323a.75.75 0 0 0-1.06 1.06L6.97 11.03a.75.75 0 0 0 1.079-.02l3.992-4.99a.75.75 0 0 0-1.071-1.05z" />
                    </svg>
                  </span>

                  <span>Software Version Check</span>
                </button>

                {/* Backup & Restore */}
                <button
                  type="button"
                  data-testid="btn-backup-restore-option"
                  className="ticket-dropdown-item"
                  role="menuitem"
                  onClick={() => {
                    setToolMenuOpen(false);

                    if (
                      typeof window !== 'undefined' &&
                      window.netx?.app
                        ?.openBackupRestoreWindow
                    ) {
                      window.netx.app.openBackupRestoreWindow(
                        session
                      );
                    }
                  }}
                >
                  <span
                    className="ticket-dropdown-item__icon"
                    aria-hidden="true"
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                    >
                      <path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z" />
                      <path d="M7.646 1.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1-.708.708L8.5 2.707V11.5a.5.5 0 0 1-1 0V2.707L5.354 4.854a.5.5 0 1 1-.708-.708l3-3z" />
                    </svg>
                  </span>

                  <span>Backup &amp; Restore</span>
                </button>
              </div>
            )}
          </div>
        </nav>

        {/* Informational Dialog Modal */}
        {infoModal && (
          <div
            className="license-modal-overlay"
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 999,
            }}
            onClick={() => setInfoModal(null)}
          >
            <div
              className="license-modal-card"
              style={{
                width: 350,
                margin: 'auto',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div
                style={{
                  padding: '14px 18px',
                  borderBottom: '1px solid #cbd5e1',
                }}
              >
                <h3
                  style={{
                    margin: 0,
                    fontSize: 14,
                    fontWeight: 700,
                    color: '#0f172a',
                  }}
                >
                  {infoModal.title}
                </h3>
              </div>

              <div
                style={{
                  padding: '16px 18px',
                  fontSize: 13,
                  color: '#334155',
                  whiteSpace: 'pre-line',
                  lineHeight: 1.5,
                }}
              >
                {infoModal.message}
              </div>

              <div className="license-modal-footer">
                <button
                  type="button"
                  className="license-modal-ok-btn"
                  onClick={() => setInfoModal(null)}
                  data-testid="btn-info-modal-ok"
                >
                  OK
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Bottom Status Footer */}
        <footer className="dashboard-footer">
          <div className="footer-section">
            <span data-testid="app-version">
              Version {version}
            </span>
          </div>

          <span
            className="footer-divider"
            aria-hidden="true"
          />

          <div className="footer-section">
            <span className="status-pill">Ready</span>
          </div>

          <span
            className="footer-divider"
            aria-hidden="true"
          />

          <div className="footer-section">
            <span>
              Validity:{' '}
              <span className="validity-text">
                26 Days (05-Oct-2026)
              </span>
            </span>
          </div>
        </footer>
      </section>
    </main>
  );
}

export default MainDashboardPage;