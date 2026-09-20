import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../app/auth-context';
import bankService from '../services/bankService';
import '../styles/bank.css';

// PART 3: Strictly 4 active bank options
const NET_BANKING_OPTIONS = [
  'Select Net Banking',
  'PHONEPE',
  'iPay-QR',
  'PayTM-QR',
  'PHONEPE-QR',
];

// PART 4: Preserved for future use (do not delete)
const PRESERVED_NET_BANKING_OPTIONS = [
  'SBI',
  'BHIMUPI',
  'AUTOPAY_UPI',
  'HDFCUPI',
  'RAZORPAYUPI',
  'iPay-QR',
  'PayTM-QR',
  'PHONEPE-QR',
  'IRCTC_WALLET',
  'AIRTELMONEY',
  'PAYTM',
];

const DEBIT_BANK_OPTIONS = [
  'Select DebitCard Bank',
  'HDFC',
  'PAYZAP',
  'AXIS',
  'ICICIVERTUAL',
  'NSDL',
];

const CREDIT_BANK_OPTIONS = [
  'Select CreditCard Bank',
  'SBI',
  'HDFC',
  'FEDRAL',
  'IDBI',
  'KOTAK',
  'UNION',
  'AXIS',
];

const CARD_NETWORKS = ['Visa', 'Master', 'Rupay'];
const EXPIRY_MONTHS = ['MM', '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
const EXPIRY_YEARS = [
  'YY',
  '2024',
  '2025',
  '2026',
  '2027',
  '2028',
  '2029',
  '2030',
  '2031',
  '2032',
  '2033',
  '2034',
  '2035',
];

export default function BankManagementPage() {
  const { session } = useAuth();
  const [token, setToken] = useState(() => session?.token || null);

  // Active Tab: 'BANK' | 'DEBIT' | 'CREDIT'
  const [activeTab, setActiveTab] = useState('BANK');

  // Banks Data & Form State
  const [banks, setBanks] = useState([]);
  const [selectedBankId, setSelectedBankId] = useState(null);
  const [bankGateway, setBankGateway] = useState('IRCTC');
  const [bankName, setBankName] = useState('Select Net Banking');
  const [bankUserName, setBankUserName] = useState('');
  const [bankNameToSave, setBankNameToSave] = useState('');
  const [editingBankId, setEditingBankId] = useState(null);

  // Debit Card Data & Form State
  const [debitCards, setDebitCards] = useState([]);
  const [selectedDebitCardId, setSelectedDebitCardId] = useState(null);
  const [debitGateway, setDebitGateway] = useState('IRCTC');
  const [debitBankName, setDebitBankName] = useState('Select DebitCard Bank');
  const [debitCardType, setDebitCardType] = useState('Visa');
  const [debitCardNumber, setDebitCardNumber] = useState('');
  const [debitExpiryMonth, setDebitExpiryMonth] = useState('MM');
  const [debitExpiryYear, setDebitExpiryYear] = useState('YY');
  const [debitNameOnCard, setDebitNameOnCard] = useState('');
  const [debitPin, setDebitPin] = useState('');
  const [debitCvv, setDebitCvv] = useState('');
  const [debit3dPassword, setDebit3dPassword] = useState('');
  const [debitNameToSave, setDebitNameToSave] = useState('');
  const [debitShowPassword, setDebitShowPassword] = useState(false);
  const [editingDebitCardId, setEditingDebitCardId] = useState(null);

  // Credit Card Data & Form State
  const [creditCards, setCreditCards] = useState([]);
  const [selectedCreditCardId, setSelectedCreditCardId] = useState(null);
  const [creditGateway, setCreditGateway] = useState('IRCTC');
  const [creditSelectType, setCreditSelectType] = useState('Credit_Card');
  const [creditBankName, setCreditBankName] = useState('Select CreditCard Bank');
  const [creditCardType, setCreditCardType] = useState('Visa');
  const [creditCardNumber, setCreditCardNumber] = useState('');
  const [creditExpiryMonth, setCreditExpiryMonth] = useState('MM');
  const [creditExpiryYear, setCreditExpiryYear] = useState('YY');
  const [creditNameOnCard, setCreditNameOnCard] = useState('');
  const [creditAtmPin, setCreditAtmPin] = useState('');
  const [creditCvv, setCreditCvv] = useState('');
  const [credit3dPassword, setCredit3dPassword] = useState('');
  const [creditNameToSave, setCreditNameToSave] = useState('');
  const [creditShowPassword, setCreditShowPassword] = useState(false);
  const [editingCreditCardId, setEditingCreditCardId] = useState(null);

  // Feedback status
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Fetch token if opening in independent child window
  useEffect(() => {
    let isMounted = true;
    if (token) return;

    const bridge = typeof window !== 'undefined' ? window.netx : null;
    if (bridge?.app?.getBankSession) {
      bridge.app
        .getBankSession()
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

  // Load Banks
  const loadBanks = useCallback(async (authToken) => {
    if (!authToken) return;
    try {
      const data = await bankService.listBanks(authToken);
      setBanks(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err?.message || 'Failed to load saved banks.');
    }
  }, []);

  // Load Cards
  const loadCards = useCallback(async (authToken, type) => {
    if (!authToken) return;
    try {
      const data = await bankService.listCards(authToken, type);
      if (type === 'DEBIT') {
        setDebitCards(Array.isArray(data) ? data : []);
      } else if (type === 'CREDIT') {
        setCreditCards(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      setError(err?.message || 'Failed to load saved cards.');
    }
  }, []);

  // Sync initial data and when tab changes
  useEffect(() => {
    if (!token) return;
    if (activeTab === 'BANK') {
      loadBanks(token);
    } else if (activeTab === 'DEBIT') {
      loadCards(token, 'DEBIT');
    } else if (activeTab === 'CREDIT') {
      loadCards(token, 'CREDIT');
    }
  }, [token, activeTab, loadBanks, loadCards]);

  const notifyChange = () => {
    if (typeof window !== 'undefined' && window.netx?.app?.notifyBanksChanged) {
      window.netx.app.notifyBanksChanged();
    }
  };

  // ==========================================================================
  // BANK ACTIONS
  // ==========================================================================

  const handleBankNameChange = (val) => {
    setBankName(val);
    if (val === 'iPay-QR') {
      setBankUserName('ipay@qr');
      setBankNameToSave('iPay-QR_ipay@qr');
    } else if (val === 'PayTM-QR') {
      setBankUserName('paytm@qr');
      setBankNameToSave('PayTM-QR_paytm@qr');
    } else if (val === 'PHONEPE-QR') {
      setBankUserName('PHONEPE@QR');
      setBankNameToSave('PHONEPE-QR_PHONEPE@QR');
    } else if (val === 'PHONEPE') {
      setBankUserName('');
      setBankNameToSave('');
    } else {
      setBankUserName('');
      setBankNameToSave('');
    }
  };

  const resetBankForm = () => {
    setBankGateway('IRCTC');
    setBankName('Select Net Banking');
    setBankUserName('');
    setBankNameToSave('');
    setEditingBankId(null);
  };

  const handleSaveBank = async (e) => {
    if (e) e.preventDefault();
    if (!token) return;

    if (!bankName || bankName === 'Select Net Banking') {
      setError('Please select a Bank Name from the list.');
      return;
    }

    const nToSave = bankNameToSave.trim();
    if (!nToSave) {
      setError('Please enter Name to Save.');
      return;
    }

    setSaving(true);
    setError('');
    setSuccess('');

    const payload = {
      gateway: bankGateway,
      bankName: bankName.trim(),
      userName: bankUserName.trim(),
      upiId: bankUserName.trim(),
      nameToSave: nToSave,
    };

    try {
      if (editingBankId) {
        await bankService.updateBank(token, editingBankId, payload);
        setSuccess(`Bank "${bankName}_${nToSave}" updated.`);
      } else {
        await bankService.createBank(token, payload);
        setSuccess(`Bank "${bankName}_${nToSave}" saved successfully.`);
      }

      resetBankForm();
      await loadBanks(token);
      notifyChange();
    } catch (err) {
      setError(err?.message || 'Failed to save bank.');
    } finally {
      setSaving(false);
    }
  };

  const handleSelectBankItem = (b) => {
    setSelectedBankId(b.id);
  };

  const handleEditSelectedBank = () => {
    if (!selectedBankId) {
      setError('Please click on a bank in the list to select it first.');
      return;
    }
    const b = banks.find((item) => item.id === selectedBankId);
    if (!b) return;

    setEditingBankId(b.id);
    setBankGateway(b.gateway || 'IRCTC');
    setBankName(b.bankName || 'Select Net Banking');
    setBankUserName(b.userName || b.upiId || '');
    setBankNameToSave(b.nameToSave || '');
    setError('');
    setSuccess(`Loaded "${b.displayName || b.bankName}" for editing.`);
  };

  const handleDeleteSelectedBank = async () => {
    if (!selectedBankId) {
      setError('Please click on a bank in the list to select it first.');
      return;
    }
    const b = banks.find((item) => item.id === selectedBankId);
    if (!b) return;

    if (!window.confirm(`Are you sure you want to delete "${b.displayName || b.bankName}"?`)) {
      return;
    }

    try {
      await bankService.deleteBank(token, b.id);
      setSelectedBankId(null);
      if (editingBankId === b.id) resetBankForm();
      setSuccess(`Bank deleted successfully.`);
      await loadBanks(token);
      notifyChange();
    } catch (err) {
      setError(err?.message || 'Failed to delete bank.');
    }
  };

  const handleDeleteAllBanks = async () => {
    if (banks.length === 0) {
      setError('No banks to delete.');
      return;
    }

    if (!window.confirm('Are you sure you want to delete ALL saved Net Banking entries?')) {
      return;
    }

    try {
      await bankService.deleteAllBanks(token);
      setSelectedBankId(null);
      resetBankForm();
      setSuccess('All banks deleted successfully.');
      await loadBanks(token);
      notifyChange();
    } catch (err) {
      setError(err?.message || 'Failed to delete all banks.');
    }
  };

  // ==========================================================================
  // DEBIT CARD ACTIONS
  // ==========================================================================

  const resetDebitForm = () => {
    setDebitGateway('IRCTC');
    setDebitBankName('Select DebitCard Bank');
    setDebitCardType('Visa');
    setDebitCardNumber('');
    setDebitExpiryMonth('MM');
    setDebitExpiryYear('YY');
    setDebitNameOnCard('');
    setDebitPin('');
    setDebitCvv('');
    setDebit3dPassword('');
    setDebitNameToSave('');
    setDebitShowPassword(false);
    setEditingDebitCardId(null);
  };

  const handleSaveDebitCard = async (e) => {
    if (e) e.preventDefault();
    if (!token) return;

    if (!debitBankName || debitBankName === 'Select DebitCard Bank') {
      setError('Please select a DebitCard Bank.');
      return;
    }
    const cleanNum = debitCardNumber.replace(/\s+/g, '');
    if (!cleanNum || cleanNum.length < 12) {
      setError('Please enter a valid Card Number (at least 12 digits).');
      return;
    }
    const nToSave = debitNameToSave.trim();
    if (!nToSave) {
      setError('Please enter Name to Save.');
      return;
    }

    setSaving(true);
    setError('');
    setSuccess('');

    const payload = {
      gateway: debitGateway,
      cardType: 'DEBIT',
      bankName: debitBankName,
      cardNetwork: debitCardType,
      cardNumber: cleanNum,
      expiryMonth: debitExpiryMonth !== 'MM' ? debitExpiryMonth : '',
      expiryYear: debitExpiryYear !== 'YY' ? debitExpiryYear : '',
      cardHolderName: debitNameOnCard.trim(),
      pin: debitPin.trim(),
      cvv: debitCvv.trim(),
      card3dPassword: debit3dPassword.trim(),
      nameToSave: nToSave,
    };

    try {
      if (editingDebitCardId) {
        await bankService.updateCard(token, editingDebitCardId, payload);
        setSuccess(`Debit Card "${debitBankName}_${nToSave}" updated.`);
      } else {
        await bankService.createCard(token, payload);
        setSuccess(`Debit Card "${debitBankName}_${nToSave}" saved.`);
      }

      resetDebitForm();
      await loadCards(token, 'DEBIT');
      notifyChange();
    } catch (err) {
      setError(err?.message || 'Failed to save debit card.');
    } finally {
      setSaving(false);
    }
  };

  const handleSelectDebitItem = (c) => {
    setSelectedDebitCardId(c.id);
  };

  const handleEditSelectedDebit = () => {
    if (!selectedDebitCardId) {
      setError('Please select a debit card from the list first.');
      return;
    }
    const c = debitCards.find((item) => item.id === selectedDebitCardId);
    if (!c) return;

    setEditingDebitCardId(c.id);
    setDebitGateway(c.gateway || 'IRCTC');
    setDebitBankName(c.bankName || 'Select DebitCard Bank');
    setDebitCardType(c.cardNetwork || 'Visa');
    setDebitCardNumber(c.cardNumber || '');
    setDebitExpiryMonth(c.expiryMonth || 'MM');
    setDebitExpiryYear(c.expiryYear || 'YY');
    setDebitNameOnCard(c.cardHolderName || '');
    setDebitPin(c.pin || '');
    setDebitCvv(c.cvv || '');
    setDebit3dPassword(c.card3dPassword || '');
    setDebitNameToSave(c.nameToSave || '');
    setError('');
    setSuccess(`Loaded "${c.displayName || c.bankName}" for editing.`);
  };

  const handleDeleteSelectedDebit = async () => {
    if (!selectedDebitCardId) {
      setError('Please select a debit card from the list first.');
      return;
    }
    const c = debitCards.find((item) => item.id === selectedDebitCardId);
    if (!c) return;

    if (!window.confirm(`Delete debit card "${c.displayName || c.bankName}"?`)) {
      return;
    }

    try {
      await bankService.deleteCard(token, c.id);
      setSelectedDebitCardId(null);
      if (editingDebitCardId === c.id) resetDebitForm();
      setSuccess('Debit card deleted successfully.');
      await loadCards(token, 'DEBIT');
      notifyChange();
    } catch (err) {
      setError(err?.message || 'Failed to delete debit card.');
    }
  };

  const handleDeleteAllDebits = async () => {
    if (debitCards.length === 0) {
      setError('No debit cards to delete.');
      return;
    }
    if (!window.confirm('Are you sure you want to delete ALL saved Debit Cards?')) {
      return;
    }

    try {
      await bankService.deleteAllCards(token, 'DEBIT');
      setSelectedDebitCardId(null);
      resetDebitForm();
      setSuccess('All debit cards deleted.');
      await loadCards(token, 'DEBIT');
      notifyChange();
    } catch (err) {
      setError(err?.message || 'Failed to delete all debit cards.');
    }
  };

  // ==========================================================================
  // CREDIT CARD ACTIONS
  // ==========================================================================

  const resetCreditForm = () => {
    setCreditGateway('IRCTC');
    setCreditSelectType('Credit_Card');
    setCreditBankName('Select CreditCard Bank');
    setCreditCardType('Visa');
    setCreditCardNumber('');
    setCreditExpiryMonth('MM');
    setCreditExpiryYear('YY');
    setCreditNameOnCard('');
    setCreditAtmPin('');
    setCreditCvv('');
    setCredit3dPassword('');
    setCreditNameToSave('');
    setCreditShowPassword(false);
    setEditingCreditCardId(null);
  };

  const handleSaveCreditCard = async (e) => {
    if (e) e.preventDefault();
    if (!token) return;

    if (!creditBankName || creditBankName === 'Select CreditCard Bank') {
      setError('Please select a CreditCard Bank.');
      return;
    }
    const cleanNum = creditCardNumber.replace(/\s+/g, '');
    if (!cleanNum || cleanNum.length < 12) {
      setError('Please enter a valid Card Number (at least 12 digits).');
      return;
    }
    const nToSave = creditNameToSave.trim();
    if (!nToSave) {
      setError('Please enter Name to Save.');
      return;
    }

    setSaving(true);
    setError('');
    setSuccess('');

    const payload = {
      gateway: creditGateway,
      cardType: 'CREDIT',
      selectYourType: creditSelectType,
      bankName: creditBankName,
      cardNetwork: creditCardType,
      cardNumber: cleanNum,
      expiryMonth: creditExpiryMonth !== 'MM' ? creditExpiryMonth : '',
      expiryYear: creditExpiryYear !== 'YY' ? creditExpiryYear : '',
      cardHolderName: creditNameOnCard.trim(),
      pin: creditAtmPin.trim(),
      cvv: creditCvv.trim(),
      card3dPassword: credit3dPassword.trim(),
      nameToSave: nToSave,
    };

    try {
      if (editingCreditCardId) {
        await bankService.updateCard(token, editingCreditCardId, payload);
        setSuccess(`Credit Card "${creditBankName}_${nToSave}" updated.`);
      } else {
        await bankService.createCard(token, payload);
        setSuccess(`Credit Card "${creditBankName}_${nToSave}" saved.`);
      }

      resetCreditForm();
      await loadCards(token, 'CREDIT');
      notifyChange();
    } catch (err) {
      setError(err?.message || 'Failed to save credit card.');
    } finally {
      setSaving(false);
    }
  };

  const handleSelectCreditItem = (c) => {
    setSelectedCreditCardId(c.id);
  };

  const handleEditSelectedCredit = () => {
    if (!selectedCreditCardId) {
      setError('Please select a credit card from the list first.');
      return;
    }
    const c = creditCards.find((item) => item.id === selectedCreditCardId);
    if (!c) return;

    setEditingCreditCardId(c.id);
    setCreditGateway(c.gateway || 'IRCTC');
    setCreditSelectType(c.selectYourType || 'Credit_Card');
    setCreditBankName(c.bankName || 'Select CreditCard Bank');
    setCreditCardType(c.cardNetwork || 'Visa');
    setCreditCardNumber(c.cardNumber || '');
    setCreditExpiryMonth(c.expiryMonth || 'MM');
    setCreditExpiryYear(c.expiryYear || 'YY');
    setCreditNameOnCard(c.cardHolderName || '');
    setCreditAtmPin(c.pin || '');
    setCreditCvv(c.cvv || '');
    setCredit3dPassword(c.card3dPassword || '');
    setCreditNameToSave(c.nameToSave || '');
    setError('');
    setSuccess(`Loaded "${c.displayName || c.bankName}" for editing.`);
  };

  const handleDeleteSelectedCredit = async () => {
    if (!selectedCreditCardId) {
      setError('Please select a credit card from the list first.');
      return;
    }
    const c = creditCards.find((item) => item.id === selectedCreditCardId);
    if (!c) return;

    if (!window.confirm(`Delete credit card "${c.displayName || c.bankName}"?`)) {
      return;
    }

    try {
      await bankService.deleteCard(token, c.id);
      setSelectedCreditCardId(null);
      if (editingCreditCardId === c.id) resetCreditForm();
      setSuccess('Credit card deleted successfully.');
      await loadCards(token, 'CREDIT');
      notifyChange();
    } catch (err) {
      setError(err?.message || 'Failed to delete credit card.');
    }
  };

  const handleDeleteAllCredits = async () => {
    if (creditCards.length === 0) {
      setError('No credit cards to delete.');
      return;
    }
    if (!window.confirm('Are you sure you want to delete ALL saved Credit Cards?')) {
      return;
    }

    try {
      await bankService.deleteAllCards(token, 'CREDIT');
      setSelectedCreditCardId(null);
      resetCreditForm();
      setSuccess('All credit cards deleted.');
      await loadCards(token, 'CREDIT');
      notifyChange();
    } catch (err) {
      setError(err?.message || 'Failed to delete all credit cards.');
    }
  };

  // Auto-dismiss alert after 3.5s
  useEffect(() => {
    if (!error && !success) return;
    const t = setTimeout(() => {
      setError('');
      setSuccess('');
    }, 3500);
    return () => clearTimeout(t);
  }, [error, success]);

  const handleClose = () => {
    const bridge = typeof window !== 'undefined' ? window.netx : null;
    if (bridge?.app?.closeCurrentWindow) {
      bridge.app.closeCurrentWindow();
    } else {
      window.close();
    }
  };

  return (
    <div className="bank-win-container">
      {/* 1. Custom Purple Desktop Header */}
      <header className="bank-win-titlebar">
        <span className="bank-win-title">Bank</span>

        {(error || success) && (
          <div className={`bank-title-badge ${error ? 'bank-title-badge--error' : 'bank-title-badge--success'}`}>
            <span>{error || success}</span>
          </div>
        )}

        <div className="bank-win-title-controls">
          <button
            type="button"
            className="bank-win-icon-btn"
            onClick={handleClose}
            title="Close"
            aria-label="Close"
          >
            {/* Cyan 4-arrow/expand icon matching screenshot */}
            <svg
              className="bank-win-expand-icon"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="#00e5ff"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
        </div>
      </header>

      {/* 2. Top Navigation Tabs: [ Bank ]  [ Debit Card ]  [ Credit Card ] */}
      <nav className="bank-tabs-row" aria-label="Bank Tabs">
        <button
          type="button"
          data-testid="tab-bank"
          className={`bank-tab-btn ${activeTab === 'BANK' ? 'bank-tab-btn--active' : ''}`}
          onClick={() => {
            setActiveTab('BANK');
            setError('');
            setSuccess('');
          }}
        >
          Bank
        </button>
        <button
          type="button"
          data-testid="tab-debit-card"
          className="bank-tab-btn bank-tab-btn--disabled"
          disabled={true}
          aria-disabled="true"
          title="Debit Card tab is currently disabled"
        >
          Debit Card
        </button>
        <button
          type="button"
          data-testid="tab-credit-card"
          className="bank-tab-btn bank-tab-btn--disabled"
          disabled={true}
          aria-disabled="true"
          title="Credit Card tab is currently disabled"
        >
          Credit Card
        </button>
      </nav>

      {/* 3. Main Split View (Left Form Panel + Right List Panel) */}
      <main className="bank-content-split">
        {/* ================================================================= */}
        {/* TAB 1: BANK */}
        {/* ================================================================= */}
        {activeTab === 'BANK' && (
          <>
            {/* Left Panel: Form */}
            <section className="bank-panel bank-panel--left" aria-label="Bank Form">
              <form className="bank-form-grid" onSubmit={handleSaveBank}>
                <div className="bank-form-row">
                  <label className="bank-form-label">Gateway :</label>
                  <select
                    className="bank-form-select bank-form-select--sm"
                    value={bankGateway}
                    onChange={(e) => setBankGateway(e.target.value)}
                  >
                    <option value="IRCTC">IRCTC</option>
                  </select>
                </div>

                <div className="bank-form-row">
                  <label className="bank-form-label">Bank Name :</label>
                  <select
                    className="bank-form-select bank-form-select--lg"
                    data-testid="select-bank-name"
                    value={bankName}
                    onChange={(e) => handleBankNameChange(e.target.value)}
                  >
                    {NET_BANKING_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="bank-form-row">
                  <label className="bank-form-label">UPI Id :</label>
                  <input
                    type="text"
                    className="bank-form-input"
                    data-testid="input-bank-username"
                    value={bankUserName}
                    onChange={(e) => setBankUserName(e.target.value)}
                    autoComplete="off"
                  />
                </div>

                <div className="bank-form-row">
                  <label className="bank-form-label bank-form-label--red">Name to Save :</label>
                  <input
                    type="text"
                    className="bank-form-input bank-form-input--cream"
                    data-testid="input-bank-nametosave"
                    value={bankNameToSave}
                    onChange={(e) => setBankNameToSave(e.target.value)}
                    autoComplete="off"
                  />
                </div>

                <div className="bank-form-footer">
                  <button
                    type="submit"
                    data-testid="btn-save-bank"
                    className="bank-btn-classic bank-btn-classic--save"
                    disabled={saving}
                  >
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </form>
            </section>

            {/* Right Panel: Saved List */}
            <section className="bank-panel bank-panel--right" aria-label="Saved Banks List">
              <div className="bank-listbox" data-testid="bank-listbox">
                {banks.map((b) => {
                  const isSelected = selectedBankId === b.id;
                  const lineText = b.displayName || `${b.bankName}_${b.nameToSave || ''}`;
                  return (
                    <div
                      key={b.id}
                      className={`bank-list-item ${isSelected ? 'bank-list-item--selected' : ''}`}
                      onClick={() => handleSelectBankItem(b)}
                    >
                      {lineText}
                    </div>
                  );
                })}
              </div>

              <div className="bank-panel-actions">
                <button
                  type="button"
                  data-testid="btn-bank-edit"
                  className="bank-btn-classic"
                  onClick={handleEditSelectedBank}
                >
                  Edit
                </button>
                <button
                  type="button"
                  data-testid="btn-bank-delete"
                  className="bank-btn-classic"
                  onClick={handleDeleteSelectedBank}
                >
                  Delete
                </button>
                <button
                  type="button"
                  data-testid="btn-bank-delete-all"
                  className="bank-btn-classic"
                  onClick={handleDeleteAllBanks}
                >
                  Delete All
                </button>
              </div>
            </section>
          </>
        )}

        {/* ================================================================= */}
        {/* TAB 2: DEBIT CARD */}
        {/* ================================================================= */}
        {activeTab === 'DEBIT' && (
          <>
            {/* Left Panel: Form */}
            <section className="bank-panel bank-panel--left" aria-label="Debit Card Form">
              <form className="bank-form-grid" onSubmit={handleSaveDebitCard}>
                <div className="bank-form-row">
                  <label className="bank-form-label">Gateway :</label>
                  <select
                    className="bank-form-select bank-form-select--sm"
                    value={debitGateway}
                    onChange={(e) => setDebitGateway(e.target.value)}
                  >
                    <option value="IRCTC">IRCTC</option>
                  </select>
                </div>

                <div className="bank-form-row">
                  <label className="bank-form-label">Bank Name :</label>
                  <select
                    className="bank-form-select bank-form-select--lg"
                    data-testid="select-debit-bank"
                    value={debitBankName}
                    onChange={(e) => setDebitBankName(e.target.value)}
                  >
                    {DEBIT_BANK_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="bank-form-row">
                  <label className="bank-form-label">Card Type :</label>
                  <select
                    className="bank-form-select bank-form-select--sm"
                    value={debitCardType}
                    onChange={(e) => setDebitCardType(e.target.value)}
                  >
                    {CARD_NETWORKS.map((cn) => (
                      <option key={cn} value={cn}>
                        {cn}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="bank-form-row">
                  <label className="bank-form-label">Card No. :</label>
                  <input
                    type="text"
                    className="bank-form-input bank-form-input--mint"
                    data-testid="input-debit-cardno"
                    value={debitCardNumber}
                    onChange={(e) => setDebitCardNumber(e.target.value)}
                    autoComplete="off"
                  />
                </div>

                <div className="bank-form-row">
                  <label className="bank-form-label">Valid Thru/Expiry Date :</label>
                  <div className="bank-expiry-group">
                    <select
                      className="bank-form-select bank-form-select--exp"
                      value={debitExpiryMonth}
                      onChange={(e) => setDebitExpiryMonth(e.target.value)}
                    >
                      {EXPIRY_MONTHS.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                    <select
                      className="bank-form-select bank-form-select--exp"
                      value={debitExpiryYear}
                      onChange={(e) => setDebitExpiryYear(e.target.value)}
                    >
                      {EXPIRY_YEARS.map((y) => (
                        <option key={y} value={y}>
                          {y}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="bank-form-row">
                  <label className="bank-form-label">Name on Card:</label>
                  <input
                    type="text"
                    className="bank-form-input bank-form-input--mint"
                    data-testid="input-debit-nameoncard"
                    value={debitNameOnCard}
                    onChange={(e) => setDebitNameOnCard(e.target.value)}
                    autoComplete="off"
                  />
                </div>

                <div className="bank-form-row bank-form-row--split">
                  <div className="bank-subrow">
                    <label className="bank-form-label bank-form-label--inline">
                      Visa / Master Pin :
                    </label>
                    <input
                      type={debitShowPassword ? 'text' : 'password'}
                      className="bank-form-input bank-form-input--mint bank-form-input--pin"
                      value={debitPin}
                      onChange={(e) => setDebitPin(e.target.value)}
                      autoComplete="off"
                    />
                  </div>
                  <div className="bank-subrow">
                    <label className="bank-form-label bank-form-label--inline bank-form-label--cvv">
                      CVV :
                    </label>
                    <input
                      type={debitShowPassword ? 'text' : 'password'}
                      maxLength="4"
                      className="bank-form-input bank-form-input--mint bank-form-input--cvv"
                      value={debitCvv}
                      onChange={(e) => setDebitCvv(e.target.value)}
                      autoComplete="off"
                    />
                  </div>
                </div>

                <div className="bank-form-row">
                  <label className="bank-form-label">Card 3D Password :</label>
                  <input
                    type={debitShowPassword ? 'text' : 'password'}
                    className="bank-form-input bank-form-input--mint"
                    value={debit3dPassword}
                    onChange={(e) => setDebit3dPassword(e.target.value)}
                    autoComplete="off"
                  />
                </div>

                <div className="bank-form-row">
                  <label className="bank-form-label bank-form-label--red">Name to Save :</label>
                  <input
                    type="text"
                    className="bank-form-input bank-form-input--cream"
                    data-testid="input-debit-nametosave"
                    value={debitNameToSave}
                    onChange={(e) => setDebitNameToSave(e.target.value)}
                    autoComplete="off"
                  />
                </div>

                <div className="bank-form-checkbox-group">
                  <label className="bank-form-checkbox-label bank-form-checkbox-label--blue">
                    <input
                      type="checkbox"
                      checked={debitShowPassword}
                      onChange={(e) => setDebitShowPassword(e.target.checked)}
                    />
                    <span>Show Password</span>
                  </label>
                </div>

                <div className="bank-form-footer">
                  <button
                    type="submit"
                    data-testid="btn-save-debit"
                    className="bank-btn-classic bank-btn-classic--save"
                    disabled={saving}
                  >
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </form>
            </section>

            {/* Right Panel: Saved Debit Cards List */}
            <section className="bank-panel bank-panel--right" aria-label="Saved Debit Cards List">
              <div className="bank-listbox" data-testid="debit-listbox">
                {debitCards.map((c) => {
                  const isSelected = selectedDebitCardId === c.id;
                  const lineText = c.displayName || `${c.bankName}_${c.nameToSave || ''}`;
                  return (
                    <div
                      key={c.id}
                      className={`bank-list-item ${isSelected ? 'bank-list-item--selected' : ''}`}
                      onClick={() => handleSelectDebitItem(c)}
                    >
                      {lineText}
                    </div>
                  );
                })}
              </div>

              <div className="bank-panel-actions">
                <button
                  type="button"
                  data-testid="btn-debit-edit"
                  className="bank-btn-classic"
                  onClick={handleEditSelectedDebit}
                >
                  Edit
                </button>
                <button
                  type="button"
                  data-testid="btn-debit-delete"
                  className="bank-btn-classic"
                  onClick={handleDeleteSelectedDebit}
                >
                  Delete
                </button>
                <button
                  type="button"
                  data-testid="btn-debit-delete-all"
                  className="bank-btn-classic"
                  onClick={handleDeleteAllDebits}
                >
                  Delete All
                </button>
              </div>
            </section>
          </>
        )}

        {/* ================================================================= */}
        {/* TAB 3: CREDIT CARD */}
        {/* ================================================================= */}
        {activeTab === 'CREDIT' && (
          <>
            {/* Left Panel: Form */}
            <section className="bank-panel bank-panel--left" aria-label="Credit Card Form">
              <form className="bank-form-grid" onSubmit={handleSaveCreditCard}>
                <div className="bank-form-row">
                  <label className="bank-form-label">Gateway :</label>
                  <select
                    className="bank-form-select bank-form-select--sm"
                    value={creditGateway}
                    onChange={(e) => setCreditGateway(e.target.value)}
                  >
                    <option value="IRCTC">IRCTC</option>
                  </select>
                </div>

                <div className="bank-form-row">
                  <label className="bank-form-label">Select Your Type</label>
                  <select
                    className="bank-form-select bank-form-select--sm"
                    value={creditSelectType}
                    onChange={(e) => setCreditSelectType(e.target.value)}
                  >
                    <option value="Credit_Card">Credit_Card</option>
                  </select>
                </div>

                <div className="bank-form-row">
                  <label className="bank-form-label">Bank Name :</label>
                  <select
                    className="bank-form-select bank-form-select--lg"
                    data-testid="select-credit-bank"
                    value={creditBankName}
                    onChange={(e) => setCreditBankName(e.target.value)}
                  >
                    {CREDIT_BANK_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="bank-form-row">
                  <label className="bank-form-label">Card Type :</label>
                  <select
                    className="bank-form-select bank-form-select--sm"
                    value={creditCardType}
                    onChange={(e) => setCreditCardType(e.target.value)}
                  >
                    {CARD_NETWORKS.map((cn) => (
                      <option key={cn} value={cn}>
                        {cn}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="bank-form-row">
                  <label className="bank-form-label">Card No. :</label>
                  <input
                    type="text"
                    className="bank-form-input bank-form-input--mint"
                    data-testid="input-credit-cardno"
                    value={creditCardNumber}
                    onChange={(e) => setCreditCardNumber(e.target.value)}
                    autoComplete="off"
                  />
                </div>

                <div className="bank-form-row">
                  <label className="bank-form-label">Valid Thru/Expiry Date :</label>
                  <div className="bank-expiry-group">
                    <select
                      className="bank-form-select bank-form-select--exp"
                      value={creditExpiryMonth}
                      onChange={(e) => setCreditExpiryMonth(e.target.value)}
                    >
                      {EXPIRY_MONTHS.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                    <select
                      className="bank-form-select bank-form-select--exp"
                      value={creditExpiryYear}
                      onChange={(e) => setCreditExpiryYear(e.target.value)}
                    >
                      {EXPIRY_YEARS.map((y) => (
                        <option key={y} value={y}>
                          {y}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="bank-form-row">
                  <label className="bank-form-label">Name on Card:</label>
                  <input
                    type="text"
                    className="bank-form-input bank-form-input--mint"
                    data-testid="input-credit-nameoncard"
                    value={creditNameOnCard}
                    onChange={(e) => setCreditNameOnCard(e.target.value)}
                    autoComplete="off"
                  />
                </div>

                <div className="bank-form-row bank-form-row--split">
                  <div className="bank-subrow">
                    <label className="bank-form-label bank-form-label--inline">
                      Card ATM Pin :
                    </label>
                    <input
                      type={creditShowPassword ? 'text' : 'password'}
                      className="bank-form-input bank-form-input--mint bank-form-input--pin"
                      value={creditAtmPin}
                      onChange={(e) => setCreditAtmPin(e.target.value)}
                      autoComplete="off"
                    />
                  </div>
                  <div className="bank-subrow">
                    <label className="bank-form-label bank-form-label--inline bank-form-label--cvv">
                      CVV :
                    </label>
                    <input
                      type={creditShowPassword ? 'text' : 'password'}
                      maxLength="4"
                      className="bank-form-input bank-form-input--mint bank-form-input--cvv"
                      value={creditCvv}
                      onChange={(e) => setCreditCvv(e.target.value)}
                      autoComplete="off"
                    />
                  </div>
                </div>

                <div className="bank-form-row">
                  <label className="bank-form-label">Card 3D Password :</label>
                  <input
                    type={creditShowPassword ? 'text' : 'password'}
                    className="bank-form-input bank-form-input--mint"
                    value={credit3dPassword}
                    onChange={(e) => setCredit3dPassword(e.target.value)}
                    autoComplete="off"
                  />
                </div>

                <div className="bank-form-row">
                  <label className="bank-form-label bank-form-label--red">Name to Save :</label>
                  <input
                    type="text"
                    className="bank-form-input bank-form-input--cream"
                    data-testid="input-credit-nametosave"
                    value={creditNameToSave}
                    onChange={(e) => setCreditNameToSave(e.target.value)}
                    autoComplete="off"
                  />
                </div>

                <div className="bank-form-checkbox-group">
                  <label className="bank-form-checkbox-label bank-form-checkbox-label--blue">
                    <input
                      type="checkbox"
                      checked={creditShowPassword}
                      onChange={(e) => setCreditShowPassword(e.target.checked)}
                    />
                    <span>Show Password</span>
                  </label>
                </div>

                <div className="bank-form-footer">
                  <button
                    type="submit"
                    data-testid="btn-save-credit"
                    className="bank-btn-classic bank-btn-classic--save"
                    disabled={saving}
                  >
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </form>
            </section>

            {/* Right Panel: Saved Credit Cards List */}
            <section className="bank-panel bank-panel--right" aria-label="Saved Credit Cards List">
              <div className="bank-listbox" data-testid="credit-listbox">
                {creditCards.map((c) => {
                  const isSelected = selectedCreditCardId === c.id;
                  const lineText = c.displayName || `${c.bankName}_${c.nameToSave || ''}`;
                  return (
                    <div
                      key={c.id}
                      className={`bank-list-item ${isSelected ? 'bank-list-item--selected' : ''}`}
                      onClick={() => handleSelectCreditItem(c)}
                    >
                      {lineText}
                    </div>
                  );
                })}
              </div>

              <div className="bank-panel-actions">
                <button
                  type="button"
                  data-testid="btn-credit-edit"
                  className="bank-btn-classic"
                  onClick={handleEditSelectedCredit}
                >
                  Edit
                </button>
                <button
                  type="button"
                  data-testid="btn-credit-delete"
                  className="bank-btn-classic"
                  onClick={handleDeleteSelectedCredit}
                >
                  Delete
                </button>
                <button
                  type="button"
                  data-testid="btn-credit-delete-all"
                  className="bank-btn-classic"
                  onClick={handleDeleteAllCredits}
                >
                  Delete All
                </button>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
