import React, { useState, useEffect } from 'react';
import { getCurrentUser, isAuthenticated, logout } from './services/authService';
import { LoginPage } from './pages/auth/LoginPage';
import { PanelLayout } from './layouts/PanelLayout';

// Super Admin Pages
import { SuperAdminDashboard } from './pages/superadmin/SuperAdminDashboard';
import { AdminsPage } from './pages/superadmin/AdminsPage';
import { SuperAdminSellersPage } from './pages/superadmin/SuperAdminSellersPage';
import { SuperAdminKeysPage } from './pages/superadmin/SuperAdminKeysPage';

// Admin Pages
import { AdminDashboard } from './pages/admin/AdminDashboard';
import { AdminSellersPage } from './pages/admin/AdminSellersPage';
import { AdminKeysPage } from './pages/admin/AdminKeysPage';

// Seller Pages
import { SellerDashboard } from './pages/seller/SellerDashboard';
import { CreateKeyPage } from './pages/seller/CreateKeyPage';
import { MyKeysPage } from './pages/seller/MyKeysPage';
import { SellerProfilePage } from './pages/seller/SellerProfilePage';

// Common Pages
import { TransactionsPage } from './pages/common/TransactionsPage';
import { SettingsPage } from './pages/common/SettingsPage';

export function App() {
  const [user, setUser] = useState(null);
  const [currentTab, setCurrentTab] = useState('dashboard');
  const [checkingAuth, setCheckingAuth] = useState(true);

  useEffect(() => {
    if (isAuthenticated()) {
      setUser(getCurrentUser());
    }
    setCheckingAuth(false);
  }, []);

  const handleLoginSuccess = (loggedInUser) => {
    setUser(loggedInUser);
    setCurrentTab('dashboard');
  };

  const handleLogout = () => {
    logout();
    setUser(null);
    setCurrentTab('dashboard');
  };

  if (checkingAuth) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: '#070b14',
          background: '#f1f5f9',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#94a3b8',
          color: '#64748b',
          fontFamily: 'sans-serif',
        }}
      >
        Initializing NETX Pro Panel...
      </div>
    );
  }

  if (!user) {
    return <LoginPage onLoginSuccess={handleLoginSuccess} />;
  }

  const role = user.role;

  // Title calculation based on tab and role
  const titles = {
    dashboard: 'Dashboard',
    admins: 'Admin Management',
    sellers: role === 'SUPER_ADMIN' ? 'Platform Sellers' : 'Seller Accounts',
    keys: role === 'SUPER_ADMIN' ? 'All Platform Keys' : 'Keys by Seller',
    transactions: 'Platform Transactions',
    settings: 'System Settings',
    'create-key': 'Generate License Key',
    'my-keys': 'My License Keys',
    profile: 'Seller Profile',
  };

  const currentTitle = titles[currentTab] || 'NETX Pro Panel';

  return (
    <PanelLayout
      title={currentTitle}
      currentTab={currentTab}
      onSelectTab={setCurrentTab}
      user={user}
      onLogout={handleLogout}
    >
      {/* Super Admin Routing */}
      {role === 'SUPER_ADMIN' && (
        <>
          {currentTab === 'dashboard' && (
            <SuperAdminDashboard user={user} onNavigate={setCurrentTab} />
          )}
          {currentTab === 'admins' && <AdminsPage />}
          {currentTab === 'sellers' && <SuperAdminSellersPage />}
          {currentTab === 'keys' && <SuperAdminKeysPage />}
          {currentTab === 'transactions' && <TransactionsPage />}
          {currentTab === 'settings' && <SettingsPage />}
        </>
      )}

      {/* Admin Routing */}
      {role === 'ADMIN' && (
        <>
          {currentTab === 'dashboard' && (
            <AdminDashboard user={user} onNavigate={setCurrentTab} />
          )}
          {currentTab === 'sellers' && <AdminSellersPage />}
          {currentTab === 'keys' && <AdminKeysPage />}
          {currentTab === 'transactions' && <TransactionsPage />}
          {currentTab === 'settings' && <SettingsPage />}
        </>
      )}

      {/* Seller Routing */}
      {role === 'SELLER' && (
        <>
          {currentTab === 'dashboard' && (
            <SellerDashboard user={user} onNavigate={setCurrentTab} />
          )}
          {currentTab === 'create-key' && (
            <CreateKeyPage onNavigate={setCurrentTab} />
          )}
          {currentTab === 'my-keys' && (
            <MyKeysPage onNavigate={setCurrentTab} />
          )}
          {currentTab === 'profile' && (
            <SellerProfilePage user={user} />
          )}
        </>
      )}
    </PanelLayout>
  );
}

export default App;

