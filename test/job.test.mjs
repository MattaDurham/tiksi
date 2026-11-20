// A job (js/job.js): drawn trim and scope items room by room, items the drawing already prices
// counted once, markups, a working-day schedule with one carpenter doing the rooms in order, and
// every page's totals and days through store.js's project rules. Synthetic house, no owner data.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
const T = await import('../js/trims.js');
const D = await import('../js/trim-design.js');
const J = await import('../js/job.js');
const P = await import('../js/program.js');
const docs = await import('../js/job-documents.js');

const near = (a, b, what, tol = 0.005) => assert.ok(Math.abs(a - b) < tol, `${what}: ${a} is not ${b}`);

// Two rooms side by side (a 4 x 3 m study and a 3 x 3 m den, a door into the study), baseboard
// round both, each in its own subproject; and a painting project with no drawn trim.
function setup() {
  store.ws.data = store.emptyWorkspace();
  const wall = (id, ax, ay, bx, by) => ({ id, level: 'l1', ax, ay, bx, by, thickness: 0.1, height: 2.4 });
  const prop = {
    id: 'prop-test', name: 'Test house', levels: [{ id: 'l1', name: 'Main', elevation: 0, height: 2.4 }], activeLevelId: 'l1',
    walls: [wall('s', 0, 0, 4, 0), wall('e', 4, 0, 4, 3), wall('n', 4, 3, 0, 3), wall('w', 0, 3, 0, 0),
      wall('s2', 4, 0, 7, 0), wall('e2', 7, 0, 7, 3), wall('n2', 7, 3, 4, 3)],
    rooms: [{ id: 'room-study', level: 'l1', name: 'Study', pts: [[0, 0], [4, 0], [4, 3], [0, 3]] },
      { id: 'room-den', level: 'l1', name: 'Den', pts: [[4, 0], [7, 0], [7, 3], [4, 3]] }],
    openings: [{ id: 'door', wallId: 'w', type: 'door', t: 0.5, width: 0.8, height: 2.03 }],
    trims: [], photos: [], scans: [],
  };
  const projects = [
    { id: 'p-trim', name: 'Trim', propertyId: prop.id, selected: true, items: [
      { id: 'it-plan', name: 'Measure and order', qty: 1, unit: 'ls', low: 150, likely: 200, high: 250, durationDays: 1, deps: [], elementIds: [] }] },
    { id: 'p-study', name: 'Study', propertyId: prop.id, parentId: 'p-trim', roomId: 'room-study', selected: true, items: [] },
    { id: 'p-den', name: 'Den', propertyId: prop.id, parentId: 'p-trim', roomId: 'room-den', selected: true, items: [] },
    { id: 'p-paint', name: 'Paint', propertyId: prop.id, selected: true, items: [
      { id: 'it-paint', name: 'Paint walls', qty: 2, unit: 'ea', low: 100, likely: 150, high: 200, durationDays: 3, deps: [] }] },
  ];
  store.ws.data.properties.push(prop); store.ws.data.settings.activePropertyId = prop.id;
  store.ws.data.projects.push(...projects);
  const env = { prop, projects, levelOf: () => 'l1', wallsOn: () => prop.walls, roomsOn: () => prop.rooms, openingsOn: () => prop.openings, heightOf: w => w.height };
  const d0 = D.trimDesign(env);
  let n = 0;
  for (const [room, sub] of [['room-study', 'p-study'], ['room-den', 'p-den']]) for (const w of prop.walls) {
    const side = [1, -1].find(x => (d0.info({ id: 'probe', wallId: w.id, side: x, f0: 0, f1: 1, style: 'baseboard' }) || {}).roomId === room);
    if (!side) continue;
    const t = T.trimTemplate('baseboard', null, w, side, { wallHeight: 2.4 });
    t.id = 'b' + (++n); t.projectId = sub; t.product = 'lowes-163e12fbdpm';
    prop.trims.push(t);
  }
  // An earlier trim package wrote the study's boards in as an item listing its sections.
  const studyIds = prop.trims.filter(t => t.projectId === 'p-study').map(t => t.id);
  store.ws.data.projects[1].items.push({ id: 'it-boards', name: 'Base boards (old package)', qty: 3, unit: 'ea', low: 30, likely: 30, high: 30, durationDays: 0, deps: [], elementIds: studyIds });
  store.touch();
  J.useJobRules();
  return { prop, root: store.projectById('p-trim'), study: store.projectById('p-study'), den: store.projectById('p-den'), paint: store.projectById('p-paint') };
}

