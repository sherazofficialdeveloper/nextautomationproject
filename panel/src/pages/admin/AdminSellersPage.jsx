import React, { useState, useEffect } from 'react';
import { PlusIcon, SearchIcon, RefreshIcon } from '../../components/Icons';
import { getAdminSellers, createSeller, updateSellerStatus } from '../../services/panelService';

export function AdminSellersPage() {
  const [sellers, setSellers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');

  // Modal State
  const [showModal, setShowModal] = useState(false);
  const [formData, setFormData] = useState({
    username: '',
    name: '',
    contact: '',
  });
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState(null);
  const [modalSuccess, setModalSuccess] = useState(null);

  const loadSellers = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await getAdminSellers({ search });
      setSellers(res.items || []);
    } catch (err) {
      setError(err.message || 'Failed to load sellers');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSellers();
  }, []);

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    loadSellers();
  };

  const handleCreateSubmit = async (e) => {
    e.preventDefault();
    setModalError(null);
    setModalSuccess(null);

    if (!formData.username || formData.username.trim().length < 3) {
      setModalError('Username must be at least 3 characters.');
      return;
    }

    try {
      setModalLoading(true);
      const res = await createSeller(formData);
      const account = res.account || res;
      setModalSuccess(`Seller "${account.username}" created successfully!`);
      setFormData({ username: '', name: '', contact: '' });
      loadSellers();
      setTimeout(() => {
        setShowModal(false);
        setModalSuccess(null);
      }, 1200);
    } catch (err) {
      setModalError(err.message || 'Failed to create seller.');
    } finally {
      setModalLoading(false);
    }
  };

  const handleToggleStatus = async (seller) => {
    const nextStatus = seller.status === 'active' ? 'inactive' : 'active';
    try {
      await updateSellerStatus(seller.id, nextStatus);
      setSellers((prev) =>
        prev.map((s) => (s.id === seller.id ? { ...s, status: nextStatus } : s))
      );
    } catch (err) {
      alert(err.message || 'Failed to update seller status');
    }
  };

  return (
    <div>
      <div className="panel-card-box">
        <div className="card-box-header">
          <div className="header-left-title">
            <h3>Seller Management</h3>
            <p>Create and manage seller accounts with unique Username</p>
          </div>

          <div className="header-actions-bar">
            <form onSubmit={handleSearchSubmit} className="search-input-wrapper">
              <SearchIcon size={16} className="search-icon" />
              <input
                type="text"
                className="search-input"
                placeholder="Search sellers..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </form>

            <button className="btn-secondary" onClick={loadSellers} title="Refresh">
              <RefreshIcon size={16} />
            </button>

            <button className="btn-primary" onClick={() => setShowModal(true)}>
              <PlusIcon size={16} />
              <span>Create Seller</span>
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
                <th>Contact</th>
                <th>Status</th>
                <th>Created Date</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="7" style={{ textAlign: 'center', padding: '32px', color: '#94a3b8' }}>
                    Loading sellers...
                  </td>
                </tr>
              ) : sellers.length === 0 ? (
                <tr>
                  <td colSpan="7" style={{ textAlign: 'center', padding: '32px', color: '#94a3b8' }}>
                    No sellers found. Click "Create Seller" to add one.
                  </td>
                </tr>
              ) : (
                sellers.map((s) => (
                  <tr key={s.id}>
                    <td style={{ color: '#64748b' }}>#{s.id}</td>
                    <td style={{ fontWeight: 600, color: '#f8fafc' }}>{s.username}</td>
                    <td>{s.name || '—'}</td>
                    <td style={{ color: '#94a3b8' }}>{s.contact || '—'}</td>
                    <td>
                      <span className={`status-pill ${s.status || 'active'}`}>
                        {s.status || 'active'}
                      </span>
                    </td>
                    <td style={{ color: '#94a3b8', fontSize: '12.5px' }}>
                      {s.createdAt ? new Date(s.createdAt).toLocaleDateString() : '—'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <button
                          className="btn-secondary"
                          style={{ padding: '5px 12px', fontSize: '12px' }}
                          onClick={() => handleToggleStatus(s)}
                        >
                          {s.status === 'active' ? 'Deactivate' : 'Activate'}
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

      {/* Create Seller Modal */}
      {showModal && (
        <div className="modal-backdrop" onClick={() => !modalLoading && setShowModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Create Seller Account</h3>
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
                  placeholder="e.g. seller_pro"
                  value={formData.username}
                  onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                  disabled={modalLoading}
                />
              </div>

              <div className="form-group">
                <label>Display Name (Optional)</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="e.g. Acme Reseller"
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
                  placeholder="+1 555-0188"
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
                  {modalLoading ? 'Creating...' : 'Create Seller'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

