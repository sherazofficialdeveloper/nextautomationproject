import { createContext, useContext } from 'react';

// Shared auth context + hook (non-component module so fast-refresh rules
// stay satisfied; AuthContext.jsx holds only the provider component).

export const AuthContext = createContext(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
