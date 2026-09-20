import apiClient from './apiClient';

/**
 * Dedicated IRCTC Account Service for the desktop renderer.
 * Communicates exclusively with the authenticated backend API.
 */
export async function listAccounts(token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await apiClient.get('/api/irctc-accounts', { headers });
  return Array.isArray(response?.data) ? response.data : [];
}

export async function createAccount(token, { irctcUserId, password }) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await apiClient.post(
    '/api/irctc-accounts',
    { irctcUserId, password },
    { headers }
  );
  return response?.data || null;
}

export async function updateAccount(token, id, { irctcUserId, password }) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const body = { irctcUserId };
  if (typeof password === 'string' && password.trim().length > 0) {
    body.password = password.trim();
  }
  const response = await apiClient.patch(`/api/irctc-accounts/${id}`, body, { headers });
  return response?.data || null;
}

export async function deleteAccount(token, id) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await apiClient.delete(`/api/irctc-accounts/${id}`, { headers });
  return response?.success || false;
}

export default {
  listAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
};

