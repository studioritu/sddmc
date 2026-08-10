// SDDMC — data layer.
//
// The browser talks to Postgres directly; the rules live in db/schema.sql as
// Row Level Security policies, not in this file. Nothing here is a security
// boundary — a member can edit this file in devtools and the database will
// still refuse to approve their own work. Treat every check below as a
// convenience for the interface, never as enforcement.
//
// Consumed from the <script type="text/x-dc"> blocks via window.SDDMC. Those
// blocks are evaluated through new Function() by support.js:842, so `import`
// does not work inside them — hence the global.

import { SUPABASE_URL, SUPABASE_ANON_KEY, ADMIN_EMAIL } from './config.js';

// The Supabase client is vendored at vendor/supabase.js and loaded by a plain
// <script> tag in the page head, which puts it on window.supabase.
//
// It used to be imported from a CDN. That meant six network round-trips to a
// third party before the site could do anything, and on a connection that
// intermittently loses whole hosts, any one of them failing left the page dead
// with "api.js did not load". The vendored file is one request to your own
// origin: it either arrives with the page, or nothing does.
//
// To update it, re-download dist/umd/supabase.js for the version you want and
// replace vendor/supabase.js. Use the UMD build — the ESM ones pull in further
// chunks at runtime, which is the problem being avoided.
const createClient = (...args) => {
  if (!window.supabase || !window.supabase.createClient) {
    throw new Error('vendor/supabase.js did not load — check the <script> tag in the page head.');
  }
  return window.supabase.createClient(...args);
};
import { prepareImage, ImageError } from './img.js';

const BUCKET = 'work';
const WORK_FIELDS = '*, owner:profiles(id,name,role)';

export class ApiError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ApiError';
    this.cause = cause;
  }
}

const configured =
  !SUPABASE_URL.includes('YOUR-PROJECT-REF') && !SUPABASE_ANON_KEY.startsWith('YOUR-');

// admin.html and index.html are the same origin loading this same module, so
// supabase-js kept ONE session for both under its default storage key. Entering
// the club code in the panel silently replaced whoever was signed in on the
// site, and signing in on the site logged the panel back out — one identity
// being swapped back and forth, never two at once.
//
// A storage key per page gives them separate buckets, so an admin can stay
// signed in to the panel and to their own member account at the same time.
// vercel.json sets cleanUrls, so the panel answers on /admin as well as
// /admin.html; both spellings have to match here or the panel silently falls
// back to the member bucket and the clash returns.
const ON_ADMIN_PAGE = /\/admin(\.html)?\/?$/.test(location.pathname);
const STORAGE_KEY = ON_ADMIN_PAGE ? 'sddmc-admin-auth' : 'sddmc-member-auth';

const sb = configured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: STORAGE_KEY },
    })
  : null;

function client() {
  if (!sb) throw new ApiError('Supabase is not set up yet. Fill in config.js.');
  return sb;
}

/** Unwrap a PostgREST result, turning its error into something throwable. */
function unwrap({ data, error }, what) {
  if (error) throw new ApiError(`Could not ${what}: ${error.message}`, error);
  return data;
}

// --- session ---------------------------------------------------------------

let profile = null;
const listeners = new Set();

async function refreshProfile() {
  const { data } = await client().auth.getUser();
  if (!data?.user) {
    profile = null;
    return null;
  }
  profile = unwrap(
    await client().from('profiles').select('*').eq('user_id', data.user.id).maybeSingle(),
    'load your profile'
  );
  return profile;
}

/** The signed-in member's profile row, or null. Cached; never throws. */
export function me() {
  return profile;
}

export function isAdmin() {
  return !!profile?.is_admin;
}

/** @param {(p: object|null) => void} fn @returns {() => void} unsubscribe */
export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce() {
  listeners.forEach((fn) => fn(profile));
}

