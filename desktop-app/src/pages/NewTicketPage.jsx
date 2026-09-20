import { useState, useEffect } from 'react';
import { useAuth } from '../app/auth-context';
import irctcAccountService from '../services/irctcAccountService';
import ticketService from '../services/ticketService';
import bankService from '../services/bankService';
import { QUOTA_LABELS, TICKET_CLASS_OPTIONS, getMaxPassengersForQuota } from '../config/trainConfig';
import '../styles/ticket.css';

// Client requirement: hide the Senior checkbox in Passenger Details while preserving state
const SHOW_SENIOR_OPTION = false;

const DEFAULT_QUOTAS = QUOTA_LABELS;
const DEFAULT_CLASSES = TICKET_CLASS_OPTIONS;


const TRAIN_TYPES = [
  'Select Train Type',
  'Rajdhani',
  'Shatabdi',
  'Duronto',
  'Superfast',
  'Mail/Express',
  'Vande Bharat',
  'Special',
];

const TICKET_SLOTS = [
  'Select_Auto Slot',
  'Tatkal AC (09:58)',
  'Tatkal Non-AC (10:58)',
  'General (07:58)',
  'Custom Slot',
];

const PAYMENT_METHODS = [
  'Select Payment Method',
  'Default Payment (Auto)',
  'IRCTC iMudra',
  'BHIM / UPI / QR Code',
  'Net Banking',
  'Payment Gateway (Cards/EMI)',
];

const DEFAULT_PRIOR_BANK = 'Select Your Bank';
const DEFAULT_BACKUP_BANK = 'No Alternate Bank';

const INITIAL_PASSENGERS = Array.from({ length: 6 }, (_, i) => ({
  id: i + 1,
  name: '',
  age: '',
  sex: 'Male',
  berthPreference: 'No Preference',
  food: 'No Preference',
  nationality: 'India-IN',
  passport: '',
  child: false,
  senior: false,
  bed: false,
}));

function getTomorrowDateString() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

