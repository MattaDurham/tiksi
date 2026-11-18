// ESTIMATE and the bid package in a browser: a synthetic study with baseboard drawn round it is
// worked out into pieces, boards and hours; a piece opens its detail; a markup moves the total
// and UNDO puts it back; a bid is recorded; an item the drawing already prices is removed; the
// old BUDGET and CUT SHEETS addresses open their new homes; the bid documents carry the
// estimate's price and print; the deep dive saves as one file.
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
const totals = () => page.evaluate(async () => {
  const e = (await import('/js/estimate.js')).projectEstimate((await import('/js/store.js')).projectById('p-trim'));
  return { likely: e.total.likely, trim: e.trimCost.likely, items: e.items.likely, covered: e.covered.length, hours: e.hours.likely, pieces: e.trim.pieces.length };
});
const money = v => page.evaluate(v => import('/js/store.js').then(s => s.fmtMoney(v)), v);

try {
  await page.goto(url + '/#/projects');
  await page.waitForSelector('#btn-file', { state: 'attached' });
  await page.evaluate(async () => {
    const s = await import('/js/store.js'), T = await import('/js/trims.js'), D = await import('/js/trim-design.js');
    s.ws.data = s.emptyWorkspace();
    const p = s.propertyTemplate('Test House');
    const lvl = p.levels[0].id;
    const wall = (id, ax, ay, bx, by) => ({ id, level: lvl, ax, ay, bx, by, thickness: 0.1, height: 2.4 });
    p.walls = [wall('s', 0, 0, 4, 0), wall('e', 4, 0, 4, 3), wall('n', 4, 3, 0, 3), wall('w', 0, 3, 0, 0)];
    p.rooms = [{ id: 'room-study', level: lvl, name: 'Study', pts: [[0, 0], [4, 0], [4, 3], [0, 3]], material: null, ceilingMaterial: null }];
    p.openings = [{ id: 'door', wallId: 'e', type: 'door', t: 0.5, width: 0.8, height: 2.03 }];
    p.trims = [];
    s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id;
    s.ws.data.projects.push(
      { id: 'p-trim', name: 'Study trim', propertyId: p.id, category: 'interior', status: 'scoped', selected: true, startDate: '', notes: '', items: [
        { id: 'it-paint', name: 'Paint the study', qty: 1, unit: 'ls', low: 400, likely: 500, high: 650, durationDays: 2, deps: [], elementIds: [], status: 'todo' }] },
      { id: 'p-study', name: 'Study', propertyId: p.id, parentId: 'p-trim', roomId: 'room-study', category: 'interior', status: 'scoped', selected: true, startDate: '', notes: '', items: [
        { id: 'it-old', name: 'Base boards from an old package', qty: 3, unit: 'ea', low: 30, likely: 30, high: 30, durationDays: 0, deps: [], elementIds: ['b1', 'b2', 'b3', 'b4'], status: 'todo' }] },
    );
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

  console.log('\n[estimate] the project is worked out from its drawn trim');
  await page.goto(url + '/#/estimate?project=p-trim');
  await page.waitForSelector('#est-summary .figs');
  const t0 = await totals();
  check(t0.pieces >= 4 && t0.hours > 0 && t0.trim > 0, `the drawn baseboard becomes ${t0.pieces} pieces and ${t0.hours.toFixed(1)} hours`);
  check(t0.covered === 1 && Math.abs(t0.items - 500) < 1e-6, 'the old item that lists the drawn sections is left out; the paint item stays');
  check((await page.locator('#est-summary .figs').innerText()).includes(await money(t0.likely)), 'the summary shows the total');
  check(await page.locator('#est-toc a[data-go="est-buy"]').count() === 1 && await page.locator('#est-toc a[data-go="est-labor"]').count() === 1, 'the contents list the buy list and the labor');
  check(await page.locator('#rail a[data-view="estimate"].active').count() === 1, 'the ESTIMATE tab is lit');

  console.log('\n[detail] a piece on a wall drawing opens with its length, ends and board');
  await page.locator('details.est-room > summary').first().click();
  await page.locator('details.est-room .ev-pc[data-d^="piece:"]').first().waitFor();
  await page.locator('details.est-room .ev-pc[data-d^="piece:"]').first().click();
  await page.waitForSelector('#est-dbody .d-title');
  const det = await page.locator('#est-dbody').innerText();
  check(/Length/.test(det) && /long point/.test(det) && /Ends/.test(det) && /Cut from/i.test(det), 'the detail gives the length, the ends and the board it is cut from');
  check(await page.locator('.est-main .td-on').count() >= 2, 'the piece lights up on the wall drawing and on its board');
  await page.locator('#est-dbody a.dl[data-d^="stick:"]').first().click();
  await until(async () => /store piece/i.test(await page.locator('#est-crumb').textContent()), 'the board detail');
  check(await page.locator('#est-back').isEnabled(), 'BACK returns to the piece');

  console.log('\n[markups] contingency moves every total; UNDO and REDO');
  await page.locator('[data-set="contingency"]').fill('10');
  await page.locator('[data-set="contingency"]').press('Tab');
  await until(async () => Math.abs((await totals()).likely - t0.likely * 1.1) < 0.01, 'the total with 10% contingency');
  check(true, 'the total is 10% higher');
  const sub = await page.evaluate(async () => (await import('/js/store.js')).projectTotals((await import('/js/store.js')).projectById('p-study')).likely);
  check(sub > 0, 'PROJECTS and the program see the study\'s share with its markup');
  check(await page.locator('#edit-history').evaluate(e => !e.hidden) && await page.locator('#btn-undo').isEnabled(), 'UNDO and REDO are offered on ESTIMATE (in the Tiksi menu)');
  await page.locator('#est-summary h1').click();   // out of the field: Cmd/Ctrl+Z is the page's undo, not the field's
  await page.keyboard.press('ControlOrMeta+z');
  await until(async () => Math.abs((await totals()).likely - t0.likely) < 0.01, 'undo the contingency');
  check((await page.locator('[data-set="contingency"]').inputValue()) === '0', 'UNDO puts the contingency back');
  await page.locator('#est-summary h1').click();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await until(async () => Math.abs((await totals()).likely - t0.likely * 1.1) < 0.01, 'redo the contingency');
  check(true, 'REDO sets it again');

  console.log('\n[bids] a bid is recorded against the estimate\'s labor');
  await page.fill('[data-add-bid] [name=who]', 'Synthetic Carpentry');
  await page.fill('[data-add-bid] [name=hours]', '12');
  await page.fill('[data-add-bid] [name=amount]', '1,200');
  await page.click('[data-add-bid] button[type=submit]');
  await page.waitForSelector('#est-bids tr[data-d^="bid:"]');
  check(/Synthetic Carpentry/.test(await page.locator('#est-bids').innerText()), 'the bid is listed');

  console.log('\n[covered] the item the drawing prices is removed, and can be restored');
  await page.click('[data-remove-covered]');
  await until(async () => (await totals()).covered === 0, 'the covered item removed');
  check(await page.evaluate(async () => (await import('/js/store.js')).activeProperty().removedRecords.some(r => r.records.some(x => x.id === 'it-old'))), 'it is kept in REMOVED RECORDS');

  console.log('\n[addresses] BUDGET and CUT SHEETS open in their new homes');
  await page.goto(url + '/#/budget');
  await page.locator('#cap-input').waitFor();
  check(await page.locator('#rail a[data-view="estimate"].active').count() === 1 && await page.locator('[data-program].here').count() === 1, '#/budget opens the program in ESTIMATE');
  await page.goto(url + '/#/sheets');
  await page.locator('.sheet-layout').waitFor();
  check(await page.locator('#rail a[data-view="documents"].active').count() === 1 && await page.locator('.doc-parts [data-part="sheets"].active').count() === 1, '#/sheets opens CUT SHEETS in DOCUMENTS');

  console.log('\n[bid package] the documents carry the estimate\'s price and print');
  await page.goto(url + '/#/documents?bid=p-trim');
  await page.waitForSelector('.bd-doc[data-doc="proposal"]');
  const price = await money(Math.round((await totals()).likely));
  check((await page.locator('.bd-doc').innerText()).includes(price), 'the proposal shows ' + price);
  await page.fill('[data-biz="name"]', 'Synthetic Builders');
  await page.locator('[data-biz="name"]').press('Tab');
  await until(async () => /Synthetic Builders/.test(await page.locator('.bd-doc').innerText()), 'the business name on the page');
  check(true, 'the business name is on the proposal');
  for (const id of ['scope', 'contract', 'bidform', 'buylist', 'cutlist']) {
    await page.click(`.bp-doc[data-doc="${id}"]`);
    await page.waitForSelector(`.bd-doc[data-doc="${id}"]`);
  }
  check(/Study/.test(await page.locator('.bd-doc').innerText()) && await page.locator('.bd-doc .ev-pc').count() > 0, 'the cut list has the study and its wall drawings');
  await page.evaluate(() => { window.print = () => {}; });
  await page.click('[data-print]');
  check(await page.locator('#print-root .bd-page').count() > 0, 'PRINT puts the pages on paper');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-deep]')]);
  const html = await readFile(await dl.path(), 'utf8');
  check(/window\.DETAILS=/.test(html) && /Study trim/.test(html) && /data-d="piece:/.test(html), `the deep dive saves as one file (${Math.round(html.length / 1024)} KB)`);

  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  console.log('\nESTIMATE: all checks passed');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
