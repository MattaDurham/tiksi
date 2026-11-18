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
  return { price: j.price.likely, cost: j.cost.likely, covered: j.covered.length, hours: j.hours.likely, pieces: j.rooms.reduce((n, r) => n + r.pieces, 0), days: j.schedule.days };
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
  check((await page.locator('.es-sec .es-t tfoot td:last-child').first().textContent()) === await money(j0.price) && await page.locator('.es-figs').count() === 0, 'the price totals the rooms table, with no figure boxes above it');
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

  console.log('\n[addresses]');
  await page.goto(url + '/#/budget');
  await page.locator('#cap-input').waitFor();
  check(await page.locator('#rail a[data-view="estimate"].active').count() === 1, '#/budget opens ALL PROJECTS in ESTIMATE');
  await page.goto(url + '/#/sheets');
  await page.locator('.sheet-layout').waitFor();
  check(await page.locator('.doc-parts [data-part="sheets"].active').count() === 1, '#/sheets opens CUT SHEETS in DOCUMENTS');

  console.log('\n[documents] the trim package and the proposal');
  await page.goto(url + '/#/documents?job=p-trim');
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
