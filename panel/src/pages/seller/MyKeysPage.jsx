import React, { useState, useEffect } from 'react';
import { SearchIcon, RefreshIcon, CopyIcon, CheckIcon, PlusIcon } from '../../components/Icons';
import { getSellerKeys } from '../../services/panelService';

export function MyKeysPage({ onNavigate }) {
  const [keys, setKeys] = useState([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [copiedKeyId, setCopiedKeyId] = useState(null);

  const loadKeys = async () => {
    try {
      setLoading(true);
      setError(null);
      const params = {};
      if (search) params.search = search;
      if (statusFilter) params.status = statusFilter;

      const res = await getSellerKeys(params);
      setKeys(res.items || []);
    } catch (err) {
      setError(err.message || 'Failed to load keys');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadKeys();
  }, [statusFilter]);

  const handleCopy = (id, keyText) => {
    navigator.clipboard.writeText(keyText);
    setCopiedKeyId(id);
    setTimeout(() => setCopiedKeyId(null), 2000);
  };

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    loadKeys();
  };

  return (
    <div className="panel-card-box">
      <div className="card-box-header">
        <div className="header-left-title">
          <h3>My Issued License Keys</h3>
          <p>Manage and track all access keys created under your account</p>
        </div>

        <div className="header-actions-bar">
          <form onSubmit={handleSearchSubmit} className="search-input-wrapper">
            <SearchIcon size={16} className="search-icon" />
            <input
              type="text"
              className="search-input"
              placeholder="Search key..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </form>

          <select
            className="form-select"
            style={{ padding: '8px 12px', fontSize: '13px' }}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All Statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="EXPIRED">Expired</option>
            <option value="REVOKED">Revoked</option>
            <option value="SUSPENDED">Suspended</option>
          </select>

          <button className="btn-secondary" onClick={loadKeys} title="Refresh">
            <RefreshIcon size={16} />
          </button>

          <button className="btn-primary" onClick={() => onNavigate('create-key')}>
            <PlusIcon size={16} />
            <span>Generate Key</span>
          </button>
        </div>
      </div>

      {error && <div className="alert-box error">{error}</div>}

      <div className="table-responsive">
        <table className="panel-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>License / Access Key</th>
              <th>Duration</th>
              <th>Status</th>
              <th>Starts At</th>
              <th>Expires At</th>
              <th>Created Date</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan="7" style={{ textAlign: 'center', padding: '32px', color: '#94a3b8' }}>
                  Loading your license keys...
                </td>
              </tr>
            ) : keys.length === 0 ? (
              <tr>
                <td colSpan="7" style={{ textAlign: 'center', padding: '32px', color: '#94a3b8' }}>
                  No keys found. Click "Generate Key" to create your first license key.
                </td>
              </tr>
            ) : (
              keys.map((k) => (
                <tr key={k.id}>
                  <td style={{ color: '#64748b' }}>#{k.id}</td>
                  <td>
                    <div className="mono-key">
                      <span>{k.key}</span>
                      <button
                        className="copy-mini-btn"
                        onClick={() => handleCopy(k.id, k.key)}
                        title="Copy Key"
                      >
                        {copiedKeyId === k.id ? (
                          <CheckIcon size={14} style={{ color: '#34d399' }} />
                        ) : (
                          <CopyIcon size={14} />
                        )}
                      </button>
                    </div>
                  </td>
                  <td>{k.duration}</td>
                  <td>
                    <span className={`status-pill ${k.status.toLowerCase()}`}>
                      {k.status}
                    </span>
                  </td>
                  <td style={{ color: '#94a3b8', fontSize: '12.5px' }}>{k.startDate}</td>
                  <td style={{ color: '#94a3b8', fontSize: '12.5px' }}>{k.expiresAt}</td>
                  <td style={{ color: '#64748b', fontSize: '12px' }}>
                    {k.createdAt ? new Date(k.createdAt).toLocaleDateString() : '—'}
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

