// Tape readings from video frames: parsing, attachment, applying through geometry history,
// the "ask the owner" list and asset references. Synthetic property only; no browser.
import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
const ms = await import('../js/measurements.js');
const { restoreGeometryEdit, editHistoryState } = await import('../js/edit-history.js');
const IN = 0.0254;

function kitchen() {
  const d = store.emptyWorkspace(), p = store.propertyTemplate('Synthetic kitchen'), L = p.levels[0].id;
  const wall = (id, ax, ay, bx, by) => ({ id, level: L, ax, ay, bx, by, thickness: 0.114, height: null, material: null });
  p.walls.push(wall('w-s', 0, 0, 4, 0), wall('w-e', 4, 0, 4, 3), wall('w-n', 4, 3, 0, 3), wall('w-w', 0, 3, 0, 0));
  p.rooms.push({ id: 'r-k', level: L, name: 'Kitchen', pts: [[0, 0], [4, 0], [4, 3], [0, 3]], material: null, ceilingMaterial: null });
  p.openings.push({ id: 'o-door', wallId: 'w-n', type: 'door', t: 0.5, width: 0.8, height: 2.03 });
  p.videos.push({ id: 'vid-walk', name: 'walkthrough.mov', mime: 'video/quicktime' });
  d.properties.push(p); d.settings.activePropertyId = p.id; d.settings.units = 'imperial';
  store.replaceWorkspace(d);
  return store.ws.data.properties[0];
}

test('readings parse tape notation; bare numbers are inches; stray text is refused', () => {
  kitchen();
  const near = (text, inches) => assert.ok(Math.abs(ms.parseReading(text) - inches * IN) < 1e-9, text);
  near('33 1/2', 33.5); near('33-1/2', 33.5); near('33 1/2"', 33.5); near('9½', 9.5); near("2'-9 1/2\"", 33.5); near('85 cm', 85 / 2.54); near('24', 24);
  for (const bad of ['', 'about 30', '30" maybe', '0', '1/0', 'n/a']) assert.ok(Number.isNaN(ms.parseReading(bad)), JSON.stringify(bad));
  assert.equal(ms.fmtReading(33.5 * IN), '33 1/2"'); assert.equal(ms.fmtReading(0.5 * IN), '1/2"');
  assert.equal(ms.fmtReading(36 * IN), '36"'); assert.equal(ms.fmtReading(130.25 * IN), "10'-10 1/4\"");
  store.ws.data.settings.units = 'metric';
  assert.ok(Math.abs(ms.parseReading('0.85') - 0.85) < 1e-12, 'metric bare numbers are metres, as everywhere');
  assert.equal(ms.fmtReading(0.851), '85.1 cm');
});

test('a reading attached to an opening applies through history; undo shows the model no longer matches', () => {
  const p = kitchen();
  const targets = ms.elementTargets(p);
  const door = targets.find(t => t.kind === 'opening' && t.dim === 'width');
  assert.match(door.label, /^Door 1 \(Kitchen\) on wall 3 · width$/);
  assert.ok(targets.some(t => t.kind === 'wall' && t.label === 'Wall 1 (Kitchen) · length'));
  const m = ms.addMeasurement(p, { videoId: 'vid-walk', seconds: 12.4, input: '33 1/2', text: 'pantry door leaf', direction: 'width', confidence: 'clear', element: door, frameAssetId: 'mf-1', crop: [0.2, 0.3, 0.4, 0.1] });
  assert.equal(m.status, 'assigned'); assert.ok(Math.abs(m.value - 33.5 * IN) < 1e-12); assert.deepEqual(m.crop, [0.2, 0.3, 0.4, 0.1]);
  assert.equal(ms.readingState(p, m), 'assigned');
  const result = ms.applyMeasurement(p, m.id);
  assert.equal(result.previous, 0.8); assert.ok(Math.abs(p.openings[0].width - 33.5 * IN) < 1e-12);
  assert.equal(ms.readingState(p, m), 'applied'); assert.equal(editHistoryState(p).undo.label, 'apply tape reading');
  assert.equal(restoreGeometryEdit(p, 'undo'), true);
  assert.equal(p.openings[0].width, 0.8, 'UNDO restores the previous width');
  assert.equal(ms.readingState(p, m), 'changed', 'the reading reports that the model no longer holds it');
  assert.equal(restoreGeometryEdit(p, 'redo'), true); assert.equal(ms.readingState(p, m), 'applied');
  ms.updateMeasurement(p, m.id, { input: '34' });
  assert.equal(m.status, 'assigned', 'a changed value is a new proposal'); assert.equal(m.applied, null);
});