test('a job is its rooms: each subproject\'s drawn trim with its boards, supplies and hours', () => {
  const { root } = setup();
  const j = J.jobOf(root);
  assert.deepEqual(j.rooms.map(r => r.name), ['Study', 'Den']);
  for (const r of j.rooms) {
    assert.equal(r.trim.length, 1, r.name + ' has its drawn trim');
    assert.ok(r.pieces > 0 && r.boards > 0 && r.supplies > 0 && r.hours.likely > 0 && r.days >= 1, r.name + ' is worked out');
    near(r.cost.likely, r.boards + r.supplies + r.hours.likely * 85, r.name + ': boards + supplies + hours at $85');
    assert.ok(r.cost.low < r.cost.likely && r.cost.likely < r.cost.high, 'hours range from the rates\' low and high');
  }
  assert.deepEqual(j.covered.map(c => c.item.id), ['it-boards'], 'the old boards item is counted by the drawing');
  near(j.other.itemCost.likely, 200, 'the project\'s own item');
  near(j.price.likely, j.rooms.reduce((n, r) => n + r.cost.likely, 0) + 200, 'no markups by default');
});

test('markups: contingency on the cost, overhead and profit on that, tax on materials only', () => {
  const { root } = setup();
  for (const [k, v] of [['contingency', 0.1], ['markup', 0.2], ['taxRate', 0.08]]) assert.ok(J.setJobSetting(root, k, v));
  store.touch();
  const j = J.jobOf(root);
  near(j.price.likely, j.cost.likely * 1.1 * 1.2 + j.materials * 0.08, 'the price');
  near(j.tax, j.materials * 0.08, 'tax on boards and supplies');
  for (const k of ['contingency', 'markup', 'taxRate']) J.setJobSetting(root, k, 0);
  assert.equal(root.job, undefined, 'defaults are not stored');
  assert.equal(J.setJobSetting(root, 'nonsense', 1), false);
  assert.equal(J.setJobSetting(root, 'markup', ''), false, 'a blank is not a number');
});

test('every page reads the same money: a subproject is its room, the shares add up', () => {
  const { root, study, den, paint } = setup();
  J.setJobSetting(root, 'markup', 0.15); store.touch();
  const j = J.jobOf(root);
  near(store.projectTotals(study).likely, j.rooms[0].price.likely, 'the study');
  near(store.projectTotals(den).likely, j.rooms[1].price.likely, 'the den');
  near(store.projectTotals(root).likely, j.other.price.likely, 'the project itself: its own item');
  near(store.projectTotals(study).likely + store.projectTotals(den).likely + store.projectTotals(root).likely, j.price.likely, 'shares add to the job');
  near(store.projectTotals(paint).likely, 300, 'a project with no drawing and no settings is its items');
  near(P.programTotals([root, study, den, paint]).likely, j.price.likely + 300, 'the program');
});

test('the schedule: one carpenter does the rooms one after another, in subproject order; items wait only for what they are set after', () => {
  const { root, den } = setup();
  const j = J.jobOf(root), s = j.schedule;
  const study = s.rows.find(r => r.id === 'trim:p-study'), denRow = s.rows.find(r => r.id === 'trim:p-den');
  assert.equal(s.sched[study.id].es, 0);
  assert.equal(s.sched[denRow.id].es, s.sched[study.id].ef, 'the den starts when the study ends');
  assert.equal(s.sched['it-plan'].es, 0, 'an item with nothing to wait for starts with the job');
  assert.ok(!s.rows.some(r => r.id === 'it-boards'), 'the covered item is not scheduled');
  // Moving the den first in the list moves it first on the schedule.
  const list = store.ws.data.projects, a = list.indexOf(store.projectById('p-study')), b = list.indexOf(den);
  [list[a], list[b]] = [list[b], list[a]]; store.touch();
  const s2 = J.jobOf(root).schedule;
  assert.equal(s2.sched['trim:p-den'].es, 0, 'the den now goes first');
  // An item set after the trim waits for that room.
  root.items[0].deps = ['trim:p-study']; store.touch();
  const s3 = J.jobOf(root).schedule;
  assert.equal(s3.sched['it-plan'].es, s3.sched['trim:p-study'].ef);
  // The trim can wait for an item.
  root.items[0].deps = []; root.job = { trimAfter: 'it-plan' }; store.touch();
  const s4 = J.jobOf(root).schedule;
  assert.equal(s4.sched['trim:p-den'].es, 1, 'the first room waits for the one-day item');
});