export async function signIn(email, password) {
  const trimmed = (email || '').trim();
  if (!trimmed || !password) throw new ApiError('Enter your email and password.');

  const { error } = await client().auth.signInWithPassword({ email: trimmed, password });
  // Supabase deliberately returns one generic message for wrong-email and
  // wrong-password. Keep it that way — distinguishing them tells an attacker
  // which club emails are real.
  if (error) throw new ApiError('That email and password did not match.', error);

  const p = await refreshProfile();
  if (!p) throw new ApiError('Signed in, but no roster entry is linked to that email.');
  announce();
  return p;
}

/**
 * The admin dashboard's single-field gate. The club code is the shared admin
 * account's actual password, so this is a real sign-in — the panel that opens
 * afterwards can genuinely write, because Postgres has accepted the session.
 * @param {string} code
 */
export async function signInAsAdmin(code) {
  if (!code) throw new ApiError('Enter the club code.');
  const { error } = await client().auth.signInWithPassword({
    email: ADMIN_EMAIL,
    password: code,
  });
  // Only a genuine credential mismatch is "Wrong code". Anything else — rate
  // limiting, an unconfirmed account, a bad key, no network — gets reported as
  // itself. Collapsing them all into "Wrong code" sent us hunting a password
  // that was never actually wrong.
  if (error) {
    const msg = error.message || 'Sign-in failed';
    if (/invalid login credentials/i.test(msg)) throw new ApiError('Wrong code', error);
    throw new ApiError(msg, error);
  }

  const p = await refreshProfile();
  if (!p) throw new ApiError('That account has no profile row.');
  if (!p.is_admin) throw new ApiError('That account is not an admin.');
  announce();
  return p;
}

export async function signOut() {
  const { error } = await client().auth.signOut();
  if (error) throw new ApiError(`Could not sign out: ${error.message}`, error);
  profile = null;
  announce();
}

// --- reads -----------------------------------------------------------------