test('wall length moves the far end like PLAN; impossible or unreadable readings are refused', () => {
  const p = kitchen();
  const south = { kind: 'wall', id: 'w-s', dim: 'length' };
  const m = ms.addMeasurement(p, { videoId: 'vid-walk', seconds: 3, input: "13'-6\"", text: 'run of base cabinets wall', confidence: 'clear', element: south });
  ms.applyMeasurement(p, m.id);
  const s = p.walls.find(w => w.id === 'w-s'), e = p.walls.find(w => w.id === 'w-e');
  assert.ok(Math.abs(s.bx - 13.5 * 12 * IN) < 1e-3); assert.equal(e.ax, s.bx, 'the joined wall follows the corner');
  const tooWide = ms.addMeasurement(p, { videoId: 'vid-walk', seconds: 4, input: "30'", text: 'door', confidence: 'clear', element: { kind: 'opening', id: 'o-door', dim: 'width' } });
  assert.throws(() => ms.applyMeasurement(p, tooWide.id), /wider than its wall/);
  const blurry = ms.addMeasurement(p, { videoId: 'vid-walk', seconds: 5, input: '30', text: 'door', confidence: 'unreadable', element: { kind: 'opening', id: 'o-door', dim: 'height' } });
  assert.throws(() => ms.applyMeasurement(p, blurry.id), /unreadable/);
  const loose = ms.addMeasurement(p, { videoId: 'vid-walk', seconds: 6, input: '24', text: 'sink base' });
  assert.throws(() => ms.applyMeasurement(p, loose.id), /Attach the reading/);
  assert.equal(p.openings[0].height, 2.03, 'refused readings leave the model unchanged');
  assert.equal(ms.addMeasurement(p, { input: '1', element: { kind: 'room', id: 'r-k', dim: 'width' } }).element, null, 'only openings and walls are targets');
});

test('the ask-the-owner list holds unassigned, unexplained, unreadable and orphaned readings', () => {
  const p = kitchen();
  const door = { kind: 'opening', id: 'o-door', dim: 'width' };
  const clear = ms.addMeasurement(p, { videoId: 'vid-walk', seconds: 1, input: '30', text: 'door leaf', confidence: 'clear', element: door });
  const note = ms.addMeasurement(p, { videoId: 'vid-walk', seconds: 2, input: '24', text: 'counter depth', confidence: 'clear', noteOnly: true });
  const what = ms.addMeasurement(p, { videoId: 'vid-walk', seconds: 9, input: '36', text: 'cabinet?', confidence: 'probable' });
  const blank = ms.addMeasurement(p, { videoId: 'vid-walk', seconds: 7, input: '15 3/4', confidence: 'clear', noteOnly: true });
  const blur = ms.addMeasurement(p, { videoId: 'vid-walk', seconds: 8, input: '', text: 'range width', confidence: 'unreadable', noteOnly: true });
  assert.equal(note.status, 'assigned'); assert.equal(note.element, null);
  assert.deepEqual(ms.askOwnerList(p).map(m => m.id), [blank.id, blur.id, what.id], 'sorted by time; clear and note-only readings are settled');
  const text = ms.askOwnerText(p);
  assert.match(text, /^1\. walkthrough\.mov at 0:07\.0: 15 3\/4" - what was measured\?/);
  assert.match(text, /2\. walkthrough\.mov at 0:08\.0: no value - range width - numbers not readable/);
  assert.match(text, /3\. .*36" - cabinet\? - which element is this\?/);
  p.openings = []; assert.equal(ms.readingState(p, clear), 'missing'); assert.ok(ms.askOwnerList(p).includes(clear));
  ms.updateMeasurement(p, what.id, { element: { kind: 'wall', id: 'w-e', dim: 'length' } });
  assert.ok(!ms.askOwnerList(p).includes(what), 'answering the question removes it from the list');
});

test('videos and saved frames are project files; damaged records are normalised on load', () => {
  const p = kitchen();
  ms.addMeasurement(p, { videoId: 'vid-walk', seconds: 1, input: '30', frameAssetId: 'mf-saved' });
  ms.addMeasurement(p, { videoId: 'vid-walk', seconds: 2, input: '31' });
  const ids = store.listAllFileIds();
  assert.ok(ids.includes('vid-walk') && ids.includes('mf-saved')); assert.equal(ids.filter(id => id.startsWith('mf-')).length, 1);
  const d = JSON.parse(JSON.stringify(store.ws.data));
  d.properties[0].measurements.push({ id: 'ms-junk', seconds: 'x', value: 'big', element: { kind: 'room', id: 1 }, status: 'odd', confidence: 'sure', crop: [1, 2] });
  d.properties[0].videos.push({ id: 'vid-junk', analysis: [1, 2], thumb: 'javascript:alert(1)' });
  store.replaceWorkspace(d);
  const junk = store.ws.data.properties[0].measurements.find(m => m.id === 'ms-junk'), vid = store.ws.data.properties[0].videos.find(v => v.id === 'vid-junk');
  assert.deepEqual([junk.seconds, junk.value, junk.element, junk.status, junk.confidence, junk.crop, junk.text], [0, null, null, 'unassigned', 'probable', null, '']);
  assert.deepEqual([vid.analysis, vid.thumb, vid.name], [null, '', 'Video']);
  assert.throws(() => store.replaceWorkspace({ properties: [{ id: 'p', measurements: {} }] }), /measurements must be a list/);
});
