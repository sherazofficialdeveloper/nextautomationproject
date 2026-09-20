import env from '../config/env';

// Centralized HTTP client for the desktop renderer.
//
// - No fake endpoints, no mock responses, no fake success.
// - When the backend URL is not configured, a clear safe error is surfaced.
// - Errors are normalized to a safe shape; raw server internals are never
//   shown to users.
//
// Error shape: { type: 'network' | 'timeout' | 'server' | 'client' | 'unknown',
//                status?: number, code?: string, message: string }

export class ApiError extends Error {
  constructor({ type = 'unknown', status = null, code = null, stage = null, message }) {
    super(message || 'Request failed.');
    this.name = 'ApiError';
    this.type = type;
    this.status = status;
    this.code = code;
    this.stage = stage;
  }
}

function buildUrl(path) {
  if (!env.apiBaseUrl) {
    throw new ApiError({
      type: 'client',
      message: 'Backend API is not configured.',
    });
  }
  const base = env.apiBaseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return base + suffix;
}

async function request(method, path, body, options = {}) {
  const url = buildUrl(path);
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || env.apiTimeoutMs;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {
    Accept: 'application/json',
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  };

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      credentials: 'omit',
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err && err.name === 'AbortError') {
      throw new ApiError({ type: 'timeout', message: 'Request timed out.' });
    }
    throw new ApiError({ type: 'network', message: 'Network error. Unable to reach the server.' });
  }
  clearTimeout(timeoutId);

  let data = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const type = response.status >= 500 ? 'server' : response.status >= 400 ? 'client' : 'unknown';
    const message =
      (data && typeof data === 'object' && typeof data.message === 'string' && data.message) ||
      (data && typeof data === 'object' && typeof data.error === 'string' && data.error) ||
      'Request failed.';
    throw new ApiError({
      type,
      status: response.status,
      code: data && data.code ? String(data.code) : null,
      stage: data && data.stage ? String(data.stage) : null,
      message,
    });
  }

  return data;
}

export const apiClient = {
  get: (path, options) => request('GET', path, null, options),
  post: (path, body, options) => request('POST', path, body, options),
  put: (path, body, options) => request('PUT', path, body, options),
  patch: (path, body, options) => request('PATCH', path, body, options),
  delete: (path, options) => request('DELETE', path, null, options),
};

export default apiClient;
