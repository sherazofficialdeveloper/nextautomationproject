import React from 'react';
import { Sidebar } from '../components/Sidebar';
import { Navbar } from '../components/Navbar';

export function PanelLayout({ title, currentTab, onSelectTab, user, onLogout, children }) {
  return (
    <div className="panel-app-shell">
      <Sidebar
        currentTab={currentTab}
        onSelectTab={onSelectTab}
        role={user?.role}
        onLogout={onLogout}
      />
      <div className="panel-main-area">
        <Navbar title={title} user={user} onLogout={onLogout} />
        <main className="panel-content-viewport">{children}</main>
      </div>
    </div>
  );
}

