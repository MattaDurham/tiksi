// A project's rooms in ESTIMATE (each a subproject): a new project, rooms added from the model or
// not in it, renamed and linked to a model room, a scope item in a room, a room removed and kept
// in REMOVED RECORDS, the project deleted with its rooms, and ESTIMATE and SCHEDULE following the
// property picker.
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
const until = async (fn, what, ms = 15000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('Timed out: ' + what); await new Promise(r => setTimeout(r, 100)); } };
const data = () => page.evaluate(async () => {
  const s = await import('/js/store.js');
  return s.ws.data.projects.map(p => ({ id: p.id, name: p.name, parentId: p.parentId, priority: p.priority, roomId: p.roomId, source: p.source, status: p.status }));
});

try {
  await page.goto(url + '/#/estimate');
  await page.waitForSelector('#btn-file', { state: 'attached' });
  await page.evaluate(async () => {
    const s = await import('/js/store.js');
    s.ws.data = s.emptyWorkspace();
    const p = s.propertyTemplate('Test House');
    p.rooms.push({ id: 'r-bath', level: p.levels[0].id, name: 'Hall bath', pts: [[0, 0], [2, 0], [2, 2], [0, 2]], material: null, ceilingMaterial: null });
    s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id;
    s.ws.data.projects.push({ id: 'proj-other', name: 'Kitchen', propertyId: p.id, category: 'kitchen', status: 'idea', selected: false, startDate: '', notes: '', items: [] });
    s.touch();
  });
  await page.goto(url + '/#/estimate?project=proj-other');
  await page.waitForSelector('.es-head [data-jf="name"]');

  console.log('\n[new] a project is started and named in ESTIMATE');
  await page.click('[data-new-job]');
  await page.waitForFunction(() => document.activeElement?.matches('[data-jf="name"]'));
  check(true, '+ NEW PROJECT puts the cursor in its name');
  await page.keyboard.type('Fix list'); await page.keyboard.press('Tab');
  await until(async () => (await data()).some(p => p.name === 'Fix list' && !p.parentId), 'the named project');
  const fix = (await data()).find(p => p.name === 'Fix list');
  await page.selectOption('[data-jf="status"]', 'scoped');
  await until(async () => (await data()).find(p => p.id === fix.id).status === 'scoped', 'its status');
  check(true, 'its status is set at the top');

  console.log('\n[rooms] rooms come from the model, or are named when not in it');
  await page.selectOption('[data-add-room]', 'r-bath');
  await until(async () => (await data()).some(p => p.parentId === fix.id && p.roomId === 'r-bath' && p.name === 'Hall bath'), 'the bath');
  check(true, 'a model room becomes a room of the project with its name and link');
  await page.selectOption('[data-add-room]', '-');
  await page.waitForFunction(() => document.activeElement?.matches('[data-rf="name"]'));
  await page.keyboard.type('Basement'); await page.keyboard.press('Tab');
  await until(async () => (await data()).some(p => p.parentId === fix.id && p.name === 'Basement' && !p.roomId), 'the basement');
  check(true, 'a room not in the model is named where it is added');
  const basement = (await data()).find(p => p.name === 'Basement');
  await page.selectOption(`[data-rf="roomId"][data-room-of="${basement.id}"]`, 'r-bath');
  await until(async () => (await data()).find(p => p.id === basement.id).roomId === 'r-bath', 'linked');
  await page.selectOption(`[data-rf="roomId"][data-room-of="${basement.id}"]`, '');
  check(true, 'a room can be linked to a model room and unlinked');

  console.log('\n[items] a scope item in a room');
  await page.click(`[data-add-item="${basement.id}"]`);
  await page.waitForSelector(`tr[data-si]`);
  await page.keyboard.type('Shelf'); await page.keyboard.press('Tab');
  await until(async () => page.evaluate(async id => (await import('/js/store.js')).projectById(id).items[0]?.name === 'Shelf', basement.id), 'the item');
  check(true, 'ADD ITEM puts the cursor in the new item\'s name');

  console.log('\n[remove] a room is removed and kept; the project is deleted with its rooms');
  await page.click(`[data-del-room="${basement.id}"]`);
  await until(async () => !(await data()).some(p => p.id === basement.id), 'removed');
  check(await page.evaluate(async id => (await import('/js/store.js')).activeProperty().removedRecords.some(e => e.kind === 'projects' && e.records.some(r => r.id === id && r.items.length === 1)), basement.id), 'the removed room is kept in REMOVED RECORDS with its item');
  await page.click('[data-del-job]');
  await until(async () => !(await data()).some(p => p.id === fix.id || p.parentId === fix.id), 'deleted');
  check((await data()).map(p => p.name).join() === 'Kitchen', 'deleting the project deletes its rooms; Kitchen remains');

  console.log('\n[property] ESTIMATE and SCHEDULE follow the property picker');
  const second = await page.evaluate(async () => {
    const s = await import('/js/store.js');
    s.projectById('proj-other').items.push({ id: 'it-cab', name: 'Cabinets', qty: 1, unit: 'ls', low: 0, likely: 0, high: 0, durationDays: 2, deps: [], elementIds: [], notes: '' });
    const q = s.propertyTemplate('Lake Cabin');
    s.ws.data.properties.push(q);
    s.ws.data.projects.push({ id: 'proj-cabin', name: 'Cabin porch', propertyId: q.id, category: 'exterior', status: 'idea', selected: true, startDate: '', notes: '',
      items: [{ id: 'it-porch', name: 'Porch boards', qty: 1, unit: 'ls', low: 900, likely: 1000, high: 1100, durationDays: 3, deps: [], elementIds: [], notes: '' }] });
    s.touch();
    return q.id;
  });
  await page.selectOption('#property-select', second);
  await page.goto(url + '/#/estimate?program');
  await page.waitForSelector('.es-in h1');
  let nav = (await page.textContent('.es-nav')).toLowerCase();
  check(nav.includes('cabin porch') && !nav.includes('kitchen'), 'ESTIMATE lists the Lake Cabin project only');
  await page.goto(url + '/#/schedule?program');
  await page.waitForSelector('.sc-in h1');
  nav = (await page.textContent('.es-nav')).toLowerCase();
  check(nav.includes('cabin porch') && !nav.includes('kitchen'), 'SCHEDULE lists the Lake Cabin project only');
  check((await data()).length === 2, 'switching property keeps every project in the workspace');

  check(errors.length === 0, 'no page errors (' + errors.join('; ') + ')');
  console.log('\nrooms e2e passed');
} finally {
  await browser.close();
  server.close();
}
