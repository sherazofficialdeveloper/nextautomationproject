import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import App from './app/App.jsx';
import { AuthProvider } from './app/AuthContext.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>
);
