import { useState, useEffect, useCallback } from 'react';
import ticketService from '../services/ticketService';
import { QUOTA_LABELS, SUPPORTED_CLASSES } from '../config/trainConfig';
import '../styles/ticket.css';

const DEFAULT_QUOTAS = QUOTA_LABELS;
const DEFAULT_CLASSES = SUPPORTED_CLASSES;

function formatDuration(dur) {
  if (!dur || dur === '—') return '—';
  if (/^\d{1,2}h\s*\d{1,2}m$/.test(dur)) return dur;
  const match = dur.match(/^(\d{1,2}):(\d{2})$/);
  if (match) {
    return `${match[1]}h ${match[2]}m`;
  }
  return dur;
}

export default function SearchTrainPage() {
  const [token, setToken] = useState(null);
  const [fromStation, setFromStation] = useState('NDLS');
  const [toStation, setToStation] = useState('HWH');
  const [journeyDate, setJourneyDate] = useState('');
  const [selectedQuota, setSelectedQuota] = useState('General');
  const [selectedClass, setSelectedClass] = useState('3A');

  const [searching, setSearching] = useState(false);
  const [trains, setTrains] = useState([]);
  const [alert, setAlert] = useState(null);

  const handleClose = () => {
    const bridge = typeof window !== 'undefined' ? window.netx : null;
    if (bridge?.app?.closeCurrentWindow) {
      bridge.app.closeCurrentWindow();
    } else if (typeof window !== 'undefined') {
      window.close();
    }
  };

  const executeSearch = useCallback(
    async (authToken, from, to, date, quota, travelClass) => {
      if (!authToken) return;
      setSearching(true);
      setAlert(null);

      try {
        const results = await ticketService.searchTrains(authToken, {
          fromStation: (from || '').trim().toUpperCase(),
          toStation: (to || '').trim().toUpperCase(),
          journeyDate: date,
          quota,
          travelClass,
        });

        const list = Array.isArray(results) ? results : [];
        
        // Safeguard deduplication by train number, preserving non-empty timings
        const trainMap = new Map();
        for (const t of list) {
          const num = String(t.trainNumber || '').trim();
          if (!num) continue;
          if (!trainMap.has(num)) {
            trainMap.set(num, { ...t });
          } else {
            const cur = trainMap.get(num);
            if ((!cur.departureTime || cur.departureTime === '—') && t.departureTime && t.departureTime !== '—') {
              cur.departureTime = t.departureTime;
            }
            if ((!cur.arrivalTime || cur.arrivalTime === '—') && t.arrivalTime && t.arrivalTime !== '—') {
              cur.arrivalTime = t.arrivalTime;
            }
            if ((!cur.duration || cur.duration === '—') && t.duration && t.duration !== '—') {
              cur.duration = t.duration;
            }
            if (!cur.trainName && t.trainName) {
              cur.trainName = t.trainName;
            }
          }
        }
        const dedupedList = trainMap.size > 0 ? Array.from(trainMap.values()) : list;
        setTrains(dedupedList);

        if (dedupedList.length === 0) {
          setAlert({
            type: 'info',
            message: 'No trains found for this route and date on Ghumo.Live.',
          });
        }
      } catch (err) {
        let msg = err?.message || 'Failed to search trains on Ghumo.Live. Please verify details and try again.';
        if (err.code === 'SEARCH_RESULTS_TIMEOUT') {
          msg = 'Timeout: Train search results took too long to load.';
        } else if (err.code === 'SEARCH_SUBMISSION_FAILED') {
          msg = 'Search Submission Failed: Could not submit the search. Please verify station codes.';
        }

        const stageInfo = err?.stage ? ` [Stage: ${err.stage}]` : '';
        setAlert({
          type: 'error',
          message: `${msg}${stageInfo}`,
          code: err?.code,
          stage: err?.stage,
        });
      } finally {
        setSearching(false);
      }
    },
    []
  );

  // Initialize from electron params or ticket session
  useEffect(() => {
    let isMounted = true;
    const bridge = typeof window !== 'undefined' ? window.netx : null;

    async function init() {
      let initialToken = null;
      let initialFrom = 'NDLS';
      let initialTo = 'HWH';
      let initialDate = '';
      let initialQuota = 'General';
      let initialClass = '3A';

      if (bridge?.app?.getSearchParams) {
        try {
          const params = await bridge.app.getSearchParams();
          if (params) {
            if (params.token) initialToken = params.token;
            if (params.fromStation) initialFrom = params.fromStation;
            if (params.toStation) initialTo = params.toStation;
            if (params.journeyDate) initialDate = params.journeyDate;
            if (params.quota) initialQuota = params.quota;
            if (params.travelClass) initialClass = params.travelClass;
          }
        } catch {
          // ignore error fetching search params
        }
      }

      if (!initialToken && bridge?.app?.getTicketSession) {
        try {
          const sess = await bridge.app.getTicketSession();
          if (sess?.token) initialToken = sess.token;
        } catch {
          // ignore error fetching ticket session
        }
      }

      if (isMounted) {
        setToken(initialToken);
        setFromStation(initialFrom);
        setToStation(initialTo);
        setJourneyDate(initialDate);
        setSelectedQuota(initialQuota);
        setSelectedClass(initialClass);

        if (initialToken) {
          executeSearch(
            initialToken,
            initialFrom,
            initialTo,
            initialDate,
            initialQuota,
            initialClass
          );
        }
      }
    }

    init();
    return () => {
      isMounted = false;
    };
  }, [executeSearch]);

  const handleRefresh = () => {
    if (!token) return;
    executeSearch(
      token,
      fromStation,
      toStation,
      journeyDate,
      selectedQuota,
      selectedClass
    );
  };

  const handleQuotaChange = (q) => {
    setSelectedQuota(q);
    if (token) {
      executeSearch(
        token,
        fromStation,
        toStation,
        journeyDate,
        q,
        selectedClass
      );
    }
  };

  const handleClassChange = (cls) => {
    setSelectedClass(cls);
    if (token) {
      executeSearch(
        token,
        fromStation,
        toStation,
        journeyDate,
        selectedQuota,
        cls
      );
    }
  };

  const handleSwapStations = () => {
    const tmp = fromStation;
    setFromStation(toStation);
    setToStation(tmp);
  };

  const handleSelectTrain = (train) => {
    const selectedData = {
      ...train,
      selectedClass,
      quota: selectedQuota,
    };
    const bridge = typeof window !== 'undefined' ? window.netx : null;
    if (bridge?.app?.selectTrain) {
      bridge.app.selectTrain(selectedData);
    } else {
      handleClose();
    }
  };

  return (
    <div className="search-train-window-container">
      {/* Header Bar matching media_1789471329250.png edge-to-edge blue */}
      <header className="st-header-bar">
        <div className="st-header-left">
          <div className="st-header-icon" aria-hidden="true">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="4" y="3" width="16" height="16" rx="2" />
              <path d="M4 11h16" />
              <path d="M12 3v8" />
              <path d="m8 19-2 3" />
              <path d="m16 19 2 3" />
            </svg>
          </div>
          <div className="st-header-titles">
            <h1 className="st-header-title">Search Train &amp; Availability</h1>
            <span className="st-header-subtitle">
              Search trains and check real-time availability
            </span>
          </div>
        </div>
        <div className="st-header-right">
          <button
            type="button"
            className="btn-window-close-red"
            onClick={handleClose}
            title="Close window"
            aria-label="Close window"
          >
            &times;
          </button>
        </div>
      </header>

      {/* Content Body */}
      <div className="st-body">
        {/* Parameters Bar matching media_1789471329250.png */}
        <div className="st-params-bar">
          <div className="st-param-field">
            <span className="st-param-label">From</span>
            <input
              type="text"
              className="st-param-input"
              value={fromStation}
              onChange={(e) => setFromStation(e.target.value.toUpperCase())}
              placeholder="From"
              maxLength={5}
            />
          </div>

          <button
            type="button"
            className="st-param-swap-btn"
            onClick={handleSwapStations}
            title="Swap stations"
            aria-label="Swap stations"
          >
            &#8644;
          </button>

          <div className="st-param-field">
            <span className="st-param-label">To</span>
            <input
              type="text"
              className="st-param-input"
              value={toStation}
              onChange={(e) => setToStation(e.target.value.toUpperCase())}
              placeholder="To"
              maxLength={5}
            />
          </div>

          <div className="st-param-field">
            <span className="st-param-label">Date</span>
            <input
              type="date"
              className="st-param-input st-param-date"
              value={journeyDate}
              onChange={(e) => setJourneyDate(e.target.value)}
            />
          </div>

          <button
            type="button"
            className="btn-refresh-search"
            onClick={handleRefresh}
            disabled={searching}
          >
            {searching ? 'Searching...' : 'Refresh Search'}
          </button>
        </div>

        {/* Quota Pills */}
        <div className="st-pill-group">
          <span className="st-pill-title">Select Quota</span>
          <div className="st-pills-row">
            {DEFAULT_QUOTAS.map((q) => (
              <button
                key={q}
                type="button"
                className={`st-pill-btn ${selectedQuota === q ? 'st-pill-btn--active' : ''}`}
                onClick={() => handleQuotaChange(q)}
              >
                {q}
              </button>
            ))}
          </div>
        </div>

        {/* Class Pills */}
        <div className="st-pill-group">
          <span className="st-pill-title">Select Class</span>
          <div className="st-pills-row">
            {DEFAULT_CLASSES.map((cls) => (
              <button
                key={cls}
                type="button"
                className={`st-pill-btn ${selectedClass === cls ? 'st-pill-btn--active' : ''}`}
                onClick={() => handleClassChange(cls)}
              >
                {cls}
              </button>
            ))}
          </div>
        </div>

        {/* Alert / Notification */}
        {alert && (
          <div className={`ticket-alert ticket-alert--${alert.type}`} role="alert">
            {alert.message}
          </div>
        )}

        {/* Availability Table matching media_1789471329250.png */}
        <div className="st-table-container">
          <table className="st-trains-table">
            <thead>
              <tr>
                <th style={{ width: '6%', textAlign: 'center' }}>#</th>
                <th style={{ width: '22%' }}>Train No.</th>
                <th style={{ width: '13%' }}>Dep.</th>
                <th style={{ width: '13%' }}>Arr.</th>
                <th style={{ width: '13%' }}>Duration</th>
                <th style={{ width: '21%' }}>
                  Availability ({selectedClass} - {selectedQuota})
                </th>
                <th style={{ width: '12%', textAlign: 'right' }}>Select</th>
              </tr>
            </thead>
            <tbody>
              {searching ? (
                <tr>
                  <td colSpan="7" className="table-status-message">
                    Searching available trains...
                  </td>
                </tr>
              ) : trains.length === 0 ? (
                <tr>
                  <td colSpan="7" className="table-status-message">
                    No trains to display. Please verify stations or refresh search.
                  </td>
                </tr>
              ) : (
                trains.map((train, idx) => (
                  <tr key={train.trainNumber || idx}>
                    <td style={{ textAlign: 'center', fontWeight: 600, color: '#64748b' }}>
                      {idx + 1}
                    </td>
                    <td>
                      <span className="st-train-no">{train.trainNumber}</span>
                      {train.trainName && (
                        <span className="st-train-name" title={train.trainName}>
                          {train.trainName}
                        </span>
                      )}
                    </td>
                    <td>{train.departureTime || '—'}</td>
                    <td>{train.arrivalTime || '—'}</td>
                    <td>{formatDuration(train.duration)}</td>
                    <td>
                      <span
                        className={
                          String(train.availability).toUpperCase().includes('AVAILABLE')
                            ? 'st-status--available'
                            : String(train.availability).toUpperCase().includes('RAC')
                            ? 'st-status--rac'
                            : 'st-status--wl'
                        }
                      >
                        {train.availability || 'AVAILABLE'}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        type="button"
                        className="btn-st-select"
                        onClick={() => handleSelectTrain(train)}
                      >
                        Select
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Info Banner matching media_1789471329250.png */}
        <div className="st-info-banner">
          <span className="st-info-icon" aria-hidden="true">&#9432;</span>
          <div className="st-info-text">
            <span>Select Quota and Class to see real-time availability.</span>
            <span>Click on Select to fill details in New Ticket.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
