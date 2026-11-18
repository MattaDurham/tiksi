// A project's estimate (js/estimate.js): drawn trim joins the scope items, items it already covers
// drop out, markups land on each subproject's share, every page's totals and schedule follow, and
// the bid documents (js/bid-documents.js) and deep dive file (js/estimate-export.js) say the same.
// A synthetic study, synthetic projects; no owner data.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
const T = await import('../js/trims.js');
const D = await import('../js/trim-design.js');
const est = await import('../js/estimate.js');
const docs = await import('../js/bid-documents.js');
const exp = await import('../js/estimate-export.js');
const { programSchedule, programTotals } = await import('../js/program.js');

const near = (a, b, what, tol = 0.005) => assert.ok(Math.abs(a - b) < tol, `${what}: ${a} is not ${b}`);

// A 4 x 3 m study with a door, baseboard all round in the study's subproject, and a second
// project with nothing drawn.
function setup() {
  store.ws.data = store.emptyWorkspace();
  const wall = (id, ax, ay, bx, by) => ({ id, level: 'l1', ax, ay, bx, by, thickness: 0.1, height: 2.4 });
  const prop = {
    id: 'prop-test', name: 'Test house', levels: [{ id: 'l1', name: 'Main', elevation: 0, height: 2.4 }], activeLevelId: 'l1',
    walls: [wall('s', 0, 0, 4, 0), wall('e', 4, 0, 4, 3), wall('n', 4, 3, 0, 3), wall('w', 0, 3, 0, 0)],
    rooms: [{ id: 'room-study', level: 'l1', name: 'Study', pts: [[0, 0], [4, 0], [4, 3], [0, 3]] }],
    openings: [{ id: 'door', wallId: 'e', type: 'door', t: 0.5, width: 0.8, height: 2.03 }],
    trims: [], photos: [], scans: [],
  };
  const projects = [
    { id: 'p-trim', name: 'Trim', propertyId: prop.id, category: 'interior', status: 'scoped', selected: true, items: [
      { id: 'it-paint', name: 'Paint the study', qty: 1, unit: 'ls', low: 400, likely: 500, high: 650, durationDays: 2, deps: [], elementIds: [] }] },
    { id: 'p-study', name: 'Study', propertyId: prop.id, parentId: 'p-trim', roomId: 'room-study', category: 'interior', status: 'scoped', selected: true, items: [] },
    { id: 'p-other', name: 'Roof', propertyId: prop.id, category: 'exterior', status: 'idea', selected: true, items: [
      { id: 'it-roof', name: 'Patch roof', qty: 2, unit: 'ea', low: 100, likely: 150, high: 200, durationDays: 1, deps: [] }] },
  ];
  store.ws.data.properties.push(prop); store.ws.data.settings.activePropertyId = prop.id;
  store.ws.data.projects.push(...projects);
  const env = { prop, projects, levelOf: () => 'l1', wallsOn: () => prop.walls, roomsOn: () => prop.rooms, openingsOn: () => prop.openings, heightOf: w => w.height };
  const d0 = D.trimDesign(env);
  let n = 0;
  for (const w of prop.walls) {
    const side = [1, -1].find(s => (d0.info({ id: 'probe', wallId: w.id, side: s, f0: 0, f1: 1, style: 'baseboard' }) || {}).roomId === 'room-study');
    const t = T.trimTemplate('baseboard', null, w, side, { wallHeight: 2.4 });
    t.id = 'b' + (++n); t.projectId = 'p-study'; t.product = 'lowes-163e12fbdpm';
    prop.trims.push(t);
  }
  // An older package wrote the study's boards as an item listing the drawn sections: covered now.
  store.ws.data.projects[1].items.push({ id: 'it-boards', name: 'Base boards (old package)', qty: 3, unit: 'ea', low: 30.84, likely: 30.84, high: 30.84, durationDays: 0, deps: [], elementIds: ['b1', 'b2', 'b3', 'b4'] });
  store.touch();
  est.useEstimateRules();
  return { prop, root: store.projectById('p-trim'), sub: store.projectById('p-study'), other: store.projectById('p-other') };
}

test('the drawn trim joins the scope items, and an item that lists only drawn sections is counted once', () => {
  const { root } = setup();
  const e = est.projectEstimate(root);
  assert.ok(e.trim && !e.trim.error, 'the study trim is worked out');
  assert.equal(e.trim.rooms.length, 1);
  assert.equal(e.trim.rooms[0].name, 'Study');
  assert.ok(e.trim.pieces.length >= 4, 'pieces on four walls');
  assert.deepEqual(e.covered.map(c => c.item.id), ['it-boards']);
  near(e.items.likely, 500, 'only the paint item is a scope item in the total');
  const r = e.trim.rooms[0];
  near(e.trimCost.likely, r.mat + r.supplies + r.hours * 85, 'trim = boards + supplies + hours at $85');
  near(e.total.likely, 500 + e.trimCost.likely, 'no markups by default');
  assert.ok(e.total.low < e.total.likely && e.total.likely < e.total.high, 'a range from item ranges and the rates\' low and high hours');
  assert.ok(e.days >= 1);
});

test('markups: contingency, overhead and profit compound in that order; tax is on the materials bought', () => {
  const { root } = setup();
  for (const [k, v] of [['contingency', 0.1], ['overhead', 0.1], ['profit', 0.1], ['taxRate', 0.08]]) assert.ok(est.setEstimateSetting(root, k, v));
  store.touch();
  const e = est.projectEstimate(root);
  const sub = e.subtotal.likely, mat = e.materials;
  near(e.total.likely, sub * 1.1 * 1.1 * 1.1 + mat * 0.08, 'the total');
  near(e.tax, mat * 0.08, 'tax on boards and supplies');
  // Setting a value back to its default stores nothing.
  for (const k of ['contingency', 'overhead', 'profit', 'taxRate']) est.setEstimateSetting(root, k, 0);
  assert.equal(root.estimate, undefined);
  assert.equal(est.setEstimateSetting(root, 'nonsense', 1), false);
  est.setEstimateSetting(root, 'contingency', 5);
  assert.equal(est.estimateSettings(root).contingency, 1, 'a setting is kept within its limits');
});

