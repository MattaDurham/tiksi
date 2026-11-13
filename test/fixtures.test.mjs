// Fixtures as data: shapes, migration, project files, undo/redo, two-device merge and the
// SketchUp mirror's spec and merge. Synthetic properties only.
import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
const fx = await import('../js/fixtures.js');
const { GeometryHistory } = await import('../js/geometry-history.js');
const { mergeShared } = await import('../js/workspace-merge.js');
const { mirrorSpec, mergeMirror, syncedState } = await import('../js/sketchup-mirror.js');
const layers = await import('../js/view-layers.js');

function kitchen() {
  const p = store.propertyTemplate('Synthetic kitchen');
  p.id = 'prop-k';
  const L = p.levels[0].id;
  p.rooms.push({ id: 'r-k', level: L, name: 'Kitchen', pts: [[0, 0], [5, 0], [5, 4], [0, 4]], material: 'mat-oak', ceilingMaterial: null });
  p.fixtures.push(Object.assign(fx.fixtureTemplate('base-run', null, { level: L }), { id: 'fx-run', pts: [[3, 0.05], [0.05, 0.05], [0.05, 2.5]], side: -1, corners: [null, 1.12, null] }));
  p.fixtures.push(Object.assign(fx.fixtureTemplate('furniture', 'bed', { level: L, x: 3.5, y: 2.5, rot: 90 }), { id: 'fx-bed' }));
  return p;
}
const area = pts => Math.abs(pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, msg + ': ' + a + ' vs ' + b);

test('an L counter run is mitred, keeps its diagonal corner and layers kick, cabinets and top', () => {
  const run = kitchen().fixtures[0];
  const parts = fx.fixtureParts(run);
  assert.deepEqual([...new Set(parts.map(p => p.role))].sort(), ['body', 'kick', 'top']);
  const tops = parts.filter(p => p.role === 'top');
  assert.equal(tops.length, 3, 'two mitred arms and the diagonal corner');
  near(tops[0].y1, 0.91, 1e-9, 'counter top'); near(tops[0].y0, 0.88, 1e-9, 'counter thickness');
  // The diagonal adds the triangle in the inner corner: the top is larger than a square L.
  const L = (2.95 + 2.45) * 0.62 - 0.62 * 0.62;
  const topArea = tops.reduce((s, p) => s + area(p.pts), 0);
  near(topArea - L, ((1.12 - 0.62 * Math.SQRT2) * Math.SQRT2) ** 2 / 2, 0.01, 'diagonal triangle area');
  const ring = fx.fixtureOutline(run);
  assert.equal(ring.length, 3 + 4, 'back line, then the front with two diagonal points');
  near(fx.runLength(run), 2.95 + 2.45, 1e-9, 'run length');
  // Without the corner reach the inner corner is square.
  assert.equal(fx.fixtureParts(Object.assign({}, run, { corners: [] })).filter(p => p.role === 'top').length, 2);
});

test('every box fixture fills exactly its w x d x h, turned by rot about its centre', () => {
  for (const [kind, k] of Object.entries(fx.FIXTURE_KINDS)) for (const subtype of k.subtypes) {
    const f = fx.normaliseFixture(Object.assign(fx.fixtureTemplate(kind, subtype, { x: 1, y: 2, rot: 30 }), { id: 'x', level: 'l' }));
    const parts = fx.fixtureParts(f);
    assert.ok(parts.length >= 1, subtype + ' has parts');
    const c = Math.cos(-30 * Math.PI / 180), s = Math.sin(-30 * Math.PI / 180);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of parts) {
      y0 = Math.min(y0, p.y0); y1 = Math.max(y1, p.y1);
      for (const [x, y] of p.pts) { const u = (x - 1) * c - (y - 2) * s, v = (x - 1) * s + (y - 2) * c; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    }
    near(u1 - u0, f.w, 1e-6, subtype + ' width'); near(v1 - v0, f.d, 1e-6, subtype + ' depth');
    near((u0 + u1) / 2, 0, 1e-6, subtype + ' centred'); near(y1 - y0, f.h, 1e-6, subtype + ' height');
  }
});

