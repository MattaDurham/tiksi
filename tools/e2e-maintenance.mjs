// MAINTENANCE: the service list is built from the property's fixtures and house systems; typed
// dates and appointments drive what is due this month; a booked visit leaves the due list and,
// once it has happened, fills in the last-done date; a calendar file adds matching visits only.
// Synthetic workspace only, with the browser clock fixed at 2026-11-04.
// Run: node tools/e2e-maintenance.mjs (Playwright + Chromium installed).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
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
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
const page = await context.newPage();
await page.clock.setFixedTime(new Date(2026, 10, 4, 10, 0));
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', d => d.accept());
const check = (ok, label) => { assert.ok(ok, label); console.log('  ok   ' + label); };
const m = () => page.evaluate(async () => (await import('/js/store.js')).activeProperty().maintenance);
const dueIds = () => page.$$eval('.maint-due tbody tr[data-task]', rows => rows.map(r => r.dataset.task));
const kpi = k => page.textContent(`[data-kpi="${k}"]`);

try {
  await page.goto(url + '/#/plan');
  await page.waitForSelector('#btn-file');
  await page.evaluate(async () => {
    const s = await import('/js/store.js');
    s.ws.data = s.emptyWorkspace();
    const p = s.propertyTemplate('Test House');
    const lvl = p.levels[0].id;
    p.rooms.push({ id: 'r-k', level: lvl, name: 'Kitchen', pts: [[0, 0], [4, 0], [4, 4], [0, 4]], material: null, ceilingMaterial: null });
    p.fixtures.push(
      { id: 'fx-dw', kind: 'appliance', subtype: 'dishwasher', level: lvl, x: 1, y: 1, rot: 0, w: 0.6, d: 0.6, h: 0.86, y0: 0, name: '', provenance: { source: 'scan', confidence: 0.8 } },
      { id: 'fx-fr', kind: 'appliance', subtype: 'fridge', level: lvl, x: 3, y: 1, rot: 0, w: 0.76, d: 0.72, h: 1.75, y0: 0, name: '', provenance: { source: 'scan', confidence: 0.8 } },
      { id: 'fx-bed', kind: 'furniture', subtype: 'bed', level: lvl, x: 8, y: 8, rot: 0, w: 2, d: 1.6, h: 0.6, y0: 0, name: '', provenance: { source: 'user', confidence: null } },
    );
    s.ws.data.properties.push(p); s.ws.data.settings.activePropertyId = p.id;
    s.touch();
  });
  await page.click('#rail a[data-view="maintenance"]');
  await page.waitForSelector('.maint-all');

  console.log('\n[list] fixtures bring their service; furniture brings none');
  const rows = await page.$$eval('.maint-all tbody tr[data-task]', r => r.map(x => x.dataset.task));
  check(JSON.stringify(rows) === JSON.stringify(['fx-dw/filter', 'fx-fr/coils', 'fx-fr/water-filter']), 'dishwasher and fridge service is listed, the bed has none');
  check((await page.textContent('.maint-all tbody tr[data-task="fx-dw/filter"]')).includes('Kitchen'), 'a fixture shows the room it stands in');
  check(await kpi('unknown') === '3' && await kpi('due') === '0', 'with no dates nothing is due and three have no last-done date');

  console.log('\n[systems] house systems are added from the presets and by name');
  await page.click('[data-sys-add="chimney"]');
  await page.click('[data-sys-add="piano"]');
  await page.fill('#maint-sys-name', 'Well pump');
  await page.press('#maint-sys-name', 'Enter');
  check((await m()).systems.map(s => s.kind).join(',') === 'chimney,piano,other', 'chimney, piano and a named system are saved on the property');
  check(await page.isDisabled('[data-sys-add="chimney"]'), 'a preset already added cannot be added twice');

  console.log('\n[dates] typed last-done dates and intervals decide what is due');
  const ch = (await m()).systems[0].id, pi = (await m()).systems[1].id;
  await page.fill(`[data-last="fx-fr/coils"]`, '2025-11-20');
  await page.dispatchEvent(`[data-last="fx-fr/coils"]`, 'change');
  await page.fill(`[data-last="${pi}/tune"]`, '2025-09-15');
  await page.dispatchEvent(`[data-last="${pi}/tune"]`, 'change');
  check(JSON.stringify(await dueIds()) === JSON.stringify([`${pi}/tune`, 'fx-fr/coils']), 'the overdue piano tuning comes first, then the coils due this month');
  check((await page.textContent(`.maint-due tr[data-task="${pi}/tune"]`)).includes('OVERDUE'), 'the piano row says overdue');
  await page.fill('[data-interval="fx-fr/coils"]', '24');
  await page.dispatchEvent('[data-interval="fx-fr/coils"]', 'change');
  check(JSON.stringify(await dueIds()) === JSON.stringify([`${pi}/tune`]), 'a longer interval moves the coils out of this month');
  await page.click('[data-off="fx-fr/water-filter"]');
  check((await m()).records.find(r => r.key === 'water-filter').off === true, 'a service can be skipped');

  console.log('\n[book] an appointment matches its service from the name and leaves the due list');
  await page.click(`[data-book="${pi}/tune"]`);
  await page.fill('#maint-draft [data-d="date"]', '2026-11-18');
  await page.click('#maint-save');
  check(JSON.stringify(await dueIds()) === '[]', 'the booked piano tuning is no longer due');
  check(await kpi('booked') === '1', 'one appointment is booked');
  await page.click('#maint-book');
  await page.fill('#maint-draft [data-d="date"]', '2026-12-02');
  await page.fill('#maint-draft [data-d="start"]', '09:30');
  await page.fill('#maint-draft [data-d="end"]', '10:00');
  await page.fill('#maint-draft [data-d="title"]', 'Rory: chimney sweep');
  check(await page.inputValue('#maint-draft [data-d="task"]') === `${ch}/sweep`, 'typing "Rory: chimney sweep" picks the chimney');
  await page.click('#maint-save');
  const appt = (await m()).appointments.find(a => a.title === 'Rory: chimney sweep');
  check(appt && appt.on === ch && appt.start === '09:30' && appt.end === '10:00', 'the visit is saved with its times and service');
  check((await page.textContent('.maint-appts')).includes('Dec 2, 2026, 9:30 AM to 10 AM'), 'the appointment reads Dec 2, 9:30 AM to 10 AM');

  console.log('\n[ics] a calendar file adds only the events that match a service, once');
  const ics = ['BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'SUMMARY:Dishwasher filter clean', 'DTSTART:20260815T140000', 'DTEND:20260815T143000', 'END:VEVENT',
    'BEGIN:VEVENT', 'SUMMARY:Dentist', 'DTSTART:20261120T090000', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const file = { name: 'house.ics', mimeType: 'text/calendar', buffer: Buffer.from(ics) };
  await page.setInputFiles('#maint-ics-file', file);
  await page.waitForSelector('.maint-notice');
  check((await page.textContent('.maint-notice')).startsWith('1 appointment added from house.ics; 1 event left out'), 'the dentist is left out and the notice says so');
  const dw = await page.textContent('.maint-all tr[data-task="fx-dw/filter"]');
  check(dw.includes('from appointment') && await page.inputValue('[data-last="fx-dw/filter"]') === '2026-08-15', 'a past appointment fills in the dishwasher last-done date');
  check(JSON.stringify(await dueIds()) === JSON.stringify(['fx-dw/filter']), 'counted from Aug 15 every 3 months, the dishwasher filter is due this month');
  // The guide and the PR show this moment: one service due, three appointments, one counted as done.
  await mkdir(resolve(root, 'test-results'), { recursive: true });
  await page.waitForFunction(() => document.querySelector('.maint').getAnimations({ subtree: true }).every(a => a.playState !== 'running'));
  await page.screenshot({ path: resolve(root, 'test-results/maintenance.png') });
  await page.setInputFiles('#maint-ics-file', []);
  await page.setInputFiles('#maint-ics-file', file);
  await page.waitForFunction(() => document.querySelector('.maint-notice')?.textContent.includes('already here'));
  check((await m()).appointments.length === 3, 're-importing the same file adds nothing twice');

  console.log('\n[done] DONE TODAY records today and the item leaves the list');
  await page.click('[data-done="fx-dw/filter"]');
  check(JSON.stringify(await dueIds()) === '[]' && await page.inputValue('[data-last="fx-dw/filter"]') === '2026-11-04', 'DONE TODAY writes today and clears the due list');

  console.log('\n[file] the schedule travels in the project file and survives a reload');
  const slice = await page.evaluate(async () => { const s = await import('/js/store.js'); return s.projectSlice(s.activeProperty().id).properties[0].maintenance; });
  check(slice.appointments.length === 3 && slice.systems.length === 3, 'the project file carries systems and appointments');
  await page.evaluate(async () => (await import('/js/store.js')).save());
  await page.reload();
  await page.waitForSelector('.maint-all');
  check((await m()).appointments.length === 3 && await kpi('booked') === '2', 'after a reload the appointments are still there');

  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  console.log('\nmaintenance E2E passed');
} finally {
  await browser.close();
  server.close();
}