test('each subproject carries its own share; every page reads the same totals through the project rules', () => {
  const { root, sub, other } = setup();
  est.setEstimateSetting(root, 'contingency', 0.1); store.touch();
  const e = est.projectEstimate(root);
  const shares = [...e.parts.values()].reduce((n, p) => n + p.total.likely, 0);
  near(shares, e.total.likely, 'the shares add up to the whole');
  near(store.projectTotals(sub).likely, e.parts.get('p-study').total.likely, 'PROJECTS and the program see the study\'s share');
  near(store.projectTotals(root).likely, 500 * 1.1, 'the parent keeps its own items, with its markup');
  near(store.projectTotals(other).likely, 300, 'a project with no drawn trim and no settings is its items\' sum');
  near(programTotals([root, sub, other]).likely, e.total.likely + 300, 'the program total');
});

test('the schedule gets an install item for the drawn trim, in working days, and drops the covered item', () => {
  const { sub } = setup();
  const work = store.projectWork(sub);
  assert.ok(!work.some(i => i.id === 'it-boards'), 'the covered item is not scheduled');
  const install = work.find(i => i.estimate);
  assert.ok(install && install.durationDays >= 1 && /Install trim \(Study\)/.test(install.name));
  const plan = programSchedule([sub], '2026-11-02');
  assert.equal(plan.plans.length, 1);
  assert.equal(plan.days, install.durationDays);
});

test('the estimate follows the drawing: a section taken out changes it at once', () => {
  const { prop, root } = setup();
  const before = est.projectEstimate(root);
  prop.trims = prop.trims.filter(t => t.id !== 'b1'); store.touch();
  const after = est.projectEstimate(root);
  assert.ok(after.trim.pieces.length < before.trim.pieces.length);
  assert.ok(after.trimCost.likely < before.trimCost.likely);
  assert.deepEqual(after.covered, [], 'the old item lists a section no longer drawn, so it counts again');
});

const ctx = (root, extra = {}) => ({ est: est.projectEstimate(root), prop: store.activeProperty(), len: m => store.fmtLen(m), money: v => store.fmtMoney(v),
  date: '2026-11-17', propertyName: 'Test house', business: { name: 'Synthetic Carpentry' }, clientName: 'A. Client', ...extra });

test('every bid document is written from the estimate and says the same price', () => {
  const { root } = setup();
  const e = est.projectEstimate(root);
  const price = store.fmtMoney(Math.round(e.total.likely));
  for (const d of docs.DOCS) {
    const html = docs.documentHtml(d.id, ctx(root));
    assert.match(html, new RegExp(`data-doc="${d.id}"`), d.id);
    assert.match(html, /Synthetic Carpentry/, d.id + ' names the business');
  }
  assert.ok(docs.documentHtml('proposal', ctx(root)).includes(price), 'the proposal');
  assert.ok(docs.documentHtml('contract', ctx(root)).includes(price), 'the contract');
  const pay = docs.documentHtml('proposal', ctx(root, { terms: { ...docs.TERMS_DEFAULTS, deposit: 0.5, progress: 0.25, final: 0.1 } }));
  assert.match(pay, /add up to 85% of the price/, 'payments that do not add up are flagged');
  const bid = docs.documentHtml('bidform', ctx(root));
  assert.match(bid, /Set up and protect the room/, 'the bid form lists the labor tasks');
  assert.ok(!/Our hours/.test(bid) && /Our hours/.test(docs.documentHtml('bidform', ctx(root, { showOurHours: true }))), 'our hours only on request');
  const cut = docs.documentHtml('cutlist', ctx(root));
  for (const g of e.trim.groups) assert.ok(cut.includes(g.mark), 'the cut list has ' + g.mark);
  assert.match(docs.documentHtml('buylist', ctx(root)), /Colonial base/);
  assert.match(docs.documentHtml('scope', ctx(root)), /Baseboard: Colonial base 5-1\/4 in, on 4 walls/);
});

test('working days skip weekends', () => {
  assert.equal(docs.workingFinish('2026-11-20', 1), '2026-11-20');   // a Friday
  assert.equal(docs.workingFinish('2026-11-20', 2), '2026-11-23');
  assert.equal(docs.workingFinish('2026-11-21', 1), '2026-11-23');   // a Saturday start begins Monday
  assert.equal(docs.workingFinish('', 3), '');
});

test('the deep dive file opens a detail for everything it lets you click', async () => {
  const { root } = setup();
  const html = await exp.estimateDeepDiveHtml(root, { drawingsCss: '' });
  const details = JSON.parse(/window\.DETAILS=(.*?);window\.FIND=/s.exec(html)[1]);
  const keys = new Set([...html.matchAll(/data-d="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&')));
  const missing = [...keys].filter(k => !details[k]);
  assert.deepEqual(missing, [], 'every clickable thing has its detail');
  assert.ok(Object.keys(details).some(k => k.startsWith('piece:')) && Object.keys(details).some(k => k.startsWith('stick:')));
  assert.match(html, /<title>Trim estimate<\/title>/);
  assert.ok(!/<script[^>]+src=/.test(html), 'one file: nothing loaded from elsewhere');
});
