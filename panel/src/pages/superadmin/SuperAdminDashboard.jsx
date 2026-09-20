import React, { useState, useEffect } from 'react';
import { WelcomeBanner } from '../../components/WelcomeBanner';
import { StatUsersIcon, StatKeyIcon, AdminShieldIcon, SellerUserIcon, KeyIcon, RefreshIcon } from '../../components/Icons';
import { getSuperAdminDashboard } from '../../services/panelService';

export function SuperAdminDashboard({ user, onNavigate }) {
  const [stats, setStats] = useState({
    totalAdmins: 0,
    totalSellers: 0,
    totalKeys: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadStats = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getSuperAdminDashboard();
      setStats(data);
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

      {/* 3 Core Metric Cards matching Reference Screenshot */}
      <div className="stat-cards-grid">
        <div className="stat-card blue">
          <div className="stat-icon-wrap">
            <StatUsersIcon size={44} />
          </div>
          <div className="stat-content-wrap">
            <span className="stat-label">Total Admin</span>
            <div className="stat-number">{loading ? '...' : Number(stats.totalAdmins).toLocaleString()}</div>
          </div>
          <div className="stat-footnote">
            <span>Platform administrators</span>
          </div>
        </div>

        <div className="stat-card purple">
          <div className="stat-icon-wrap">
            <StatUsersIcon size={44} />
          </div>
          <div className="stat-content-wrap">
            <span className="stat-label">Total Seller Created</span>
            <div className="stat-number">{loading ? '...' : Number(stats.totalSellers).toLocaleString()}</div>
          </div>
          <div className="stat-footnote">
            <span>System-wide active sellers</span>
          </div>
        </div>

        <div className="stat-card orange">
          <div className="stat-icon-wrap">
            <StatKeyIcon size={44} />
          </div>
          <div className="stat-content-wrap">
            <span className="stat-label">Total Keys Created</span>
            <div className="stat-number">{loading ? '...' : Number(stats.totalKeys).toLocaleString()}</div>
          </div>
          <div className="stat-footnote">
            <span>Issued license keys</span>
          </div>
        </div>
      </div>

      {/* Quick Navigation / Overview Action Cards */}
      <div className="panel-card-box">
        <div className="card-box-header">
          <div className="header-left-title">
            <h3>Quick Management Actions</h3>
            <p>Direct navigation to manage platform entities</p>
          </div>
          <button className="btn-secondary" onClick={loadStats}>
            <RefreshIcon size={15} />
            <span>Refresh Stats</span>
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
            onClick={() => onNavigate('admins')}
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
                <AdminShieldIcon size={18} />
              </div>
              <h4 style={{ color: '#0f172a', fontSize: '15px', fontWeight: 700 }}>Manage Admins</h4>
            </div>
            <p style={{ color: '#64748b', fontSize: '13px' }}>
              Create new Admins with Username & Password, toggle status, or remove accounts.
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
            onClick={() => onNavigate('sellers')}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '10px' }}>
              <div
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '10px',
                  background: 'rgba(168, 85, 247, 0.1)',
                  color: '#9333ea',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <SellerUserIcon size={18} />
              </div>
              <h4 style={{ color: '#0f172a', fontSize: '15px', fontWeight: 700 }}>View Sellers</h4>
            </div>
            <p style={{ color: '#64748b', fontSize: '13px' }}>
              Inspect all registered sellers across the system and view creator admin links.
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
              <h4 style={{ color: '#0f172a', fontSize: '15px', fontWeight: 700 }}>View Platform Keys</h4>
            </div>
            <p style={{ color: '#64748b', fontSize: '13px' }}>
              Audit all issued license keys, track expiry dates, and seller associations.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