test('migration keeps good fixtures, repairs references and drops what cannot be one', () => {
  const p = kitchen();
  const data = { properties: [Object.assign(p, { fixtures: [...p.fixtures,
    { id: 'fx-bad-kind', kind: 'spaceship', level: p.levels[0].id },
    { id: 'fx-no-pts', kind: 'wall-run', level: p.levels[0].id, pts: [[0, 0]] },
    { id: 'bad id with spaces', kind: 'appliance', subtype: 'toaster', level: 'gone', x: '1.5', y: 2, provenance: { source: 'guess', confidence: 7 } },
  ] })], projects: [], materials: [{ id: 'mat-mine', name: 'Mine', custom: true, kind: 'any', color: '#123456' }], products: [] };
  data.properties[0].fixtures[1].material = 'mat-mine';
  store.replaceWorkspace(JSON.parse(JSON.stringify(data)));
  const got = store.ws.data.properties[0].fixtures;
  assert.deepEqual(got.map(f => f.kind), ['base-run', 'furniture', 'appliance']);
  const app = got[2];
  assert.match(app.id, /^fx-/, 'an id that does not look like one is regenerated');
  assert.equal(app.level, store.ws.data.properties[0].levels[0].id, 'a stale level falls to the lowest');
  assert.equal(app.subtype, 'toaster', 'an unknown subtype retains its identity');
  assert.equal(app.x, 1.5);
  assert.equal(app.provenance.source, 'unknown');
  assert.equal(app.provenance.confidence, null);
  assert.equal(app.provenance.rawSource, 'guess');
  assert.equal(app.provenance.rawConfidence, 7);
  assert.deepEqual(app.provenance.defaultedFields, ['w','d','h']);
  const slice = store.projectSlice('prop-k', store.ws.data);
  assert.ok(slice.materials.some(m => m.id === 'mat-mine'), 'a custom finish on a fixture travels with the project file');
});

test('fixture edits undo and redo with the plan, and a level holding fixtures is not deleted', () => {
  const p = kitchen(), h = new GeometryHistory();
  h.begin(p, 'add fixture');
  p.fixtures.push(Object.assign(fx.fixtureTemplate('appliance', 'fridge', { level: p.levels[0].id, x: 4, y: 0.4 }), { id: 'fx-fridge' }));
  h.commit(p);
  h.begin(p, 'edit fixture');
  p.fixtures.find(f => f.id === 'fx-bed').h = 0.65;
  h.commit(p);
  assert.ok(h.restore(p, 'undo'));
  assert.equal(p.fixtures.find(f => f.id === 'fx-bed').h, 0.59);
  assert.ok(h.restore(p, 'undo'));
  assert.ok(!p.fixtures.some(f => f.id === 'fx-fridge'));
  assert.ok(h.restore(p, 'redo') && h.restore(p, 'redo'));
  assert.equal(p.fixtures.find(f => f.id === 'fx-bed').h, 0.65);
  assert.ok(p.fixtures.some(f => f.id === 'fx-fridge'));
  const up = store.addLevel(p, { name: 'Upper', elevation: 3 });
  p.fixtures.push(Object.assign(fx.fixtureTemplate('furniture', 'desk', { level: up.id }), { id: 'fx-desk' }));
  assert.equal(store.deleteLevel(p, up.id), false, 'the desk keeps its level');
  p.fixtures = p.fixtures.filter(f => f.id !== 'fx-desk');
  assert.equal(store.deleteLevel(p, up.id), true);
});

test('two devices editing different fixtures combine; the same value on both is a conflict', () => {
  const base = kitchen(), desk = JSON.parse(JSON.stringify(base)), phone = JSON.parse(JSON.stringify(base));
  desk.fixtures[0].h = 0.92;
  phone.fixtures[1].w = 2.1;
  phone.fixtures.push(Object.assign(fx.fixtureTemplate('bath', 'tub', { level: base.levels[0].id }), { id: 'fx-tub' }));
  const ok = mergeShared(base, desk, phone);
  assert.deepEqual(ok.conflicts, []);
  assert.equal(ok.value.fixtures.find(f => f.id === 'fx-run').h, 0.92);
  assert.equal(ok.value.fixtures.find(f => f.id === 'fx-bed').w, 2.1);
  assert.ok(ok.value.fixtures.some(f => f.id === 'fx-tub'));
  const other = JSON.parse(JSON.stringify(base));
  other.fixtures[0].h = 0.86;
  assert.deepEqual(mergeShared(base, desk, other).conflicts, ['fixtures.fx-run.h']);
  const gone = JSON.parse(JSON.stringify(base));
  gone.fixtures = gone.fixtures.filter(f => f.id !== 'fx-run');
  assert.deepEqual(mergeShared(base, desk, gone).conflicts, ['fixtures.fx-run'], 'deleted on one device, edited on the other');
});

// The server's reading of an unedited .skp: now == base for every fixture.
const readOf = spec => ({ model: { propertyId: spec.property.id, elements: spec.elements }, walls: [],
  rooms: spec.rooms.map(r => ({ id: r.id, level: r.level, base: { pts: r.pts, name: r.name, elevation: r.elevation }, now: { pts: r.pts.map(q => [...q]), name: r.name, elevation: r.elevation } })),
  fixtures: spec.fixtures.map(f => ({ id: f.id, level: f.level, base: { ...f.base, elevation: f.elevation }, now: JSON.parse(JSON.stringify(f.base)) })),
  untagged: { faces: 0, groups: 0, instances: 0 }, warnings: [] });