test('working days: Monday to Friday', () => {
  assert.equal(P.workday('2026-12-04', 0), '2026-12-04');   // a Friday
  assert.equal(P.workday('2026-12-04', 1), '2026-12-07');   // the Monday after
  assert.equal(P.workday('2026-12-05', 0), '2026-12-07');   // a Saturday start begins Monday
  assert.equal(P.workday('2026-12-07', 9), '2026-12-18');
  assert.equal(P.workdaysBetween('2026-12-07', '2026-12-14'), 5);
  assert.equal(P.workdaysBetween('2026-12-07', '2026-12-12'), 5, 'a Saturday start counts from the Monday after');
  assert.equal(P.lastWorkDay('2026-12-07', 6), '2026-12-14');
});

test('the program: a job is laid out as one; a project set to follow another starts when it ends', () => {
  const { root, study, den, paint } = setup();
  const all = [root, study, den, paint];
  const plan = P.programSchedule(all, '2026-12-07');
  const job = plan.plans.find(x => x.p.id === 'p-trim'), p2 = plan.plans.find(x => x.p.id === 'p-paint');
  assert.equal(plan.plans.length, 2, 'the subprojects are part of their job, not plans of their own');
  assert.equal(job.end, J.jobOf(root).schedule.days);
  assert.equal(p2.offset, 0, 'side by side by default');
  paint.after = 'p-trim';
  const plan2 = P.programSchedule(all, '2026-12-07');
  const p3 = plan2.plans.find(x => x.p.id === 'p-paint');
  assert.equal(p3.offset, job.end, 'painting starts when the trim ends');
  assert.equal(plan2.days, job.end + 3);
  assert.equal(plan2.lastDay, P.lastWorkDay('2026-12-07', plan2.days));
});

test('the proposal carries the job\'s price and dates, and leaves unpriced lines off', () => {
  const { root } = setup();
  root.startDate = '2026-12-07';
  store.ws.data.settings.business = { name: 'Synthetic Builders' };
  root.proposal = { client: 'A. Client', deposit: 0.25 };
  const j = J.jobOf(root);
  const { html } = docs.proposalHtml(j, store.activeProperty());
  const price = store.fmtMoney(Math.round(j.price.likely));
  assert.ok(html.includes(price), 'the price');
  assert.ok(html.includes('Synthetic Builders') && html.includes('A. Client'));
  assert.ok(html.includes(store.fmtDate(P.workday('2026-12-07', j.schedule.days - 1))), 'the last working day');
  assert.ok(html.includes(store.fmtMoney(Math.round(Math.round(j.price.likely) * 0.25))), 'the deposit');
  assert.ok(!/Base boards \(old package\)/.test(html), 'the covered item is not on it');
});

test('the trim package is priced with the job\'s contingency', () => {
  const { root } = setup();
  J.setJobSetting(root, 'contingency', 0.1); store.touch();
  const book = J.trimForBook(root), j = J.jobOf(root);
  // The book prices the engine's exact hours; the estimate quotes each room's hours to a tenth, so
  // they differ by at most half a tenth of an hour a room at the rate, with contingency.
  const slack = j.rooms.length * 0.05 * j.settings.laborRate * 1.1 + 1e-6;
  const est = j.rooms.reduce((n, r) => n + r.cost.likely, 0) * 1.1;
  assert.ok(Math.abs(book.totals.total - est) <= slack, `the book's total ${book.totals.total} is the trim cost with contingency ${est}, but for the hours' rounding`);
});

test('hours are quoted to a tenth, labor is those hours at the rate, and the discount comes off the labor', () => {
  const { root } = setup();
  J.setJobSetting(root, 'taxRate', 0.08); J.setJobSetting(root, 'discount', 0.5); store.touch();
  const j = J.jobOf(root);
  for (const r of j.rooms) {
    near(r.hours.likely * 10, Math.round(r.hours.likely * 10), 'a room\'s hours are a whole number of tenths');
    near(r.labor.likely, r.hours.likely * j.settings.laborRate, 'labor is the quoted hours at the rate');
  }
  const before = j.materials + j.labor.likely + j.itemCost.likely;
  near(j.discount.likely, j.labor.likely * 0.5, 'the discount is half of the labor, and nothing else');
  near(j.tax, j.materials * 0.08, 'tax is on the materials as bought');
  near(j.price.likely, before - j.discount.likely + j.tax, 'the total is what is left, plus tax');
  assert.equal(J.setJobSetting(root, 'discount', 'x'), false, 'a discount that is not a number is refused');
});

