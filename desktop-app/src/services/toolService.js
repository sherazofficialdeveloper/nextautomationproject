'use strict';

import apiClient from './apiClient';

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export const toolService = {
  getPreferences: async (token) => {
    const res = await apiClient.get('/api/tools/preferences', {
      headers: authHeaders(token),
    });
    return res.preferences;
  },

  updatePreferences: async (token, data) => {
    const res = await apiClient.put('/api/tools/preferences', data, {
      headers: authHeaders(token),
    });
    return res.preferences;
  },

  getBookingHistory: async (token, retentionDays) => {
    const query = retentionDays ? `?retention_days=${retentionDays}` : '';
    const res = await apiClient.get(`/api/tools/history${query}`, {
      headers: authHeaders(token),
    });
    return res.history || [];
  },

  createBookingHistory: async (token, data) => {
    const res = await apiClient.post('/api/tools/history', data, {
      headers: authHeaders(token),
    });
    return res.record;
  },

  clearBookingHistory: async (token) => {
    const res = await apiClient.delete('/api/tools/history', {
      headers: authHeaders(token),
    });
    return res;
  },

  getProxies: async (token) => {
    const res = await apiClient.get('/api/tools/proxies', {
      headers: authHeaders(token),
    });
    return res.proxies || [];
  },

  createProxy: async (token, data) => {
    const res = await apiClient.post('/api/tools/proxies', data, {
      headers: authHeaders(token),
    });
    return res.proxy;
  },

  deleteProxy: async (token, proxyId) => {
    const res = await apiClient.delete(`/api/tools/proxies/${proxyId}`, {
      headers: authHeaders(token),
    });
    return res;
  },

  deleteAllProxies: async (token) => {
    const res = await apiClient.delete('/api/tools/proxies', {
      headers: authHeaders(token),
    });
    return res;
  },

  checkProxy: async (token, proxyId) => {
    const res = await apiClient.post(`/api/tools/proxies/${proxyId}/check`, null, {
      headers: authHeaders(token),
    });
    return res;
  },

  createBackup: async (token, options) => {
    const res = await apiClient.post('/api/tools/backup', options, {
      headers: authHeaders(token),
    });
    return res;
  },

  restoreBackup: async (token, options) => {
    const res = await apiClient.post('/api/tools/restore', options, {
      headers: authHeaders(token),
    });
    return res;
  },

  deleteUserData: async (token, options) => {
    const res = await apiClient.post('/api/tools/delete-data', options, {
      headers: authHeaders(token),
    });
    return res;
  },

  exportCategory: async (token, category) => {
    const res = await apiClient.get(`/api/tools/export/${category}`, {
      headers: authHeaders(token),
    });
    return res;
  },

  clearAutomationCookies: async (token) => {
    const res = await apiClient.post('/api/tools/clear-cookies', null, {
      headers: authHeaders(token),
    });
    return res;
  },

  getLicenseInfo: async (token) => {
    const res = await apiClient.get('/api/tools/license-info', {
      headers: authHeaders(token),
    });
    return res;
  },
};

export default toolService;

