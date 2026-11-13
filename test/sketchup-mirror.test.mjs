// SketchUp mirror: the spec Tiksi sends and the merge of what SketchUp saved back.
// Synthetic properties only; the native write/read is covered by test_sketchup_mirror.py.
import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
const { mirrorSpec, mergeMirror, syncedState, specSignature, mirrorFileName, sketchupImageBytes, wallSig, elementState, syncMirror } = await import('../js/sketchup-mirror.js');

function room() {
  const p = store.propertyTemplate('Synthetic room');
  p.id = 'prop-syn';
  const lvl = p.levels[0].id;
  const wall = (id, ax, ay, bx, by) => ({ id, level: lvl, ax, ay, bx, by, thickness: 0.1, height: null, material: 'mat-drywall' });
  p.walls.push(wall('w-s', 0, 0, 4, 0), wall('w-e', 4, 0, 4, 3), wall('w-n', 4, 3, 0, 3), wall('w-w', 0, 3, 0, 0));
  p.openings.push(
    { id: 'o-door', wallId: 'w-s', type: 'door', t: 0.25, width: 0.9, height: 2.0 },
    { id: 'o-win', wallId: 'w-s', type: 'window', t: 0.75, width: 1.0, height: 1.2, sill: 0.9 },
  );
  p.rooms.push({ id: 'r-1', level: lvl, name: 'Studio', pts: [[0, 0], [4, 0], [4, 3], [0, 3]], material: 'mat-oak', ceilingMaterial: null });
  return p;
}

// What the server reports for a .skp nobody edited: now == written values.
function readOf(spec) {
  return {
    model: { propertyId: spec.property.id, elements: spec.elements },
    walls: spec.walls.map(w => {
      const base = { ax: w.ax, ay: w.ay, bx: w.bx, by: w.by, thickness: w.thickness, height: w.height, elevation: w.elevation };
      return {
        id: w.id, level: w.level, base, now: { ...base },
        openings: w.holes.map(h => {
          const ob = { wallId: w.id, t: h.t, width: h.width, height: h.height, sill: h.sill };
          return { id: h.id, type: h.type, base: ob, now: { ...ob } };
        }),
      };
    }),
    rooms: spec.rooms.map(r => {
      const base = { pts: r.pts, name: r.name, elevation: r.elevation };
      return { id: r.id, level: r.level, base, now: { ...base, pts: r.pts.map(q => [...q]) } };
    }),
    untagged: { faces: 0, groups: 0, instances: 0 }, warnings: [],
  };
}

test('spec carries walls with cut openings, rooms, elements and the underlay', () => {
  const p = room();
  p.levels[0].plan = { img: 'data:image/png;base64,AAAA', imgW: 200, imgH: 100, mPerPx: 0.02, offsetX: -1, offsetY: -2, opacity: 0.5, calibrated: true };
  const spec = mirrorSpec(p);
  assert.equal(spec.format, 'tiksi-sketchup-mirror');
  assert.equal(spec.walls.length, 4);
  const south = spec.walls.find(w => w.id === 'w-s');
  assert.equal(south.height, store.levelHeight(p, p.levels[0].id), 'a wall without its own height follows the level');
  const door = south.holes.find(h => h.id === 'o-door'), win = south.holes.find(h => h.id === 'o-win');
  assert.deepEqual([door.s0, door.s1, door.v0, door.v1].map(v => +v.toFixed(3)), [0.55, 1.45, 0, 2]);
  assert.deepEqual([win.v0, +win.v1.toFixed(3)], [0.9, 2.1]);
  assert.deepEqual(Object.keys(spec.elements).sort(), ['o-door', 'o-win', 'r-1', 'w-e', 'w-n', 'w-s', 'w-w']);
  assert.deepEqual(spec.underlays[0], { level: p.levels[0].id, levelName: p.levels[0].name, elevation: 0, sig: spec.underlays[0].sig, x: -1, y: -2, widthM: 4, heightM: 2 });
  assert.equal(specSignature(spec), specSignature(mirrorSpec(p)), 'signature is stable');
  assert.equal(mirrorFileName('12 Example Ave #3B.tiksi'), '12 Example Ave #3B.skp');
});

