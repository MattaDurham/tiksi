// SketchUp mirror: the spec Tiksi sends and the merge of what SketchUp saved back.
// Synthetic properties only; the native write/read is covered by test_sketchup_mirror.py.
import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
const { mirrorSpec, mergeMirror, syncedState, specSignature, mirrorFileName } = await import('../js/sketchup-mirror.js');

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
  assert.equal(mirrorFileName('160 W 66th St #55E.tiksi'), '160 W 66th St #55E.skp');
});

test('an unedited .skp changes nothing', () => {
  const p = room(), before = JSON.stringify(p);
  const r = mergeMirror(p, readOf(mirrorSpec(p)), syncedState(p));
  assert.deepEqual([r.applied, r.added, r.deleted, r.conflicts], [[], [], [], []]);
  assert.equal(JSON.stringify(p), before);
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

test('the property survives store validation after a merge', () => {
  const p = room(), synced = syncedState(p), read = readOf(mirrorSpec(p));
  read.walls.push(structuredClone(read.walls[0]));
  mergeMirror(p, read, synced);
  store.ws.data = store.emptyWorkspace();
  const ids = store.mergeWorkspace({ version: 2, properties: [p], materials: [], products: [], projects: [] });
  assert.deepEqual(ids, ['prop-syn']);
});
