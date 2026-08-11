// Unit tests for the events + exhibitions logic added since the last suite.
//
// The scheduling, current-exhibition and submission-filter logic lives in the
// inline admin component (no DOM to import) and in api.js (which pulls in
// browser globals). As with the other unit tests, these re-implement each
// algorithm exactly as it appears there and lock the behaviour down as a spec.
import test from 'node:test';
import assert from 'node:assert/strict';

// --- events dropdown derivation (mirror of index.html/admin.html) ----------

const eventOptions = (events) => [...(events || []).map((e) => e.name), 'Personal / off-theme'];

test('event dropdown lists the table names plus the fixed Personal choice', () => {
  const opts = eventOptions([{ name: 'STEMCON 2025' }, { name: 'Sunnydale Games' }]);
  assert.deepEqual(opts, ['STEMCON 2025', 'Sunnydale Games', 'Personal / off-theme']);
});
test('event dropdown falls back to just Personal when the table is empty', () => {
  assert.deepEqual(eventOptions([]), ['Personal / off-theme']);
  assert.deepEqual(eventOptions(null), ['Personal / off-theme']);
});

// --- current / for-date exhibition (mirror of api.js exhibitionForDate) -----

const exhibitionForDate = (list, day) =>
  (list || []).find((e) => e.starts_on <= day && day <= e.ends_on) || null;

const AUG = { id: 'a', theme: 'Fall Season', starts_on: '2026-08-01', ends_on: '2026-08-31' };
const SEP = { id: 'b', theme: 'Cold Open', starts_on: '2026-09-01', ends_on: '2026-09-30' };
const LIST = [SEP, AUG];

test('exhibitionForDate picks the range that contains the day', () => {
  assert.equal(exhibitionForDate(LIST, '2026-08-15').id, 'a');
  assert.equal(exhibitionForDate(LIST, '2026-08-31').id, 'a'); // inclusive end
  assert.equal(exhibitionForDate(LIST, '2026-09-01').id, 'b'); // inclusive start
  assert.equal(exhibitionForDate(LIST, '2026-09-30').id, 'b');
});
test('exhibitionForDate returns null in a gap with no exhibition', () => {
  assert.equal(exhibitionForDate(LIST, '2026-07-31'), null);
  assert.equal(exhibitionForDate(LIST, '2026-10-01'), null);
  assert.equal(exhibitionForDate([], '2026-08-15'), null);
});
test('the current exhibition advances on its own as the date crosses months', () => {
  // Same list, different "today" — no flag to flip.
  assert.equal(exhibitionForDate(LIST, '2026-08-31').theme, 'Fall Season');
  assert.equal(exhibitionForDate(LIST, '2026-09-01').theme, 'Cold Open');
});

// --- month range for scheduling (mirror of doSchedule in admin.html) -------

function monthRange(month /* 'YYYY-MM' */) {
  const p = month.split('-').map(Number);
  const last = new Date(p[0], p[1], 0).getDate(); // day 0 of the next (1-based) month = last day of this one
  const pad = (n) => String(n).padStart(2, '0');
  return { startsOn: month + '-01', endsOn: month + '-' + pad(last) };
}

test('scheduling a month spans its first to last day', () => {
  assert.deepEqual(monthRange('2026-08'), { startsOn: '2026-08-01', endsOn: '2026-08-31' });
  assert.deepEqual(monthRange('2026-09'), { startsOn: '2026-09-01', endsOn: '2026-09-30' });
});
test('scheduling handles February and leap years', () => {
  assert.equal(monthRange('2026-02').endsOn, '2026-02-28');
  assert.equal(monthRange('2028-02').endsOn, '2028-02-29'); // 2028 is a leap year
});

// --- submissions filter (mirror of exSubs in admin.html) -------------------

function exSubs(works, cur) {
  if (!cur) return [];
  return works.filter((w) =>
    w.kind === 'art' && w.destination === 'exhibition' && w.status !== 'declined'
    && w.made_on >= cur.starts_on && w.made_on <= cur.ends_on);
}

const WORKS = [
  { id: '1', kind: 'art',    destination: 'exhibition', status: 'approved', made_on: '2026-08-10', owner: { id: 'p1', name: 'Saahil' } },
  { id: '2', kind: 'art',    destination: 'exhibition', status: 'pending',  made_on: '2026-08-20', owner: { id: 'p2', name: 'Mahiba' } },
  { id: '3', kind: 'art',    destination: 'exhibition', status: 'declined', made_on: '2026-08-05', owner: { id: 'p1' } }, // file deleted
  { id: '4', kind: 'design', destination: 'profile',    status: 'approved', made_on: '2026-08-12', owner: { id: 'p1' } }, // not exhibition
  { id: '5', kind: 'art',    destination: 'exhibition', status: 'approved', made_on: '2026-09-03', owner: { id: 'p3' } }, // next month
];

test('current exhibition shows only this month undeclined art exhibition works', () => {
  const subs = exSubs(WORKS, AUG);
  assert.deepEqual(subs.map((w) => w.id).sort(), ['1', '2']); // pending + approved, in range
});
test('declined submissions are hidden (their files were deleted)', () => {
  assert.ok(!exSubs(WORKS, AUG).some((w) => w.status === 'declined'));
});
test('a custom-dated upload counts for the exhibition of that date, not the current', () => {
  // Work #5 is made_on 2026-09-03 — it belongs to September, not August.
  assert.ok(!exSubs(WORKS, AUG).some((w) => w.id === '5'));
  assert.deepEqual(exSubs(WORKS, SEP).map((w) => w.id), ['5']);
});
test('after the exhibition ends, its works drop out of the current view', () => {
  // "today" in September → current is SEP → August works no longer shown.
  const cur = exhibitionForDate(LIST, '2026-09-15');
  const subs = exSubs(WORKS, cur);
  assert.ok(!subs.some((w) => w.made_on.startsWith('2026-08')));
});
test('the submission carries the uploader profile so the panel can show it', () => {
  const first = exSubs(WORKS, AUG)[0];
  assert.equal(first.owner.name, 'Saahil');
});

// --- event held-date display + save (mirror of admin.html eventList/save) ---

// held_on (a date, stored YYYY-MM-01) <-> the month picker value (YYYY-MM).
const monthOf = (held_on) => (held_on ? String(held_on).slice(0, 7) : '');
// Build the patch the Save button sends from the two inputs.
function eventPatch(nameInput, monthInput) {
  const patch = {};
  if (nameInput && nameInput.trim()) patch.name = nameInput.trim();
  if (monthInput !== undefined) patch.heldOn = monthInput ? monthInput + '-01' : null;
  return patch;
}

test('held date shows in the month picker as YYYY-MM', () => {
  assert.equal(monthOf('2026-08-01'), '2026-08');
  assert.equal(monthOf(null), '');
  assert.equal(monthOf(''), '');
});
test('saving a month writes held_on as the first of that month', () => {
  assert.deepEqual(eventPatch('', '2026-09'), { heldOn: '2026-09-01' });
});
test('saving a name and a month writes both', () => {
  assert.deepEqual(eventPatch('STEMCON 2026', '2026-09'), { name: 'STEMCON 2026', heldOn: '2026-09-01' });
});
test('clearing the month clears the date', () => {
  assert.deepEqual(eventPatch('', ''), { heldOn: null });
});
test('a blank name is not included in the patch', () => {
  assert.ok(!('name' in eventPatch('   ', '2026-09')));
});
