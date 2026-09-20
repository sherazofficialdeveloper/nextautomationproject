import React, { useState, useEffect } from 'react';
import { WelcomeBanner } from '../../components/WelcomeBanner';
import { StatKeyIcon, UserProfileIcon, RefreshIcon, PlusIcon, KeyIcon } from '../../components/Icons';
import { getSellerDashboard } from '../../services/panelService';

export function SellerDashboard({ user, onNavigate }) {
  const [stats, setStats] = useState({
    totalKeys: 0,
    activeKeys: 0,
    deactivatedKeys: 0,
    usedKeys: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadStats = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getSellerDashboard();
      setStats({
        totalKeys: data.totalKeys || 0,
        activeKeys: data.activeKeys || 0,
        deactivatedKeys: data.deactivatedKeys || 0,
        usedKeys: data.usedKeys || 0,
      });
    } catch (err) {
      setError(err.message || 'Failed to load seller stats');
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

      {/* 4 Metric Cards for Seller */}
      <div className="stat-cards-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        <div className="stat-card blue">
          <div className="stat-icon-wrap">
            <StatKeyIcon size={44} />
          </div>
          <div className="stat-content-wrap">
            <span className="stat-label">Total Keys</span>
            <div className="stat-number">{loading ? '...' : Number(stats.totalKeys).toLocaleString()}</div>
          </div>
          <div className="stat-footnote">
            <span>All generated licenses</span>
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
            <span>Valid and operational</span>
          </div>
        </div>

        <div className="stat-card amber">
          <div className="stat-icon-wrap">
            <StatKeyIcon size={44} />
          </div>
          <div className="stat-content-wrap">
            <span className="stat-label">Deactivated Keys</span>
            <div className="stat-number">{loading ? '...' : Number(stats.deactivatedKeys).toLocaleString()}</div>
          </div>
          <div className="stat-footnote">
            <span>Expired / Suspended</span>
          </div>
        </div>

        <div className="stat-card red">
          <div className="stat-icon-wrap">
            <StatKeyIcon size={44} />
          </div>
          <div className="stat-content-wrap">
            <span className="stat-label">Used Keys</span>
            <div className="stat-number">{loading ? '...' : Number(stats.usedKeys).toLocaleString()}</div>
          </div>
          <div className="stat-footnote">
            <span>Assigned to clients</span>
          </div>
        </div>
      </div>

      {/* Quick Actions Container */}
      <div className="panel-card-box">
        <div className="card-box-header">
          <div className="header-left-title">
            <h3>License Distribution Hub</h3>
            <p>Generate new access keys or inspect your active inventory</p>
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button className="btn-secondary" onClick={loadStats}>
              <RefreshIcon size={15} />
              <span>Refresh Stats</span>
            </button>
          </div>
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
            onClick={() => onNavigate('create-key')}
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
                <PlusIcon size={18} />
              </div>
              <h4 style={{ color: '#0f172a', fontSize: '15px', fontWeight: 700 }}>Generate License Key</h4>
            </div>
            <p style={{ color: '#64748b', fontSize: '13px' }}>
              Create a fresh access key for 1, 3, 6, or 12 months with immediate copy-to-clipboard.
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
            onClick={() => onNavigate('my-keys')}
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
              <h4 style={{ color: '#0f172a', fontSize: '15px', fontWeight: 700 }}>My Issued Keys</h4>
            </div>
            <p style={{ color: '#64748b', fontSize: '13px' }}>
              Review all keys created by your seller account, verify validity, and search keys.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
