'use strict';

// HTTP-level security checks for the account-management routes that run
// WITHOUT a database: route wiring plus 401 for unauthenticated requests.
// Role-based behavior (403) requires valid JWTs and is covered by service
// tests + RBAC middleware review; DB-backed flows need PostgreSQL.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const app = require('../src/app');

async function withServer(fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.on('listening', resolve);
    server.on('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

async function request(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

test('account routes reject unauthenticated requests with 401', async () => {
  await withServer(async (base) => {
    const cases = [
      ['GET', '/api/health', undefined],
      ['GET', '/api/admin/sellers', undefined],
      ['POST', '/api/admin/sellers', {}],
      ['GET', '/api/admin/sellers/1', undefined],
      ['PUT', '/api/admin/sellers/1', {}],
      ['PATCH', '/api/admin/sellers/1/status', { status: 'active' }],
      ['GET', '/api/admin/me', undefined],
      ['PATCH', '/api/admin/me', {}],
      ['PATCH', '/api/admin/me/password', {}],
      ['GET', '/api/seller/me', undefined],
      ['PATCH', '/api/seller/me', {}],
      ['PATCH', '/api/seller/me/password', {}],
    ];
    const results = [];
    for (const [method, path, body] of cases) {
      results.push([method, path, await request(base, method, path, body)]);
    }

    const [, , health] = results[0];
    assert.equal(health.status, 200, 'health endpoint should stay public');
    assert.equal(health.data.status, 'ok');

    for (let i = 1; i < results.length; i += 1) {
      const [method, path, result] = results[i];
      assert.equal(result.status, 401, `${method} ${path} must require authentication`);
    }
  });
});

test('login validation runs before any database access', async () => {
  await withServer(async (base) => {
    const badIdentifier = await request(base, 'POST', '/api/auth/login', { identifier: 'bad identifier!', password: 'longenough1' });
    assert.equal(badIdentifier.status, 400);
    const badPassword = await request(base, 'POST', '/api/auth/login', { identifier: 'someone', password: 'short' });
    assert.equal(badPassword.status, 400);
  });
});