test('an unedited .skp changes nothing', () => {
  const p = room(), before = JSON.stringify(p);
  const r = mergeMirror(p, readOf(mirrorSpec(p)), syncedState(p));
  assert.deepEqual([r.applied, r.added, r.deleted, r.conflicts], [[], [], [], []]);
  assert.equal(JSON.stringify(p), before);
});

// Typed lengths are stored exactly, so the mirror tells apart changes far under a millimetre.
const INCH = 0.0254;
test('a typed change under a millimetre counts as a change on both sides', () => {
  const p = room(), w = p.walls.find(x => x.id === 'w-e');   // 100 mm thick
  const synced = syncedState(p), read = readOf(mirrorSpec(p));
  w.thickness = 0.1 + INCH / 64;   // typed 1/64" (0.4 mm) thicker
  assert.notEqual(syncedState(p)['w-e'], synced['w-e'], 'the typed change is a change');
  // SketchUp moved the same wall meanwhile: both changed, so Tiksi keeps its typed value.
  read.walls.find(x => x.id === 'w-e').now.ax = 4.5;
  const r = mergeMirror(p, read, synced);
  assert.deepEqual(r.conflicts.map(c => c.id), ['w-e']);
  assert.equal(w.thickness, 0.1 + INCH / 64);
});

test('a wall moved half a millimetre in SketchUp moves in Tiksi', () => {
  const p = room(), synced = syncedState(p), read = readOf(mirrorSpec(p));
  Object.assign(read.walls.find(x => x.id === 'w-e').now, { ax: 4.0005, bx: 4.0005 });
  const r = mergeMirror(p, read, synced);
  assert.deepEqual(r.applied, ['w-e']);
  assert.deepEqual([p.walls.find(x => x.id === 'w-e').ax, p.walls.find(x => x.id === 'w-e').bx], [4.0005, 4.0005]);
});

test('a length signs alike as Tiksi holds it and as the server reads it back to the micrometre', () => {
  // The server reports each value rounded to six decimals of a metre (r6), from its exact value.
  const readBack = v => Number(v.toFixed(6));
  const differ = [];
  for (let n = -16 * 400; n <= 16 * 400; n++) for (const v of [n * INCH / 16, n * INCH / 32, n / 1e4, n / 1e5]) {
    const params = { ax: v, ay: 0, bx: 1, by: 0, thickness: 0.1, height: 2.4 };
    if (wallSig(params) !== wallSig({ ...params, ax: readBack(v) })) differ.push(v);
  }
  assert.deepEqual(differ.slice(0, 5), [], differ.length + ' lengths sign differently once read back');
});

// A project mirrored before the 0.1 mm signatures: its records hold millimetre signatures, made
// here as the earlier mirror made them (lengths to the millimetre, positions to 1/2000).
const mmOld = v => Math.round(Number(v || 0) * 1000), permilleOld = v => Math.round(Number(v || 0) * 2000);
const oldSig = (kind, q) => kind === 'wall' ? ['wall', mmOld(q.ax), mmOld(q.ay), mmOld(q.bx), mmOld(q.by), mmOld(q.thickness), mmOld(q.height)].join(',')
  : kind === 'opening' ? ['opening', q.wallId, permilleOld(q.t), mmOld(q.width), mmOld(q.height), mmOld(q.sill)].join(',')
  : ['room', q.name || '', ...q.pts.map(c => mmOld(c[0]) + ':' + mmOld(c[1]))].join(',');
const legacySigs = p => Object.fromEntries([...elementState(p)].map(([id, st]) => [id, oldSig(st.kind, st.params)]));
const legacySpec = p => { const spec = mirrorSpec(p, []), sigs = legacySigs(p);
  for (const [id, e] of Object.entries(spec.elements)) e.sig = sigs[id];
  return spec; };