test('the mirror spec carries one tagged group per fixture with framed parts and finishes', () => {
  const p = kitchen();
  const spec = mirrorSpec(p, [{ id: 'mat-quartz', name: 'Quartz countertop', color: '#EDE9E1' }, { id: 'mat-trim', name: 'Trim, painted semi-gloss', color: '#f4f2ec' }]);
  assert.deepEqual(spec.fixtures.map(f => f.id), ['fx-run', 'fx-bed']);
  assert.equal(spec.elements['fx-run'].kind, 'fixture');
  const run = spec.fixtures[0], bed = spec.fixtures[1];
  assert.deepEqual(run.origin, [3, 0.05]);
  near(run.angle, Math.PI, 1e-6, 'first segment runs west');
  assert.deepEqual(run.local.pts[0], [0, 0]);
  const top = run.parts.find(q => q.z1 === 0.91);
  assert.deepEqual(top.material, { id: 'mat-quartz', name: 'Quartz countertop', color: '#ede9e1' });
  assert.equal(run.parts.find(q => q.z0 === 0).material.name, 'Default toe kick');
  assert.equal(bed.shape, 'box'); near(bed.angle, Math.PI / 2, 1e-6, 'bed angle');
  assert.ok(bed.parts.every(q => q.pts.every(([u, v]) => Math.abs(u) <= 1.0 + 1e-9 && Math.abs(v) <= 0.785 + 1e-9)), 'parts in the bed frame');
  assert.deepEqual(spec.warnings.filter(w => /fixture/.test(w)), [], 'known and unset finishes do not warn');
  p.fixtures[1].material = 'mat-missing';
  assert.deepEqual(mirrorSpec(p, [{ id: 'mat-quartz', name: 'Q', color: '#ffffff' }, { id: 'mat-trim', name: 'T', color: '#ffffff' }]).warnings.filter(w => /fixture/.test(w)), ['material mat-missing on fixture fx-bed is not in the material library; painted Default upholstery']);
});

test('mirror read-back: moves apply, copies are new, deletes remove, two-sided edits are reported', () => {
  const p = kitchen(), synced = syncedState(p);
  const spec = mirrorSpec(p, []);
  assert.deepEqual(mergeMirror(p, readOf(spec), synced), { applied: [], added: [], deleted: [], conflicts: [], warnings: [], untagged: { faces: 0, groups: 0, instances: 0 }, seen: mergeMirror(kitchen(), readOf(spec), synced).seen });
  const moved = readOf(spec);
  const bed = moved.fixtures.find(f => f.id === 'fx-bed');
  Object.assign(bed.now, { x: 3.9, rot: 0, w: 2.2 });
  moved.fixtures.push(JSON.parse(JSON.stringify(moved.fixtures.find(f => f.id === 'fx-run'))));   // a copy keeps the dictionary
  moved.fixtures[moved.fixtures.length - 1].now.pts = moved.fixtures[0].now.pts.map(q => [q[0] + 1, q[1]]);
  let r = mergeMirror(p, moved, synced);
  assert.deepEqual(r.applied, ['fx-bed']);
  assert.equal(r.added.length, 1);
  const b = p.fixtures.find(f => f.id === 'fx-bed');
  assert.deepEqual([b.x, b.rot, b.w, b.d], [3.9, 0, 2.2, 1.57]);
  const copy = p.fixtures.find(f => f.id === r.added[0]);
  assert.match(copy.id, /^fx-/); assert.equal(copy.kind, 'base-run'); assert.equal(copy.pts[0][0], 4);
  // SketchUp deletes the run while Tiksi changed it: kept and reported.
  const q = kitchen(), qs = syncedState(q), qspec = mirrorSpec(q, []);
  q.fixtures[0].h = 0.95;
  const without = readOf(qspec); without.fixtures = without.fixtures.filter(f => f.id !== 'fx-run');
  r = mergeMirror(q, without, qs);
  assert.deepEqual(r.deleted, []); assert.equal(r.conflicts[0].id, 'fx-run');
  // Unchanged in Tiksi: the delete lands.
  const z = kitchen(), zs = syncedState(z), zread = readOf(mirrorSpec(z, []));
  zread.fixtures = zread.fixtures.filter(f => f.id !== 'fx-bed');
  assert.deepEqual(mergeMirror(z, zread, zs).deleted, ['fx-bed']);
  assert.deepEqual(z.fixtures.map(f => f.id), ['fx-run']);
});

test('the furniture tag hides loose furniture fixtures; built-ins sit on their own tag', async () => {
  const T = await import('../js/tags.js');
  const p = kitchen();
  T.normalizeTags(p);
  assert.ok(layers.layerHasMembers(p, 'furnishings'), 'a furniture fixture counts as furnishings for PLAN footprints');
  assert.equal(T.keyShown(p, 'fixture:fx-bed'), true);
  T.setTagShown(p, T.CANON.furniture.id, false);
  assert.equal(T.keyShown(p, 'fixture:fx-bed'), false, 'the bed hides');
  assert.equal(T.keyShown(p, 'fixture:fx-run'), true, 'the counter run is part of the building');
  const q = kitchen(); q.fixtures = q.fixtures.filter(f => f.kind !== 'furniture');
  assert.equal(layers.layerHasMembers(q, 'furnishings'), false);
});
