import React, { useState } from 'react';
import { BellIcon, MenuIcon, ChevronDownIcon, UserProfileIcon, LogOutIcon } from './Icons';

export function Navbar({ title, user, onLogout }) {
  const [showDropdown, setShowDropdown] = useState(false);

  const roleName = (user && user.role) || 'USER';
  let roleDisplay = 'Super Admin';
  let avatarBg = '#0066ff';
  if (user?.role === 'ADMIN') {
    roleDisplay = 'Admin';
    avatarBg = '#0066ff';
  } else if (user?.role === 'SELLER') {
    roleDisplay = 'Seller';
    avatarBg = '#10b981';
  }

  const displayName = user?.name || user?.username || roleDisplay;
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <header className="panel-topbar">
      <div className="topbar-left">
        <h1 className="topbar-title">{title}</h1>
        <button className="hamburger-btn" title="Toggle menu" type="button">
          <MenuIcon size={20} />
        </button>
      </div>

      <div className="topbar-right">
        <button className="notification-bell-btn" title="Notifications" type="button">
          <BellIcon size={18} />
          <span className="bell-badge-dot"></span>
        </button>

        <div style={{ position: 'relative' }}>
          <div
            className="user-profile-pill"
            onClick={() => setShowDropdown(!showDropdown)}
          >
            <div className="avatar-circle" style={{ backgroundColor: avatarBg }}>
              <UserProfileIcon size={16} />
            </div>
            <div className="user-details-mini">
              <span className="user-name-label">{displayName}</span>
              <span className="user-role-badge">{roleName.replace('_', ' ')}</span>
            </div>
            <ChevronDownIcon size={14} className="icon" />
          </div>

          {showDropdown && (
            <div
              style={{
                position: 'absolute',
                top: '46px',
                right: '0',
                background: '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: '10px',
                padding: '8px',
                width: '190px',
                boxShadow: '0 10px 25px rgba(0,0,0,0.1)',
                zIndex: 50,
              }}
            >
              <div
                style={{
                  padding: '8px 12px',
                  fontSize: '12px',
                  color: '#64748b',
                  borderBottom: '1px solid #f1f5f9',
                  marginBottom: '4px',
                }}
              >
                Logged in as <strong style={{ color: '#0f172a' }}>{user?.username}</strong>
                <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>Role: {roleDisplay}</div>
              </div>
              <button
                type="button"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  width: '100%',
                  background: 'transparent',
                  border: 'none',
                  color: '#ef4444',
                  padding: '8px 12px',
                  borderRadius: '6px',
                  fontSize: '13px',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
                onClick={() => {
                  setShowDropdown(false);
                  onLogout();
                }}
              >
                <LogOutIcon size={14} />
                <span>Logout</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