test('a room\'s typed quantity or time replaces the count or the published time, and resets', () => {
  const { root } = setup();
  const j0 = J.jobOf(root), study = j0.rooms[0], base = study.trim[0].labor.find(l => l.task === 'base');
  assert.ok(base && !base.qtySet && base.eachSet === '', 'counted from the drawing at the published time');
  assert.ok(J.setRoomLabor(root, study.key, 'qty', 'base', 100)); store.touch();
  let l = J.jobOf(root).rooms[0].trim[0].labor.find(x => x.task === 'base');
  assert.equal(l.qty, 100); assert.ok(l.qtySet); near(l.counted, base.qty, 'the count is kept beside it');
  near(l.hours, 100 * base.rate, 'the line\'s hours follow');
  const r1 = J.jobOf(root).rooms[0];
  assert.ok(r1.hours.likely >= j0.rooms[0].hours.likely + (100 - base.qty) * base.rate - 1e-9, 'and the room\'s (with setup and cleanup for any added day)');
  assert.ok(r1.days >= j0.rooms[0].days);
  assert.ok(J.setRoomLabor(root, study.key, 'each', 'base', 0.05)); store.touch();
  l = J.jobOf(root).rooms[0].trim[0].labor.find(x => x.task === 'base');
  near(l.hours, 5, '100 LF at 0.05'); assert.equal(l.eachSet, 'room');
  near(J.jobOf(root).rooms[1].hours.likely, j0.rooms[1].hours.likely, 'the other room is untouched');
  // A task the drawing does not count can be added.
  assert.ok(J.setRoomLabor(root, study.key, 'qty', 'scarf', 2)); store.touch();
  assert.ok(J.jobOf(root).rooms[0].trim[0].labor.some(x => x.task === 'scarf' && x.qty === 2));
  assert.equal(J.setRoomLabor(root, study.key, 'qty', 'base', -1), false, 'no negative quantities');
  for (const [f, t] of [['qty', 'base'], ['each', 'base'], ['qty', 'scarf']]) J.setRoomLabor(root, study.key, f, t, null);
  store.touch();
  assert.equal(root.job, undefined, 'nothing left stored');
  near(J.jobOf(root).price.likely, j0.price.likely, 'back to the drawing');
});

test('who does the work: their rate and their own times price the job', () => {
  const { root } = setup();
  const j0 = J.jobOf(root);
  const x = J.addInstaller({ name: 'Sam', rate: 100 });
  assert.ok(J.setInstallerTime(x, 'base', 0.07));
  assert.ok(J.setJobWho(root, x.id)); store.touch();
  const j = J.jobOf(root), l = j.rooms[0].trim[0].labor.find(y => y.task === 'base');
  assert.equal(j.settings.laborRate, 100); assert.equal(l.rate, 0.07); assert.equal(l.eachSet, 'who');
  near(j.labor.likely, j.hours.likely * 100, 'hours at Sam\'s rate');
  assert.ok(j.hours.likely > j0.hours.likely, 'a slower baseboard time adds hours');
  // A room's typed time still wins over theirs.
  J.setRoomLabor(root, j.rooms[0].key, 'each', 'base', 0.02); store.touch();
  assert.equal(J.jobOf(root).rooms[0].trim[0].labor.find(y => y.task === 'base').eachSet, 'room');
  J.setRoomLabor(root, j.rooms[0].key, 'each', 'base', null);
  J.removeInstaller(x.id); store.touch();
  assert.equal(root.job, undefined, 'removing them takes them off the job');
  assert.equal(J.jobOf(root).settings.laborRate, 85);
  assert.equal(J.setJobWho(root, 'nobody'), false);
});

test('the boards bought are PRODUCTS records with their store pages, and a record\'s price prices the board', async () => {
  const { root, prop } = setup();
  const JP = await import('../js/job-products.js');
  const j0 = J.jobOf(root);
  const made = JP.ensureBoardProducts(j0.trim, prop); store.touch();
  const recs = store.ws.data.products.filter(p => p.trimStock);
  assert.equal(made, recs.length); assert.ok(recs.length >= 1);
  for (const r of recs) assert.ok(/^https:\/\/www\.(lowes|homedepot)\.com\/p/.test(r.url) && r.price > 0 && r.propertyIds.includes(prop.id) && r.priceCheckedAt, r.name);
  assert.equal(JP.ensureBoardProducts(J.jobOf(root).trim, prop), 0, 'made once');
  near(J.jobOf(root).boards, j0.boards, 'the records carry the prices the estimate used');
  const line = j0.trim.buy[0].lines[0], { record } = JP.productForBoard(j0.trim.buy[0].pid, line.lenIn, line.how);
  record.price += 10; store.touch();
  near(J.jobOf(root).boards - j0.boards, 10 * line.order, 'ten dollars more for each of those boards');
  assert.equal(JP.feetInches(94.5), '7\'-10 1/2"'); assert.equal(JP.feetInches(144), '12\'-0"');
});

