import { apiRequest } from './apiClient';

// Super Admin Endpoints
export async function getSuperAdminDashboard() {
  return await apiRequest('/api/super-admin/dashboard');
}

export async function getAdmins() {
  return await apiRequest('/api/super-admin/admins');
}

export async function createAdmin(payload) {
  return await apiRequest('/api/super-admin/admins', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateAdminStatus(id, status) {
  return await apiRequest(`/api/super-admin/admins/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export async function deleteAdmin(id) {
  return await apiRequest(`/api/super-admin/admins/${id}`, {
    method: 'DELETE',
  });
}

export async function getSuperAdminSellers(search = '') {
  const q = search ? `?search=${encodeURIComponent(search)}` : '';
  return await apiRequest(`/api/super-admin/sellers${q}`);
}

export async function getSuperAdminKeys(search = '', status = '') {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (status) params.set('status', status);
  const q = params.toString() ? `?${params.toString()}` : '';
  return await apiRequest(`/api/super-admin/keys${q}`);
}

// Admin Endpoints
export async function getAdminDashboard() {
  return await apiRequest('/api/auth/admin/dashboard');
}

export async function getAdminSellers(params = {}) {
  const q = new URLSearchParams(params).toString();
  return await apiRequest(`/api/admin/sellers${q ? `?${q}` : ''}`);
}

export async function createSeller(payload) {
  return await apiRequest('/api/admin/sellers', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateSellerStatus(id, status) {
  return await apiRequest(`/api/admin/sellers/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export async function getAdminKeys(params = {}) {
  const q = new URLSearchParams(params).toString();
  return await apiRequest(`/api/admin/licenses${q ? `?${q}` : ''}`);
}

// Seller Endpoints
export async function getSellerDashboard() {
  return await apiRequest('/api/auth/seller/dashboard');
}

export async function createSellerKey(payload) {
  return await apiRequest('/api/seller/licenses', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function getSellerKeys(params = {}) {
  const q = new URLSearchParams(params).toString();
  return await apiRequest(`/api/seller/licenses${q ? `?${q}` : ''}`);
}