export function publicUrl(path) {
  if (!path) return '';
  return client().storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

/**
 * Club members only. The shared admin account has a profile row too — it has
 * to, since is_admin lives there — but it is not a person, so is_roster keeps
 * it out of every list on the site.
 */
// Every column except email. The anon role has had SELECT on email revoked
// (db/schema.sql), and Postgres rejects the entire statement — not just that
// column — if a barred one is requested, so `select('*')` fails when signed
// out. Add any new column here too, or it will be missing for visitors.
const ROSTER_PUBLIC_COLUMNS =
  'id,name,role,grade,avatar_path,is_admin,is_public,show_grade,show_badges,sort_order,is_roster,created_at';

export async function listRoster() {
  return unwrap(
    await client().from('profiles')
      .select(profile ? '*' : ROSTER_PUBLIC_COLUMNS)
      .eq('is_roster', true)
      .order('sort_order').order('name'),
    'load the roster'
  );
}

/** @param {{ownerId?: string, status?: string, destination?: string}} [filter] */
export async function listWorks(filter = {}) {
  let q = client().from('works').select(WORK_FIELDS).order('created_at', { ascending: false });
  if (filter.ownerId) q = q.eq('owner_id', filter.ownerId);
  if (filter.status) q = q.eq('status', filter.status);
  if (filter.destination) q = q.eq('destination', filter.destination);
  return unwrap(await q, 'load work');
}

/** The admin review queue. Returns [] for non-admins because RLS hides them. */
export async function listPending() {
  return listWorks({ status: 'pending' });
}

/**
 * Reshape a row into the field names the existing templates already use, so
 * the markup in index.html / admin.html needs as little rewriting as possible.
 */
export function toCard(work) {
  const show = work.destination === 'exhibition';
  return {
    id: work.id,
    img: publicUrl(work.image_path),
    thumb: publicUrl(work.thumb_path),
    t: work.title,
    // made_on is 'YYYY-MM-DD'. Slicing beats new Date(): parsing that string
    // gives UTC midnight, which is the previous year west of Greenwich.
    y: String(work.made_on || '').slice(0, 4),
    kind: work.kind,
    event: work.event,
    show,
    status: work.status,
    note: work.note,
    winner: work.is_winner,
    pub: work.is_public,
    ownerId: work.owner_id,
    owner: work.owner?.name || 'Member',
    kindLabel: work.kind === 'art' ? 'Digital art' : 'Graphic design',
    tag: work.kind === 'art' ? (show ? 'Fall Season entry' : 'Digital art') : work.event,
  };
}

// --- writes ----------------------------------------------------------------

/**
 * Compress and store both sizes under the owner's folder.
 * @returns {Promise<{image_path: string, thumb_path: string}>}
 */
export async function uploadImage(ownerId, file) {
  const { display, thumb, ext } = await prepareImage(file);
  const base = `${ownerId}/${crypto.randomUUID()}`;
  const image_path = `${base}.${ext}`;
  const thumb_path = `${base}-t.${ext}`;
  const store = client().storage.from(BUCKET);

  const [a, b] = await Promise.all([
    store.upload(image_path, display, { contentType: display.type }),
    store.upload(thumb_path, thumb, { contentType: thumb.type }),
  ]);
  const failed = a.error || b.error;
  if (failed) {
    // One half may have landed. Drop both so a retry does not leave orphans
    // quietly consuming the 1 GB allowance.
    await store.remove([image_path, thumb_path]);
    throw new ApiError(`Could not upload the image: ${failed.message}`, failed);
  }
  return { image_path, thumb_path };
}

async function insertWork(ownerId, fields, file) {
  const paths = await uploadImage(ownerId, file);
  const { data, error } = await client()
    .from('works')
    .insert({ owner_id: ownerId, ...fields, ...paths })
    .select(WORK_FIELDS)
    .single();

  if (error) {
    await client().storage.from(BUCKET).remove([paths.image_path, paths.thumb_path]);
    throw new ApiError(`Could not save the piece: ${error.message}`, error);
  }
  return data;
}

/**
 * A member submitting their own work. The status sent here is ignored — the
 * guard_work_flags trigger pins it to 'pending' for anyone who is not admin.
 * @param {{file: File, title?: string, kind?: string, event?: string,
 *          destination?: string, madeOn?: string, note?: string}} input
 */
export async function submitWork(input) {
  if (!profile) throw new ApiError('Sign in first.');
  return insertWork(profile.id, {
    title: (input.title || '').trim() || 'Untitled',
    kind: input.kind || 'art',
    event: input.event || null,
    destination: input.destination || 'exhibition',
    made_on: input.madeOn || new Date().toISOString().slice(0, 10),
    note: (input.note || '').trim() || null,
    is_public: input.isPublic !== false,
  }, input.file);
}

/** Admin posting on a member's behalf. Approved on arrival — no self-review. */
export async function addWorkFor(ownerId, input) {
  if (!isAdmin()) throw new ApiError('Only an admin can add work for someone else.');
  return insertWork(ownerId, {
    title: (input.title || '').trim() || 'Untitled',
    kind: input.kind || 'design',
    event: input.event || null,
    destination: input.destination || 'profile',
    made_on: input.madeOn || new Date().toISOString().slice(0, 10),
    status: 'approved',
    is_public: input.isPublic !== false,
  }, input.file);
}

/**
 * Edit a piece the caller owns. The allow-list is an interface convenience,
 * not a control: status, is_winner and owner_id are pinned server-side by the
 * guard_work_flags trigger for anyone who is not an admin.
 */
export async function updateWork(workId, patch) {
  const allowed = ['title', 'event', 'destination', 'made_on', 'note', 'is_public'];
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  if (!Object.keys(clean).length) throw new ApiError('Nothing to change.');
  return unwrap(
    await client().from('works').update(clean).eq('id', workId).select(WORK_FIELDS).single(),
    'save that change'
  );
}

export async function setWorkStatus(workId, status) {
  return unwrap(
    await client().from('works').update({ status }).eq('id', workId).select(WORK_FIELDS).single(),
    `mark that piece ${status}`
  );
}

export async function deleteWork(workId) {
  const work = unwrap(
    await client().from('works').select('image_path,thumb_path').eq('id', workId).single(),
    'find that piece'
  );
  // Files first: a deleted row with surviving files is invisible and
  // unreclaimable, whereas a surviving row with missing files is obvious.
  const { error } = await client().storage.from(BUCKET).remove([work.image_path, work.thumb_path]);
  if (error) throw new ApiError(`Could not remove the image: ${error.message}`, error);
  unwrap(await client().from('works').delete().eq('id', workId).select('id'), 'remove that piece');
}

export async function addMember({ name, role, email }) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new ApiError('Name required.');
  return unwrap(
    await client()
      .from('profiles')
      .insert({ name: trimmed, role: (role || '').trim() || 'Member', email: email || null })
      .select()
      .single(),
    'add that member'
  );
}