test('a room\'s days set by hand scale its tasks to fit, the labor follows, and reset', () => {
  const { root } = setup();
  const j0 = J.jobOf(root), room = j0.rooms[0], d0 = room.days, h0 = room.hours.likely;
  const want = d0 + 2;
  assert.ok(J.setRoomDays(root, room.key, want)); store.touch();
  const j1 = J.jobOf(root), r1 = j1.rooms[0], lines = r1.trim.flatMap(x => x.labor);
  assert.equal(r1.days, want, 'the room takes the days set');
  const work = lines.filter(l => l.per !== 'room_days').reduce((n, l) => n + l.hours, 0);
  near(work, want * 6, 'its working hours fill the days at 6 hours a day');
  assert.ok(lines.filter(l => l.per !== 'room_days' && l.own > 0).every(l => l.scaled && Math.abs(l.rate / l.own - lines.find(x => x.per !== 'room_days' && x.own > 0).rate / lines.find(x => x.per !== 'room_days' && x.own > 0).own) < 1e-9), 'every task is scaled by the same factor');
  assert.ok(r1.hours.likely > h0 && Math.abs(r1.labor.likely - r1.hours.likely * j1.settings.laborRate) < 1e-6, 'more days, more hours, and the labor follows');
  assert.ok(J.setRoomLabor(root, room.key, 'each', 'base', 0.05)); store.touch();
  assert.equal(J.jobOf(root).rooms[0].days, want, 'a task typed in a room whose days are set keeps the days');
  assert.equal(J.setRoomDays(root, room.key, 0), false, 'less than a day is refused');
  assert.ok(J.setRoomDays(root, room.key, null)); store.touch();
  assert.ok(J.jobOf(root).rooms[0].trim.every(x => !x.daysSet), 'reset: the days are counted again');
  assert.ok(root.job.labor[room.key].each.base === 0.05, 'and the typed time stays');
});

test('the job\'s supplies: a count or price typed over the rule, one removed and put back, one added', () => {
  const { root } = setup();
  const t0 = J.jobOf(root).trim, first = t0.supplies[0], total0 = t0.totals.supplies;
  assert.ok(J.setSupply(root, first.id, 'packages', first.packages + 2)); store.touch();
  let t = J.jobOf(root).trim, row = t.supplies.find(x => x.id === first.id);
  assert.ok(row.packagesSet && row.packages === first.packages + 2, 'the typed count wins');
  near(t.totals.supplies, total0 + 2 * first.price, 'and the total follows');
  assert.ok(J.setSupply(root, first.id, 'price', 1)); store.touch();
  near(J.jobOf(root).trim.supplies.find(x => x.id === first.id).ext, (first.packages + 2) * 1, 'a typed price each');
  assert.equal(J.setSupply(root, first.id, 'price', -3), false, 'a negative price is refused');
  assert.ok(J.removeSupply(root, first.id)); store.touch();
  t = J.jobOf(root).trim;
  assert.ok(!t.supplies.some(x => x.id === first.id) && t.removedSupplies.some(x => x.id === first.id), 'removed, and kept to put back');
  const j = J.jobOf(root);
  near(j.supplies, t.totals.supplies, 'the rooms\' supplies add up to the list without it');
  const id = J.addSupply(root, { product: 'Synthetic tape', packages: 3, price: 2.5 }); store.touch();
  near(J.jobOf(root).trim.supplies.find(x => x.id === id).ext, 7.5, 'a supply added by hand');
  assert.ok(J.removeSupply(root, id)); store.touch();
  assert.ok(!(root.job.supplies.added || []).length, 'an added supply removed is gone');
  assert.ok(J.restoreSupply(root, first.id)); J.setSupply(root, first.id, 'packages', null); J.setSupply(root, first.id, 'price', null); store.touch();
  near(J.jobOf(root).trim.totals.supplies, total0, 'put back and reset, the list is as counted');
  assert.ok(!root.job || !root.job.supplies, 'and nothing is left stored');
});
