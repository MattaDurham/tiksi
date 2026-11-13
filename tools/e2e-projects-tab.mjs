// PROJECTS tab: search through scope items, status chips with counts, the VIEW menu's filters,
// sort and grouping (remembered after a reload), the board and its drag and keyboard moves,
// the summary line, scope item status, the scope item panel and its links into MODEL, PRODUCTS
// and PHOTOS, and naming a new project in place. Synthetic workspace only.
// Run: node tools/e2e-projects-tab.mjs (Playwright + Chromium installed).
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
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });   // the room link opens MODEL
const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', d => d.accept());
const check = (ok, label) => { assert.ok(ok, label); console.log('  ok   ' + label); };
const store = fn => page.evaluate(async src => { const s = await import('/js/store.js'); return new Function('s', src)(s); }, fn);
const cards = () => page.locator('#proj-list .proj-card b').allTextContents();
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

try {
  await page.goto(url + '/#/projects');
  await page.waitForSelector('#btn-file', { state: 'attached' });
  await page.evaluate(async pixel => {
    const s = await import('/js/store.js');
    localStorage.clear();
    s.ws.data = s.emptyWorkspace();
    const p = s.propertyTemplate('Test House');
    const lv = p.levels[0].id;
    p.walls.push({ id: 'w-north', level: lv, ax: 0, ay: 0, bx: 4, by: 0, thickness: 0.12, height: 2.44, material: null });
    p.rooms.push({ id: 'r-kitchen', level: lv, name: 'Kitchen', pts: [[0, 0], [4, 0], [4, 3], [0, 3]], material: null, ceilingMaterial: null },
      { id: 'r-bath', level: lv, name: 'Hall bath', pts: [[4, 0], [6, 0], [6, 2], [4, 2]], material: null, ceilingMaterial: null });
    p.photos = [{ id: 'ph-tile', name: 'Backsplash.jpg', kind: 'photo', w: 4, h: 3, mime: 'image/png', thumb: pixel, createdAt: new Date().toISOString(),
      notes: '', roomId: '', elementIds: [], itemIds: ['it-tile'], pin: null }];
    s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id;
    const it = (id, name, extra) => Object.assign({ id, name, qty: 1, unit: 'ea', low: 0, likely: 0, high: 0, durationDays: 0, deps: [], elementIds: [], notes: '' }, extra);
    s.ws.data.products.push({ id: 'prod-tile', name: 'Subway tile', brand: 'Synthetic', model: '', category: 'tile', url: '', price: 6, unit: 'sf', imageUrl: '', specs: '', notes: '', itemIds: ['it-tile'] });
    s.mergeWorkspace({ properties: [], projects: [
      { id: 'proj-kitchen', name: 'Kitchen refresh', propertyId: p.id, category: 'kitchen', status: 'scoped', priority: 'medium', selected: true, startDate: '', notes: '', items: [
        it('it-tile', 'Backsplash tile', { qty: 30, unit: 'sf', likely: 12, elementIds: ['r-kitchen'], notes: 'Measured from the scan, 30 sf net.' }),
        it('it-paint', 'Paint walls', { elementIds: ['w-north'] }),
      ] },
      { id: 'proj-bath', name: 'Bath fixes', propertyId: p.id, category: 'bath', status: 'idea', priority: 'high', selected: false, startDate: '', notes: '', roomId: 'r-bath', items: [
        it('it-fan', 'Replace exhaust fan', { likely: 300 }),
      ] },
      { id: 'proj-laundry', name: 'Laundry closet', propertyId: p.id, category: 'interior', status: 'done', selected: false, startDate: '', notes: '', items: [
        it('it-shelf', 'Shelf above the dryer', { likely: 80 }),
      ] },
    ] });
    s.touch();
  }, PIXEL);
  await page.goto(url + '/#/projects');
  await page.waitForSelector('#proj-list .proj-card');

  console.log('\n[file] an older file\'s scope items open as "to do"');
  check((await store(`return s.ws.data.projects.flatMap(p => p.items.map(i => i.status)).join()`)) === 'todo,todo,todo,todo', 'every item has status todo');

  console.log('\n[search] the box matches names, rooms and scope items');
  await page.fill('#proj-search', 'dryer');
  check((await cards()).join() === 'Laundry closet', 'searching "dryer" finds the project through its scope item (' + (await cards()).join() + ')');
  check((await page.textContent('.proj-card .p-hit')).includes('Shelf above the dryer'), 'the card says which scope item matched');
  await page.fill('#proj-search', 'hall bath');
  check((await cards()).join() === 'Bath fixes', 'searching the room name "hall bath" finds the bath project');
  check((await page.textContent('#proj-count')).includes('showing 1'), 'the header says how many are showing');
  await page.press('#proj-search', 'Escape');
  check((await cards()).length === 3 && await page.inputValue('#proj-search') === '', 'Esc clears the search');
  await page.click('#view .view-title');
  await page.keyboard.press('/');
  check(await page.evaluate(() => document.activeElement?.id === 'proj-search'), '"/" puts the cursor in the search box');

  console.log('\n[status] chips count and filter');
  const chip = s => page.locator(`#proj-status [data-status="${s}"]`);
  check((await chip('').textContent()).includes('3') && (await chip('open').textContent()).includes('2') && (await chip('done').textContent()).includes('1'), 'All 3, Open 2, Done 1');
  await chip('open').click();
  check((await cards()).sort().join() === 'Bath fixes,Kitchen refresh', 'Open hides the done project');
  await chip('open').click();
  check((await cards()).length === 3, 'clicking the chip again shows all');

  console.log('\n[view] filters, sort and grouping, remembered after a reload');
  await page.click('#proj-view-btn');
  await page.selectOption('#pv-sort', 'likely');
  check((await cards()).join() === 'Kitchen refresh,Bath fixes,Laundry closet', 'sorted by likely cost, highest first (' + (await cards()).join() + ')');
  await page.selectOption('#pv-group', 'status');
  const heads = await page.locator('.proj-group-head span:first-child').allTextContents();
  check(heads.join() === 'Idea,Scoped,Done', 'grouped by status in status order (' + heads.join() + ')');
  await page.check('#pv-program');
  check((await cards()).join() === 'Kitchen refresh' && (await page.textContent('#proj-view-btn')) === 'VIEW · 1', 'in-program filter keeps the selected project, and VIEW counts one filter');
  await page.reload();
  await page.waitForSelector('#proj-list .proj-card');
  check((await cards()).join() === 'Kitchen refresh' && await page.locator('.proj-group-head').count() === 1, 'the filter and grouping come back after a reload');
  await page.click('#proj-clear');
  check((await cards()).length === 3 && await page.locator('#proj-clear').isHidden(), 'CLEAR shows everything and hides itself');
  await page.click('#proj-view-btn');
  await page.selectOption('#pv-group', 'none');
  await page.selectOption('#pv-sort', 'order');
  await page.click('#view .view-title');
  check(!(await page.locator('#proj-viewmenu').evaluate(d => d.open)), 'clicking outside closes the VIEW menu');

  console.log('\n[board] columns by status; drag and arrow keys move a project');
  await page.click('[data-layout="board"]');
  check(await page.locator('.pb-col').count() === 5, 'five status columns');
  check(await page.locator('.pb-col[data-col="idea"] .proj-card[data-id="proj-bath"]').count() === 1, 'Bath fixes sits in Idea');
  // The page's own drag events, in the browser's order, on one shared dataTransfer: Playwright's
  // pointer drag reaches the drop on some machines and not others (macOS CI missed it).
  const accepted = await page.evaluate(() => {
    const card = document.querySelector('.proj-card[data-id="proj-bath"]');
    const col = document.querySelector('.pb-col[data-col="committed"]');
    const dataTransfer = new DataTransfer();
    const fire = (el, type) => { const e = new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true }); el.dispatchEvent(e); return e; };
    fire(card, 'dragstart');
    const over = fire(col, 'dragover');
    fire(col, 'drop');
    fire(card, 'dragend');
    return over.defaultPrevented && !dataTransfer.types.includes('text/plain');
  });
  check(accepted, 'the column accepts the card, and the drag carries no text the link drop would take');
  check((await store(`return s.projectById('proj-bath').status`)) === 'committed', 'dragging to Committed changes the status');
  await page.locator('.proj-card[data-id="proj-bath"]').focus();
  await page.keyboard.press('ArrowRight');
  check((await store(`return s.projectById('proj-bath').status`)) === 'in-progress', 'ArrowRight moves it one column right');
  check(await page.evaluate(() => document.activeElement?.dataset.id === 'proj-bath'), 'the moved card keeps focus');
  await page.click('[data-layout="list"]');

  console.log('\n[summary] priced and done counts');
  await page.click('.proj-card[data-id="proj-kitchen"]');
  const summary = await page.textContent('.proj-summary');
  check(summary.includes('1 of 2') && summary.includes('items priced') && summary.includes('$360'), 'the summary says 1 of 2 priced and $360 likely (' + summary.replace(/\s+/g, ' ').trim() + ')');
  check((await page.textContent('.proj-card[data-id="proj-kitchen"] .p-sub')).includes('1 priced'), 'the card shows how many items are priced');
  await page.click('.proj-card[data-id="proj-laundry"]');
  check((await page.textContent('.proj-summary')).includes('1 of 1'), 'a fully priced project shows 1 of 1');

  console.log('\n[items] done checkbox and status');
  await page.click('.proj-card[data-id="proj-kitchen"]');
  await page.locator('tr[data-item="it-tile"] [data-done]').check();
  const tile = await store(`const i = s.projectById('proj-kitchen').items[0]; return i.status + ' ' + i.doneAt`);
  check(/^done \d{4}-\d{2}-\d{2}$/.test(tile), 'checking it marks the item done with today\'s date (' + tile + ')');
  const order = await page.locator('#items-table tr[data-item]').evaluateAll(rs => rs.map(r => r.dataset.item));
  check(order.join() === 'it-paint,it-tile', 'the done item moves to the bottom (' + order.join() + ')');
  check((await store(`return s.projectById('proj-kitchen').items.map(i => i.id).join()`)) === 'it-tile,it-paint', 'the stored order is unchanged');
  await page.click('tr[data-item="it-tile"] [data-toggle].it-toggle');
  await page.selectOption('tr[data-more="it-tile"] [data-istatus]', 'ordered');
  check((await store(`const i = s.projectById('proj-kitchen').items[0]; return i.status + '|' + i.doneAt`)) === 'ordered|', 'setting Ordered clears the done date');

  console.log('\n[panel] notes and links');
  const linkLine = await page.textContent('tr[data-item="it-tile"] .it-links');
  check(linkLine.includes('Ordered') && linkLine.includes('Kitchen · 1 product · 1 photo'), 'the line under the name shows Ordered, names the room and counts the product and photo (' + linkLine + ')');
  const panel = page.locator('tr[data-more="it-tile"]');
  check(await panel.locator('[data-inote]').inputValue() === 'Measured from the scan, 30 sf net.', 'the panel shows the item\'s notes');
  await panel.locator('[data-inote]').fill('Measured twice.');
  await panel.locator('[data-inote]').dispatchEvent('change');
  check((await store(`return s.projectById('proj-kitchen').items[0].notes`)) === 'Measured twice.', 'editing the notes saves them');
  await panel.locator('[data-add-el]').selectOption('w-north');
  check((await store(`return s.projectById('proj-kitchen').items[0].elementIds.join()`)) === 'r-kitchen,w-north', 'linking a wall adds it');
  await page.locator('tr[data-more="it-tile"] [data-unlink-el="w-north"]').click();
  check((await store(`return s.projectById('proj-kitchen').items[0].elementIds.join()`)) === 'r-kitchen', 'unlinking removes it again');
  check(await page.locator('tr[data-more="it-tile"] .ip-photos img').count() === 1, 'the linked photo shows as a thumbnail');

  console.log('\n[links] chips open MODEL, PRODUCTS and PHOTOS on the record');
  const roomChip = page.locator('tr[data-more="it-tile"] .link-chip a', { hasText: 'Kitchen' });
  check(await roomChip.getAttribute('href') === '#/model?select=r-kitchen' && await roomChip.getAttribute('title') === 'Open in MODEL', 'the room chip links to MODEL with the room selected');
  await roomChip.click();
  await page.waitForSelector('.inspector [data-name]');
  check(await page.inputValue('.inspector [data-name]') === 'Kitchen' && await page.evaluate(() => location.hash) === '#/model', 'MODEL opens with Kitchen selected, and the address is plain #/model');
  await page.goBack();
  await page.waitForSelector('tr[data-more="it-tile"]');
  check(true, 'Back returns to PROJECTS with the panel still open');
  await page.locator('tr[data-more="it-tile"] .link-chip a', { hasText: 'Subway tile' }).click();
  await page.waitForSelector('#prod-form [data-f="name"]');
  check(await page.inputValue('#prod-form [data-f="name"]') === 'Subway tile', 'PRODUCTS opens the linked product');
  await page.goBack();
  await page.locator('tr[data-more="it-tile"] .ip-photos a').click();
  await page.waitForSelector('.ph-card.active');
  check((await page.getAttribute('.ph-card.active', 'data-id')) === 'ph-tile', 'PHOTOS opens with the photo selected');
  await page.goBack();
  await page.locator('tr[data-more="it-tile"] [data-unlink-prod="prod-tile"]').click();
  check((await store(`return s.ws.data.products[0].itemIds.join()`)) === '', 'unlinking the product removes the item from it');

  console.log('\n[new] a new project is named in place');
  await page.click('#new-project');
  check(await page.evaluate(() => document.activeElement?.matches('#proj-detail [data-f="name"]') && document.activeElement.value === 'New project'), 'NEW PROJECT puts the cursor in its name field');
  await page.keyboard.press('Escape');
  check((await store(`return s.ws.data.projects.length`)) === 3, 'Esc on the untouched new project removes it');
  await page.click('#new-project');
  await page.keyboard.type('Porch steps');
  await page.keyboard.press('Enter');
  check((await cards()).includes('Porch steps'), 'typing a name and Enter keeps it');

  check(errors.length === 0, 'no page errors (' + errors.join('; ') + ')');
  console.log('\nprojects tab e2e passed');
} finally {
  await browser.close();
  server.close();
}