// --- logins (via the admin-gated serverless endpoint) ----------------------
//
// Creating logins and setting passwords needs the service_role key, which
// cannot be in the browser. These call /api/members, which re-checks that the
// caller is an admin server-side before touching anything.
//
// None of this works against a plain static file server — the function does
// not exist there. Use `vercel dev`, or the deployed site.

async function callMembers(method, payload) {
  const { data } = await client().auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new ApiError('Sign in again.');

  const r = await fetch('./api/members', {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload || {}),
  });

  let body = null;
  try {
    body = await r.json();
  } catch {
    // A static host answers /api/members with the 404 HTML page, not JSON.
    throw new ApiError('Member management is not available on this host — use db/make-logins.sql instead.');
  }
  if (!r.ok || !body.ok) throw new ApiError(body?.error || `Request failed (${r.status}).`);
  return body;
}

/** @returns {Promise<{password: string, member: object}>} shown once, then gone. */
export async function createMember({ name, role, email }) {
  return callMembers('POST', { name, role, email });
}

export async function setMemberLogin(profileId, email) {
  return callMembers('PATCH', { profileId, email });
}

/** @returns {Promise<{password: string}>} the new password, shown once. */
export async function resetMemberPassword(profileId) {
  return callMembers('PATCH', { profileId, resetPassword: true });
}

/** Removes the login, the roster row, and every piece they uploaded. */
export async function deleteMember(profileId) {
  return callMembers('DELETE', { profileId });
}

export async function removeMember(profileId) {
  unwrap(
    await client().from('profiles').delete().eq('id', profileId).select('id'),
    'remove that member'
  );
}

/** Settings a member may change about themselves (the privacy toggles). */
export async function updateMyProfile(patch) {
  if (!profile) throw new ApiError('Sign in first.');
  const allowed = ['is_public', 'show_grade', 'show_badges', 'grade', 'avatar_path'];
  const clean = Object.fromEntries(
    Object.entries(patch).filter(([k]) => allowed.includes(k))
  );
  profile = unwrap(
    await client().from('profiles').update(clean).eq('id', profile.id).select().single(),
    'save your settings'
  );
  announce();
  return profile;
}

// --- boot ------------------------------------------------------------------

const ready = (async () => {
  if (!configured) return null;

  // Subscribed before the first read, not after it. supabase-js restores the
  // persisted session asynchronously and emits INITIAL_SESSION the moment it
  // lands. Registering this listener after the awaited refreshProfile() below
  // left a window — one network round-trip wide — in which that event fired
  // with nobody listening. When it was missed, getUser() had already answered
  // "no session" and nothing ever announced the correction, so the page went
  // on rendering a signed-out nav while the session was in fact live.
  client().auth.onAuthStateChange(async (event) => {
    if (event === 'SIGNED_OUT') profile = null;
    else await refreshProfile();
    announce();
  });

  await refreshProfile();
  return profile;
})();

export { ready, configured, sb, ImageError };

// Bridge for the DC script blocks, which cannot use import.
window.SDDMC = {
  ready, configured, sb, ApiError, ImageError,
  signIn, signInAsAdmin, signOut, me, isAdmin, onAuthChange,
  listRoster, listWorks, listPending, toCard, publicUrl,
  submitWork, addWorkFor, setWorkStatus, updateWork, deleteWork,
  addMember, removeMember, updateMyProfile, uploadImage,
  createMember, setMemberLogin, resetMemberPassword, deleteMember,
};