test('a mirror saved with millimetre signatures still brings a SketchUp edit and a SketchUp delete across', () => {
  const p = room(), read = readOf(legacySpec(p)), old = legacySigs(p);
  Object.assign(read.walls.find(x => x.id === 'w-e').now, { ax: 4.5, bx: 4.5 });
  read.rooms = read.rooms.filter(r => r.id !== 'r-1');   // deleted in SketchUp before the upgrade
  const r = mergeMirror(p, read, old, old);
  assert.deepEqual([r.applied, r.deleted, r.conflicts], [['w-e'], ['r-1'], []]);
  assert.equal(p.walls.find(x => x.id === 'w-e').ax, 4.5);
  // And a Tiksi change made since that sync is still a Tiksi change: both changed, Tiksi kept.
  const q = room(), qread = readOf(legacySpec(q)), qold = legacySigs(q);
  q.walls.find(x => x.id === 'w-n').ay = 3.2;
  qread.walls.find(x => x.id === 'w-n').now.ay = 3.4;
  assert.deepEqual(mergeMirror(q, qread, qold, qold).conflicts.map(c => c.id), ['w-n']);
});

test('a mirror up to date under the millimetre signatures is not rewritten or read again', async () => {
  const p = room(), mats = [];   // no finishes listed, as legacySpec
  const file = { name: 'Synthetic room.skp', size: 1234, lastModified: 1700000000000, async arrayBuffer() { throw new Error('the .skp was read'); } };
  const folder = { async getFileHandle(name) { if (name !== file.name) throw new DOMException('none', 'NotFoundError'); return { async getFile() { return file; } }; } };
  const entry = { file: 'Synthetic room.tiksi', mirror: { file: file.name, mtime: file.lastModified, size: file.size, synced: legacySigs(p),
    sig: specSignature(legacySpec(p)), underlays: {} } };
  let writes = 0;
  const result = await syncMirror(folder, p, entry, async () => { writes++; }, mats);
  assert.deepEqual([writes, result.changed], [0, false]);
  assert.equal(entry.mirror.sig, specSignature(mirrorSpec(p, mats)), 'the new signature is kept');
  assert.deepEqual(entry.mirror.synced, syncedState(p));
});

test('a wall moved and raised in SketchUp updates Tiksi; its height stops following the level', () => {
  const p = room(), synced = syncedState(p), read = readOf(mirrorSpec(p));
  const east = read.walls.find(w => w.id === 'w-e');
  Object.assign(east.now, { ax: 4.5, bx: 4.5, height: 3 });
  const r = mergeMirror(p, read, synced);
  assert.deepEqual(r.applied, ['w-e']);
  const w = p.walls.find(x => x.id === 'w-e');
  assert.deepEqual([w.ax, w.bx, w.height], [4.5, 4.5, 3]);
});

test('an opening slid along its wall in SketchUp moves in Tiksi', () => {
  const p = room(), synced = syncedState(p), read = readOf(mirrorSpec(p));
  read.walls.find(w => w.id === 'w-s').openings.find(o => o.id === 'o-win').now.t = 0.6;
  const r = mergeMirror(p, read, synced);
  assert.deepEqual(r.applied, ['o-win']);
  assert.equal(p.openings.find(o => o.id === 'o-win').t, 0.6);
});

test('when both sides changed a wall, Tiksi keeps its version and reports it', () => {
  const p = room(), synced = syncedState(p), read = readOf(mirrorSpec(p));
  read.walls.find(w => w.id === 'w-n').now.ay = 3.4;
  p.walls.find(w => w.id === 'w-n').ay = 3.2;
  const r = mergeMirror(p, read, synced);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].id, 'w-n');
  assert.equal(p.walls.find(w => w.id === 'w-n').ay, 3.2);
});

test('the same edit made on both sides is not a conflict', () => {
  const p = room(), synced = syncedState(p), read = readOf(mirrorSpec(p));
  read.walls.find(w => w.id === 'w-n').now.ay = 3.2;
  p.walls.find(w => w.id === 'w-n').ay = 3.2;
  const r = mergeMirror(p, read, synced);
  assert.deepEqual([r.applied, r.conflicts], [[], []]);
});

