// Unit tests for the pure algorithms the site relies on.
//
// The roster ordering, handle derivation and share-URL logic live inside the
// inline DC component in index.html, which cannot be imported without a DOM.
// These tests re-implement each algorithm exactly as it appears there and lock
// its behaviour down as a spec: if index.html's copy drifts, these encode what
// it is supposed to do. The validation regexes are copied verbatim from
// api/members.js and api.js.
import test from 'node:test';
import assert from 'node:assert/strict';

// --- validation regexes (verbatim from api/members.js) ---------------------

const EMAILISH = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test('EMAILISH accepts club-style usernames', () => {
  for (const ok of ['a@sddmc.club', 'mahiba.arshia@sddmc.club', 'x@y.z']) {
    assert.ok(EMAILISH.test(ok), ok);
  }
});
test('EMAILISH rejects non-emails', () => {
  for (const bad of ['', 'plain', 'no@domain', 'a b@x.y', 'two@@x.y']) {
    assert.ok(!EMAILISH.test(bad), bad);
  }
});
test('UUID accepts a canonical id and rejects injection strings', () => {
  assert.ok(UUID.test('9057c39e-185a-4f14-89d7-19e7b6056d8b'));
  for (const bad of ['0 or 1=1', '', 'abc', '9057c39e-185a-4f14-89d7-19e7b6056d8b OR 1=1']) {
    assert.ok(!UUID.test(bad), bad);
  }
});

// --- generated password shape (mirror of newPassword in api/members.js) ----

