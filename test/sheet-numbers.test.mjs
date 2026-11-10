// Printed sheets: lengths to the sixteenth, door pairs, text that does not fit says so, wall
// centre-line labels, and links and pictures from an imported file stay safe. Synthetic data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// sheet-render.js imports three by its browser import-map names.
const vendor = new URL('../vendor/', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'three') return { url: vendor + 'three.module.min.js', shortCircuit: true };
    if (spec.startsWith('three/addons/')) return { url: vendor + 'addons/' + spec.slice(13), shortCircuit: true };
    return next(spec, ctx);
  },
});
globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
globalThis.location ||= { hash: '' };
const store = await import('../js/store.js');
const ds = await import('../js/doc-sets.js');
const compose = await import('../js/sheet-compose.js');
const render = await import('../js/sheet-render.js');
const cut = await import('../js/cutsheets.js');
const IN = 0.0254;
// A length as it appears in markup: quote marks may be written as entities.
const printed = text => new RegExp('>' + text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/'/g, "(?:'|&#39;)").replace(/"/g, '(?:"|&quot;)') + '<');

function house() {
  const d = store.emptyWorkspace(), p = store.propertyTemplate('Synthetic house'), L = p.levels[0].id;
  const wall = (id, ax, ay, bx, by) => ({ id, level: L, ax, ay, bx, by, thickness: 0.114, height: null, material: null });
  // A south wall 12'-6 1/2" long on its centre line.
  const len = (150.5) * IN;
  p.walls.push(wall('w-s', 0, 0, len, 0), wall('w-e', len, 0, len, 3), wall('w-n', len, 3, 0, 3), wall('w-w', 0, 3, 0, 0));
  p.rooms.push({ id: 'r-1', level: L, name: 'Den', pts: [[0, 0], [len, 0], [len, 3], [0, 3]], material: null, ceilingMaterial: null });
  p.openings.push({ id: 'o-pair', wallId: 'w-n', type: 'door', t: 0.5, width: 60 * IN, height: 80 * IN, leaves: 2 },
    { id: 'o-one', wallId: 'w-s', type: 'door', t: 0.3, width: 33.5 * IN, height: 80 * IN });
  d.properties.push(p); d.settings.activePropertyId = p.id; d.settings.units = 'imperial';
  store.replaceWorkspace(d);
  return store.ws.data.properties[0];
}
const planView = p => ds.newViewport('plan', { x: 1, y: 1, w: 8, h: 6 }, { levelId: p.levels[0].id, center: [2, 1.5], scale: 48 });

test('drawing sheets print lengths to the sixteenth of an inch', () => {
  const p = house();
  const svg = render.planVectorSvg(p, planView(p));
  assert.match(svg, printed("12'-6 1/2\""), 'the wall dimension reads 12\'-6 1/2", not 12\'-7"');
  const set = ds.newSet('Set'), sched = ds.newViewport('schedule', { x: 1, y: 1, w: 8, h: 4 }, { source: 'openings' });
  set.sheets[0].viewports.push(sched);
  const sheet = compose.sheetSvg(p, set, set.sheets[0], new Map(), { index: 0, count: 1 });
  assert.match(sheet, printed("2'-9 1/2\""), 'the opening schedule prints the 33 1/2" door as 2\'-9 1/2"');
});

test('a door with two leaves prints as a pair on the sheet, a single door as one leaf', () => {
  const p = house();
  const svg = render.planVectorSvg(p, planView(p));
  const swings = (svg.match(/stroke-dasharray="2 1.5"/g) || []).length;
  assert.equal(swings, 3, 'two swing arcs for the pair and one for the single door');
  p.openings[0].leaves = 1;
  assert.equal((render.planVectorSvg(p, planView(p)).match(/stroke-dasharray="2 1.5"/g) || []).length, 2, 'set back to one leaf, the pair door draws one swing');
});

test('text that does not fit its box or the title block says how much is left out', () => {
  house();
  const short = ds.newViewport('text', { x: 1, y: 1, w: 3, h: 0.6 }, { text: Array.from({ length: 12 }, (_, i) => 'Line ' + (i + 1)).join('\n') });
  const svg = compose.textSvg(short);
  const fits = Math.floor((0.6 * 72 - short.fontSize) / (short.fontSize * 1.3)) + 1;
  assert.match(svg, new RegExp('>' + (12 - fits + 1) + ' more lines: make this view taller<'));
  assert.ok(!/more line/.test(compose.textSvg(ds.newViewport('text', { x: 1, y: 1, w: 3, h: 3 }, { text: 'Fits' }))), 'text that fits has no note');
  const p = store.activeProperty();
  const set = ds.newSet('Set');
  set.titleBlock.notes = Array.from({ length: 10 }, (_, i) => 'Note number ' + (i + 1) + ' about the work').join('\n');
  const sheet = compose.sheetSvg(p, set, set.sheets[0], new Map(), { index: 0, count: 1 });
  assert.match(sheet, />7 more lines not shown: shorten this</, 'ten lines of notes show three and say seven are left out');
});

test('plans, room schedules and cut sheets say their lengths and areas are on wall centre lines', () => {
  const p = house();
  const set = ds.newSet('Set');
  const plan = planView(p), rooms = ds.newViewport('schedule', { x: 1, y: 8, w: 6, h: 2 }, { source: 'rooms' });
  set.sheets[0].viewports.push(plan, rooms);
  const sheet = compose.sheetSvg(p, set, set.sheets[0], new Map(), { index: 0, count: 1 });
  assert.match(sheet, />DIMENSIONS AND AREAS TO WALL CENTRE LINES</);
  assert.match(sheet, />AREA TO WALL CL</);
  store.ws.data.projects.push({ id: 'pr', name: 'Den', propertyId: p.id, category: 'interior', status: 'idea', selected: true, items: [{ id: 'it', name: 'Paint', qty: 1, unit: 'ls', low: 0, likely: 0, high: 0, durationDays: 0, deps: [], elementIds: ['w-s', 'r-1'], notes: '', status: 'todo' }] });
  const html = cut.itemSheetHtml(store.ws.data.projects[0], store.ws.data.projects[0].items[0]);
  assert.match(html, /Length \(wall CL\)/);
  assert.match(html, printed("12'-6 1/2\""), 'the cut sheet prints the wall to the sixteenth');
  assert.match(html, /measured on wall centre lines/);
});

test('a vendor link or a picture from an imported file cannot run script', () => {
  const p = house();
  const bad = cut.productSheetHtml({ id: 'x', name: 'Tap', brand: '', model: '', category: 'plumbing', url: 'javascript:alert(1)', specs: '', price: 0 });
  assert.ok(!/href="javascript:/i.test(bad) && /javascript:alert\(1\)/.test(bad), 'a javascript: vendor link is printed as text, not a link');
  const good = cut.productSheetHtml({ id: 'y', name: 'Tap', brand: '', model: '', category: 'plumbing', url: 'https://example.com/tap?a=1&b=2', specs: '', price: 0 });
  assert.match(good, /<a href="https:\/\/example.com\/tap\?a=1&amp;b=2"/);
  assert.equal(compose.safeImageHref('javascript:alert(1)'), '');
  assert.equal(compose.safeImageHref('data:text/html,<script>'), '');
  assert.equal(compose.safeImageHref('data:image/jpeg;base64,AAAA'), 'data:image/jpeg;base64,AAAA');
  const set = ds.newSet('Set'), pic = ds.newViewport('image', { x: 1, y: 1, w: 3, h: 2 }, {});
  set.sheets[0].viewports.push(pic);
  const sheet = compose.sheetSvg(p, set, set.sheets[0], new Map([[pic.id, { href: 'data:image/png;base64,AA"/><script>alert(1)</script>' }]]), { index: 0, count: 1 });
  assert.ok(!/<script>/.test(sheet) && /href="data:image\/png;base64,AA&quot;\/&gt;/.test(sheet), 'a picture address is escaped inside the sheet');
});
