import React, { useState, useEffect } from 'react';
import { UserProfileIcon, RefreshIcon } from '../../components/Icons';
import { fetchProfile } from '../../services/authService';

export function SellerProfilePage({ user }) {
  const [profile, setProfile] = useState(user);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const loadProfile = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchProfile();
      setProfile(data);
    } catch (err) {
      setError(err.message || 'Failed to fetch profile');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProfile();
  }, []);

  return (
    <div style={{ maxWidth: '640px', margin: '0 auto' }}>
      <div className="panel-card-box">
        <div className="card-box-header">
          <div className="header-left-title">
            <h3>Seller Profile</h3>
            <p>Account credentials and authorization parameters</p>
          </div>
          <button className="btn-secondary" onClick={loadProfile} title="Refresh">
            <RefreshIcon size={16} />
          </button>
        </div>

        {error && <div className="alert-box error">{error}</div>}

        <div style={{ display: 'flex', alignItems: 'center', gap: '20px', marginBottom: '28px', paddingBottom: '24px', borderBottom: '1px solid #1c2b44' }}>
          <div
            style={{
              width: '64px',
              height: '64px',
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #2563eb, #06b6d4)',
              color: '#ffffff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '24px',
              fontWeight: 800,
            }}
          >
            {(profile?.name || profile?.username || 'S').charAt(0).toUpperCase()}
          </div>
          <div>
            <h3 style={{ color: '#fff', fontSize: '18px', marginBottom: '4px' }}>
              {profile?.name || profile?.username}
            </h3>
            <div style={{ display: 'flex', gap: '8px' }}>
              <span className="status-pill active">{profile?.role || 'SELLER'}</span>
              <span className={`status-pill ${profile?.status || 'active'}`}>{profile?.status || 'active'}</span>
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
          <div className="form-group">
            <label>Username</label>
            <input
              type="text"
              className="form-input"
              value={profile?.username || ''}
              disabled
              style={{ opacity: 0.8, cursor: 'not-allowed' }}
            />
          </div>

          <div className="form-group">
            <label>Display Name</label>
            <input
              type="text"
              className="form-input"
              value={profile?.name || profile?.username || ''}
              disabled
              style={{ opacity: 0.8, cursor: 'not-allowed' }}
            />
          </div>

          <div className="form-group">
            <label>Email Address</label>
            <input
              type="text"
              className="form-input"
              value={profile?.email || 'Not configured'}
              disabled
              style={{ opacity: 0.8, cursor: 'not-allowed' }}
            />
          </div>

          <div className="form-group">
            <label>Account ID</label>
            <input
              type="text"
              className="form-input"
              value={profile?.id ? `#${profile.id}` : '—'}
              disabled
              style={{ opacity: 0.8, cursor: 'not-allowed' }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