test('a wall copied in SketchUp becomes a new wall, its openings copied with it', () => {
  const p = room(), synced = syncedState(p), read = readOf(mirrorSpec(p));
  const copy = structuredClone(read.walls.find(w => w.id === 'w-s'));
  Object.assign(copy.now, { ay: 6, by: 6 });
  read.walls.push(copy);
  const r = mergeMirror(p, read, synced);
  assert.equal(r.added.length, 3, 'one wall and its two openings');
  const fresh = p.walls.find(w => w.ay === 6);
  assert.ok(fresh && fresh.id !== 'w-s' && fresh.material === 'mat-drywall');
  assert.equal(p.openings.filter(o => o.wallId === fresh.id).length, 2);
  assert.equal(p.walls.find(w => w.id === 'w-s').ay, 0, 'the original stays put');
});

test('a wall deleted in SketchUp is deleted in Tiksi with its openings', () => {
  const p = room(), synced = syncedState(p), read = readOf(mirrorSpec(p));
  read.walls = read.walls.filter(w => w.id !== 'w-s');
  const r = mergeMirror(p, read, synced);
  assert.deepEqual(r.deleted.sort(), ['o-door', 'o-win', 'w-s']);
  assert.ok(!p.walls.some(w => w.id === 'w-s'));
  assert.ok(!p.openings.some(o => o.wallId === 'w-s'));
});

test('deleted in SketchUp but edited in Tiksi: kept, reported', () => {
  const p = room(), synced = syncedState(p), read = readOf(mirrorSpec(p));
  read.rooms = [];
  p.rooms[0].name = 'Studio and office';
  const r = mergeMirror(p, read, synced);
  assert.deepEqual(r.deleted, []);
  assert.equal(r.conflicts[0].id, 'r-1');
  assert.equal(p.rooms.length, 1);
});

test('deleted in Tiksi after the last sync stays deleted', () => {
  const p = room(), synced = syncedState(p), read = readOf(mirrorSpec(p));
  p.walls = p.walls.filter(w => w.id !== 'w-w');
  const r = mergeMirror(p, read, synced);
  assert.deepEqual([r.added, r.conflicts], [[], []]);
  assert.ok(!p.walls.some(w => w.id === 'w-w'));
});

test('a room renamed in SketchUp is renamed in Tiksi', () => {
  const p = room(), synced = syncedState(p), read = readOf(mirrorSpec(p));
  read.rooms[0].now.name = 'Library';
  mergeMirror(p, read, synced);
  assert.equal(p.rooms[0].name, 'Library');
});

test('a mirror written on another machine merges against its own record', () => {
  const p = room(), read = readOf(mirrorSpec(p));
  read.walls.find(w => w.id === 'w-e').now.bx = 4.25;
  const r = mergeMirror(p, read, {});
  assert.deepEqual(r.applied, ['w-e']);
  assert.equal(p.walls.find(w => w.id === 'w-e').bx, 4.25);
});

// The .skp was open in SketchUp while Tiksi rewrote it; SketchUp then saves its older copy.
test('a stale save from SketchUp does not undo a later Tiksi edit', () => {
  const p = room();
  const staleRead = readOf(mirrorSpec(p));             // the copy SketchUp opened
  p.walls.find(w => w.id === 'w-e').bx = 4.5;          // Tiksi edits and rewrites the mirror
  const synced = syncedState(p);
  const r = mergeMirror(p, staleRead, synced);
  assert.deepEqual([r.applied, r.conflicts], [[], []]);
  assert.equal(p.walls.find(w => w.id === 'w-e').bx, 4.5);
});

test('a stale save does not delete what Tiksi added after SketchUp opened the file', () => {
  const p = room();
  const staleRead = readOf(mirrorSpec(p));
  p.rooms.push({ id: 'r-2', level: p.levels[0].id, name: 'Closet', pts: [[0, 3], [1, 3], [1, 4], [0, 4]], material: 'mat-oak', ceilingMaterial: null });
  const r = mergeMirror(p, staleRead, syncedState(p));
  assert.deepEqual(r.deleted, []);
  assert.ok(p.rooms.some(x => x.id === 'r-2'));
});

