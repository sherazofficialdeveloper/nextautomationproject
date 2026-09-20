import React, { useState, useEffect } from 'react';
import { SearchIcon, RefreshIcon } from '../../components/Icons';
import { getSuperAdminSellers } from '../../services/panelService';

export function SuperAdminSellersPage() {
  const [sellers, setSellers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');

  const loadSellers = async (term = '') => {
    try {
      setLoading(true);
      setError(null);
      const res = await getSuperAdminSellers(term);
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
    loadSellers(search);
  };

  return (
    <div className="panel-card-box">
      <div className="card-box-header">
        <div className="header-left-title">
          <h3>Platform Sellers</h3>
          <p>System-wide seller accounts and their creator administrators (View Only)</p>
        </div>

        <div className="header-actions-bar">
          <form onSubmit={handleSearchSubmit} className="search-input-wrapper">
            <SearchIcon size={16} className="search-icon" />
            <input
              type="text"
              className="search-input"
              placeholder="Search by name/username..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </form>

          <button className="btn-secondary" onClick={() => loadSellers(search)} title="Refresh">
            <RefreshIcon size={16} />
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
              <th>Created By (Admin)</th>
              <th>Keys Created</th>
              <th>Status</th>
              <th>Joined Date</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan="7" style={{ textAlign: 'center', padding: '32px', color: '#94a3b8' }}>
                  Loading seller accounts...
                </td>
              </tr>
            ) : sellers.length === 0 ? (
              <tr>
                <td colSpan="7" style={{ textAlign: 'center', padding: '32px', color: '#94a3b8' }}>
                  No sellers found in the system.
                </td>
              </tr>
            ) : (
              sellers.map((s) => (
                <tr key={s.id}>
                  <td style={{ color: '#64748b' }}>#{s.id}</td>
                  <td style={{ fontWeight: 600, color: '#f8fafc' }}>{s.username}</td>
                  <td>{s.name || '—'}</td>
                  <td>
                    {s.created_by_username ? (
                      <span
                        style={{
                          background: 'rgba(59, 130, 246, 0.12)',
                          color: '#60a5fa',
                          padding: '3px 8px',
                          borderRadius: '6px',
                          fontSize: '12px',
                          fontWeight: 600,
                        }}
                      >
                        @{s.created_by_username}
                      </span>
                    ) : (
                      <span style={{ color: '#64748b' }}>System Root</span>
                    )}
                  </td>
                  <td>
                    <span
                      style={{
                        background: 'rgba(16, 185, 129, 0.12)',
                        color: '#34d399',
                        padding: '3px 8px',
                        borderRadius: '6px',
                        fontSize: '12px',
                        fontWeight: 600,
                      }}
                    >
                      {s.keys_count || 0} keys
                    </span>
                  </td>
                  <td>
                    <span className={`status-pill ${s.status || 'active'}`}>
                      {s.status || 'active'}
                    </span>
                  </td>
                  <td style={{ color: '#94a3b8', fontSize: '12.5px' }}>
                    {s.created_at ? new Date(s.created_at).toLocaleDateString() : '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

