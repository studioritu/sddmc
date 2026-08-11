// Integration tests for the admin-gated serverless function api/members.js.
// The real handler is imported and exercised end to end; only the network
// (fetch to Supabase) is mocked, so requireAdmin, the input validation, the
// UUID injection guard and the create/update/delete flows all run for real.
//
// Env must be set before importing the module, because api/members.js reads
// SUPABASE_* into module-level constants at load time.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';

const { default: handler } = await import('../api/members.js');

// --- test doubles ----------------------------------------------------------

let scenario;
function resp(ok, body, status) {
  return {
    ok,
    status: status ?? (ok ? 200 : 401),
    text: async () => (body == null ? '' : JSON.stringify(body)),
    json: async () => body,
  };
}

// Route each Supabase call the handler makes to a scenario-controlled answer.
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = init.method || 'GET';

  if (u.endsWith('/auth/v1/user')) {
    return scenario.userOk ? resp(true, scenario.user) : resp(false, { msg: 'bad jwt' }, 401);
  }
  if (u.includes('/rest/v1/profiles') && method === 'GET') {
    if (u.includes('user_id=eq.')) return resp(true, scenario.adminRows ?? []); // requireAdmin
    if (u.includes('email=eq.')) return resp(true, scenario.clashRows ?? []);   // createMember dup check
    if (u.includes('id=eq.')) return resp(true, scenario.targetRows ?? []);     // targetProfile
    return resp(true, []);
  }
  if (u.endsWith('/auth/v1/admin/users') && method === 'POST') {
    return resp(true, { id: 'new-auth-id' });
  }
  if (u.includes('/rest/v1/profiles') && method === 'PATCH') {
    return resp(true, [{ id: 'p-new', name: 'Someone' }]);
  }
  if (u.includes('/auth/v1/admin/users/') && (method === 'PUT' || method === 'DELETE')) {
    return resp(true, {});
  }
  if (u.includes('/rest/v1/profiles') && method === 'DELETE') {
    return resp(true, [{ id: 'p-del' }]);
  }
  return resp(true, {});
};

function mockReq({ method = 'POST', auth, body = {} } = {}) {
  return { method, headers: auth ? { authorization: 'Bearer ' + auth } : {}, body };
}
function mockRes() {
  const r = { statusCode: 0, body: null, headers: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}
const ADMIN = { userOk: true, user: { id: 'admin-uid' }, adminRows: [{ id: 'a', name: 'Admin', is_admin: true }] };

// --- auth gate -------------------------------------------------------------

test('no token → 401 Not signed in', async () => {
  scenario = {};
  const res = mockRes();
  await handler(mockReq({ auth: undefined }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /signed in/i);
});

test('forged/expired token → 401', async () => {
  scenario = { userOk: false };
  const res = mockRes();
  await handler(mockReq({ auth: 'forged' }), res);
  assert.equal(res.statusCode, 401);
});

test('valid token but not admin → 403', async () => {
  scenario = { userOk: true, user: { id: 'u1' }, adminRows: [{ id: 'p1', is_admin: false }] };
  const res = mockRes();
  await handler(mockReq({ auth: 'good' }), res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /admin/i);
});

test('valid token, no profile row → 403', async () => {
  scenario = { userOk: true, user: { id: 'u1' }, adminRows: [] };
  const res = mockRes();
  await handler(mockReq({ auth: 'good' }), res);
  assert.equal(res.statusCode, 403);
});

// --- input validation (admin authenticated) --------------------------------

test('createMember rejects a non-email username → 400', async () => {
  scenario = { ...ADMIN };
  const res = mockRes();
  await handler(mockReq({ method: 'POST', auth: 'ok', body: { name: 'X', email: 'not-an-email' } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /email/i);
});

test('createMember rejects an empty name → 400', async () => {
  scenario = { ...ADMIN };
  const res = mockRes();
  await handler(mockReq({ method: 'POST', auth: 'ok', body: { name: '  ', email: 'x@sddmc.club' } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /name/i);
});

test('createMember rejects a duplicate username → 409', async () => {
  scenario = { ...ADMIN, clashRows: [{ id: 'exists' }] };
  const res = mockRes();
  await handler(mockReq({ method: 'POST', auth: 'ok', body: { name: 'X', email: 'x@sddmc.club' } }), res);
  assert.equal(res.statusCode, 409);
});

test('DELETE with a non-UUID profileId → 400 (injection guard)', async () => {
  scenario = { ...ADMIN };
  const res = mockRes();
  await handler(mockReq({ method: 'DELETE', auth: 'ok', body: { profileId: '0 or 1=1' } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /invalid member id/i);
});

test('DELETE refuses to touch an admin profile → 400', async () => {
  scenario = { ...ADMIN, targetRows: [{ id: '11111111-1111-1111-1111-111111111111', is_admin: true }] };
  const res = mockRes();
  await handler(mockReq({ method: 'DELETE', auth: 'ok', body: { profileId: '11111111-1111-1111-1111-111111111111' } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /admin accounts/i);
});

// --- happy path ------------------------------------------------------------

test('createMember succeeds → 200 with a 10-hex password and display_name set', async () => {
  scenario = { ...ADMIN, clashRows: [] };
  let createBody = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/auth/v1/admin/users') && (init.method === 'POST')) {
      createBody = JSON.parse(init.body);
    }
    return realFetch(url, init);
  };
  const res = mockRes();
  await handler(mockReq({ method: 'POST', auth: 'ok', body: { name: 'Jane Doe', role: 'Member', email: 'jane@sddmc.club' } }), res);
  globalThis.fetch = realFetch;
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.password, /^[0-9a-f]{10}$/);
  assert.equal(createBody.email, 'jane@sddmc.club');
  assert.equal(createBody.email_confirm, true);
  assert.equal(createBody.user_metadata.display_name, 'Jane Doe');
});

test('unsupported method (GET) with admin → 405', async () => {
  scenario = { ...ADMIN };
  const res = mockRes();
  await handler(mockReq({ method: 'GET', auth: 'ok', body: {} }), res);
  assert.equal(res.statusCode, 405);
});
