// Editable catalog trim uses the same triangles in MODEL and its native mirror.
// Synthetic properties only; SDK geometry/read guards live in test_sketchup_trim_detail.py.
import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
const { trimTemplate } = await import('../js/trims.js');
const { catalogFor } = await import('../js/trim-catalog.js');
const { trimMeshParts } = await import('../js/trim-mesh.js');
const { mirrorSpec, specSignature, elementState, mergeMirror, syncedState } = await import('../js/sketchup-mirror.js');

function fixture(style = 'baseboard') {
  const p = store.propertyTemplate('Synthetic trimmed wall'); p.id = 'trim-property';
  const wall = { id: 'wall', level: p.levels[0].id, ax: 0, ay: 0, bx: 4, by: 0, thickness: .15, height: 2.44, material: 'mat-drywall' };
  p.walls = [wall]; p.rooms = []; p.openings = [];
  p.trims = [{ ...trimTemplate(style, catalogFor(style)[0].id, wall, 1, { wallHeight: 2.44 }), id: 'trim-section', evidence: { geometry: { status: 'inferred', source: 'Synthetic specification' } } }];
  return p;
}

function readOf(p) {
  const spec = mirrorSpec(p), state = elementState(p);
  return { model: { propertyId: p.id, elements: spec.elements }, warnings: [], rooms: [], fixtures: [],
    walls: spec.walls.map(w => {
      const base = { ...structuredClone(state.get(w.id).params), elevation: w.elevation };
      if (w.trims) base.trimGeometry = w.trims.map(t => ({ id: t.id, meshSig: t.meshSig }));
      return { id: w.id, level: w.level, base, now: structuredClone(base), openings: [] };
    }) };
}

test('native spec carries exact shared triangles and complete source/catalog metadata for each editable trim style', () => {
  for (const style of ['baseboard', 'board-batten', 'chair-rail', 'picture-frame', 'wainscot-cap']) {
    const p = fixture(style), wall = p.walls[0], source = p.trims[0];
    const expected = trimMeshParts(source, wall, { walls: p.walls, rooms: [], wallHeight: 2.44 }, []);
    const native = mirrorSpec(p).walls[0].trims[0];
    assert.ok(native.parts.length && native.parts.every(part => part.positions.length > 0));
    assert.deepEqual(native.parts.map(({ role, positions }) => ({ role, positions })), expected.parts.map(({ role, positions }) => ({ role, positions })), style + ' uses the viewer triangles');
    assert.deepEqual(native.source, source);
    assert.equal(native.product.id, source.product);
    assert.ok(native.meshSig);
    const before = JSON.stringify(p), result = mergeMirror(p, readOf(p), syncedState(p));
    assert.deepEqual([result.applied, result.added, result.deleted, result.conflicts], [[], [], [], []]);
    assert.equal(JSON.stringify(p), before, 'unchanged readback preserves full trim source');
  }
});

test('trim-only edits update native spec and host conflict signatures', () => {
  const p = fixture('chair-rail'), initial = mirrorSpec(p), old = syncedState(p).wall;
  p.trims[0].y += .12;
  assert.notEqual(specSignature(mirrorSpec(p)), specSignature(initial));
  assert.notEqual(syncedState(p).wall, old);
  assert.notDeepEqual(mirrorSpec(p).walls[0].trims[0].parts, initial.walls[0].trims[0].parts);
});

test('independent rigid wall translation and rotation retain exact trim records', () => {
  for (const change of [{ ax: 2, ay: 1, bx: 6, by: 1 }, { ax: 0, ay: 0, bx: 0, by: 4 }]) {
    const p = fixture(), read = readOf(p), synced = syncedState(p), source = structuredClone(p.trims);
    Object.assign(read.walls[0].now, change);
    const result = mergeMirror(p, read, synced);
    assert.deepEqual(result.applied, ['wall']); assert.equal(result.blockWrite, undefined);
    assert.deepEqual(p.trims, source);
    for (const [key, value] of Object.entries(change)) assert.equal(p.walls[0][key], value);
  }
});

test('native wall movement or removal that changes a neighbouring trim mitre is refused atomically', () => {
  for (const operation of ['move-host', 'move-neighbour', 'delete-neighbour']) {
    const p = fixture(); p.walls.push({ ...p.walls[0], id: 'neighbour', ax: 4, ay: 0, bx: 4, by: 3 });
    const read = readOf(p), before = JSON.stringify(p), synced = syncedState(p);
    if (operation === 'delete-neighbour') read.walls = read.walls.filter(w => w.id !== 'neighbour');
    else { const row = read.walls.find(w => w.id === (operation === 'move-host' ? 'wall' : 'neighbour')); row.now.ax += 1; row.now.bx += 1; }
    const result = mergeMirror(p, read, synced);
    assert.equal(result.blockWrite, true, operation);
    assert.ok(result.conflicts.length); assert.deepEqual(result.applied, []);
    assert.equal(JSON.stringify(p), before, 'no partial mutation on refused geometry');
  }
});

test('native copied trim walls and concurrent trim edits preserve the native copy instead of silently rewriting', () => {
  for (const operation of ['copy', 'concurrent', 'old-mirror']) {
    const p = fixture(), read = readOf(p), synced = syncedState(p);
    if (operation === 'copy') read.walls.push(structuredClone(read.walls[0]));
    else {
      read.walls[0].now.ax += 1; read.walls[0].now.bx += 1;
      if (operation === 'concurrent') p.trims[0].y += .1;
      else { delete read.walls[0].base.trimState; delete read.walls[0].now.trimState; delete read.walls[0].base.trimGeometry; }
    }
    const before = JSON.stringify(p), result = mergeMirror(p, read, synced);
    assert.equal(result.blockWrite, true, operation); assert.equal(JSON.stringify(p), before);
  }
});

test('deleting a native wall deletes its attached trim records without leaving orphan sections', () => {
  const p = fixture(), read = readOf(p), synced = syncedState(p); read.walls = [];
  const result = mergeMirror(p, read, synced);
  assert.deepEqual(result.deleted, ['wall']); assert.deepEqual(p.trims, []);
});
