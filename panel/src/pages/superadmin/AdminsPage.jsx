import React, { useState, useEffect } from 'react';
import { PlusIcon, SearchIcon, RefreshIcon, TrashIcon, CheckIcon } from '../../components/Icons';
import { getAdmins, createAdmin, updateAdminStatus, deleteAdmin } from '../../services/panelService';

export function AdminsPage() {
  const [admins, setAdmins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');

  // Modal State
  const [showModal, setShowModal] = useState(false);
  const [formData, setFormData] = useState({
    username: '',
    password: '',
    name: '',
    contact: '',
  });
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState(null);
  const [modalSuccess, setModalSuccess] = useState(null);

  const loadAdmins = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await getAdmins();
      setAdmins(res.items || []);
    } catch (err) {
      setError(err.message || 'Failed to load admins');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAdmins();
  }, []);

  const handleCreateSubmit = async (e) => {
    e.preventDefault();
    setModalError(null);
    setModalSuccess(null);

    if (!formData.username || formData.username.trim().length < 3) {
      setModalError('Username must be at least 3 characters.');
      return;
    }
    if (!formData.password || formData.password.length < 8) {
      setModalError('Password must be at least 8 characters.');
      return;
    }

    try {
      setModalLoading(true);
      const res = await createAdmin(formData);
      setModalSuccess(`Admin "${res.admin.username}" created successfully!`);
      setFormData({ username: '', password: '', name: '', contact: '' });
      loadAdmins();
      setTimeout(() => {
        setShowModal(false);
        setModalSuccess(null);
      }, 1200);
    } catch (err) {
      setModalError(err.message || 'Failed to create admin.');
    } finally {
      setModalLoading(false);
    }
  };

  const handleToggleStatus = async (admin) => {
    const nextStatus = admin.status === 'active' ? 'inactive' : 'active';
    try {
      await updateAdminStatus(admin.id, nextStatus);
      setAdmins((prev) =>
        prev.map((a) => (a.id === admin.id ? { ...a, status: nextStatus } : a))
      );
    } catch (err) {
      alert(err.message || 'Failed to update status');
    }
  };

  const handleDelete = async (admin) => {
    if (!window.confirm(`Are you sure you want to delete Admin "${admin.username}"?`)) {
      return;
    }
    try {
      await deleteAdmin(admin.id);
      setAdmins((prev) => prev.filter((a) => a.id !== admin.id));
    } catch (err) {
      alert(err.message || 'Failed to delete admin');
    }
  };

  const filteredAdmins = admins.filter((a) => {
    const term = search.toLowerCase();
    return (
      (a.username && a.username.toLowerCase().includes(term)) ||
      (a.name && a.name.toLowerCase().includes(term)) ||
      (a.email && a.email.toLowerCase().includes(term))
    );
  });

  return (
    <div>
      <div className="panel-card-box">
        <div className="card-box-header">
          <div className="header-left-title">
            <h3>Admin Management</h3>
            <p>Create and manage platform administrator accounts</p>
          </div>

          <div className="header-actions-bar">
            <div className="search-input-wrapper">
              <SearchIcon size={16} className="search-icon" />
              <input
                type="text"
                className="search-input"
                placeholder="Search admins..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <button className="btn-secondary" onClick={loadAdmins} title="Refresh">
              <RefreshIcon size={16} />
            </button>

            <button className="btn-primary" onClick={() => setShowModal(true)}>
              <PlusIcon size={16} />
              <span>Create Admin</span>
            </button>
          </div>
        </div>

        {error && <div className="alert-box error">{error}</div>}

        <div className="table-responsive">
          <table className="panel-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Username</th>
                <th>Display Name</th>
                <th>Sellers Created</th>
                <th>Status</th>
                <th>Created Date</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="7" style={{ textAlign: 'center', padding: '32px', color: '#94a3b8' }}>
                    Loading administrator accounts...
                  </td>
                </tr>
              ) : filteredAdmins.length === 0 ? (
                <tr>
                  <td colSpan="7" style={{ textAlign: 'center', padding: '32px', color: '#94a3b8' }}>
                    No administrators found.
                  </td>
                </tr>
              ) : (
                filteredAdmins.map((adm) => (
                  <tr key={adm.id}>
                    <td style={{ color: '#64748b' }}>#{adm.id}</td>
                    <td style={{ fontWeight: 600, color: '#f8fafc' }}>{adm.username}</td>
                    <td>{adm.name || '—'}</td>
                    <td>
                      <span
                        style={{
                          background: 'rgba(168, 85, 247, 0.12)',
                          color: '#c084fc',
                          padding: '3px 8px',
                          borderRadius: '6px',
                          fontSize: '12px',
                          fontWeight: 600,
                        }}
                      >
                        {adm.sellers_count || 0} sellers
                      </span>
                    </td>
                    <td>
                      <span className={`status-pill ${adm.status || 'active'}`}>
                        {adm.status || 'active'}
                      </span>
                    </td>
                    <td style={{ color: '#94a3b8', fontSize: '12.5px' }}>
                      {adm.created_at ? new Date(adm.created_at).toLocaleDateString() : '—'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <button
                          className="btn-secondary"
                          style={{ padding: '5px 10px', fontSize: '12px' }}
                          onClick={() => handleToggleStatus(adm)}
                        >
                          {adm.status === 'active' ? 'Deactivate' : 'Activate'}
                        </button>
                        <button
                          className="btn-danger-outline"
                          onClick={() => handleDelete(adm)}
                          title="Delete Admin"
                        >
                          <TrashIcon size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Admin Modal */}
      {showModal && (
        <div className="modal-backdrop" onClick={() => !modalLoading && setShowModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Create Administrator Account</h3>
              <button
                className="modal-close-btn"
                onClick={() => !modalLoading && setShowModal(false)}
              >
                ✕
              </button>
            </div>

            {modalError && <div className="alert-box error">{modalError}</div>}
            {modalSuccess && <div className="alert-box success">{modalSuccess}</div>}

            <form onSubmit={handleCreateSubmit}>
              <div className="form-group">
                <label>Username *</label>
                <input
                  type="text"
                  className="form-input"
                  required
                  placeholder="e.g. admin_north"
                  value={formData.username}
                  onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                  disabled={modalLoading}
                />
              </div>

              <div className="form-group">
                <label>Password * (Minimum 8 characters)</label>
                <input
                  type="password"
                  className="form-input"
                  required
                  placeholder="••••••••••••"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  disabled={modalLoading}
                />
              </div>

              <div className="form-group">
                <label>Display Name (Optional)</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="e.g. John Doe"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  disabled={modalLoading}
                />
              </div>

              <div className="form-group">
                <label>Contact (Optional)</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="+1 555-0199"
                  value={formData.contact}
                  onChange={(e) => setFormData({ ...formData, contact: e.target.value })}
                  disabled={modalLoading}
                />
              </div>

              <div className="modal-actions-row">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setShowModal(false)}
                  disabled={modalLoading}
                >
                  Cancel
                </button>
                <button type="submit" className="btn-primary" disabled={modalLoading}>
                  {modalLoading ? 'Creating...' : 'Create Admin'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