test('a value SketchUp already delivered is not applied again over a newer Tiksi edit', () => {
  const p = room(), opened = readOf(mirrorSpec(p));
  // Save 1 from SketchUp: the north wall moves to 3.4; Tiksi takes it.
  opened.walls.find(w => w.id === 'w-n').now.ay = 3.4;
  const first = mergeMirror(p, opened, syncedState(p));
  assert.deepEqual(first.applied, ['w-n']);
  // Tiksi then moves it to 3.6 and rewrites; SketchUp saves again, still holding 3.4.
  p.walls.find(w => w.id === 'w-n').ay = 3.6;
  const second = mergeMirror(p, opened, syncedState(p), first.seen);
  assert.deepEqual([second.applied, second.conflicts], [[], []]);
  assert.equal(p.walls.find(w => w.id === 'w-n').ay, 3.6);
});

test('a second SketchUp edit of the same element after a merge applies', () => {
  const p = room(), opened = readOf(mirrorSpec(p));
  opened.walls.find(w => w.id === 'w-n').now.ay = 3.4;
  const first = mergeMirror(p, opened, syncedState(p));
  const synced = syncedState(p);
  opened.walls.find(w => w.id === 'w-n').now.ay = 3.5;   // same SketchUp session, edited again
  const second = mergeMirror(p, opened, synced, first.seen);
  assert.deepEqual([second.applied, second.conflicts], [['w-n'], []]);
  assert.equal(p.walls.find(w => w.id === 'w-n').ay, 3.5);
});

test('the property survives store validation after a merge', () => {
  const p = room(), synced = syncedState(p), read = readOf(mirrorSpec(p));
  read.walls.push(structuredClone(read.walls[0]));
  mergeMirror(p, read, synced);
  store.ws.data = store.emptyWorkspace();
  const ids = store.mergeWorkspace({ version: 2, properties: [p], materials: [], products: [], projects: [] });
  assert.deepEqual(ids, ['prop-syn']);
});

