// Subprojects in PROJECTS: added from a project, listed under its card (open first, highest
// priority first, done struck through), edited from the parent's table, linked to a room,
// moved between projects, labelled "Parent / Child" in BUDGET, and deleted with their project.
// Synthetic workspace only. Run: node tools/e2e-subprojects.mjs (Playwright + Chromium installed).
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
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const check = (ok, label) => { assert.ok(ok, label); console.log('  ok   ' + label); };
page.on('dialog', d => d.accept());
const data = () => page.evaluate(async () => {
  const s = await import('/js/store.js');
  return s.ws.data.projects.map(p => ({ id: p.id, name: p.name, parentId: p.parentId, priority: p.priority, roomId: p.roomId, source: p.source, status: p.status }));
});

try {
  await page.goto(url + '/#/plan');
  await page.waitForSelector('#btn-file');
  await page.evaluate(async () => {
    const s = await import('/js/store.js');
    s.ws.data = s.emptyWorkspace();
    const p = s.propertyTemplate('Test House');
    p.rooms.push({ id: 'r-bath', level: p.levels[0].id, name: 'Hall bath', pts: [[0, 0], [2, 0], [2, 2], [0, 2]], material: null, ceilingMaterial: null });
    s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id;
    s.ws.data.projects.push(
      { id: 'proj-list', name: 'Fix list', propertyId: p.id, category: 'interior', status: 'idea', selected: false, startDate: '', notes: '', items: [] },
      { id: 'proj-other', name: 'Kitchen', propertyId: p.id, category: 'kitchen', status: 'idea', selected: false, startDate: '', notes: '', items: [] },
    );
    s.touch();
  });
  await page.goto(url + '/#/projects');
  await page.waitForSelector('#proj-list .proj-card');

  console.log('\n[add] subprojects are added from the project and listed under its card');
  for (const name of ['Shelf in the basement bath', 'Door does not latch', 'Toilet is clogged']) {
    await page.click('.proj-card[data-id="proj-list"]');
    await page.click('#add-sub');
    await page.waitForSelector(`.sub-crumb`);
    // The new subproject's name field has focus; Enter keeps the typed name.
    check(await page.evaluate(() => document.activeElement?.matches('#proj-detail [data-f="name"]')), 'ADD SUBPROJECT puts the cursor in its name field');
    await page.keyboard.type(name);
    await page.keyboard.press('Enter');
  }
  let d = await data();
  const subs = d.filter(p => p.parentId === 'proj-list');
  check(subs.length === 3, 'three subprojects point at their project (' + subs.length + ')');
  check(await page.locator('#proj-list .proj-card').count() === 2, 'only top-level projects get cards');
  check(await page.locator('.sub-list[data-parent="proj-list"] .sub-row').count() === 3, 'the three subprojects sit under their card');
  check((await page.textContent('.view-sub')).includes('2 projects, 3 subprojects'), 'the header counts projects and subprojects');

  console.log('\n[edit] priority, status and room from the parent and the subproject');
  await page.click('.proj-card[data-id="proj-list"]');
  const row = name => page.locator('#subs-table tr', { hasText: name });
  await row('Toilet is clogged').locator('[data-sf="priority"]').selectOption('high');
  await row('Door does not latch').locator('[data-sf="priority"]').selectOption('medium');
  await row('Shelf in the basement bath').locator('[data-sf="status"]').selectOption('done');
  const order = await page.locator('.sub-list[data-parent="proj-list"] .sub-name').allTextContents();
  check(order.join(' | ') === 'Toilet is clogged | Door does not latch | Shelf in the basement bath', 'open subprojects come first, highest priority first (' + order.join(' | ') + ')');
  const doneRow = page.locator('.sub-row', { hasText: 'Shelf in the basement bath' });
  check(await doneRow.evaluate(n => n.classList.contains('done') && getComputedStyle(n.querySelector('.sub-name')).textDecorationLine === 'line-through'), 'a done subproject is struck through');
  check((await page.textContent('.proj-card[data-id="proj-list"] .p-sub')).includes('3 subprojects (2 open)'), 'the card counts open subprojects');

  await page.click('.sub-row:has-text("Toilet is clogged")');
  check((await page.textContent('.sub-crumb')).includes('Fix list'), 'a subproject names its project');
  await page.selectOption('#proj-detail [data-f="roomId"]', 'r-bath');
  await page.fill('#proj-detail [data-f="source"]', 'Shared note, line 1');
  await page.dispatchEvent('#proj-detail [data-f="source"]', 'change');
  d = await data();
  const toilet = d.find(p => p.name === 'Toilet is clogged');
  check(toilet.roomId === 'r-bath' && toilet.source === 'Shared note, line 1' && toilet.priority === 'high', 'room, source and priority are stored on the subproject');
  await page.click('.sub-crumb [data-open]');
  check((await row('Toilet is clogged').locator('td').nth(3).textContent()).trim() === 'Hall bath', 'the parent\'s table shows the room');

  console.log('\n[move] a subproject moves to another project; a project with subprojects cannot become one');
  await page.click('.sub-row:has-text("Door does not latch")');
  await page.selectOption('#proj-detail [data-f="parentId"]', 'proj-other');
  d = await data();
  check(d.find(p => p.name === 'Door does not latch').parentId === 'proj-other', 'the subproject now belongs to Kitchen');
  check(await page.locator('.sub-list[data-parent="proj-other"] .sub-row').count() === 1, 'it is listed under Kitchen');
  await page.click('.proj-card[data-id="proj-list"]');
  check(await page.locator('#proj-detail [data-f="parentId"]').isDisabled(), 'a project with subprojects cannot be put under another');

  console.log('\n[budget] subprojects are labelled with their project');
  await page.evaluate(async () => { const s = await import('/js/store.js'); for (const p of s.ws.data.projects) p.selected = true; s.touch(); });
  await page.goto(url + '/#/budget');
  await page.waitForSelector('.view-title');
  check((await page.textContent('body')).includes('Fix list / Toilet is clogged'), 'BUDGET shows "Fix list / Toilet is clogged"');

  console.log('\n[delete] deleting a project deletes its subprojects');
  await page.goto(url + '/#/projects');
  await page.waitForSelector('#proj-list .proj-card');
  await page.click('.proj-card[data-id="proj-list"]');
  await page.click('#del-project');
  d = await data();
  check(d.map(p => p.name).sort().join() === 'Door does not latch,Kitchen', 'only Kitchen and its subproject remain (' + d.map(p => p.name).join() + ')');

  console.log('\n[property] PROJECTS, BUDGET and SCHEDULE follow the PROPERTY picker');
  const second = await page.evaluate(async () => {
    const s = await import('/js/store.js');
    // Kitchen stays on Test House and gets schedulable work, so leaving it out of SCHEDULE means something.
    s.projectById('proj-other').items.push({ id: 'it-cab', name: 'Cabinets', qty: 1, unit: 'ls', low: 0, likely: 0, high: 0, durationDays: 2, deps: [], elementIds: [], notes: '' });
    const q = s.propertyTemplate('Lake Cabin');
    s.ws.data.properties.push(q);
    s.ws.data.projects.push({ id: 'proj-cabin', name: 'Cabin porch', propertyId: q.id, category: 'exterior', status: 'idea', selected: true, startDate: '', notes: '',
      items: [{ id: 'it-porch', name: 'Porch boards', qty: 1, unit: 'ls', low: 900, likely: 1000, high: 1100, durationDays: 3, deps: [], elementIds: [], notes: '' }] });
    s.touch();
    return q.id;
  });
  await page.goto(url + '/#/projects');
  await page.waitForSelector('#proj-list .proj-card');
  const cards = () => page.locator('#proj-list .proj-card b').allTextContents();
  check((await cards()).join() === 'Kitchen', 'Test House lists only its own project (' + (await cards()).join() + ')');
  await page.selectOption('#property-select', second);
  await page.waitForSelector('#proj-list .proj-card[data-id="proj-cabin"]');
  check((await cards()).join() === 'Cabin porch', 'Lake Cabin lists only its own project (' + (await cards()).join() + ')');
  await page.goto(url + '/#/budget');
  await page.waitForSelector('.view-title');
  const budget = await page.textContent('body');
  check(budget.includes('Cabin porch') && !budget.includes('Kitchen'), 'BUDGET shows the Lake Cabin project only');
  await page.goto(url + '/#/schedule');
  await page.waitForSelector('.view-title');
  const gantt = (await page.textContent('#gantt')).toLowerCase();   // the chart draws names in capitals
  check(gantt.includes('cabin porch') && !gantt.includes('kitchen'), 'SCHEDULE shows the Lake Cabin project only');
  check((await data()).length === 3, 'switching property keeps every project in the workspace');

  check(errors.length === 0, 'no page errors (' + errors.join('; ') + ')');
  console.log('\nsubprojects e2e passed');
} finally {
  await browser.close();
  server.close();
}
