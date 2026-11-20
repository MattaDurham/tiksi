// ESTIMATE, SCHEDULE and PROJECT DOCUMENTS in a browser: a synthetic study with baseboard drawn round it
// is worked out room by room; a piece opens its detail; a markup moves the price and UNDO puts it
// back; a bid is recorded; an item the drawing already prices is removed; a scope item is set to
// wait for the trim in working days; the old BUDGET and CUT SHEETS addresses open their new homes;
// the trim package names every piece and the proposal carries the price.
// Synthetic workspace only. Run: node tools/e2e-estimate.mjs (Playwright + Chromium installed).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const path = resolve(root, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { const bytes = await readFile(path); res.setHeader('Content-Type', types[extname(path)] || 'application/octet-stream'); res.end(bytes); }
  catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(+(process.env.E2E_APP_PORT || 0), 'localhost', r));
const url = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', d => d.accept());
const check = (ok, label) => { assert.ok(ok, label); console.log('  ok   ' + label); };
// Waits by polling from here: a page-side async predicate would not be awaited.
async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out: ' + what); await new Promise(r => setTimeout(r, 120)); }
}
const job = () => page.evaluate(async () => {
  const j = (await import('/js/job.js')).jobOf((await import('/js/store.js')).projectById('p-trim'));
  const cents = '$' + j.price.likely.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return { price: j.price.likely, cost: j.cost.likely, covered: j.covered.length, hours: j.hours.likely, pieces: j.rooms.reduce((n, r) => n + r.pieces, 0), days: j.schedule.days,
    discount: j.discount.likely, tax: j.tax, before: j.cost.likely + j.contingency.likely + j.markup.likely, labor: j.labor.likely, cents, supplies: j.supplies };
});
const money = v => page.evaluate(v => import('/js/store.js').then(s => s.fmtMoney(v)), v);

