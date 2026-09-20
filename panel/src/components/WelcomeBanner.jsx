import React, { useState, useEffect } from 'react';
import { CrownIcon, AdminUserIcon, StoreIcon, CalendarIcon } from './Icons';

export function WelcomeBanner({ user }) {
  const [currentDateTime, setCurrentDateTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentDateTime(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const role = user?.role;

  // Header content configuration based on role
  let roleIcon = <CrownIcon size={26} />;
  let title = 'Super Admin Dashboard';
  let subtitle = 'Overview of your platform';

  if (role === 'ADMIN') {
    roleIcon = <AdminUserIcon size={26} />;
    title = 'Admin Dashboard';
    subtitle = 'Overview of your sellers and keys';
  } else if (role === 'SELLER') {
    roleIcon = <StoreIcon size={26} />;
    title = 'Seller Dashboard';
    subtitle = 'Overview of your keys';
  }

  // Format date: e.g. "Saturday, 13 September 2026"
  const dateStr = currentDateTime.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  // Format time: e.g. "02:30:15 PM"
  const timeStr = currentDateTime.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });

  return (
    <div className="dashboard-header-banner">
      <div className="dashboard-title-group">
        <div className="dashboard-role-icon-box">
          {roleIcon}
        </div>
        <div className="dashboard-text-meta">
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
      </div>

      <div className="live-calendar-card">
        <div className="calendar-icon-wrap">
          <CalendarIcon size={20} />
        </div>
        <div className="calendar-text-wrap">
          <span className="calendar-date-text">{dateStr}</span>
          <span className="calendar-time-text">{timeStr}</span>
        </div>
      </div>
    </div>
  );
}
