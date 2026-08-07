// SDDMC — member and login management.
//
// Creating logins and changing passwords needs Supabase's service_role key,
// which ignores every Row Level Security policy in db/schema.sql. That key must
// never reach a browser, so it lives here, in a Vercel environment variable,
// and the dashboard calls this endpoint instead of calling Supabase directly.
//
// Because service_role bypasses RLS, THIS FILE IS THE ONLY THING STANDING
// BETWEEN A STRANGER AND YOUR DATABASE. Every request is checked twice before
// anything happens: the caller must present a valid session token, and the
// profile behind that token must have is_admin set. Never add a code path that
// skips requireAdmin().
//
// Set in Vercel -> Project Settings -> Environment Variables:
//   SUPABASE_URL
//   SUPABASE_ANON_KEY
//   SUPABASE_SERVICE_ROLE_KEY     <- secret. Not in config.js, not in git.
//
// Note this cannot run on a plain static server (python -m http.server). Use
// `vercel dev` locally, or test it on the deployed site.

const URL_BASE = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PASSWORD_BYTES = 5; // 10 hex characters
const DEFAULT_ROLE = 'Member';
const EMAILISH = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** service_role request. Anything using this has already passed requireAdmin. */
async function admin(path, init = {}) {
  const r = await fetch(`${URL_BASE}${path}`, {
    ...init,
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  const body = text ? JSON.parse(text) : null;
  if (!r.ok) {
    throw new HttpError(r.status, body?.msg || body?.message || body?.error_description || text);
  }
  return body;
}

/**
 * Resolve the caller's session token to an admin profile, or throw.
 * @returns {Promise<{id: string, name: string}>} the caller's profile
 */
async function requireAdmin(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw new HttpError(401, 'Not signed in.');

  // Validated by Supabase, not by us — a forged token fails here.
  const who = await fetch(`${URL_BASE}/auth/v1/user`, {
    headers: { apikey: ANON, Authorization: `Bearer ${token}` },
  });
  if (!who.ok) throw new HttpError(401, 'Session expired. Sign in again.');
  const user = await who.json();

  const rows = await admin(`/rest/v1/profiles?select=id,name,is_admin&user_id=eq.${user.id}`);
  if (!rows?.length || !rows[0].is_admin) throw new HttpError(403, 'Admins only.');
  return rows[0];
}

function newPassword() {
  const bytes = new Uint8Array(PASSWORD_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Look up one profile, and refuse to touch an admin account. */
async function targetProfile(profileId) {
  const rows = await admin(
    `/rest/v1/profiles?select=id,name,email,user_id,is_admin&id=eq.${profileId}`
  );
  if (!rows?.length) throw new HttpError(404, 'No such member.');
  // Without this, one wrong click on the shared admin row locks everybody out
  // of the dashboard with no way back except the Supabase console.
  if (rows[0].is_admin) {
    throw new HttpError(400, 'Admin accounts are managed in Supabase, not here.');
  }
  return rows[0];
}

async function createMember({ name, role, email }) {
  const cleanName = (name || '').trim();
  const cleanEmail = (email || '').trim().toLowerCase();
  if (!cleanName) throw new HttpError(400, 'Name required.');
  if (!EMAILISH.test(cleanEmail)) {
    throw new HttpError(400, 'Username must look like an email, e.g. mahiba@sddmc.club');
  }

  const clash = await admin(
    `/rest/v1/profiles?select=id&email=eq.${encodeURIComponent(cleanEmail)}`
  );
  if (clash?.length) throw new HttpError(409, 'That username is already taken.');

  const password = newPassword();
  // email_confirm skips the confirmation mail, which matters because these
  // addresses are login names with no mailbox behind them.
  const user = await admin('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email: cleanEmail, password, email_confirm: true }),
  });

  // The link_profile trigger already made a profile row for this account;
  // give it the real name and role rather than the email prefix.
  const saved = await admin(`/rest/v1/profiles?user_id=eq.${user.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ name: cleanName, role: (role || '').trim() || DEFAULT_ROLE }),
  });

  return { member: saved?.[0] || null, password };
}

async function updateMember({ profileId, email, resetPassword }) {
  const profile = await targetProfile(profileId);
  if (!profile.user_id) throw new HttpError(400, 'That member has no login yet.');

  const patch = {};
  let password = null;

  if (email) {
    const cleanEmail = email.trim().toLowerCase();
    if (!EMAILISH.test(cleanEmail)) throw new HttpError(400, 'Username must look like an email.');
    patch.email = cleanEmail;
    patch.email_confirm = true;
  }
  if (resetPassword) {
    password = newPassword();
    patch.password = password;
  }
  if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to change.');

  await admin(`/auth/v1/admin/users/${profile.user_id}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });

  // profiles.email is what link_profile matches on, so it has to stay in step
  // with the auth record or a future re-link would attach to the wrong row.
  if (patch.email) {
    await admin(`/rest/v1/profiles?id=eq.${profile.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ email: patch.email }),
    });
  }

  return { password };
}

async function deleteMember({ profileId }) {
  const profile = await targetProfile(profileId);
  // profiles.user_id is ON DELETE SET NULL, so removing the auth user leaves
  // the roster row behind; it is deleted explicitly. Their works rows follow
  // via the owner_id cascade.
  if (profile.user_id) {
    await admin(`/auth/v1/admin/users/${profile.user_id}`, { method: 'DELETE' });
  }
  await admin(`/rest/v1/profiles?id=eq.${profile.id}`, { method: 'DELETE' });
  return { removed: profile.name };
}

export default async function handler(req, res) {
  if (!URL_BASE || !ANON || !SERVICE) {
    return res.status(500).json({
      ok: false,
      error: 'Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY in Vercel.',
    });
  }

  try {
    await requireAdmin(req);
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};

    if (req.method === 'POST') {
      return res.status(200).json({ ok: true, ...(await createMember(body)) });
    }
    if (req.method === 'PATCH') {
      return res.status(200).json({ ok: true, ...(await updateMember(body)) });
    }
    if (req.method === 'DELETE') {
      return res.status(200).json({ ok: true, ...(await deleteMember(body)) });
    }

    res.setHeader('Allow', 'POST, PATCH, DELETE');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    return res.status(status).json({ ok: false, error: error.message });
  }
}
