import { apiRequest } from './apiClient';

const TOKEN_KEY = 'netx_token';
const USER_KEY = 'netx_user';

export async function login(identifier, password) {
  const data = await apiRequest('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier, password }),
  });

  if (data.token && data.user) {
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
  }

  return data;
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function getCurrentUser() {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function isAuthenticated() {
  return !!getToken() && !!getCurrentUser();
}

export function getUserRole() {
  const user = getCurrentUser();
  return user ? user.role : null;
}

export async function fetchProfile() {
  const profile = await apiRequest('/api/auth/profile');
  const user = getCurrentUser() || {};
  const updated = { ...user, ...profile };
  localStorage.setItem(USER_KEY, JSON.stringify(updated));
  return updated;
}

