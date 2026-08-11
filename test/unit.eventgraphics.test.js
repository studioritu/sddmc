// Unit tests for the DB-driven event-graphics logic (mirror of index.html
// evts()/archiveEvts()). Events come from the admin table; each carries its
// real works; Personal is hidden everywhere; Non event club work is hidden on
// the Event Graphics page but kept on the home page; empty events are coming-soon.
import test from 'node:test';
import assert from 'node:assert/strict';

const PH = 'data:image/gif;base64,PLACEHOLDER';
const isPersonal = (n) => /personal/i.test(n || '');
const isNonEvent = (n) => /non.?event/i.test(n || '');

// mirror of evts(): home-page scope (personal removed, non-event kept)
function evts(events, works) {
  return (events || []).filter((e) => !isPersonal(e.name)).map((e, i) => {
    const ws = (works || []).filter((w) => w.event === e.name && w.status !== 'declined');
    const imgs = ws.map((w) => w.thumb);
    return {
      i, no: String(i + 1).padStart(2, '0'), event: e.name, works: ws,
      hasWorks: ws.length > 0, count: String(ws.length).padStart(2, '0'),
      note: ws.length ? ('Every graphic we shipped for ' + e.name + '.')
                      : 'No works uploaded for this event yet, coming soon!',
      imgA: imgs[0] || PH, imgB: imgs[1] || imgs[0] || PH, imgC: imgs[2] || imgs[0] || PH,
    };
  });
}
// mirror of archiveEvts(): Event Graphics page scope
const archiveEvts = (events, works) => evts(events, works).filter((e) => !isNonEvent(e.event));

// mirror of galleryData(): a reel tile links to its maker's profile only when
// that maker is still on the roster
function reelItems(works, roster) {
  const onRoster = new Set((roster || []).map((p) => p.id));
  return (works || []).map((w) => {
    const name = (w.owner && w.owner.name) || 'Member';
    const linked = !!w.owner_id && onRoster.has(w.owner_id);
    return { by: linked ? name + ' ↗' : name, linked, profileId: linked ? w.owner_id : null };
  });
}

const EVENTS = [
  { name: 'STEMCON 2025' },
  { name: 'Sunnydale Games' },
  { name: 'Non event club work' },
  { name: 'Personal works' },
  { name: 'Personal / off-theme' },
];
const WORKS = [
  { event: 'STEMCON 2025', status: 'approved', title: 'Poster',  thumb: 'a.webp', owner: { name: 'Saahil' } },
  { event: 'STEMCON 2025', status: 'pending',  title: 'Banner',  thumb: 'b.webp', owner: { name: 'Mahiba' } },
  { event: 'STEMCON 2025', status: 'declined', title: 'Reject',  thumb: 'c.webp', owner: { name: 'x' } },
  { event: 'Non event club work', status: 'approved', title: 'Club logo', thumb: 'd.webp', owner: { name: 'Ahnaf' } },
];

test('home page shows real events, hides Personal, keeps Non event club work', () => {
  const names = evts(EVENTS, WORKS).map((e) => e.event);
  assert.deepEqual(names, ['STEMCON 2025', 'Sunnydale Games', 'Non event club work']);
  assert.ok(!names.some((n) => /personal/i.test(n)));
});

test('Event Graphics page also hides Non event club work', () => {
  const names = archiveEvts(EVENTS, WORKS).map((e) => e.event);
  assert.deepEqual(names, ['STEMCON 2025', 'Sunnydale Games']);
});

test('an event carries its undeclined works from every profile', () => {
  const stemcon = evts(EVENTS, WORKS).find((e) => e.event === 'STEMCON 2025');
  assert.equal(stemcon.works.length, 2); // approved + pending, not declined
  assert.deepEqual(stemcon.works.map((w) => w.owner.name), ['Saahil', 'Mahiba']);
  assert.equal(stemcon.count, '02');
});

test('an event with no works is a coming-soon card', () => {
  const games = evts(EVENTS, WORKS).find((e) => e.event === 'Sunnydale Games');
  assert.equal(games.hasWorks, false);
  assert.equal(games.note, 'No works uploaded for this event yet, coming soon!');
  assert.equal(games.imgA, PH);
});

test('the count reflects the number of real events (not a hardcoded 4)', () => {
  assert.equal(archiveEvts(EVENTS, WORKS).length, 2);
  assert.equal(String(archiveEvts(EVENTS, WORKS).length), '2');
});

test('a reel tile points at the profile of whoever made the design', () => {
  const roster = [{ id: 'u-1', name: 'Saahil' }, { id: 'u-2', name: 'Mahiba' }];
  const works = [
    { owner_id: 'u-2', owner: { name: 'Mahiba' } },
    { owner_id: 'u-1', owner: { name: 'Saahil' } },
  ];
  assert.deepEqual(reelItems(works, roster).map((g) => g.profileId), ['u-2', 'u-1']);
  assert.deepEqual(reelItems(works, roster).map((g) => g.by), ['Mahiba ↗', 'Saahil ↗']);
});

test('a design whose maker left the roster stays a plain caption, not a dead link', () => {
  const roster = [{ id: 'u-1', name: 'Saahil' }];
  const gone = reelItems([{ owner_id: 'u-9', owner: { name: 'Former member' } }], roster)[0];
  assert.equal(gone.linked, false);
  assert.equal(gone.profileId, null);
  assert.equal(gone.by, 'Former member');

  const orphan = reelItems([{ owner_id: null, owner: null }], roster)[0];
  assert.equal(orphan.linked, false);
  assert.equal(orphan.by, 'Member');
});

test('image fallbacks: one work fills all three plates, none uses placeholder', () => {
  const one = evts([{ name: 'Solo' }], [{ event: 'Solo', status: 'approved', title: 't', thumb: 'x.webp', owner: {} }]);
  assert.deepEqual([one[0].imgA, one[0].imgB, one[0].imgC], ['x.webp', 'x.webp', 'x.webp']);
});
