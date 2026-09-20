import React from 'react';
import {
  BrandLogoIcon,
  CrownIcon,
  AdminUserIcon,
  StoreIcon,
  DashboardIcon,
  AdminShieldIcon,
  SellerUserIcon,
  KeyIcon,
  TransactionsIcon,
  SettingsIcon,
  UserProfileIcon,
  PlusIcon,
  LogOutIcon,
} from './Icons';

export function Sidebar({ currentTab, onSelectTab, role, onLogout }) {
  let brandTitle = 'ADMIN';
  let brandIcon = <AdminUserIcon size={30} />;
  let brandSub = 'Admin Panel';

  if (role === 'SUPER_ADMIN') {
    brandTitle = 'SUPER ADMIN';
    brandIcon = <CrownIcon size={30} />;
    brandSub = 'Super Admin Panel';
  } else if (role === 'ADMIN') {
    brandTitle = 'ADMIN';
    brandIcon = <AdminUserIcon size={30} />;
    brandSub = 'Admin Panel';
  } else if (role === 'SELLER') {
    brandTitle = 'SELLER';
    brandIcon = <StoreIcon size={30} />;
    brandSub = 'Seller Panel';
  }

  let navItems = [];
  if (role === 'SUPER_ADMIN') {
    navItems = [
      { id: 'dashboard', label: 'Dashboard', icon: <DashboardIcon /> },
      { id: 'admins', label: 'Admins', icon: <AdminShieldIcon /> },
      { id: 'sellers', label: 'Sellers', icon: <SellerUserIcon /> },
      { id: 'keys', label: 'Keys', icon: <KeyIcon /> },
      { id: 'transactions', label: 'Transactions', icon: <TransactionsIcon /> },
      { id: 'settings', label: 'Settings', icon: <SettingsIcon /> },
    ];
  } else if (role === 'ADMIN') {
    navItems = [
      { id: 'dashboard', label: 'Dashboard', icon: <DashboardIcon /> },
      { id: 'sellers', label: 'Sellers', icon: <SellerUserIcon /> },
      { id: 'keys', label: 'Keys', icon: <KeyIcon /> },
      { id: 'transactions', label: 'Transactions', icon: <TransactionsIcon /> },
      { id: 'settings', label: 'Settings', icon: <SettingsIcon /> },
    ];
  } else if (role === 'SELLER') {
    navItems = [
      { id: 'dashboard', label: 'Dashboard', icon: <DashboardIcon /> },
      { id: 'create-key', label: 'Create Key', icon: <PlusIcon /> },
      { id: 'my-keys', label: 'My Keys', icon: <KeyIcon /> },
      { id: 'profile', label: 'Profile', icon: <UserProfileIcon /> },
    ];
  }

  return (
    <aside className="panel-sidebar">
      <div>
        <div className="sidebar-brand">
          <div className="brand-icon-box">
            <BrandLogoIcon size={32} />
            {brandIcon}
          </div>
          <div className="brand-info">
            <span className="brand-role-title">{brandTitle}</span>
            <span className="brand-title">NETX Pro</span>
            <span className="brand-role-subtext">{brandSub}</span>
          </div>
        </div>

        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item-btn ${currentTab === item.id ? 'active' : ''}`}
              onClick={() => onSelectTab(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      </div>

      <div className="sidebar-footer">
        <button type="button" className="logout-btn" onClick={onLogout}>
          <LogOutIcon size={16} />
          <span>Logout</span>
        </button>
      </div>
    </aside>
  );
}