export default function NewTicketPage() {
  const { session } = useAuth();
  const [token, setToken] = useState(() => session?.token || null);
  const [editingTicketId, setEditingTicketId] = useState(null);

  const applyTicketData = (ticket) => {
    if (!ticket) return;
    setEditingTicketId(ticket.id || null);
    if (ticket.ticketName) setTicketName(ticket.ticketName);
    if (ticket.fromStation) setFromStation(ticket.fromStation);
    if (ticket.toStation) setToStation(ticket.toStation);
    if (ticket.journeyDate) {
      const parts = String(ticket.journeyDate).split('T')[0];
      setJourneyDate(parts);
    }
    if (ticket.boardingPoint) setBoardingPoint(ticket.boardingPoint);
    if (ticket.trainNumber) setTrainNumber(ticket.trainNumber);
    if (ticket.selectedClass) setSelectedClass(ticket.selectedClass);
    if (ticket.quota) setSelectedQuota(ticket.quota);
    if (ticket.slotTime) setTicketSlot(ticket.slotTime);
    if (ticket.paymentMethod) setPaymentMethod(ticket.paymentMethod);
    if (ticket.priorBank) setPriorBank(ticket.priorBank);
    if (ticket.backupBank) setBackupBank(ticket.backupBank);
    if (ticket.mobileNumber) setMobileNumber(ticket.mobileNumber);
    if (ticket.irctcAccountId) setSelectedAccountId(String(ticket.irctcAccountId));
    if (ticket.autoUpgradation !== undefined) setAutoUpgradation(Boolean(ticket.autoUpgradation));
    if (ticket.confirmBerthsOnly !== undefined) setConfirmBerthsOnly(Boolean(ticket.confirmBerthsOnly));

    setSelectedTrain({
      trainNumber: ticket.trainNumber || '',
      trainName: ticket.trainName || '',
      selectedClass: ticket.selectedClass || '3A',
      quota: ticket.quota || 'General',
      boardingPoint: ticket.boardingPoint || ticket.fromStation || '',
      journeyTime: ticket.journeyTime || '',
      slotTime: ticket.slotTime || '',
    });

    if (ticket.passengers) {
      try {
        const raw = Array.isArray(ticket.passengers)
          ? ticket.passengers
          : typeof ticket.passengers === 'string'
          ? JSON.parse(ticket.passengers)
          : [];
        const populated = Array.from({ length: 6 }, (_, i) => {
          const p = raw[i];
          if (p) {
            return {
              id: i + 1,
              name: p.name || '',
              age: p.age != null ? String(p.age) : '',
              sex: p.sex || 'Male',
              berthPreference: p.berthPreference || 'No Preference',
              food: p.food || 'No Preference',
              nationality: p.nationality || 'India-IN',
              passport: p.passport || p.idNumber || '',
              child: Boolean(p.child),
              senior: Boolean(p.senior),
              bed: Boolean(p.bed),
            };
          }
          return { ...INITIAL_PASSENGERS[i] };
        });
        setPassengers(populated);
      } catch (err) {
        console.error('Error parsing passengers for edit:', err);
      }
    }

    setAlert({
      type: 'info',
      message: `Editing saved ticket "${ticket.ticketName || ticket.id}". Modify fields and click Save.`,
    });
  };

  // Fetch token & initialTicket if opened as an independent BrowserWindow
  useEffect(() => {
    let isMounted = true;

    if (session?.initialTicket) {
      applyTicketData(session.initialTicket);
    }

    const bridge = typeof window !== 'undefined' ? window.netx : null;
    if (bridge?.app?.getTicketSession) {
      bridge.app.getTicketSession().then((sess) => {
        if (isMounted && sess) {
          if (sess.token && !token) {
            setToken(sess.token);
          }
          if (sess.initialTicket) {
            applyTicketData(sess.initialTicket);
          }
        }
      }).catch(() => {});
    }

    let unsubscribe = null;
    if (bridge?.app?.onTicketSessionUpdated) {
      unsubscribe = bridge.app.onTicketSessionUpdated((sess) => {
        if (sess) {
          if (sess.token) setToken(sess.token);
          if (sess.initialTicket) applyTicketData(sess.initialTicket);
        }
      });
    }

    return () => {
      isMounted = false;
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [session, token]);

  // Account State
  const [accounts, setAccounts] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');

  // Top Section 1: Journey & Train Criteria (matches media_1789453391132.png)
  const [fromStation, setFromStation] = useState('NDLS');
  const [toStation, setToStation] = useState('HWH');
  const [journeyDate, setJourneyDate] = useState(() => getTomorrowDateString());
  const [boardingPoint, setBoardingPoint] = useState('NDLS');
  const [trainNumber, setTrainNumber] = useState('');
  const [trainType, setTrainType] = useState('Select Train Type');
  const [selectedClass, setSelectedClass] = useState('3A');
  const [selectedQuota, setSelectedQuota] = useState('General');

  // Selected Train info from Window 3
  const [selectedTrain, setSelectedTrain] = useState({
    trainNumber: '',
    trainName: '',
    selectedClass: '3A',
    quota: 'General',
    boardingPoint: 'NDLS',
    journeyTime: '',
    slotTime: '',
  });

  // Section 2: Passenger Details (6 Rows)
  const [passengers, setPassengers] = useState(INITIAL_PASSENGERS);
  const [passengerWarnings, setPassengerWarnings] = useState({});

  // Contact & Fare
  const [mobileNumber, setMobileNumber] = useState('');
  const [fareText, setFareText] = useState('Base');

  // Bottom Configuration Section (Mint Green)
  const [ticketSlot, setTicketSlot] = useState('Select_Auto Slot');
  const [paymentMethod, setPaymentMethod] = useState('Default Payment (Auto)');
  const [priorBank, setPriorBank] = useState(DEFAULT_PRIOR_BANK);
  const [backupBank, setBackupBank] = useState(DEFAULT_BACKUP_BANK);
  const [savedBanks, setSavedBanks] = useState([]);
  const [autoUpgradation, setAutoUpgradation] = useState(true);
  const [confirmBerthsOnly, setConfirmBerthsOnly] = useState(true);
  const [ticketName, setTicketName] = useState(() => `NDLS - HWH (${getTomorrowDateString()})`);

  const [saving, setSaving] = useState(false);
  const [alert, setAlert] = useState(null);

  // Load IRCTC Accounts on Mount
  useEffect(() => {
    let isMounted = true;
    async function fetchAccounts() {
      if (!token) return;
      try {
        const list = await irctcAccountService.listAccounts(token);
        if (isMounted) {
          setAccounts(Array.isArray(list) ? list : []);
          if (list && list.length > 0 && !selectedAccountId) {
            setSelectedAccountId(String(list[0].id));
          }
        }
      } catch (err) {
        if (isMounted) {
          setAlert({ type: 'error', message: err?.message || 'Failed to load saved IRCTC accounts.' });
        }
      }
    }
    fetchAccounts();
    return () => {
      isMounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Load Saved Banks from Backend (Single Source of Truth) and subscribe to updates
  useEffect(() => {
    let isMounted = true;
    async function fetchBanks() {
      if (!token) return;
      try {
        const list = await bankService.listBanks(token);
        if (isMounted) {
          setSavedBanks(Array.isArray(list) ? list : []);
        }
      } catch {
        // Fallback gracefully
      }
    }
    fetchBanks();

    const bridge = typeof window !== 'undefined' ? window.netx : null;
    let unsubscribe = null;
    if (bridge?.app?.onBanksChanged) {
      unsubscribe = bridge.app.onBanksChanged(() => {
        fetchBanks();
      });
    }

    return () => {
      isMounted = false;
      if (unsubscribe) unsubscribe();
    };
  }, [token]);

  // Listen for train selected from child SearchTrainWindow via IPC
  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.netx : null;
    if (!bridge?.app?.onTrainSelected) return;

    const unsubscribe = bridge.app.onTrainSelected((train) => {
      if (train) {
        setTrainNumber(train.trainNumber || '');
        setBoardingPoint(fromStation.toUpperCase());
        if (train.selectedClass) setSelectedClass(train.selectedClass);
        if (train.quota) setSelectedQuota(train.quota);

        setSelectedTrain({
          trainNumber: train.trainNumber || '',
          trainName: train.trainName || '',
          selectedClass: train.selectedClass || selectedClass || '3A',
          quota: train.quota || selectedQuota || 'General',
          boardingPoint: fromStation.toUpperCase(),
          journeyTime: `${train.departureTime || '16:55'} - ${train.arrivalTime || '10:00'}`,
          slotTime: train.duration || '17h 05m',
        });

        setFareText(`₹${train.trainNumber ? (parseInt(train.trainNumber.slice(-3), 10) * 2 + 850) : 'Base'}`);
        setAlert({
          type: 'success',
          message: `Train ${train.trainNumber} selected! Details populated automatically.`,
        });
      }
    });

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [fromStation, selectedClass, selectedQuota]);

  const handleSwapStations = () => {
    const temp = fromStation;
    setFromStation(toStation);
    setToStation(temp);
    setBoardingPoint(toStation);
    setTicketName(`${toStation} - ${temp} (${journeyDate})`);
  };

  const handleSearchTrains = (e) => {
    if (e) e.preventDefault();
    setAlert(null);

    const activeAccountId = selectedAccountId || (accounts.length > 0 ? String(accounts[0].id) : '1');
    const cleanFrom = fromStation.trim().toUpperCase();
    const cleanTo = toStation.trim().toUpperCase();

    if (!cleanFrom || !cleanTo) {
      setAlert({ type: 'error', message: 'Please enter both From and To stations.' });
      return;
    }
    if (cleanFrom === cleanTo) {
      setAlert({ type: 'error', message: 'From Station and To Station cannot be the same.' });
      return;
    }

    const bridge = typeof window !== 'undefined' ? window.netx : null;
    if (bridge?.app?.openSearchTrainWindow) {
      bridge.app.openSearchTrainWindow({
        token,
        accountId: activeAccountId,
        fromStation: cleanFrom,
        toStation: cleanTo,
        journeyDate,
        quota: selectedQuota,
        travelClass: selectedClass,
      });
    } else {
      setAlert({
        type: 'info',
        message: 'Search Train window opened in desktop client.',
      });
    }
  };

  const handlePassengerNameChange = (index, rawValue) => {
    const sanitized = rawValue.replace(/[^a-zA-Z\s]/g, '');
    let warning = '';
    if (rawValue !== sanitized) {
      warning = 'Letters and spaces only';
    } else if (sanitized.trim().length > 0 && sanitized.trim().length < 2) {
      warning = 'Min 2 letters';
    }
    setPassengerWarnings((prev) => ({
      ...prev,
      [index]: { ...prev[index], name: warning },
    }));

    setPassengers((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], name: sanitized };
      return copy;
    });
  };

  const handlePassengerAgeChange = (index, rawValue) => {
    const sanitized = rawValue.replace(/\D/g, '').slice(0, 3);
    let warning = '';
    if (rawValue !== sanitized && rawValue !== '') {
      warning = 'Numbers only';
    } else if (sanitized !== '') {
      const num = parseInt(sanitized, 10);
      if (num < 1 || num > 125) {
        warning = '1-125 only';
      }
    }
    setPassengerWarnings((prev) => ({
      ...prev,
      [index]: { ...prev[index], age: warning },
    }));

    setPassengers((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], age: sanitized };
      return copy;
    });
  };

  const handlePassengerChange = (index, field, value) => {
    setPassengers((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], [field]: value };
      return copy;
    });
  };

  const resetForm = () => {
    setEditingTicketId(null);
    setPassengers(INITIAL_PASSENGERS);
    setPassengerWarnings({});
    setTicketName(`NDLS - HWH (${getTomorrowDateString()})`);
    setMobileNumber('');
    setFareText('Base');
    setTrainNumber('');
    setSelectedTrain({
      trainNumber: '',
      trainName: '',
      selectedClass: '3A',
      quota: 'General',
      boardingPoint: 'NDLS',
      journeyTime: '',
      slotTime: '',
    });
  };

  const maxAllowed = getMaxPassengersForQuota(selectedQuota);
  const activePassengers = passengers.slice(0, maxAllowed);
  const filledPassengers = activePassengers.filter(
    (p) => p.name.trim().length > 0 || String(p.age).trim().length > 0
  );

  const hasValidAccount = Boolean(selectedAccountId || (accounts.length > 0 ? accounts[0].id : null));
  const hasValidStations =
    Boolean(fromStation.trim()) &&
    Boolean(toStation.trim()) &&
    fromStation.trim().toUpperCase() !== toStation.trim().toUpperCase();
  const hasValidDate = Boolean(journeyDate) && !isNaN(Date.parse(journeyDate));
  const hasValidTicketName = Boolean(ticketName.trim());

  const hasAtLeastOnePassenger = filledPassengers.length > 0;
  const allPassengersValid =
    hasAtLeastOnePassenger &&
    filledPassengers.every((p) => {
      const nameValid = /^[a-zA-Z\s]{2,50}$/.test(p.name.trim());
      const rawAge = String(p.age).trim();
      const ageValid =
        /^\d{1,3}$/.test(rawAge) && parseInt(rawAge, 10) >= 1 && parseInt(rawAge, 10) <= 125;
      return nameValid && ageValid;
    });

  const hasPassengerWarnings = Object.values(passengerWarnings).some(
    (w) => Boolean(w?.name) || Boolean(w?.age)
  );

  const isFormValid =
    hasValidAccount &&
    hasValidStations &&
    hasValidDate &&
    hasValidTicketName &&
    allPassengersValid &&
    !hasPassengerWarnings;

  const handleSaveTicket = async (e) => {
    if (e) e.preventDefault();
    setAlert(null);

    if (!isFormValid) {
      setAlert({ type: 'error', message: 'Please complete all required fields with valid values.' });
      return;
    }

    const activeAccountId = selectedAccountId || (accounts.length > 0 ? accounts[0].id : null);
    setSaving(true);
    try {
      const payload = {
        irctcAccountId: parseInt(activeAccountId, 10),
        ticketName: ticketName.trim(),
        fromStation: fromStation.trim().toUpperCase(),
        toStation: toStation.trim().toUpperCase(),
        journeyDate,
        quota: selectedQuota,
        selectedClass,
        trainNumber: trainNumber || selectedTrain.trainNumber,
        trainName: selectedTrain.trainName || `Train ${trainNumber}`,
        boardingPoint: boardingPoint || fromStation.trim().toUpperCase(),
        journeyTime: selectedTrain.journeyTime,
        slotTime: ticketSlot,
        passengers: filledPassengers.map((p) => ({
          ...p,
          name: p.name.trim(),
          age: parseInt(p.age, 10),
        })),
        mobileNumber: mobileNumber.trim(),
        email: '',
        paymentMethod,
      };

      let result;
      if (editingTicketId) {
        result = await ticketService.updateTicket(token, editingTicketId, payload);
        setAlert({
          type: 'success',
          message: `Ticket "${result?.ticketName || payload.ticketName}" updated successfully in PostgreSQL!`,
        });
      } else {
        result = await ticketService.saveTicket(token, payload);
        resetForm();
        setAlert({
          type: 'success',
          message: `Ticket "${result?.ticketName || payload.ticketName}" saved successfully in PostgreSQL!`,
        });
      }
    } catch (err) {
      setAlert({
        type: 'error',
        message: err?.message || 'Failed to save ticket configuration.',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    const bridge = typeof window !== 'undefined' ? window.netx : null;
    if (bridge?.app?.closeCurrentWindow) {
      bridge.app.closeCurrentWindow();
    } else if (typeof window !== 'undefined') {
      window.close();
    }
  };

  return (
    <div className="new-ticket-container">
      {/* Title Bar (media_1789453391132.png: Purple header with New Ticket and cyan close icon) */}
      <header className="nt-titlebar">
        <span className="nt-title-text ticket-header-title">{editingTicketId ? 'Edit Ticket' : 'New Ticket'}</span>
        <button
          type="button"
          className="nt-title-close btn-window-close-cyan"
          onClick={handleClose}
          aria-label="Close"
          title="Close New Ticket window"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="2" y1="2" x2="14" y2="14" />
            <line x1="14" y1="2" x2="2" y2="14" />
          </svg>
        </button>
      </header>

      {/* Main Body */}
      <div className="nt-body">
        {/* Global Alert Notification */}
        {alert && (
          <div className={`nt-alert nt-alert--${alert.type}`} role="alert">
            {alert.message}
          </div>
        )}

        {/* Account Selector Strip (Hidden/Compact for multi-account support) */}
        {accounts.length > 1 && (
          <div className="nt-account-strip">
            <span className="nt-acc-label">Active IRCTC ID:</span>
            <select
              id="irctc-account-select"
              className="nt-acc-select"
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
            >
              {accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.irctcUserId || acc.username} (#{acc.id})
                </option>
              ))}
            </select>
          </div>
        )}

        {/* TOP SECTION: JOURNEY & TRAIN INPUTS (Exact layout from media_1789453391132.png) */}
        <div className="nt-top-grid">
          {/* Row 1: From, Swap, To, Date, Find */}
          <div className="nt-row nt-row-1">
            <div className="nt-field nt-field-from">
              <label className="nt-label" htmlFor="from-input">From:</label>
              <input
                id="from-input"
                data-testid="from-station-input"
                type="text"
                className="nt-input nt-input-from"
                value={fromStation}
                onChange={(e) => setFromStation(e.target.value.toUpperCase())}
                placeholder="Station code"
              />
            </div>

            <button
              type="button"
              className="nt-btn-swap"
              onClick={handleSwapStations}
              title="Swap From and To stations"
              aria-label="Swap Stations"
            >
              &#8644;
            </button>

            <div className="nt-field nt-field-to">
              <label className="nt-label" htmlFor="to-input">To:</label>
              <input
                id="to-input"
                data-testid="to-station-input"
                type="text"
                className="nt-input nt-input-to"
                value={toStation}
                onChange={(e) => setToStation(e.target.value.toUpperCase())}
                placeholder="Station code"
              />
            </div>

            <div className="nt-field nt-field-date">
              <label className="nt-label" htmlFor="date-input">Date:</label>
              <input
                id="date-input"
                data-testid="journey-date-input"
                type="date"
                className="nt-input nt-input-date"
                value={journeyDate}
                onChange={(e) => {
                  setJourneyDate(e.target.value);
                  setTicketName(`${fromStation} - ${toStation} (${e.target.value})`);
                }}
              />
            </div>

            <button
              type="button"
              className="nt-btn-find btn-search-trains"
              onClick={handleSearchTrains}
              title="Search trains on IRCTC"
            >
              Find
            </button>
          </div>

          {/* Row 2: Bdg Pt, Train No, Train Type, Availability */}
          <div className="nt-row nt-row-2">
            <div className="nt-field nt-field-bdg">
              <label className="nt-label" htmlFor="bdg-input">Bdg Pt:</label>
              <input
                id="bdg-input"
                type="text"
                className="nt-input nt-input-bdg"
                value={boardingPoint}
                onChange={(e) => setBoardingPoint(e.target.value.toUpperCase())}
                placeholder="Boarding"
              />
            </div>

            <div className="nt-field nt-field-trainno">
              <label className="nt-label" htmlFor="trainno-input">Train No:</label>
              <input
                id="trainno-input"
                type="text"
                className="nt-input nt-input-trainno field-input-autofill"
                value={trainNumber}
                onChange={(e) => setTrainNumber(e.target.value)}
                placeholder="Train No"
              />
            </div>

            <div className="nt-field nt-field-traintype">
              <label className="nt-label" htmlFor="traintype-select">Train Type:</label>
              <select
                id="traintype-select"
                className="nt-select nt-select-traintype"
                value={trainType}
                onChange={(e) => setTrainType(e.target.value)}
              >
                {TRAIN_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>

            <button
              type="button"
              className="nt-link-availability btn-search-trains"
              onClick={handleSearchTrains}
              title="Check real-time train availability"
            >
              Availability
            </button>

            {selectedTrain.trainName && (
              <span className="nt-train-name-tag" title={selectedTrain.trainName}>
                {selectedTrain.trainName}
              </span>
            )}
          </div>

          {/* Row 3: Class, Quota Radios */}
          <div className="nt-row nt-row-3">
            <div className="nt-field nt-field-class">
              <label className="nt-label" htmlFor="class-select">Class:</label>
              <select
                id="class-select"
                className="nt-select nt-select-class"
                value={selectedClass}
                onChange={(e) => setSelectedClass(e.target.value)}
              >
                {DEFAULT_CLASSES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            {/* Quota Blue Container with Radio Buttons */}
            <div className="nt-quota-container">
              <span className="nt-quota-title">Quota:</span>
              <div className="nt-quota-radios">
                {DEFAULT_QUOTAS.map((q) => (
                  <label key={q} className="nt-radio-label">
                    <input
                      type="radio"
                      name="quota-radio-group"
                      value={q}
                      checked={selectedQuota === q}
                      onChange={(e) => setSelectedQuota(e.target.value)}
                      className="nt-radio-input"
                    />
                    <span>{q}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* SECTION 2: PASSENGER DETAILS FIELDSET (media_1789453391132.png) */}
        <fieldset className="nt-passenger-fieldset">
          <legend className="nt-passenger-legend">
            <span>Passenger Details</span>
            {getMaxPassengersForQuota(selectedQuota) === 4 && (
              <span className="nt-passenger-quota-badge" style={{ marginLeft: '10px', fontSize: '11.5px', color: '#b91c1c', fontWeight: 700 }}>
                ({selectedQuota}: Max 4 Passengers)
              </span>
            )}
          </legend>

          <div className="nt-table-wrapper">
            <table className="nt-passenger-table passenger-table" aria-label="Passenger Details Table">
              <thead>
                <tr>
                  <th className="th-sno">SNo</th>
                  <th className="th-name">Name</th>
                  <th className="th-age">Age</th>
                  <th className="th-sex">Sex</th>
                  <th className="th-berth">Berth</th>
                  <th className="th-food">Food</th>
                  <th className="th-nat">Nationality</th>
                  <th className="th-pass">Passport</th>
                  <th className="th-child">Child</th>
                  {SHOW_SENIOR_OPTION && <th className="th-senior">Senior</th>}
                  <th className="th-bed">Bed</th>
                </tr>
              </thead>
              <tbody>
                {passengers.slice(0, getMaxPassengersForQuota(selectedQuota)).map((p, idx) => (
                  <tr key={p.id}>
                    <td className="td-sno">{p.id}</td>
                    <td className="td-name">
                      <input
                        type="text"
                        className={`nt-cell-input ${passengerWarnings[idx]?.name ? 'nt-cell-input--warning' : ''}`}
                        placeholder="Enter Passenger Name"
                        value={p.name}
                        onChange={(e) => handlePassengerNameChange(idx, e.target.value)}
                        data-testid={`passenger-name-${idx}`}
                      />
                      {passengerWarnings[idx]?.name && (
                        <div className="nt-field-warning" role="alert">{passengerWarnings[idx].name}</div>
                      )}
                    </td>
                    <td className="td-age">
                      <input
                        type="text"
                        inputMode="numeric"
                        className={`nt-cell-input nt-cell-age ${passengerWarnings[idx]?.age ? 'nt-cell-input--warning' : ''}`}
                        placeholder="Age"
                        value={p.age}
                        onChange={(e) => handlePassengerAgeChange(idx, e.target.value)}
                        data-testid={`passenger-age-${idx}`}
                      />
                      {passengerWarnings[idx]?.age && (
                        <div className="nt-field-warning" role="alert">{passengerWarnings[idx].age}</div>
                      )}
                    </td>
                    <td className="td-sex">
                      <select
                        className="nt-cell-select"
                        value={p.sex}
                        onChange={(e) => handlePassengerChange(idx, 'sex', e.target.value)}
                      >
                        <option value="Male">Male</option>
                        <option value="Female">Female</option>
                        <option value="Transgender">Trans</option>
                      </select>
                    </td>
                    <td className="td-berth">
                      <select
                        className="nt-cell-select"
                        value={p.berthPreference}
                        onChange={(e) => handlePassengerChange(idx, 'berthPreference', e.target.value)}
                      >
                        <option value="No Preference">Choose Berth</option>
                        <option value="Lower">Lower</option>
                        <option value="Middle">Middle</option>
                        <option value="Upper">Upper</option>
                        <option value="Side Lower">Side Lower</option>
                        <option value="Side Upper">Side Upper</option>
                        <option value="Window Side">Window Side</option>
                      </select>
                    </td>
                    <td className="td-food">
                      <select
                        className="nt-cell-select"
                        value={p.food}
                        onChange={(e) => handlePassengerChange(idx, 'food', e.target.value)}
                      >
                        <option value="No Preference">None</option>
                        <option value="Veg">Veg</option>
                        <option value="Non-Veg">Non-Veg</option>
                      </select>
                    </td>
                    <td className="td-nat">
                      <select
                        className="nt-cell-select"
                        value={p.nationality}
                        onChange={(e) => handlePassengerChange(idx, 'nationality', e.target.value)}
                      >
                        <option value="India-IN">India-IN</option>
                        <option value="Foreigner">Foreigner</option>
                      </select>
                    </td>
                    <td className="td-pass">
                      <input
                        type="text"
                        className="nt-cell-input"
                        placeholder="Passport / ID"
                        value={p.passport}
                        onChange={(e) => handlePassengerChange(idx, 'passport', e.target.value)}
                      />
                    </td>
                    <td className="td-child text-center">
                      <input
                        type="checkbox"
                        checked={p.child}
                        onChange={(e) => handlePassengerChange(idx, 'child', e.target.checked)}
                        title="Child passenger (under 5)"
                      />
                    </td>
                    {SHOW_SENIOR_OPTION && (
                      <td className="td-senior text-center">
                        <input
                          type="checkbox"
                          checked={p.senior}
                          onChange={(e) => handlePassengerChange(idx, 'senior', e.target.checked)}
                          title="Senior citizen quota"
                        />
                      </td>
                    )}
                    <td className="td-bed text-center">
                      <input
                        type="checkbox"
                        checked={p.bed}
                        onChange={(e) => handlePassengerChange(idx, 'bed', e.target.checked)}
                        title="Bedroll requested"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </fieldset>

        {/* MIDDLE ROW: MOBILE & FARE (media_1789453391132.png) */}
        <div className="nt-contact-fare-row">
          <div className="nt-mobile-group">
            <span className="nt-mobile-label">Mobile +91</span>
            <input
              type="tel"
              className="nt-mobile-input"
              value={mobileNumber}
              onChange={(e) => setMobileNumber(e.target.value.replace(/\D/g, '').slice(0, 10))}
              placeholder="1234567890"
              maxLength={10}
            />
          </div>

          <div className="nt-fare-group">
            <span className="nt-fare-label">Fare:</span>
            <span className="nt-fare-value">{fareText}</span>
            <button
              type="button"
              className="nt-btn-getfare"
              onClick={() => setFareText(`₹${passengers.filter(p => p.name.trim()).length * 1250 || 1250}`)}
            >
              Get Fare
            </button>
          </div>
        </div>

        {/* BOTTOM SECTION: MINT GREEN CONFIGURATION CARD (media_1789453391132.png) */}
        <div className="nt-bottom-card">
          {/* Row 1: Ticket Slot, Getways, Prior Bank */}
          <div className="nt-bottom-row nt-bottom-row-1">
            <div className="nt-bfield">
              <label className="nt-blabel">Ticket Slot:</label>
              <select
                className="nt-bselect"
                value={ticketSlot}
                onChange={(e) => setTicketSlot(e.target.value)}
              >
                {TICKET_SLOTS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>

            <div className="nt-bfield">
              <label className="nt-blabel">Getways:</label>
              <select
                className="nt-bselect"
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>

            <div className="nt-bfield">
              <label className="nt-blabel">Prior Bank:</label>
              <select
                className="nt-bselect"
                data-testid="select-prior-bank"
                value={priorBank}
                onChange={(e) => setPriorBank(e.target.value)}
              >
                <option value={DEFAULT_PRIOR_BANK}>{DEFAULT_PRIOR_BANK}</option>
                {savedBanks.map((b) => {
                  const val = b.displayName || b.bankName;
                  return (
                    <option key={b.id || val} value={val}>
                      {val}
                    </option>
                  );
                })}
              </select>
            </div>
          </div>

          {/* Row 2: Reversed columns: BackUp Bank (Left), Checkboxes (Right) */}
          <div className="nt-bottom-row nt-bottom-row-2">
            <div className="nt-backup-bank-col">
              <div className="nt-bfield">
                <label className="nt-blabel">BackUp Bank:</label>
                <select
                  className="nt-bselect"
                  data-testid="select-backup-bank"
                  value={backupBank}
                  onChange={(e) => setBackupBank(e.target.value)}
                >
                  <option value={DEFAULT_BACKUP_BANK}>{DEFAULT_BACKUP_BANK}</option>
                  {savedBanks.map((b) => {
                    const val = b.displayName || b.bankName;
                    return (
                      <option key={b.id || val} value={val}>
                        {val}
                      </option>
                    );
                  })}
                </select>
              </div>
            </div>

            <div className="nt-checkboxes-col">
              <label className="nt-bcheckbox-label">
                <input
                  type="checkbox"
                  checked={autoUpgradation}
                  onChange={(e) => setAutoUpgradation(e.target.checked)}
                />
                <span>Consider for Auto Upgradation.</span>
              </label>

              <label className="nt-bcheckbox-label">
                <input
                  type="checkbox"
                  checked={confirmBerthsOnly}
                  onChange={(e) => setConfirmBerthsOnly(e.target.checked)}
                />
                <span>Book only if confirm berths allotted.</span>
              </label>
            </div>
          </div>

          {/* Row 3: Name and Save Button */}
          <div className="nt-bottom-row nt-bottom-row-3">
            <div className="nt-name-field">
              <label className="nt-blabel">Name:</label>
              <input
                type="text"
                className="nt-binput nt-input-name"
                value={ticketName}
                onChange={(e) => setTicketName(e.target.value)}
                placeholder="Ticket name / reference"
              />
            </div>

            <button
              type="button"
              className="nt-btn-save"
              onClick={handleSaveTicket}
              disabled={!isFormValid || saving}
              data-testid="btn-save-ticket"
            >
              {saving ? 'Saving...' : editingTicketId ? 'Update' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
