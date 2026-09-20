import apiClient from './apiClient';

/**
 * Dedicated Ticket & Train Search Service for the desktop client.
 */
export async function searchTrains(token, searchParams) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await apiClient.post('/api/tickets/search', searchParams, {
    headers,
    timeoutMs: 90000,
  });
  return Array.isArray(response?.data) ? response.data : [];
}

export async function saveTicket(token, ticketData) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await apiClient.post('/api/tickets', ticketData, { headers });
  return response?.data || null;
}

export async function updateTicket(token, id, ticketData) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await apiClient.put(`/api/tickets/${id}`, ticketData, { headers });
  return response?.data || null;
}

export async function getTicketById(token, id) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await apiClient.get(`/api/tickets/${id}`, { headers });
  return response?.data || null;
}

export async function listTickets(token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await apiClient.get('/api/tickets', { headers });
  return Array.isArray(response?.data) ? response.data : [];
}

export async function deleteTicket(token, id) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await apiClient.delete(`/api/tickets/${id}`, { headers });
  return response?.success || false;
}

export async function deleteAllTickets(token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await apiClient.delete('/api/tickets', { headers });
  return response?.deletedCount ?? 0;
}

export async function launchBrowser(token, id, webId, options = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await apiClient.post(`/api/tickets/${id}/launch-browser`, { webId, ...options }, { headers, timeoutMs: 45000 });
  return response?.data || null;
}

export async function prepareBrowser(token, id, browserKey = 'chrome') {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await apiClient.post(`/api/tickets/${id}/prepare-browser`, { browserKey }, { headers, timeoutMs: 35000 });
  return response?.data || null;
}

export async function startBooking(token, id, options = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await apiClient.post(`/api/tickets/${id}/start-booking`, options, { headers, timeoutMs: 30000 });
  return response?.data || null;
}

export async function stopBooking(token, id) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await apiClient.post(`/api/tickets/${id}/stop-booking`, {}, { headers, timeoutMs: 15000 });
  return response?.data || null;
}

export async function getBookingStatus(token, id) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await apiClient.get(`/api/tickets/${id}/booking-status`, { headers, timeoutMs: 10000 });
  return response?.data || null;
}

export async function getAvailability(token, id) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await apiClient.get(`/api/tickets/${id}/availability`, { headers, timeoutMs: 15000 });
  return response?.data || null;
}

export async function getBrowserAvailability(token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await apiClient.get('/api/tickets/browsers/availability', { headers, timeoutMs: 10000 });
  return response?.data || null;
}

export default {
  searchTrains,
  saveTicket,
  updateTicket,
  getTicketById,
  listTickets,
  deleteTicket,
  deleteAllTickets,
  launchBrowser,
  prepareBrowser,
  startBooking,
  stopBooking,
  getBookingStatus,
  getAvailability,
  getBrowserAvailability,
};


