import apiClient from './apiClient';

/**
 * Dedicated Bank & Card Service for the desktop renderer.
 * Communicates exclusively with the authenticated backend API.
 */

// ============================================================================
// BANKS
// ============================================================================

export async function listBanks(token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await apiClient.get('/api/banks', { headers });
  return Array.isArray(response?.data) ? response.data : [];
}

export async function createBank(token, bankData) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await apiClient.post('/api/banks', bankData, { headers });
  return response?.data || null;
}

export async function updateBank(token, id, bankData) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await apiClient.put(`/api/banks/${id}`, bankData, { headers });
  return response?.data || null;
}

export async function deleteBank(token, id) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await apiClient.delete(`/api/banks/${id}`, { headers });
  return response?.success || false;
}

export async function deleteAllBanks(token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await apiClient.delete('/api/banks', { headers });
  return response?.success || false;
}

// ============================================================================
// CARDS (DEBIT / CREDIT)
// ============================================================================

export async function listCards(token, cardType = null) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const query = cardType ? `?type=${encodeURIComponent(cardType)}` : '';
  const response = await apiClient.get(`/api/cards${query}`, { headers });
  return Array.isArray(response?.data) ? response.data : [];
}

export async function createCard(token, cardData) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await apiClient.post('/api/cards', cardData, { headers });
  return response?.data || null;
}

export async function updateCard(token, id, cardData) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await apiClient.put(`/api/cards/${id}`, cardData, { headers });
  return response?.data || null;
}

export async function deleteCard(token, id) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await apiClient.delete(`/api/cards/${id}`, { headers });
  return response?.success || false;
}

export async function deleteAllCards(token, cardType = null) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const query = cardType ? `?type=${encodeURIComponent(cardType)}` : '';
  const response = await apiClient.delete(`/api/cards${query}`, { headers });
  return response?.success || false;
}

export default {
  listBanks,
  createBank,
  updateBank,
  deleteBank,
  deleteAllBanks,
  listCards,
  createCard,
  updateCard,
  deleteCard,
  deleteAllCards,
};
