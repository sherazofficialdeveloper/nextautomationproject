import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../app/auth-context';
import irctcAccountService from '../services/irctcAccountService';
import '../styles/accounts.css';

export default function AccountManagerPage() {
  const { session } = useAuth();
  const [token, setToken] = useState(() => session?.token || null);
  const [accounts, setAccounts] = useState([]);
  const [irctcUserId, setIrctcUserId] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Fetch token if opening in independent child window
  useEffect(() => {
    let isMounted = true;
    if (token) return;

    const bridge = typeof window !== 'undefined' ? window.netx : null;
    if (bridge?.app?.getAccountSession) {
      bridge.app.getAccountSession().then((sess) => {
        if (isMounted && sess?.token) {
          setToken(sess.token);
        }
      }).catch(() => {});
    }

    return () => {
      isMounted = false;
    };
  }, [token]);

  const loadAccounts = useCallback(async (authToken) => {
    if (!authToken) return;
    try {
      const data = await irctcAccountService.listAccounts(authToken);
      setAccounts(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err?.message || 'Failed to load IRCTC accounts.');
    }
  }, []);

  useEffect(() => {
    let ignore = false;
    async function fetchAccounts() {
      if (!token) return;
      try {
        const data = await irctcAccountService.listAccounts(token);
        if (!ignore) {
          setAccounts(Array.isArray(data) ? data : []);
        }
      } catch (err) {
        if (!ignore) {
          setError(err?.message || 'Failed to load IRCTC accounts.');
        }
      }
    }
    fetchAccounts();
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

  const resetForm = () => {
    setEditingId(null);
    setIrctcUserId('');
    setPassword('');
    setShowPassword(false);
  };

  const startEdit = (acc) => {
    setEditingId(acc.id);
    setIrctcUserId(acc.irctcUserId || acc.username || '');
    setPassword(acc.password || '');
    setShowPassword(false);
    setError('');
    setSuccess('');
  };

  const cancelEdit = () => {
    resetForm();
    setError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    const trimmedUser = irctcUserId.trim();
    if (!trimmedUser) {
      setError('IRCTC User ID is required.');
      return;
    }

    if (!editingId && !password) {
      setError('Password is required.');
      return;
    }

    setSaving(true);
    try {
      if (editingId) {
        await irctcAccountService.updateAccount(token, editingId, {
          irctcUserId: trimmedUser,
          password: password.trim() ? password : undefined,
        });
        setSuccess('IRCTC account updated successfully.');
      } else {
        await irctcAccountService.createAccount(token, {
          irctcUserId: trimmedUser,
          password,
        });
        setSuccess('IRCTC account saved successfully.');
      }
      resetForm();
      await loadAccounts(token);
    } catch (err) {
      setError(err?.message || 'Failed to save IRCTC account.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    setError('');
    setSuccess('');
    try {
      await irctcAccountService.deleteAccount(token, id);
      setDeletingId(null);
      setSuccess('IRCTC account deleted successfully.');
      await loadAccounts(token);
    } catch (err) {
      setError(err?.message || 'Failed to delete IRCTC account.');
    }
  };

  return (
    <div className="accounts-screen">
      <div className="accounts-card">
        {/* Header */}
        <div className="accounts-header">
          <div className="accounts-header-left">
            <h1 className="accounts-title">IRCTC ID Management</h1>
            <span
              className="accounts-count-badge"
              data-testid="total-accounts-count"
            >
              Total: {accounts.length}
            </span>
          </div>
          <button
            type="button"
            className="window-close-btn"
            onClick={handleClose}
            aria-label="Close window"
            title="Close window"
          >
            &times;
          </button>
        </div>

        {/* Alerts */}
        {error && (
          <div className="accounts-alert accounts-alert--error" role="alert">
            {error}
          </div>
        )}
        {success && (
          <div className="accounts-alert accounts-alert--success" role="status">
            {success}
          </div>
        )}

        {/* Form */}
        <form
          className="account-form accounts-form"
          onSubmit={handleSubmit}
          noValidate
        >
          <h2 className="account-form-heading accounts-form-title">
            {editingId ? 'Edit IRCTC Account' : 'Add IRCTC Account'}
          </h2>

          <div className="accounts-field">
            <label className="accounts-label" htmlFor="acc-irctc-userid">
              IRCTC User ID
            </label>
            <input
              id="acc-irctc-userid"
              type="text"
              className="accounts-input"
              placeholder="Enter IRCTC User ID"
              value={irctcUserId}
              onChange={(e) => setIrctcUserId(e.target.value)}
              disabled={saving}
              autoComplete="off"
            />
          </div>

          <div className="accounts-field">
            <label className="accounts-label" htmlFor="acc-password">
              Password
            </label>
            <div className="pw-input-wrapper">
              <input
                id="acc-password"
                type={showPassword ? 'text' : 'password'}
                className="accounts-input"
                placeholder={
                  editingId
                    ? 'Leave blank to keep unchanged'
                    : 'Enter Password'
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={saving}
                autoComplete="off"
              />
              <button
                type="button"
                className="pw-toggle-btn btn-toggle-pw"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                title={showPassword ? 'Hide password' : 'Show password'}
                tabIndex={0}
              >
                {showPassword ? (
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          <div className="form-actions">
            <button type="submit" className="btn-save" disabled={saving}>
              {saving
                ? 'Saving...'
                : editingId
                ? 'Update Account'
                : 'Add Account'}
            </button>
            {editingId && (
              <button
                type="button"
                className="btn-cancel"
                onClick={cancelEdit}
                disabled={saving}
              >
                Cancel
              </button>
            )}
          </div>
        </form>

        {/* Table */}
        <div className="accounts-table-container">
          <table className="accounts-table">
            <thead>
              <tr>
                <th className="col-sn">#</th>
                <th className="col-username">IRCTC User ID</th>
                <th className="col-password">Password</th>
                <th className="col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {accounts.length === 0 ? (
                <tr>
                  <td colSpan="4" className="accounts-empty">
                    No IRCTC accounts saved yet. Add one above.
                  </td>
                </tr>
              ) : (
                accounts.map((acc, index) => (
                  <tr key={acc.id}>
                    <td className="col-sn">{index + 1}</td>
                    <td className="col-username">
                      <span
                        className="account-username"
                        title={acc.irctcUserId || acc.username}
                      >
                        {acc.irctcUserId || acc.username}
                      </span>
                    </td>
                    <td className="col-password">
                      <span
                        className="account-password-visible"
                        title={acc.password}
                      >
                        {acc.password || '—'}
                      </span>
                    </td>
                    <td className="col-actions">
                      {deletingId === acc.id ? (
                        <div className="delete-confirm-wrap">
                          <span className="delete-confirm-text">Delete?</span>
                          <button
                            type="button"
                            className="btn-confirm-del btn-confirm-yes"
                            onClick={() => handleDelete(acc.id)}
                          >
                            Yes
                          </button>
                          <button
                            type="button"
                            className="btn-confirm-no"
                            onClick={() => setDeletingId(null)}
                          >
                            No
                          </button>
                        </div>
                      ) : (
                        <div className="action-btn-group">
                          <button
                            type="button"
                            className="btn-edit btn-action-edit"
                            onClick={() => startEdit(acc)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="btn-delete btn-action-delete"
                            onClick={() => setDeletingId(acc.id)}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
