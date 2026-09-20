import { useState, useEffect } from 'react';
import { useAuth } from '../app/auth-context';
import toolService from '../services/toolService';
import '../styles/backupRestore.css';

export default function BackupRestorePage() {
  const { session } = useAuth();
  const [token, setToken] = useState(() => session?.token || null);
  const [activeTab, setActiveTab] = useState('backup'); // 'backup' | 'restore' | 'delete'

  // Tab 1: Backup State
  const [allBackup, setAllBackup] = useState(true);
  const [irctcBackup, setIrctcBackup] = useState(true);
  const [bankBackup, setBankBackup] = useState(true);
  const [ticketBackup, setTicketBackup] = useState(true);
  const [historyBackup, setHistoryBackup] = useState(true);
  const [backupPassword, setBackupPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // Tab 2: Restore State
  const [selectedFilePath, setSelectedFilePath] = useState('');
  const [loadedBackupPackage, setLoadedBackupPackage] = useState(null);
  const [restorePassword, setRestorePassword] = useState('');
  const [appendToExisting, setAppendToExisting] = useState(true);

  // Tab 3: Delete State
  const [deleteTarget, setDeleteTarget] = useState('irctc'); // 'irctc' | 'bank' | 'ticket' | 'history' | 'all'

  // Toast / Status Message
  const [statusMessage, setStatusMessage] = useState('');
  const [loading, setLoading] = useState(false);

  // 1. Session Token Fetch
  useEffect(() => {
    let isMounted = true;
    if (token) return;

    const bridge = typeof window !== 'undefined' ? window.netx : null;
    if (bridge?.app?.getBackupRestoreSession) {
      bridge.app
        .getBackupRestoreSession()
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

  const showToast = (msg) => {
    setStatusMessage(msg);
    setTimeout(() => setStatusMessage(''), 3500);
  };

  const handleClose = () => {
    if (typeof window !== 'undefined' && window.netx?.app?.closeCurrentWindow) {
      window.netx.app.closeCurrentWindow();
    }
  };

  // -------------------------------------------------------------
  // TAB 1: BACKUP HANDLER
  // -------------------------------------------------------------
  const handleBackup = async (e) => {
    e?.preventDefault();
    if (!token) {
      showToast('Authentication session not found.');
      return;
    }

    if (!backupPassword) {
      showToast('Please enter a Backup Password.');
      return;
    }

    if (backupPassword !== confirmPassword) {
      showToast('Backup Password and Confirm Password do not match.');
      return;
    }

    const categories = [];
    if (allBackup || irctcBackup) categories.push('irctc');
    if (allBackup || bankBackup) categories.push('bank');
    if (allBackup || ticketBackup) categories.push('ticket');
    if (allBackup || historyBackup) categories.push('history');

    setLoading(true);
    try {
      const res = await toolService.createBackup(token, {
        all: allBackup,
        categories,
        password: backupPassword,
        confirmPassword,
      });

      if (!res.ok) {
        showToast(res.message || 'Backup creation failed.');
        return;
      }

      // Save using native dialog if available
      const bridge = typeof window !== 'undefined' ? window.netx : null;
      if (bridge?.app?.browseSaveBackupPath && bridge?.app?.saveBackupFile) {
        const saveDialog = await bridge.app.browseSaveBackupPath(res.filename);
        if (!saveDialog.canceled && saveDialog.filePath) {
          const saveRes = await bridge.app.saveBackupFile({
            filePath: saveDialog.filePath,
            content: res.encryptedPackage,
          });
          if (saveRes.ok) {
            showToast(`Backup saved successfully to: ${saveDialog.filePath}`);
            setBackupPassword('');
            setConfirmPassword('');
          } else {
            showToast(`Failed to write file: ${saveRes.error}`);
          }
        }
      } else {
        // Fallback: download via browser blob
        const blob = new Blob([JSON.stringify(res.encryptedPackage, null, 2)], {
          type: 'application/json',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = res.filename;
        a.click();
        URL.revokeObjectURL(url);
        showToast('Backup package downloaded.');
        setBackupPassword('');
        setConfirmPassword('');
      }
    } catch (err) {
      showToast(err?.message || 'Error creating backup.');
    } finally {
      setLoading(false);
    }
  };

  // -------------------------------------------------------------
  // TAB 2: RESTORE HANDLERS
  // -------------------------------------------------------------
  const handleBrowseFile = async () => {
    const bridge = typeof window !== 'undefined' ? window.netx : null;
    if (bridge?.app?.browseBackupFile) {
      const result = await bridge.app.browseBackupFile();
      if (!result.canceled && result.filePath) {
        setSelectedFilePath(result.filePath);
        if (result.package) {
          setLoadedBackupPackage(result.package);
        } else if (result.error) {
          showToast(result.error);
        }
      }
    } else {
      // Browser file picker fallback
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.netxbak,.bak,.json';
      input.onchange = (e) => {
        const file = e.target.files[0];
        if (file) {
          setSelectedFilePath(file.name);
          const reader = new FileReader();
          reader.onload = (evt) => {
            try {
              const parsed = JSON.parse(evt.target.result);
              setLoadedBackupPackage(parsed);
            } catch {
              showToast('Invalid backup file JSON format.');
            }
          };
          reader.readAsText(file);
        }
      };
      input.click();
    }
  };

  const handleRestore = async (e) => {
    e?.preventDefault();
    if (!token) {
      showToast('Authentication session not found.');
      return;
    }

    if (!loadedBackupPackage) {
      showToast('Please select a valid backup file first.');
      return;
    }

    if (!restorePassword) {
      showToast('Please enter the File Password.');
      return;
    }

    setLoading(true);
    try {
      const res = await toolService.restoreBackup(token, {
        encryptedPackage: loadedBackupPackage,
        password: restorePassword,
        append: appendToExisting,
      });

      if (res.ok) {
        showToast(res.message || 'Backup restored successfully!');
        setRestorePassword('');
      } else {
        showToast(res.message || 'Restore failed.');
      }
    } catch (err) {
      showToast(err?.message || 'Error restoring backup. Check password.');
    } finally {
      setLoading(false);
    }
  };

  // -------------------------------------------------------------
  // TAB 3: DELETE HANDLERS
  // -------------------------------------------------------------
  const handleDelete = async () => {
    if (!token) {
      showToast('Authentication session not found.');
      return;
    }

    const labels = {
      irctc: 'IRCTC IDs',
      bank: 'Bank & Card details',
      ticket: 'Saved Tickets',
      history: 'Booking History',
      all: 'ALL data',
    };

    const targetLabel = labels[deleteTarget] || deleteTarget;
    const confirm = window.confirm(`Are you sure you want to permanently delete ${targetLabel}?`);
    if (!confirm) return;

    setLoading(true);
    try {
      const res = await toolService.deleteUserData(token, { target: deleteTarget });
      if (res.ok) {
        showToast(`Successfully deleted ${res.deletedCount} records.`);
      } else {
        showToast(res.message || 'Delete operation failed.');
      }
    } catch (err) {
      showToast(err?.message || 'Error during delete.');
    } finally {
      setLoading(false);
    }
  };

  const handleExportQuick = async () => {
    if (!token) {
      showToast('Authentication session not found.');
      return;
    }

    const catMap = {
      irctc: 'irctc',
      bank: 'bank',
      ticket: 'ticket',
      history: 'history',
      all: 'history',
    };

    try {
      const res = await toolService.exportCategory(token, catMap[deleteTarget] || 'history');
      if (res.ok) {
        const blob = new Blob([JSON.stringify(res.records, null, 2)], {
          type: 'application/json',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `NETX_EXPORT_${deleteTarget.toUpperCase()}_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast(`Exported ${deleteTarget} data successfully.`);
      }
    } catch (err) {
      showToast(err?.message || 'Export failed.');
    }
  };

  const handleImportQuick = () => {
    setActiveTab('restore');
    handleBrowseFile();
  };

  return (
    <div className="bak-window-frame" data-testid="backup-restore-window">
      {/* Purple Titlebar matching media_1789628764453.png */}
      <header className="bak-titlebar">
        <span className="bak-titlebar-title">BACKUP &amp; RESTORE</span>
        <button
          type="button"
          className="bak-close-btn"
          onClick={handleClose}
          title="Close"
          data-testid="btn-close-backup-restore"
        >
          ✕
        </button>
      </header>

      {/* Main Cyan Wrapper with Tabs & Content */}
      <div className="bak-body-wrapper">
        {/* Navigation Tabs */}
        <nav className="bak-tabs-nav" aria-label="Backup and Restore Navigation">
          <button
            type="button"
            className={`bak-tab-btn ${activeTab === 'backup' ? 'bak-tab-btn--active' : ''}`}
            onClick={() => setActiveTab('backup')}
            data-testid="tab-backup"
          >
            Backup
          </button>
          <button
            type="button"
            className={`bak-tab-btn ${activeTab === 'restore' ? 'bak-tab-btn--active' : ''}`}
            onClick={() => setActiveTab('restore')}
            data-testid="tab-restore"
          >
            Restore
          </button>
          <button
            type="button"
            className={`bak-tab-btn ${activeTab === 'delete' ? 'bak-tab-btn--active' : ''}`}
            onClick={() => setActiveTab('delete')}
            data-testid="tab-delete"
          >
            Delete
          </button>
        </nav>

        {/* Content Card Area */}
        <main className="bak-content-panel">
          {/* ============================================================ */}
          {/* TAB 1: BACKUP (media_1789628764453.png)                       */}
          {/* ============================================================ */}
          {activeTab === 'backup' && (
            <fieldset className="bak-fieldset" data-testid="panel-backup">
              <legend className="bak-legend">Backup</legend>

              {/* Checkboxes Group */}
              <div className="bak-checkbox-grid">
                <label className="bak-checkbox-label">
                  <input
                    type="checkbox"
                    checked={allBackup}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setAllBackup(checked);
                      if (checked) {
                        setIrctcBackup(true);
                        setBankBackup(true);
                        setTicketBackup(true);
                        setHistoryBackup(true);
                      }
                    }}
                    data-testid="chk-all-backup"
                  />
                  <span>All Backup</span>
                </label>

                <label className={`bak-checkbox-label ${allBackup ? 'bak-checkbox-label--disabled' : ''}`}>
                  <input
                    type="checkbox"
                    checked={allBackup || irctcBackup}
                    disabled={allBackup}
                    onChange={(e) => setIrctcBackup(e.target.checked)}
                    data-testid="chk-irctc-backup"
                  />
                  <span>IRCTC ID Details</span>
                </label>

                <label className={`bak-checkbox-label ${allBackup ? 'bak-checkbox-label--disabled' : ''}`}>
                  <input
                    type="checkbox"
                    checked={allBackup || bankBackup}
                    disabled={allBackup}
                    onChange={(e) => setBankBackup(e.target.checked)}
                    data-testid="chk-bank-backup"
                  />
                  <span>Bank Details</span>
                </label>

                <div className="bak-checkbox-col">
                  <label className={`bak-checkbox-label ${allBackup ? 'bak-checkbox-label--disabled' : ''}`}>
                    <input
                      type="checkbox"
                      checked={allBackup || ticketBackup}
                      disabled={allBackup}
                      onChange={(e) => setTicketBackup(e.target.checked)}
                      data-testid="chk-ticket-backup"
                    />
                    <span>Saved Ticket</span>
                  </label>

                  <label className={`bak-checkbox-label ${allBackup ? 'bak-checkbox-label--disabled' : ''}`}>
                    <input
                      type="checkbox"
                      checked={allBackup || historyBackup}
                      disabled={allBackup}
                      onChange={(e) => setHistoryBackup(e.target.checked)}
                      data-testid="chk-history-backup"
                    />
                    <span>Ticket History</span>
                  </label>
                </div>
              </div>

              {/* Password Inputs and Action */}
              <div className="bak-form-rows">
                <div className="bak-form-row">
                  <label htmlFor="bak-pwd" className="bak-form-label">
                    Backup Password:
                  </label>
                  <input
                    id="bak-pwd"
                    type="password"
                    className="bak-form-input"
                    value={backupPassword}
                    onChange={(e) => setBackupPassword(e.target.value)}
                    data-testid="input-backup-password"
                  />
                </div>

                <div className="bak-form-row bak-form-row--with-btn">
                  <label htmlFor="bak-confirm-pwd" className="bak-form-label">
                    Confirm Password:
                  </label>
                  <input
                    id="bak-confirm-pwd"
                    type="password"
                    className="bak-form-input"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    data-testid="input-confirm-password"
                  />

                  <button
                    type="button"
                    className="bak-action-btn bak-action-btn--primary"
                    onClick={handleBackup}
                    disabled={loading}
                    data-testid="btn-do-backup"
                  >
                    {loading ? 'Processing...' : 'Backup'}
                  </button>
                </div>
              </div>
            </fieldset>
          )}

          {/* ============================================================ */}
          {/* TAB 2: RESTORE (media_1789628776913.png)                      */}
          {/* ============================================================ */}
          {activeTab === 'restore' && (
            <fieldset className="bak-fieldset" data-testid="panel-restore">
              <legend className="bak-legend">Restore</legend>

              <div className="bak-restore-grid">
                {/* Row 1: Select File & Browse Button */}
                <div className="bak-restore-row">
                  <label htmlFor="restore-file-path" className="bak-restore-label">
                    Select File:
                  </label>
                  <input
                    id="restore-file-path"
                    type="text"
                    className="bak-restore-input"
                    value={selectedFilePath}
                    placeholder="Select .netxbak or .bak file..."
                    readOnly
                    data-testid="input-restore-file"
                  />
                  <button
                    type="button"
                    className="bak-browse-btn"
                    onClick={handleBrowseFile}
                    data-testid="btn-browse-file"
                  >
                    Browse
                  </button>
                </div>

                {/* Row 2: File Password & Restore Button */}
                <div className="bak-restore-row">
                  <label htmlFor="restore-pwd" className="bak-restore-label">
                    File Password:
                  </label>
                  <input
                    id="restore-pwd"
                    type="password"
                    className="bak-restore-input"
                    value={restorePassword}
                    onChange={(e) => setRestorePassword(e.target.value)}
                    placeholder="Enter backup password"
                    data-testid="input-restore-password"
                  />

                  <div className="bak-restore-action-box">
                    <button
                      type="button"
                      className="bak-restore-btn"
                      onClick={handleRestore}
                      disabled={loading}
                      data-testid="btn-do-restore"
                    >
                      {loading ? 'Restoring...' : 'Restore'}
                    </button>

                    <label className="bak-append-checkbox-label">
                      <input
                        type="checkbox"
                        checked={appendToExisting}
                        onChange={(e) => setAppendToExisting(e.target.checked)}
                        data-testid="chk-append-existing"
                      />
                      <span>Append To Existing Data</span>
                    </label>
                  </div>
                </div>
              </div>
            </fieldset>
          )}

          {/* ============================================================ */}
          {/* TAB 3: DELETE (media_1789628789010.png)                       */}
          {/* ============================================================ */}
          {activeTab === 'delete' && (
            <fieldset className="bak-fieldset" data-testid="panel-delete">
              <legend className="bak-legend">Delete Data</legend>

              <div className="bak-delete-grid">
                {/* Left Action Buttons */}
                <div className="bak-delete-left-actions">
                  <button
                    type="button"
                    className="bak-side-btn"
                    onClick={handleExportQuick}
                    data-testid="btn-delete-export"
                  >
                    Export
                  </button>
                  <button
                    type="button"
                    className="bak-side-btn"
                    onClick={handleImportQuick}
                    data-testid="btn-delete-import"
                  >
                    Import
                  </button>
                </div>

                {/* Right Radio Options in 2 Columns */}
                <div className="bak-delete-radios-container">
                  <div className="bak-radio-col">
                    <label className="bak-radio-label">
                      <input
                        type="radio"
                        name="deleteTarget"
                        value="irctc"
                        checked={deleteTarget === 'irctc'}
                        onChange={(e) => setDeleteTarget(e.target.value)}
                        data-testid="radio-del-irctc"
                      />
                      <span>Only Irctc-id</span>
                    </label>

                    <label className="bak-radio-label">
                      <input
                        type="radio"
                        name="deleteTarget"
                        value="bank"
                        checked={deleteTarget === 'bank'}
                        onChange={(e) => setDeleteTarget(e.target.value)}
                        data-testid="radio-del-bank"
                      />
                      <span>Only Bank</span>
                    </label>
                  </div>

                  <div className="bak-radio-col">
                    <label className="bak-radio-label">
                      <input
                        type="radio"
                        name="deleteTarget"
                        value="ticket"
                        checked={deleteTarget === 'ticket'}
                        onChange={(e) => setDeleteTarget(e.target.value)}
                        data-testid="radio-del-ticket"
                      />
                      <span>Only Ticket</span>
                    </label>

                    <label className="bak-radio-label">
                      <input
                        type="radio"
                        name="deleteTarget"
                        value="history"
                        checked={deleteTarget === 'history'}
                        onChange={(e) => setDeleteTarget(e.target.value)}
                        data-testid="radio-del-history"
                      />
                      <span>Only History</span>
                    </label>

                    <label className="bak-radio-label">
                      <input
                        type="radio"
                        name="deleteTarget"
                        value="all"
                        checked={deleteTarget === 'all'}
                        onChange={(e) => setDeleteTarget(e.target.value)}
                        data-testid="radio-del-all"
                      />
                      <span>All Data</span>
                    </label>
                  </div>
                </div>

                {/* Bottom Wide Delete Button */}
                <div className="bak-delete-action-row">
                  <button
                    type="button"
                    className="bak-delete-btn"
                    onClick={handleDelete}
                    disabled={loading}
                    data-testid="btn-do-delete"
                  >
                    {loading ? 'Deleting...' : 'Delete'}
                  </button>
                </div>
              </div>
            </fieldset>
          )}

          {/* Toast Notification */}
          {statusMessage && <div className="bak-toast">{statusMessage}</div>}
        </main>
      </div>
    </div>
  );
}

