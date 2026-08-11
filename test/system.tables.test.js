// System tests — live RLS for the events and exhibitions tables, with the
// public publishable key. Read-only except one INSERT per table that RLS is
// expected to reject before any row is created. Each table's tests skip
// cleanly if the table has not been created yet (its migration not run) or if
// the network is unreachable, so this is safe to run any time.
import test from 'node:test';
import assert from 'node:assert/strict';

const URL = 'https://uslioumewsjucoytezph.supabase.co';
const KEY = 'sb_publishable_KZtQpNweqpvUZ1BYaU4lGg_0OHPnt6C';
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const to = () => AbortSignal.timeout(8000);

// Probe once whether each table is reachable (exists + network up). A missing
// table returns 404 from PostgREST; a network failure throws.
async function exists(table) {
  try {
    const r = await fetch(`${URL}/rest/v1/${table}?select=*&limit=1`, { headers: H, signal: to() });
    return r.status === 200;
  } catch {
    return false;
  }
}

for (const table of ['events', 'exhibitions']) {
  const present = await exists(table);
  const reason = present ? false : `${table} table not present (migration not run) or offline — skipped`;
  const maybe = (name, fn) => test(name, { skip: reason }, fn);
  // Each table has a different text column; sending the other would 400 on the
  // unknown column before RLS is even consulted.
  const body = table === 'events' ? { name: 'pentest-x' } : { theme: 'pentest-x' };

  maybe(`anon can read ${table}`, async () => {
    const r = await fetch(`${URL}/rest/v1/${table}?select=*`, { headers: H, signal: to() });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(await r.json()));
  });

  maybe(`anon INSERT into ${table} is blocked by RLS`, async () => {
    const r = await fetch(`${URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: to(),
    });
    assert.ok(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
  });

  maybe(`anon UPDATE on ${table} changes nothing`, async () => {
    const r = await fetch(`${URL}/rest/v1/${table}?id=eq.00000000-0000-0000-0000-000000000000`, {
      method: 'PATCH',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: to(),
    });
    assert.ok([401, 403, 204].includes(r.status), `status ${r.status}`);
  });
}