test('underlays SketchUp cannot read are re-encoded, the rest are sent as they are', async () => {
  const sent = [];
  const encode = async bytes => { sent.push(Array.from(bytes)); return new Uint8Array([0xff, 0xd8, 0xff]); };
  const webp = await sketchupImageBytes('data:image/webp;base64,UklGRg==', encode);
  assert.equal(webp.ext, 'jpg', 'a scan underlay (WebP) goes to SketchUp as JPEG');
  assert.deepEqual(Array.from(webp.bytes), [0xff, 0xd8, 0xff]);
  assert.deepEqual(sent, [[0x52, 0x49, 0x46, 0x46]], 'the encoder received the original WebP bytes');
  const png = await sketchupImageBytes('data:image/png;base64,iVBORw==', encode);
  assert.equal(png.ext, 'png');
  assert.deepEqual(Array.from(png.bytes), [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(sent.length, 1, 'PNG and JPEG need no re-encoding');
  assert.equal(await sketchupImageBytes('data:image/gif;base64,R0lGOD', encode), null, 'unsupported images are not sent');
});

// ---------- finishes ----------

const MATS = [
  { id: 'mat-brick', name: 'Brick, red', color: '#9C4A3A' },
  { id: 'mat-sage', name: 'Sage paint', color: '#8fa58a' },
  { id: 'mat-drywall', name: 'Drywall, painted', color: '#d8d4cc' },
  { id: 'mat-oak', name: 'White oak flooring', color: '#c9a06a' },
  { id: 'mat-trim', name: 'Trim, painted semi-gloss', color: '#f4f2ec' },
  { id: 'mat-glass', name: 'Glass, clear', color: '#d2e7ee' },
  { id: 'mat-unused', name: 'Unused tile', color: '#123456' },
];
const mats = () => structuredClone(MATS);
const pick = (list, id) => { const m = list.find(x => x.id === id); return { id: m.id, name: m.name, color: m.color.toLowerCase() }; };

// Brick outside; the south wall painted sage inside; a second room east of the studio
// makes the east wall a partition.
function finished() {
  const p = room();
  for (const w of p.walls) w.material = 'mat-brick';
  p.walls.find(w => w.id === 'w-s').materialIn = 'mat-sage';
  p.rooms.push({ id: 'r-2', level: p.levels[0].id, name: 'Annex', pts: [[4, 0], [6, 0], [6, 3], [4, 3]], material: 'mat-oak', ceilingMaterial: null });
  return p;
}

test('spec carries each face\'s finish the way the 3D view paints it', () => {
  const list = mats(), spec = mirrorSpec(finished(), list);
  const wall = id => spec.walls.find(w => w.id === id).materials;
  // The studio lies on the +normal side of every wall drawn round it, so that is `pos`.
  assert.deepEqual(wall('w-s'), { pos: pick(list, 'mat-sage'), neg: pick(list, 'mat-brick'), other: pick(list, 'mat-sage') },
    'ends, top and reveals take the interior finish, not the outside brick');
  assert.equal(wall('w-s').neg.color, '#9c4a3a', 'colours go out as lower-case hex');
  assert.deepEqual(wall('w-n'), { pos: pick(list, 'mat-drywall'), neg: pick(list, 'mat-brick'), other: pick(list, 'mat-drywall') },
    'an exterior wall with an automatic interior is drywall on the room side');
  assert.deepEqual(wall('w-e'), { pos: pick(list, 'mat-brick'), neg: pick(list, 'mat-brick'), other: pick(list, 'mat-brick') },
    'a partition with an automatic interior wears its own finish both sides');
  assert.deepEqual(spec.rooms.find(r => r.id === 'r-1').material, pick(list, 'mat-oak'));
  const holes = Object.fromEntries(spec.walls.find(w => w.id === 'w-s').holes.map(h => [h.id, h.material]));
  assert.deepEqual(holes, { 'o-door': pick(list, 'mat-trim'), 'o-win': pick(list, 'mat-glass') });
  assert.deepEqual(spec.warnings, []);
});

test('each long face can carry its own finish; an unrecorded exterior shows grey, not the room\'s paint', async () => {
  const { wallFaceLabels } = await import('../js/wall-solids.js');
  const list = mats().concat([{ id: 'mat-exterior-unknown', name: 'Exterior, not recorded', color: '#9b9d9f' }]);
  const grey = pick(list, 'mat-exterior-unknown');
  const p = finished();
  const w = id => p.walls.find(x => x.id === id);
  // North wall: exterior, its own finish the same as its interior: the outside does not copy it.
  w('w-n').material = 'mat-sage'; w('w-n').materialIn = 'mat-sage';
  // West wall: exterior with no finish of its own at all.
  w('w-w').material = null;
  // East wall: the partition between the studio and the annex, sage toward the annex only.
  w('w-e').materialNeg = 'mat-sage';
  // South wall: brick outside stays brick (it says something the interior does not).
  let spec = mirrorSpec(p, list);
  const faces = id => spec.walls.find(x => x.id === id).materials;
  assert.deepEqual(faces('w-n'), { pos: pick(list, 'mat-sage'), neg: grey, other: pick(list, 'mat-sage') });
  assert.deepEqual(faces('w-w').neg, grey, 'no finish of its own: grey outside');
  assert.deepEqual(faces('w-w').pos, pick(list, 'mat-drywall'), 'the room side keeps the automatic drywall');
  assert.deepEqual(faces('w-e'), { pos: pick(list, 'mat-brick'), neg: pick(list, 'mat-sage'), other: pick(list, 'mat-brick') },
    'a partition shows a different finish to each room');
  assert.deepEqual(faces('w-s'), { pos: pick(list, 'mat-sage'), neg: pick(list, 'mat-brick'), other: pick(list, 'mat-sage') });
  // A face's own finish wins on the outside too, once the cladding is known.
  w('w-n').materialNeg = 'mat-brick';
  spec = mirrorSpec(p, list);
  assert.deepEqual(faces('w-n').neg, pick(list, 'mat-brick'));
  assert.deepEqual(spec.warnings, []);
  // Labels name the compass side and what it looks onto (plan y runs south).
  assert.deepEqual(wallFaceLabels(w('w-s'), p.rooms), { pos: 'South face (Studio)', neg: 'North face (outside)' });
  assert.deepEqual(wallFaceLabels(w('w-e'), p.rooms), { pos: 'West face (Studio)', neg: 'East face (Annex)' });
});

test('a wall outside every room wears its own finish on every face', async () => {
  const { wallFaceMaterialIds } = await import('../js/wall-solids.js');
  const garden = { id: 'w-g', ax: 10, ay: 10, bx: 14, by: 10, thickness: 0.2, material: 'mat-brick' };
  assert.deepEqual(wallFaceMaterialIds(garden, finished().rooms), { pos: 'mat-brick', neg: 'mat-brick', other: 'mat-brick' });
});

test('a finish change rewrites the mirror without reading back as a SketchUp edit', () => {
  const p = finished(), list = mats();
  const written = mirrorSpec(p, list), synced = syncedState(p);
  // An unused material, or the same values in a fresh copy, do not trigger a rewrite.
  const other = mats(); other.find(m => m.id === 'mat-unused').color = '#654321';
  assert.equal(specSignature(mirrorSpec(p, other)), specSignature(written));
  const recolour = mats(); recolour.find(m => m.id === 'mat-sage').color = '#334455';
  assert.notEqual(specSignature(mirrorSpec(p, recolour)), specSignature(written), 'a used material\'s colour');
  const renamed = mats(); renamed.find(m => m.id === 'mat-oak').name = 'Walnut flooring';
  assert.notEqual(specSignature(mirrorSpec(p, renamed)), specSignature(written), 'a used material\'s name');
  p.rooms.find(r => r.id === 'r-1').material = 'mat-sage';
  p.walls.find(w => w.id === 'w-n').materialIn = 'mat-sage';
  const changed = mirrorSpec(p, list);
  assert.notEqual(specSignature(changed), specSignature(written), 'an element\'s material');
  assert.deepEqual(changed.elements, written.elements, 'element signatures are geometry only');
  assert.deepEqual(syncedState(p), synced);
  // The .skp written before the change comes back unedited: nothing to merge, nothing lost.
  const before = JSON.stringify(p);
  const r = mergeMirror(p, readOf(written), synced);
  assert.deepEqual([r.applied, r.added, r.deleted, r.conflicts], [[], [], [], []]);
  assert.equal(JSON.stringify(p), before, 'the new finishes stay in Tiksi');
});

test('an unknown material falls back to the 3D view\'s colour with a warning', () => {
  const p = finished();
  p.walls.find(w => w.id === 'w-w').material = 'mat-gone';
  p.walls.find(w => w.id === 'w-n').material = 'mat-gone';
  p.rooms.find(r => r.id === 'r-1').material = null;
  const spec = mirrorSpec(p, mats().filter(m => m.id !== 'mat-trim'));
  assert.deepEqual(spec.walls.find(w => w.id === 'w-w').materials.neg, { id: 'mat-gone', name: 'Default wall', color: '#d8d4cc' });
  assert.deepEqual(spec.rooms.find(r => r.id === 'r-1').material, { id: null, name: 'Default floor', color: '#97999b' }, 'an unset floor is not an error');
  assert.deepEqual(spec.walls.find(w => w.id === 'w-s').holes.find(h => h.id === 'o-door').material, { id: 'mat-trim', name: 'Default trim', color: '#f3f1ec' });
  assert.deepEqual(spec.warnings, [
    'material mat-trim on opening o-door is not in the material library; painted Default trim',
    'material mat-gone on wall w-n is not in the material library; painted Default wall',
  ], 'one warning per missing material');
  const bad = mats(); bad.find(m => m.id === 'mat-oak').color = 'oak';
  assert.equal(mirrorSpec(finished(), bad).rooms[0].material.color, '#97999b', 'an unusable colour takes the fallback');
  assert.equal(mirrorSpec(finished()).walls[0].materials.pos.name, 'Default wall', 'no library at all still writes');
});

test('materials sharing a name keep separate SketchUp materials', () => {
  const p = finished(), list = mats();
  list.find(m => m.id === 'mat-sage').name = 'Brick, red';
  const south = mirrorSpec(p, list).walls.find(w => w.id === 'w-s').materials;
  assert.equal(south.pos.name, 'Brick, red (mat-sage)');
  assert.equal(south.neg.name, 'Brick, red (mat-brick)');
});
