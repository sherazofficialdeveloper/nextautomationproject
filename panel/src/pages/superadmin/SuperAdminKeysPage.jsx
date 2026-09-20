import React, { useState, useEffect } from 'react';
import { SearchIcon, RefreshIcon, CopyIcon, CheckIcon } from '../../components/Icons';
import { getSuperAdminKeys } from '../../services/panelService';

export function SuperAdminKeysPage() {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [copiedKeyId, setCopiedKeyId] = useState(null);

  const loadKeys = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await getSuperAdminKeys(search, statusFilter);
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
          <h3>Platform License Keys</h3>
          <p>Global registry of all generated license keys and statuses</p>
        </div>

        <div className="header-actions-bar">
          <form onSubmit={handleSearchSubmit} className="search-input-wrapper">
            <SearchIcon size={16} className="search-icon" />
            <input
              type="text"
              className="search-input"
              placeholder="Search by key/seller..."
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
        </div>
      </div>

      {error && <div className="alert-box error">{error}</div>}

      <div className="table-responsive">
        <table className="panel-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>License / Access Key</th>
              <th>Seller</th>
              <th>Duration</th>
              <th>Status</th>
              <th>Starts At</th>
              <th>Expires At</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan="7" style={{ textAlign: 'center', padding: '32px', color: '#94a3b8' }}>
                  Loading license keys...
                </td>
              </tr>
            ) : keys.length === 0 ? (
              <tr>
                <td colSpan="7" style={{ textAlign: 'center', padding: '32px', color: '#94a3b8' }}>
                  No license keys found.
                </td>
              </tr>
            ) : (
              keys.map((k) => (
                <tr key={k.id}>
                  <td style={{ color: '#64748b' }}>#{k.id}</td>
                  <td>
                    <div className="mono-key">
                      <span>{k.access_key}</span>
                      <button
                        className="copy-mini-btn"
                        onClick={() => handleCopy(k.id, k.access_key)}
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
                      @{k.seller_username}
                    </span>
                  </td>
                  <td>
                    {k.duration_value} {k.duration_unit}
                  </td>
                  <td>
                    <span className={`status-pill ${k.status.toLowerCase()}`}>
                      {k.status}
                    </span>
                  </td>
                  <td style={{ color: '#94a3b8', fontSize: '12.5px' }}>
                    {k.starts_at ? new Date(k.starts_at).toLocaleDateString() : '—'}
                  </td>
                  <td style={{ color: '#94a3b8', fontSize: '12.5px' }}>
                    {k.expires_at ? new Date(k.expires_at).toLocaleDateString() : '—'}
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

