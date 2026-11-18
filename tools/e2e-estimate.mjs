// ESTIMATE, SCHEDULE and JOB DOCUMENTS in a browser: a synthetic study with baseboard drawn round it
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
  await page.goto(url + '/#/projects');
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
  check((await page.locator('.es-figs .big b').textContent()) === await money(j0.price), 'the price is at the top');
  check(await page.locator('#rail a[data-view="estimate"].active').count() === 1, 'the ESTIMATE tab is lit');
  await page.click('tr[data-room="p-study"] td:first-child');
  await page.locator('.es-open .ev-pc[data-d^="piece:"]').first().waitFor();
  check(await page.locator('.es-open .es-cut tr[data-d^="piece:"]').count() > 0, 'the open room shows its walls, boards and cut list');
  await page.locator('.es-open .es-cut tr[data-d^="piece:"]').first().click();
  await until(async () => /long point/.test(await page.locator('#es-dbody').textContent()), 'the piece detail');
  check(/Ends/.test(await page.locator('#es-dbody').textContent()), 'a piece opens with its length, ends and board');

  console.log('\n[price] a markup moves the price; UNDO and REDO');
  await page.locator('[data-set="contingency"]').fill('10');
  await page.locator('[data-set="contingency"]').press('Tab');
  await until(async () => Math.abs((await job()).price - j0.price * 1.1) < 0.01, 'the price with 10% contingency');
  check(true, 'contingency 10% raises the price by 10%');
  await page.locator('.es-head h1').click();
  await page.keyboard.press('ControlOrMeta+z');
  await until(async () => Math.abs((await job()).price - j0.price) < 0.01, 'undo');
  check(true, 'UNDO puts it back');
  await page.locator('.es-head h1').click();
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
  check((await page.locator('.es-figs .big b').textContent()).startsWith(String(j1.days)), `the job takes ${j1.days} working days, the trim then the item`);

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
