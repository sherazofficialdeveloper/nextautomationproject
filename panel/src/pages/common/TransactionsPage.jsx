import React, { useState } from 'react';
import { TransactionsIcon, SearchIcon, RefreshIcon } from '../../components/Icons';

export function TransactionsPage() {
  const [searchTerm, setSearchTerm] = useState('');

  // Sample transactions data for presentation
  const transactions = [
    {
      id: 'TX-1092',
      action: 'License Key Issued',
      performedBy: 'admin_alpha',
      target: 'KEY-9X82-KL12',
      duration: '3 Months',
      date: '2026-09-16 14:22:10',
      status: 'success',
    },
    {
      id: 'TX-1091',
      action: 'Seller Created',
      performedBy: 'superadmin',
      target: 'seller_prime',
      duration: '-',
      date: '2026-09-16 12:45:00',
      status: 'success',
    },
    {
      id: 'TX-1090',
      action: 'License Key Revoked',
      performedBy: 'admin_beta',
      target: 'KEY-4A77-QP91',
      duration: 'Expired',
      date: '2026-09-15 18:30:12',
      status: 'revoked',
    },
    {
      id: 'TX-1089',
      action: 'Admin Created',
      performedBy: 'superadmin',
      target: 'admin_gamma',
      duration: '-',
      date: '2026-09-15 10:15:45',
      status: 'success',
    },
  ];

  const filtered = transactions.filter(
    (t) =>
      t.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
      t.action.toLowerCase().includes(searchTerm.toLowerCase()) ||
      t.performedBy.toLowerCase().includes(searchTerm.toLowerCase()) ||
      t.target.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div>
      <div className="panel-card-box">
        <div className="card-box-header">
          <div className="header-left-title">
            <h3>Platform Transactions & Audit Log</h3>
            <p>Complete ledger of administrative and licensing operations</p>
          </div>

          <div className="header-actions-bar">
            <div className="search-input-wrapper">
              <SearchIcon size={16} className="search-icon" />
              <input
                type="text"
                className="search-input"
                placeholder="Search transactions..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            <button className="btn-secondary" onClick={() => setSearchTerm('')}>
              <RefreshIcon size={14} />
              <span>Reset</span>
            </button>
          </div>
        </div>

        <div className="table-responsive">
          <table className="panel-table">
            <thead>
              <tr>
                <th>Tx ID</th>
                <th>Operation</th>
                <th>Operator</th>
                <th>Target Resource</th>
                <th>Duration / Detail</th>
                <th>Timestamp</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((tx) => (
                <tr key={tx.id}>
                  <td>
                    <span className="mono-key" style={{ fontWeight: 600 }}>
                      {tx.id}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <TransactionsIcon size={14} style={{ color: '#0066ff' }} />
                      <span style={{ fontWeight: 600 }}>{tx.action}</span>
                    </div>
                  </td>
                  <td>{tx.performedBy}</td>
                  <td>
                    <span className="mono-key">{tx.target}</span>
                  </td>
                  <td>{tx.duration}</td>
                  <td style={{ color: '#64748b', fontSize: '12.5px' }}>{tx.date}</td>
                  <td>
                    <span className={`status-pill ${tx.status === 'success' ? 'active' : 'revoked'}`}>
                      {tx.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

