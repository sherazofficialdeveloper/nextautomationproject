import React, { useState, useEffect } from 'react';
import { WelcomeBanner } from '../../components/WelcomeBanner';
import { StatUsersIcon, StatKeyIcon, SellerUserIcon, KeyIcon, RefreshIcon } from '../../components/Icons';
import { getAdminDashboard } from '../../services/panelService';

export function AdminDashboard({ user, onNavigate }) {
  const [stats, setStats] = useState({
    totalSellers: 0,
    activeKeys: 0,
    inactiveKeys: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadStats = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getAdminDashboard();
      setStats({
        totalSellers: data.totalSellers || 0,
        activeKeys: data.activeKeys || 0,
        inactiveKeys: data.inactiveKeys || 0,
      });
    } catch (err) {
      setError(err.message || 'Failed to load dashboard metrics');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStats();
  }, []);

  return (
    <div>
      <WelcomeBanner user={user} />

      {error && (
        <div className="alert-box error">
          <span>{error}</span>
          <button
            onClick={loadStats}
            style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}
          >
            Retry
          </button>
        </div>
      )}

      {/* 3 Metric Cards for Admin */}
      <div className="stat-cards-grid">
        <div className="stat-card blue">
          <div className="stat-icon-wrap">
            <StatUsersIcon size={44} />
          </div>
          <div className="stat-content-wrap">
            <span className="stat-label">Total Seller</span>
            <div className="stat-number">{loading ? '...' : Number(stats.totalSellers).toLocaleString()}</div>
          </div>
          <div className="stat-footnote">
            <span>Sellers managed by you</span>
          </div>
        </div>

        <div className="stat-card green">
          <div className="stat-icon-wrap">
            <StatKeyIcon size={44} />
          </div>
          <div className="stat-content-wrap">
            <span className="stat-label">Active Keys</span>
            <div className="stat-number">{loading ? '...' : Number(stats.activeKeys).toLocaleString()}</div>
          </div>
          <div className="stat-footnote">
            <span>Currently valid licenses</span>
          </div>
        </div>

        <div className="stat-card red">
          <div className="stat-icon-wrap">
            <StatKeyIcon size={44} />
          </div>
          <div className="stat-content-wrap">
            <span className="stat-label">Inactive Keys</span>
            <div className="stat-number">{loading ? '...' : Number(stats.inactiveKeys).toLocaleString()}</div>
          </div>
          <div className="stat-footnote">
            <span>Expired / Revoked keys</span>
          </div>
        </div>
      </div>

      {/* Quick Access Container */}
      <div className="panel-card-box">
        <div className="card-box-header">
          <div className="header-left-title">
            <h3>Admin Management Overview</h3>
            <p>Perform key administrative actions and monitor seller performance</p>
          </div>
          <button className="btn-secondary" onClick={loadStats}>
            <RefreshIcon size={15} />
            <span>Refresh Data</span>
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
          <div
            style={{
              background: '#f8fafc',
              border: '1px solid #e2e8f0',
              borderRadius: '12px',
              padding: '20px',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
            onClick={() => onNavigate('sellers')}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '10px' }}>
              <div
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '10px',
                  background: 'rgba(37, 99, 235, 0.1)',
                  color: '#0066ff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <SellerUserIcon size={18} />
              </div>
              <h4 style={{ color: '#0f172a', fontSize: '15px', fontWeight: 700 }}>Seller Accounts</h4>
            </div>
            <p style={{ color: '#64748b', fontSize: '13px' }}>
              Create new Seller accounts with unique Username, view seller activity.
            </p>
          </div>

          <div
            style={{
              background: '#f8fafc',
              border: '1px solid #e2e8f0',
              borderRadius: '12px',
              padding: '20px',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
            onClick={() => onNavigate('keys')}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '10px' }}>
              <div
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '10px',
                  background: 'rgba(16, 185, 129, 0.1)',
                  color: '#059669',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <KeyIcon size={18} />
              </div>
              <h4 style={{ color: '#0f172a', fontSize: '15px', fontWeight: 700 }}>Audit Keys by Seller</h4>
            </div>
            <p style={{ color: '#64748b', fontSize: '13px' }}>
              Inspect and filter issued license keys and expiry timelines for each seller.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
