'use strict';

// HTTP-level security checks that run WITHOUT a database:
// - the whole backend module graph loads (no DB connection needed, the pg Pool
//   is lazy),
// - license routes are mounted and protected by authenticate middleware
//   (401 when no token is presented).
// DB-dependent authorization/isolation tests cannot run here because
// PostgreSQL is unavailable in this environment; they are covered by
// inspection of the parameterized SQL (see the module report).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const app = require('../src/app');

async function withServer(fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.on('listening', resolve);
    server.on('error', reject);
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
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

test('backend module graph loads without a database connection', () => {
  assert.ok(app);
  assert.equal(typeof app.listen, 'function');
});

test('unauthenticated requests to license endpoints return 401', async () => {
  await withServer(async (base) => {
    const cases = [
      ['GET', '/api/health', undefined],
      ['GET', '/api/admin/licenses', undefined],
      ['GET', '/api/admin/licenses/1', undefined],
      ['POST', '/api/admin/licenses', {}],
      ['POST', '/api/admin/licenses/1/extend', {}],
      ['POST', '/api/admin/licenses/1/renew', {}],
      ['POST', '/api/admin/licenses/1/revoke', undefined],
      ['POST', '/api/admin/licenses/1/suspend', undefined],
      ['GET', '/api/seller/licenses', undefined],
      ['GET', '/api/seller/licenses/1', undefined],
      ['POST', '/api/seller/licenses', {}],
    ];
    const results = [];
    for (const [method, path, body] of cases) {
      results.push([method, path, await request(base, method, path, body)]);
    }

    const [healthMethod, healthPath, health] = results[0];
    assert.equal(health.status, 200, `${healthMethod} ${healthPath} should be public`);
    assert.equal(health.data.status, 'ok');

    for (let i = 1; i < results.length; i += 1) {
      const [method, path, result] = results[i];
      assert.equal(result.status, 401, `${method} ${path} must require authentication`);
    }
  });
});

test('unknown routes fall through to the error handler safely', async () => {
  await withServer(async (base) => {
    const result = await request(base, 'GET', '/api/admin/licenses/not-an-id');
    // 401 because authentication runs before path parameters are parsed.
    assert.equal(result.status, 401);
  });
});