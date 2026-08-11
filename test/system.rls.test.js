// System tests — real Row Level Security behaviour against the live Supabase
// project, using the public publishable key (the same one shipped in
// config.js). These are READ-ONLY: every assertion is a GET, except one INSERT
// that RLS is expected to reject with 401 *before* any row is created, so the
// database is never mutated.
//
// If the network is unreachable the whole suite skips rather than failing, so
// it is safe to run offline.
import test from 'node:test';
import assert from 'node:assert/strict';

const URL = 'https://uslioumewsjucoytezph.supabase.co';
const KEY = 'sb_publishable_KZtQpNweqpvUZ1BYaU4lGg_0OHPnt6C';
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };

async function reachable() {
  try {
    const r = await fetch(`${URL}/rest/v1/`, { headers: H, signal: AbortSignal.timeout(8000) });
    return r.status < 500;
  } catch {
    return false;
  }
}
const online = await reachable();
const maybe = (name, fn) => test(name, { skip: online ? false : 'Supabase unreachable — skipped' }, fn);

maybe('anon can read the public roster', async () => {
  const r = await fetch(
    `${URL}/rest/v1/profiles?select=id,name,role&is_roster=eq.true`,
    { headers: H, signal: AbortSignal.timeout(8000) });
  assert.equal(r.status, 200);
  const rows = await r.json();
  assert.ok(Array.isArray(rows));
});

maybe('anon INSERT into profiles is blocked by RLS (no row created)', async () => {
  // Deliberately incomplete row: even if RLS somehow allowed it, the missing
  // NOT NULL name would fail — but RLS rejects it first with 401/403.
  const r = await fetch(`${URL}/rest/v1/profiles`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'pentest-should-never-persist' }),
    signal: AbortSignal.timeout(8000),
  });
  assert.ok(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
});

maybe('anon UPDATE cannot promote anyone to admin', async () => {
  const r = await fetch(
    `${URL}/rest/v1/profiles?id=eq.00000000-0000-0000-0000-000000000000`, {
      method: 'PATCH',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_admin: true }),
      signal: AbortSignal.timeout(8000),
    });
  // 401/403 (blocked) or 204 (allowed by grammar but the RLS filter matches no
  // rows, so nothing is changed) — never a 200 with a mutated row.
  assert.ok([401, 403, 204].includes(r.status), `status ${r.status}`);
});

maybe('anon cannot see pending works', async () => {
  const r = await fetch(
    `${URL}/rest/v1/works?select=id&status=eq.pending`, { headers: H, signal: AbortSignal.timeout(8000) });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), []);
});

maybe('anon cannot see non-public works', async () => {
  const r = await fetch(
    `${URL}/rest/v1/works?select=id&is_public=eq.false`, { headers: H, signal: AbortSignal.timeout(8000) });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), []);
});

maybe('the auth users table is not exposed anonymously', async () => {
  const r = await fetch(`${URL}/rest/v1/users?select=*`, { headers: H, signal: AbortSignal.timeout(8000) });
  assert.ok(r.status === 404 || r.status === 401, `status ${r.status}`);
});
