import { useState, useEffect } from 'react';
import { useAuth } from '../app/auth-context';

import ticketService from '../services/ticketService';
import { formatQuotaDisplay } from '../utils/quotaDisplay';
import '../styles/ticket.css';

/**
 * Open Tickets Window (Total Ticket Screen)
 * Visual source of truth: media_1789479275721.png (bottom window).
 * Displays real saved tickets from PostgreSQL backend.
 */

function formatDate(dateStr) {
  if (!dateStr) return '—';
  // If in YYYY-MM-DD format, convert to DD-MM-YYYY
  const parts = String(dateStr).split('T')[0].split('-');
  if (parts.length === 3 && parts[0].length === 4) {
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }
  return dateStr;
}

export default function OpenTicketsPage() {
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

  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Per-ticket UI dropdown overrides (slot, web, app)
  const [ticketOptions, setTicketOptions] = useState({});

  // Obtain session token if opened as an independent BrowserWindow
  useEffect(() => {
    let isMounted = true;
    if (token) return;

    const bridge = typeof window !== 'undefined' ? window.netx : null;
    if (bridge?.app?.getOpenTicketsSession) {
      bridge.app.getOpenTicketsSession().then((sess) => {
        if (isMounted && sess?.token) {
          setToken(sess.token);
        }
      }).catch(() => {});
    }

    return () => {
      isMounted = false;
    };
  }, [token]);

  useEffect(() => {
    let ignore = false;
    async function fetchTickets() {
      if (!token) return;
      try {
        const data = await ticketService.listTickets(token);
        if (!ignore) {
          setTickets(Array.isArray(data) ? data : []);
          setLoading(false);
        }
      } catch (err) {
        if (!ignore) {
          console.error('[OpenTickets] Failed to load tickets:', err);
          setError(err?.message || 'Failed to load tickets from server.');
          setLoading(false);
        }
      }
    }

    fetchTickets();
    return () => {
      ignore = true;
    };
  }, [token]);


  const handleClose = () => {
    const bridge = typeof window !== 'undefined' ? window.netx : null;
    if (bridge?.app?.closeCurrentWindow) {
      bridge.app.closeCurrentWindow();
    } else if (typeof window !== 'undefined') {
      window.close();
    }
  };

  const handleOptionChange = (ticketId, field, value) => {
    setTicketOptions((prev) => ({
      ...prev,
      [ticketId]: {
        ...prev[ticketId],
        [field]: value,
      },
    }));
  };

  const handleOpenTicket = (ticket) => {
    const bridge = typeof window !== 'undefined' ? window.netx : null;
    if (bridge?.app?.openTicketWebSelectWindow) {
      const currentOpts = ticketOptions[ticket.id] || {};
      const activeToken = token || session?.token;
      const activeSession = session || (activeToken ? { token: activeToken } : null);
      bridge.app.openTicketWebSelectWindow({
        ...ticket,
        token: activeToken,
        session: activeSession,
        slotSelection: currentOpts.slot || ticket.slotTime || 'Slot-1',
        webSelection: currentOpts.web || '1',
      });
    }
  };

  const handleDelete = async (ticket) => {
    if (!window.confirm(`Are you sure you want to delete ticket "${ticket.ticketName}"?`)) {
      return;
    }
    try {
      await ticketService.deleteTicket(token, ticket.id);
      setTickets((prev) => prev.filter((t) => t.id !== ticket.id));
    } catch (err) {
      alert(`Delete failed: ${err.message || 'Unknown error'}`);
    }
  };

  const handleDeleteAll = async () => {
    if (tickets.length === 0) return;
    if (!window.confirm(`Are you sure you want to delete all ${tickets.length} tickets? This cannot be undone.`)) {
      return;
    }
    try {
      await ticketService.deleteAllTickets(token);
      setTickets([]);
    } catch (err) {
      alert(`Delete All failed: ${err.message || 'Unknown error'}`);
    }
  };

  const handleOpenAllTickets = () => {
    if (tickets.length === 0) return;
    tickets.forEach((t) => handleOpenTicket(t));
  };

  const handleEditTicket = (ticket) => {
    const bridge = typeof window !== 'undefined' ? window.netx : null;
    if (bridge?.app?.openTicketWindow) {
      const activeToken = token || session?.token;
      bridge.app.openTicketWindow({
        ...(session || {}),
        token: activeToken,
        initialTicket: ticket,
      });
    }
  };


  const countString = tickets.length < 10 ? `0${tickets.length}` : `${tickets.length}`;

  return (
    <div className="open-tickets-container">
      {/* Title Bar: Purple header with dynamic Total Ticket count and cyan close icon */}
      <header className="open-tickets-titlebar">
        <span className="open-tickets-title-text" data-testid="total-ticket-count">
          Total Ticket &nbsp; {countString}
        </span>
        <button
          type="button"
          className="open-tickets-close btn-window-close-cyan"
          onClick={handleClose}
          aria-label="Close"
          title="Close Open Tickets window"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="2" y1="2" x2="14" y2="14" />
            <line x1="14" y1="2" x2="2" y2="14" />
          </svg>
        </button>
      </header>

      {/* Main Table Area */}
      <div className="open-tickets-body">
        {loading ? (
          <div className="open-tickets-status-msg">Loading saved tickets...</div>
        ) : error ? (
          <div className="open-tickets-status-msg open-tickets-status-msg--error">{error}</div>
        ) : tickets.length === 0 ? (
          <div className="open-tickets-status-msg">No saved tickets found in database.</div>
        ) : (
          <div className="open-tickets-table-wrapper">
            <table className="open-tickets-table" aria-label="Saved Tickets">
              <thead>
                <tr>
                  <th className="th-num">#</th>
                  <th className="th-name">Name</th>
                  <th className="th-from">From</th>
                  <th className="th-to">To</th>
                  <th className="th-date">Date</th>
                  <th className="th-qt">QT</th>
                  <th className="th-cls">CLS</th>
                  <th className="th-slot">SLOT</th>
                  <th className="th-web">Web</th>
                  <th className="th-action">Open</th>
                  <th className="th-action">Login</th>
                  <th className="th-action">Edit</th>
                  <th className="th-action">Delete</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((ticket, index) => {
                  const opts = ticketOptions[ticket.id] || {};
                  const currentSlot = opts.slot || ticket.slotTime || 'Slot-1';
                  const currentWeb = opts.web || '1';

                  return (
                    <tr key={ticket.id}>
                      <td className="td-num">{index + 1}</td>
                      <td className="td-name" title={ticket.ticketName}>{ticket.ticketName}</td>
                      <td className="td-from">{ticket.fromStation}</td>
                      <td className="td-to">{ticket.toStation}</td>
                      <td className="td-date">{formatDate(ticket.journeyDate)}</td>
                      <td className="td-qt">{formatQuotaDisplay(ticket.quota)}</td>
                      <td className="td-cls">{ticket.selectedClass || 'SL'}</td>
                      <td className="td-slot">
                        <select
                          className="opt-select"
                          value={currentSlot}
                          onChange={(e) => handleOptionChange(ticket.id, 'slot', e.target.value)}
                        >
                          <option value="Slot-1">Slot-1</option>
                          <option value="Slot-2">Slot-2</option>
                          <option value="Slot-3">Slot-3</option>
                          <option value="Slot-4">Slot-4</option>
                          <option value="Slot-5">Slot-5</option>
                        </select>
                      </td>
                      <td className="td-web">
                        <select
                          className="opt-select opt-select--mini"
                          value={currentWeb}
                          onChange={(e) => handleOptionChange(ticket.id, 'web', e.target.value)}
                        >
                          <option value="1">1</option>
                          <option value="2">2</option>
                          <option value="3">3</option>
                        </select>
                      </td>
                      <td className="td-action">
                        <button
                          type="button"
                          className="btn-opt-action btn-opt-open"
                          onClick={() => handleOpenTicket(ticket)}
                          data-testid={`btn-open-ticket-${ticket.id}`}
                        >
                          Open
                        </button>
                      </td>
                      <td className="td-action">
                        <button
                          type="button"
                          className="btn-opt-action"
                          onClick={() => handleOpenTicket(ticket)}
                        >
                          Login
                        </button>
                      </td>
                      <td className="td-action">
                        <button
                          type="button"
                          className="btn-opt-action"
                          onClick={() => handleEditTicket(ticket)}
                        >
                          Edit
                        </button>
                      </td>
                      <td className="td-action">
                        <button
                          type="button"
                          className="btn-opt-action btn-opt-delete"
                          onClick={() => handleDelete(ticket)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Bottom Bar: Delete All and Open All Ticket */}
      <footer className="open-tickets-footer">
        <button
          type="button"
          className="btn-ot-footer btn-ot-delete-all"
          onClick={handleDeleteAll}
          disabled={tickets.length === 0}
          data-testid="btn-delete-all-tickets"
        >
          Delete All
        </button>
        <button
          type="button"
          className="btn-ot-footer btn-ot-open-all"
          onClick={handleOpenAllTickets}
          disabled={tickets.length === 0}
          data-testid="btn-open-all-tickets"
        >
          Open All Ticket
        </button>
      </footer>
    </div>
  );
}
