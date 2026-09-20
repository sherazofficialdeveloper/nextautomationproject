import { useEffect, useState } from 'react';
import { useAuth } from './auth-context';
import LoginPage from '../pages/LoginPage';
import MainDashboardPage from '../pages/MainDashboardPage';
import AccountManagerPage from '../pages/AccountManagerPage';
import NewTicketPage from '../pages/NewTicketPage';
import SearchTrainPage from '../pages/SearchTrainPage';
import OpenTicketsPage from '../pages/OpenTicketsPage';
import TicketWebSelectPage from '../pages/TicketWebSelectPage';
import BankManagementPage from '../pages/BankManagementPage';
import BookingHistoryPage from '../pages/BookingHistoryPage';
import ProxySettingPage from '../pages/ProxySettingPage';
import BackupRestorePage from '../pages/BackupRestorePage';
import BrowserCheckPage from '../pages/BrowserCheckPage';
import CookieDeletePage from '../pages/CookieDeletePage';
import SoftwareVersionPage from '../pages/SoftwareVersionPage';

function App() {
  const { isAuthenticated } = useAuth();
  const [currentHash, setCurrentHash] = useState(() => {
    return typeof window !== 'undefined' ? window.location.hash : '';
  });

  useEffect(() => {
    const handleHashChange = () => {
      setCurrentHash(window.location.hash);
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  if (currentHash === '#accounts') {
    return <AccountManagerPage />;
  }

  if (currentHash === '#bank') {
    return <BankManagementPage />;
  }

  if (currentHash === '#ticket') {
    return <NewTicketPage />;
  }

  if (currentHash === '#open-tickets') {
    return <OpenTicketsPage />;
  }

  if (currentHash === '#ticket-web-select') {
    return <TicketWebSelectPage />;
  }

  if (currentHash === '#search-train') {
    return <SearchTrainPage />;
  }

  if (currentHash === '#booking-history') {
    return <BookingHistoryPage />;
  }

  if (currentHash === '#proxy-setting') {
    return <ProxySettingPage />;
  }

  if (currentHash === '#backup-restore') {
    return <BackupRestorePage />;
  }

  if (currentHash === '#browser-check') {
    return <BrowserCheckPage />;
  }

  if (currentHash === '#cookie-delete') {
    return <CookieDeletePage />;
  }

  if (currentHash === '#version-check') {
    return <SoftwareVersionPage />;
  }

  return isAuthenticated ? <MainDashboardPage /> : <LoginPage />;
}

export default App;