function newPassword() {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
test('newPassword is exactly 10 lowercase hex chars', () => {
  for (let i = 0; i < 200; i++) assert.match(newPassword(), /^[0-9a-f]{10}$/);
});
test('newPassword is not constant', () => {
  assert.notEqual(newPassword(), newPassword());
});

// --- roster ordering: only the four exec, in a fixed order -----------------
// (mirror of execRoster() in index.html)

function execRoster(roster) {
  const RANK = { president: 0, 'vice-president': 1, 'general-secretary': 2 };
  const key = (role) => String(role || '').toLowerCase().replace(/[\s_]+/g, '-');
  const BLURB = ['P', 'VP', 'GS1', 'GS2'];
  const ranked = roster
    .map((p, idx) => ({ p, idx }))
    .filter(({ p }) => key(p.role) in RANK)
    .sort((a, b) => {
      const r = RANK[key(a.p.role)] - RANK[key(b.p.role)];
      if (r) return r;
      return (a.p.sort_order - b.p.sort_order) || String(a.p.name).localeCompare(b.p.name);
    });
  let gs = 0;
  return ranked.map(({ p, idx }, pos) => {
    const k = key(p.role);
    const blurb = k === 'president' ? BLURB[0] : k === 'vice-president' ? BLURB[1] : (BLURB[2 + gs++] || BLURB[3]);
    return { name: p.name, role: p.role, blurb, no: String(pos + 1).padStart(2, '0'), rosterIndex: idx };
  });
}

const FOUR = [
  { id: 'd', name: 'Md Saahil Alam Talha', role: 'President', sort_order: 100 },
  { id: 'c', name: 'Mahiba Arshia', role: 'Vice-President', sort_order: 100 },
  { id: 'a', name: 'Abrar Ibn Awwal', role: 'General-Secretary', sort_order: 100 },
  { id: 'b', name: 'Ahnaf Tahmid Khondaker', role: 'General-Secretary', sort_order: 100 },
];

test('exec order is President, VP, then the two GS — regardless of sort_order', () => {
  const out = execRoster(FOUR);
  assert.deepEqual(out.map((x) => x.role),
    ['President', 'Vice-President', 'General-Secretary', 'General-Secretary']);
  assert.equal(out[0].blurb, 'P');
  assert.equal(out[1].blurb, 'VP');
  assert.deepEqual([out[2].blurb, out[3].blurb], ['GS1', 'GS2']);
});

test('regular members never appear in the exec grid', () => {
  const withMembers = [...FOUR,
    { id: 'z', name: 'New Member', role: 'Member', sort_order: 100 },
    { id: 'y', name: 'Artist Two', role: 'Digital artist', sort_order: 100 }];
  const out = execRoster(withMembers);
  assert.equal(out.length, 4);
  assert.ok(!out.some((x) => /Member|Artist/.test(x.name)));
});

test('exec grid tolerates role spacing/casing variants', () => {
  const variants = [
    { id: '1', name: 'P', role: 'president', sort_order: 1 },
    { id: '2', name: 'V', role: 'Vice President', sort_order: 1 },
    { id: '3', name: 'G', role: 'general_secretary', sort_order: 1 },
  ];
  assert.equal(execRoster(variants).length, 3);
});

test('rosterIndex points back to the row in the full roster', () => {
  const out = execRoster(FOUR);
  const pres = out.find((x) => x.role === 'President');
  assert.equal(FOUR[pres.rosterIndex].name, 'Md Saahil Alam Talha');
});

// --- handle + share URL (mirror of index.html) -----------------------------

const handleOf = (me) =>
  String((me && (me.email || me.name)) || '').split('@')[0].trim().toLowerCase().replace(/\s+/g, '');
const shareUrl = (origin, path, id) => origin + path + (id ? '#p=' + id : '');

test('handle is the email local part, lowercased and space-free', () => {
  assert.equal(handleOf({ email: 'Mahiba.Arshia@sddmc.club' }), 'mahiba.arshia');
  assert.equal(handleOf({ name: 'Md Saahil' }), 'mdsaahil');
  assert.equal(handleOf(null), '');
});

test('shareUrl builds a #p=<id> deep link on the current page', () => {
  assert.equal(
    shareUrl('https://sddmc.vercel.app', '/', '9057c39e-185a-4f14-89d7-19e7b6056d8b'),
    'https://sddmc.vercel.app/#p=9057c39e-185a-4f14-89d7-19e7b6056d8b');
  assert.equal(shareUrl('https://sddmc.vercel.app', '/', ''), 'https://sddmc.vercel.app/');
});

// mirror of closeProfile(): closing a profile drops the #p= fragment so the
// address bar goes back to the page you were on, and nothing reopens the modal
const urlAfterClose = (path, search, hash) =>
  (/^#p=/.test(hash || '') ? path + search : path + search + (hash || ''));

test('closing a profile restores the pre-profile URL', () => {
  assert.equal(urlAfterClose('/', '', '#p=9057c39e-185a-4f14-89d7-19e7b6056d8b'), '/');
  assert.equal(urlAfterClose('/', '?ref=ig', '#p=9057c39e-185a-4f14-89d7-19e7b6056d8b'), '/?ref=ig');
});

test('closing a profile leaves any other fragment alone', () => {
  assert.equal(urlAfterClose('/', '', '#admin'), '/#admin');
  assert.equal(urlAfterClose('/', '', ''), '/');
});

test('a cleared hash no longer matches the route regex, so nothing reopens', () => {
  const re = /^#p=([0-9a-fA-F-]{6,})/;
  assert.equal(re.exec(urlAfterClose('/', '', '#p=9057c39e-185a-4f14-89d7-19e7b6056d8b').slice(1)), null);
});

test('the #p= route regex extracts a UUID and ignores junk', () => {
  const re = /^#p=([0-9a-fA-F-]{6,})/;
  assert.equal(re.exec('#p=9057c39e-185a-4f14-89d7-19e7b6056d8b')[1], '9057c39e-185a-4f14-89d7-19e7b6056d8b');
  assert.equal(re.exec('#admin'), null);
  assert.equal(re.exec(''), null);
});

// --- works reshape (mirror of toCard in api.js) ----------------------------

function toCard(work) {
  const show = work.destination === 'exhibition';
  return {
    id: work.id,
    t: work.title,
    y: String(work.made_on || '').slice(0, 4),
    show,
    kindLabel: work.kind === 'art' ? 'Digital art' : 'Graphic design',
    tag: work.kind === 'art' ? (show ? 'Fall Season entry' : 'Digital art') : work.event,
    owner: work.owner?.name || 'Member',
  };
}

test('toCard derives year from made_on without timezone drift', () => {
  const c = toCard({ id: '1', title: 'X', made_on: '2026-01-01', kind: 'art', destination: 'exhibition', owner: { name: 'A' } });
  assert.equal(c.y, '2026'); // slice, not new Date() — no year-rollback west of GMT
  assert.equal(c.tag, 'Fall Season entry');
  assert.equal(c.kindLabel, 'Digital art');
});
test('toCard falls back to "Member" when owner is missing', () => {
  assert.equal(toCard({ id: '1', title: 'X', made_on: '2026', kind: 'design', event: 'E' }).owner, 'Member');
});

// --- privacy allow-list (mirror of updateMyProfile in api.js) --------------

test('a member may only change their own privacy/display fields', () => {
  const allowed = ['is_public', 'show_grade', 'show_badges', 'grade', 'avatar_path'];
  const patch = { is_public: false, is_admin: true, role: 'President', grade: 'A' };
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  assert.deepEqual(clean, { is_public: false, grade: 'A' });
  assert.ok(!('is_admin' in clean) && !('role' in clean));
});