try {
  await page.goto(url + '/#/estimate');
  await page.waitForSelector('#btn-file', { state: 'attached' });
  await page.evaluate(async () => {
    const s = await import('/js/store.js'), T = await import('/js/trims.js'), D = await import('/js/trim-design.js');
    s.ws.data = s.emptyWorkspace();
    const p = s.propertyTemplate('Test House'), lvl = p.levels[0].id;
    const wall = (id, ax, ay, bx, by) => ({ id, level: lvl, ax, ay, bx, by, thickness: 0.1, height: 2.4 });
    p.walls = [wall('s', 0, 0, 4, 0), wall('e', 4, 0, 4, 3), wall('n', 4, 3, 0, 3), wall('w', 0, 3, 0, 0)];
    p.rooms = [{ id: 'room-study', level: lvl, name: 'Study', pts: [[0, 0], [4, 0], [4, 3], [0, 3]], material: null, ceilingMaterial: null }];
    p.openings = [{ id: 'door', wallId: 'e', type: 'door', t: 0.5, width: 0.8, height: 2.03 }];
    p.trims = [];
    s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id; s.ws.data.settings.programStart = '2026-12-07';
    s.ws.data.projects.push(
      { id: 'p-trim', name: 'Study trim', propertyId: p.id, category: 'interior', status: 'scoped', selected: true, startDate: '2026-12-07', notes: '', items: [
        { id: 'it-order', name: 'Measure and order', qty: 1, unit: 'ls', low: 150, likely: 200, high: 250, durationDays: 1, deps: [], elementIds: [], status: 'todo' }] },
      { id: 'p-study', name: 'Study', propertyId: p.id, parentId: 'p-trim', roomId: 'room-study', category: 'interior', status: 'scoped', selected: true, startDate: '', notes: '', items: [
        { id: 'it-old', name: 'Base boards from an old package', qty: 3, unit: 'ea', low: 30, likely: 30, high: 30, durationDays: 0, deps: [], elementIds: ['b1', 'b2', 'b3', 'b4'], status: 'todo' }] });
    const env = { prop: p, projects: s.ws.data.projects, levelOf: () => lvl, wallsOn: () => p.walls, roomsOn: () => p.rooms, openingsOn: () => p.openings, heightOf: w => w.height };
    const d0 = D.trimDesign(env);
    let n = 0;
    for (const w of p.walls) {
      const side = [1, -1].find(x => (d0.info({ id: 'probe', wallId: w.id, side: x, f0: 0, f1: 1, style: 'baseboard' }) || {}).roomId === 'room-study');
      const t = T.trimTemplate('baseboard', null, w, side, { wallHeight: 2.4 });
      t.id = 'b' + (++n); t.projectId = 'p-study'; t.product = 'lowes-163e12fbdpm';
      p.trims.push(t);
    }
    s.touch();
  });

  console.log('\n[estimate] the project, room by room');
  await page.goto(url + '/#/estimate?project=p-trim');
  await page.waitForSelector('.es-head h1');
  const j0 = await job();
  check(j0.pieces >= 4 && j0.hours > 0 && j0.covered === 1, `the study's baseboard is ${j0.pieces} pieces and ${j0.hours.toFixed(1)} hours; the old boards item is counted once`);
  check((await page.locator('.es-rooms tfoot td[data-d="cell:*|price"]').textContent()) === await money(j0.price) && await page.locator('.es-figs').count() === 0, 'the price totals the rooms table, with no figure boxes above it');
  check(await page.locator('#rail a[data-view="estimate"].active').count() === 1, 'the ESTIMATE tab is lit');
  await page.click('tr[data-room="p-study"] td:first-child');
  await page.locator('.es-open .ev-pc[data-d^="piece:"]').first().waitFor();
  check(await page.locator('.es-open .es-cut tr[data-d^="piece:"]').count() > 0, 'the open room shows its walls, boards and cut list');
  await page.locator('.es-open .es-cut tr[data-d^="piece:"]').first().click();
  await until(async () => /long point/.test(await page.locator('#es-dbody').textContent()), 'the piece detail');
  check(/Ends/.test(await page.locator('#es-dbody').textContent()), 'a piece opens with its length, ends and board');

  console.log('\n[labor] a room\'s quantities and times are typed over in its labor table');
  const baseHours = async () => page.evaluate(async () => { const J = await import('/js/job.js'), s = await import('/js/store.js'); return J.jobOf(s.projectById('p-trim')).rooms.find(r => r.key === 'p-study').trim[0].labor.find(l => l.task === 'base'); });
  const b0 = await baseHours();
  await page.locator('[data-lq="p-study|base"]').fill('50');
  await page.locator('[data-lq="p-study|base"]').press('Tab');
  await until(async () => (await baseHours()).qty === 50, 'the typed quantity');
  check(Math.abs((await baseHours()).hours - 50 * b0.rate) < 1e-9 && await page.locator('tr[data-lt="p-study|base"].typed [data-lr]').count() === 1, 'typing 50 LF of base gives 50 × its time, marked typed with a RESET');
  await page.locator('[data-lr="p-study|base"]').click();
  await until(async () => !(await baseHours()).qtySet, 'reset');
  check(Math.abs((await baseHours()).qty - b0.qty) < 1e-9, 'RESET goes back to the drawing\'s count');
  await page.locator('tr[data-lt="p-study|base"] td.lk').click();
  await until(async () => /Where the published time comes from/i.test(await page.locator('#es-dbody').textContent()), 'the task detail');
  check(await page.locator('#es-dbody [data-go-room="p-study"]').count() === 1, 'the task\'s detail links to each room it is in');

  console.log('\n[scope items] added, priced and removed inside the room');
  const studyItems = async () => page.evaluate(async () => (await import('/js/store.js')).projectById('p-study').items.map(i => ({ id: i.id, name: i.name, qty: i.qty, likely: i.likely, status: i.status })));
  const n0 = (await studyItems()).length, price0 = (await job()).price;
  await page.click('[data-add-item="p-study"]');
  await until(async () => (await studyItems()).length === n0 + 1, 'a new item');
  const added = (await studyItems()).at(-1);
  const row = `tr[data-si="${added.id}"]`;
  await page.locator(row + ' [data-si-f="name"]').fill('Patch plaster');
  await page.locator(row + ' [data-si-f="name"]').press('Tab');
  await page.locator(row + ' [data-si-f="qty"]').fill('2');
  await page.locator(row + ' [data-si-f="qty"]').press('Tab');
  await page.locator(row + ' [data-si-money="likely"]').fill('$150');
  await page.locator(row + ' [data-si-money="likely"]').press('Tab');
  await until(async () => (await studyItems()).at(-1).likely === 150, 'the price');
  const it1 = (await studyItems()).at(-1);
  check(it1.name === 'Patch plaster' && it1.qty === 2 && Math.abs((await job()).price - price0 - 300) < 0.01, 'a new item typed in the room (2 at $150) adds $300 to the price');
  await page.locator(row + ' [data-si-money="low"]').fill('lots');
  await page.locator(row + ' [data-si-money="low"]').press('Tab');
  await until(async () => (await page.locator('[data-money-problem]').count()) === 1, 'the refusal');
  check(true, 'a price that cannot be read is refused with a reason');
  await page.locator(row + ' .si-more').click();
  await page.locator('#es-dbody [data-sid-status]').selectOption('ordered');
  await until(async () => (await studyItems()).at(-1).status === 'ordered', 'status');
  check(true, 'the item\'s record in the detail column sets its status');
  await page.click(`[data-si-del="${added.id}"]`);
  await until(async () => (await studyItems()).length === n0, 'removed');
  check(Math.abs((await job()).price - price0) < 0.01, 'removing it takes its price back off');

  console.log('\n[products] the boards are PRODUCTS records with their store pages');
  await until(async () => (await page.evaluate(async () => (await import('/js/store.js')).ws.data.products.filter(p => p.trimStock).length)) > 0, 'board records');
  await page.locator('.es-open .es-cut tr[data-d^="piece:"]').first().click();
  await page.locator('#es-dbody [data-d^="product:"]').click();
  await until(async () => /Bought as/i.test(await page.locator('#es-dbody').textContent()), 'the product detail');
  check(await page.locator('#es-dbody a[href^="https://www.lowes.com/"], #es-dbody a[href^="https://www.homedepot.com/"]').count() > 0
    && await page.locator('#es-dbody a[href^="#/products?select="]').count() > 0, 'a moulding links to its store page and its PRODUCTS record');

  console.log('\n[who] who does the work sets the rate and the times');
  await page.click('[data-add-who]');
  await page.locator('[data-wf="rate"]').waitFor();
  await page.locator('[data-wf="name"]').fill('Synthetic Carpenter'); await page.locator('[data-wf="name"]').press('Tab');
  await page.locator('[data-wf="rate"]').fill('100'); await page.locator('[data-wf="rate"]').press('Tab');
  await page.locator('[data-wt="base"]').fill('0.05'); await page.locator('[data-wt="base"]').press('Tab');
  await until(async () => (await page.evaluate(async () => (await import('/js/store.js')).ws.data.settings.installers[0].each.base)) === 0.05, 'their time');
  await page.goto(url + '/#/estimate?project=p-trim');
  await page.locator('[data-job-who]').waitFor();
  const who = await page.evaluate(async () => (await import('/js/store.js')).ws.data.settings.installers[0].id);
  await page.selectOption('[data-job-who]', who);
  await until(async () => (await baseHours()).rate === 0.05, 'the job uses their time');
  check(await page.evaluate(async () => { const J = await import('/js/job.js'), s = await import('/js/store.js'); return J.jobOf(s.projectById('p-trim')).settings.laborRate; }) === 100, 'choosing them prices the job at their rate and their own baseboard time');
  await page.selectOption('[data-job-who]', '');
  await until(async () => (await baseHours()).rate === b0.rate, 'back to the published time');

  console.log('\n[price] a markup moves the price; UNDO and REDO');
  await page.locator('[data-set="contingency"]').fill('10');
  await page.locator('[data-set="contingency"]').press('Tab');
  await until(async () => Math.abs((await job()).price - j0.price * 1.1) < 0.01, 'the price with 10% contingency');
  check(true, 'contingency 10% raises the price by 10%');
  await page.locator('.es-head .es-kicker').click();
  await page.keyboard.press('ControlOrMeta+z');
  await until(async () => Math.abs((await job()).price - j0.price) < 0.01, 'undo');
  check(true, 'UNDO puts it back');
  await page.locator('.es-head .es-kicker').click();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await until(async () => Math.abs((await job()).price - j0.price * 1.1) < 0.01, 'redo');
  check(true, 'REDO sets it again');

  console.log('\n[details] every number opens how it is worked out, on down to its parts');
  await page.locator('[data-set="discount"]').fill('50');
  await page.locator('[data-set="discount"]').press('Tab');
  await until(async () => (await job()).discount > 0, 'the discount');
  const jx = await job();
  check(Math.abs(jx.price - (jx.before - jx.discount + jx.tax)) < 0.01 && Math.abs(jx.discount - jx.labor / 2) < 0.01, 'a 50% discount comes off the labor only');
  const lines = (await page.locator('.es-build tr td:first-child').allTextContents()).map(t => t.trim().split(/\s/)[0]).filter(w => !['Contingency', 'Scope'].includes(w)).join();
  check(await page.locator('.es-build thead').count() === 0 && lines === 'Materials,Labor,Discount,Tax,Total', `the price is one column: materials, labor, discount, tax, total (${lines})`);
  const firstRoom = await page.locator('.es-rooms tr.es-room').first().getAttribute('data-room');
  await page.click(`td[data-d="cell:${firstRoom}|supplies"]`);
  await until(async () => /share by feet of trim/.test(await page.locator('#es-dbody').textContent()), 'a room\'s supplies');
  await page.click('#es-dbody a[data-d="supplies:all"]');
  await until(async () => (await page.locator('#es-dbody a[data-d^="supply:"]').count()) > 3, 'the supplies list');
  await page.locator('#es-dbody a[data-d^="supply:"]').first().click();
  await until(async () => /How many/.test(await page.locator('#es-dbody').textContent()), 'one supply');
  await page.locator('#es-dbody a[data-d^="measure:"]').first().click();
  await until(async () => /Counted from the drawing/.test(await page.locator('#es-dbody').textContent()), 'its measure');
  check(true, 'a room\'s supplies open the list, a product, and the measure of the drawing it is counted from');
  for (const col of ['lf', 'pieces', 'boards', 'hours', 'labor', 'days', 'price']) {
    await page.click(`td[data-d="cell:${firstRoom}|${col}"]`);
    await until(async () => (await page.locator('#es-dbody .d-title').count()) === 1 && (await page.locator('#es-crumb').textContent()) !== 'Details', col);
  }
  check(true, 'every number of a room opens its working');
  console.log('\n[supplies and removing] the supplies list to change; × and right-click remove');
  const s0 = (await job()).supplies, firstSup = page.locator('.es-sup tr[data-sup]').first(), supId = await firstSup.getAttribute('data-sup');
  await firstSup.locator('[data-sup-del]').click();
  await until(async () => (await job()).supplies < s0 - 0.001, 'a supply removed');
  check(await page.locator(`[data-sup-restore="${supId}"]`).count() === 1, 'a supply\'s × takes it off the job, and PUT BACK is offered');
  await page.click(`[data-sup-restore="${supId}"]`);
  await until(async () => Math.abs((await job()).supplies - s0) < 0.001, 'put back');
  await page.locator('.es-sup tr[data-sup]').first().locator('[data-sup-f="packages"]').fill('40');
  await page.locator('.es-sup tr[data-sup]').first().locator('[data-sup-f="packages"]').press('Tab');
  await until(async () => (await job()).supplies > s0 + 0.001, 'a typed count');
  check(true, 'typing over a supply\'s count changes the supplies');
  await page.locator('.es-sup tr[data-sup]').first().click({ button: 'right' });
  await page.locator('.es-menu button', { hasText: 'Back to its count and price' }).click();
  await until(async () => Math.abs((await job()).supplies - s0) < 0.001, 'reset from the menu');
  check(true, 'right-click on a supply offers to put back its count and price');
  await page.fill('[data-sup-add] [name=product]', 'Synthetic drop cloth'); await page.fill('[data-sup-add] [name=packages]', '2'); await page.fill('[data-sup-add] [name=price]', '10');
  await page.click('[data-sup-add] button[type=submit]');
  await until(async () => Math.abs((await job()).supplies - (s0 + 20)) < 0.001, 'added');
  check(true, 'a supply added by hand counts');
  await page.locator('.es-sup tr[data-sup]').filter({ has: page.locator('[data-sup-name]') }).locator('[data-sup-del]').click();
  await until(async () => Math.abs((await job()).supplies - s0) < 0.001, 'added one removed');
  await page.locator('.es-rooms tr.es-room').first().click({ button: 'right' });
  check(await page.locator('.es-menu button', { hasText: /^Remove / }).count() === 1, 'right-click on a room offers to remove it');
  await page.keyboard.press('Escape');
  await until(async () => await page.locator('.es-menu').count() === 0, 'menu closed');
  await page.locator('[data-set="discount"]').fill('0');
  await page.locator('[data-set="discount"]').press('Tab');
  await until(async () => (await job()).discount === 0, 'no discount');

  console.log('\n[bids and covered items]');
  await page.fill('[data-add-bid] [name=who]', 'Synthetic Carpentry');
  await page.fill('[data-add-bid] [name=amount]', '1,200');
  await page.click('[data-add-bid] button[type=submit]');
  await until(async () => /Synthetic Carpentry/.test(await page.locator('.es-in').textContent()), 'the bid');
  check(true, 'a bid is recorded');
  await page.click('[data-remove-covered]');
  await until(async () => (await job()).covered === 0, 'covered removed');
  check(await page.evaluate(async () => (await import('/js/store.js')).activeProperty().removedRecords.some(r => r.records.some(x => x.id === 'it-old'))), 'the item the drawing prices is removed and kept in REMOVED RECORDS');

  console.log('\n[schedule] working days, the room\'s trim, what an item waits for');
  await page.goto(url + '/#/schedule?project=p-trim');
  await page.waitForSelector('#gantt tr[data-key="trim:p-study"]');
  await page.selectOption('[data-after="it-order"]', 'trim:p-study');
  await until(async () => (await page.evaluate(async () => (await import('/js/store.js')).projectById('p-trim').items[0].deps.join())) === 'trim:p-study', 'the item waits for the trim');
  await page.waitForSelector('#gantt tr[data-key="it-order"]');
  await page.click('#gantt tr[data-key="it-order"] td.work');
  const det = await page.locator('#gantt-detail').textContent();
  check(/working day/.test(det) && /Dec \d+, 2026/.test(det), 'a line gives its working days and dates (' + det + ')');
  const j1 = await job();
  check((await page.locator('.es-nav .es-job.here .m').textContent()) === `${j1.days} days` && await page.locator('.es-figs').count() === 0, `the job takes ${j1.days} working days, the trim then the item`);
  await page.locator('#gantt tr[data-key="trim:p-study"] td.work').dblclick();
  await until(async () => (await page.locator('#gantt tr.g-task').count()) > 0, 'the room\'s tasks');
  const tasks = await page.locator('#gantt tr.g-task td.work').allTextContents();
  check(tasks[0] === 'Set up and protect the room' && tasks[tasks.length - 1] === 'Clean up', `double-clicking a room shows its ${tasks.length} tasks in order`);
  await page.locator('#gantt tr[data-key="trim:p-study"] [data-open-room]').click();
  await until(async () => (await page.locator('#gantt tr.g-task').count()) === 0, 'closed');

  console.log('\n[schedule] a number opens the column on the right; change it here or everywhere; drag a bar; stretch the calendar');
  const roomDays = () => page.evaluate(async () => (await import('/js/job.js')).jobOf((await import('/js/store.js')).projectById('p-trim')).rooms.find(r => r.key === 'p-study').days);
  const d0 = await roomDays();
  await page.click('#gantt tr[data-key="trim:p-study"] td[data-num="days"]');
  await page.locator('#sc-dbody [data-f="days"]').waitFor();
  check(await page.locator('.sc.det-open').count() === 1 && await page.evaluate(() => document.activeElement && document.activeElement.dataset.f === 'days'), 'clicking a room\'s days opens the column on the right, ready to type');
  await page.fill('#sc-dbody [data-f="days"]', String(d0 + 2));
  await page.click('#sc-dbody [data-apply="days|one"]');
  await until(async () => (await roomDays()) === d0 + 2, 'the room\'s days');
  const fit = await page.evaluate(async () => { const J = await import('/js/job.js'), S = await import('/js/store.js'); const j = J.jobOf(S.projectById('p-trim')), r = j.rooms.find(x => x.key === 'p-study'), L = r.trim.flatMap(x => x.labor).filter(l => l.per !== 'room_days'); return { work: L.reduce((n, l) => n + l.hours, 0), typed: L.filter(l => l.rate > 0).every(l => l.eachSet === 'room'), labor: r.labor.likely, hours: r.hours.likely, rate: j.settings.laborRate }; });
  check(Math.abs(fit.work - (d0 + 2) * 6) < 1e-3 && fit.typed && Math.abs(fit.labor - fit.hours * fit.rate) < 1e-6, `set to ${d0 + 2} days, the room's times are rewritten to fill them (${fit.work.toFixed(2)} working hours) and the labor is those hours at the rate`);
  await page.click('#gantt tr[data-key="trim:p-study"] [data-open-room]');
  await page.click('#gantt tr[data-key="trim:p-study|base"] td[data-num="hours"]');
  await page.locator('#sc-dbody [data-f="each"]').waitFor();
  const before = await roomDays(), each0 = Number(await page.inputValue('#sc-dbody [data-f="each"]'));
  await page.fill('#sc-dbody [data-f="each"]', String(each0 * 5));
  await page.click('#sc-dbody [data-apply="each|one"]');
  await until(async () => (await roomDays()) > before, 'more days');
  check(true, `a task's time typed afterwards moves the room's days (${before} → ${await roomDays()}): nothing is pinned`);
  await page.click('#gantt tr[data-key="trim:p-study"] [data-open-room]');
  await page.locator('.es-head h1').click();
  await page.evaluate(async () => { const J = await import('/js/job.js'), S = await import('/js/store.js'); const p = S.projectById('p-trim'); delete p.job.labor['p-study'].each; if (!Object.keys(p.job.labor['p-study']).length) delete p.job.labor['p-study']; if (!Object.keys(p.job.labor).length) delete p.job.labor; S.touch(); });
  await until(async () => (await roomDays()) === d0 && (await page.locator('[data-bar="trim:p-study"]').getAttribute('data-days')) === String(d0), 'back to the count, drawn');
  await page.waitForTimeout(300);
  const bar = page.locator('[data-bar="trim:p-study"]'), bb = await bar.boundingBox(), dw = Number(await page.locator('#gantt').getAttribute('data-dayw'));
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.mouse.down();
  await page.mouse.move(bb.x + bb.width / 2 + dw * 1.1, bb.y + bb.height / 2, { steps: 6 }); await page.mouse.up();
  await until(async () => (await roomDays()) === d0 + 1, 'the dragged bar');
  check(true, 'dragging a room\'s bar a day longer fits its times to the day more');
  await page.locator('.es-head h1').click();
  await page.evaluate(async () => { const S = await import('/js/store.js'); const p = S.projectById('p-trim'); delete p.job.labor['p-study']; if (!Object.keys(p.job.labor).length) delete p.job.labor; S.touch(); });
  await until(async () => (await roomDays()) === d0, 'reset again');
  const ab = await page.locator('#gantt th.axis').boundingBox();
  await page.mouse.move(ab.x + 10, ab.y + ab.height / 2); await page.mouse.down();
  await page.mouse.move(ab.x + 160, ab.y + ab.height / 2, { steps: 8 }); await page.mouse.up();
  await until(async () => Number(await page.locator('#gantt').getAttribute('data-dayw')) > dw * 1.5, 'stretched');
  check(await page.locator('[data-fit]').count() === 1, `dragging across the calendar stretches it (a day ${dw} → ${await page.locator('#gantt').getAttribute('data-dayw')} pixels), and FIT is offered`);
  await page.click('[data-fit]');
  await until(async () => await page.locator('[data-fit]').count() === 0, 'fit');
  await page.click('#gantt tr[data-key="it-order"] td[data-num="days"]');
  await page.locator('#sc-dbody [data-f="idays"]').waitFor();
  await page.fill('#sc-dbody [data-f="idays"]', '3');
  await page.press('#sc-dbody [data-f="idays"]', 'Enter');
  await until(async () => (await page.evaluate(async () => (await import('/js/store.js')).projectById('p-trim').items[0].durationDays)) === 3, 'the item\'s days');
  check(true, 'a scope item\'s days change from the column (Enter applies to this item)');
  await page.click('.sc-det [data-close]');
  await until(async () => await page.locator('.sc.det-open').count() === 0, 'closed');

  console.log('\n[addresses]');
  await page.goto(url + '/#/budget');
  await page.locator('#cap-input').waitFor();
  check(await page.locator('#rail a[data-view="estimate"].active').count() === 1, '#/budget opens ALL PROJECTS in ESTIMATE');
  await page.goto(url + '/#/sheets');
  await page.locator('.sheet-layout').waitFor();
  check(await page.locator('.doc-parts [data-part="sheets"].active').count() === 1, '#/sheets opens CUT SHEETS in DOCUMENTS');

  console.log('\n[documents] the summary, the trim package and the proposal');
  await page.goto(url + '/#/documents?job=p-trim');
  await page.waitForSelector('.sm');
  const sum = await page.locator('.sm').textContent(), jd = await job();
  check(!/Discount/.test(sum) && /Tax \(/.test(sum) && sum.includes(jd.cents), `the summary gives each room, the tax and the estimate's total ${jd.cents}, and no discount line without a discount`);
  const gantt = await page.evaluate(async () => { const j = (await import('/js/job.js')).jobOf((await import('/js/store.js')).projectById('p-trim')); return { rows: j.schedule.rows.length, days: j.schedule.days, bars: document.querySelectorAll('.sm-sched .sm-bar').length, text: document.querySelector('.sm-sched')?.textContent || '' }; });
  check(gantt.bars === gantt.rows && gantt.text.includes(`${gantt.days} working day`), `the summary ends with the schedule: ${gantt.bars} bars over ${gantt.days} working days`);
  await page.click('[data-doc="package"]');
  await page.waitForSelector('.tpkg');
  const marks = await page.evaluate(async () => (await import('/js/job.js')).jobOf((await import('/js/store.js')).projectById('p-trim')).trim.groups.map(g => g.mark));
  const book = await page.locator('.tpkg').textContent();
  check(marks.every(m => book.includes(m)), 'the trim package names every piece');
  await page.click('[data-doc="proposal"]');
  await page.waitForSelector('.pp');
  check((await page.locator('.pp').textContent()).includes(await money(Math.round((await job()).price))), 'the proposal carries the price');
  await page.evaluate(() => { window.print = () => {}; });
  await page.click('[data-print]');
  check(await page.locator('#print-root .pp').count() === 1, 'PRINT puts it on paper');

  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  console.log('\nESTIMATE: all checks passed');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
