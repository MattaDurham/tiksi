// Network fault injection uses Playwright routing, which service workers bypass.
// The real service-worker/offline journey is covered in e2e-audit-repairs.mjs.
// CLEAN UNUSED STORAGE on the Mac, in FILE → Settings → Workspace backup & maintenance: a press
// lists what a clean-up would remove before anything goes; nothing to remove offers no REMOVE;
// REMOVE sends back exactly that list, and a list that changed meanwhile is shown again to be
// confirmed; a touch device sees the list but no REMOVE; a server without the call shows no
// control. Made-up saved copies and stored originals in a temporary state folder; live 8642 is
// never used.
// Run: node tools/e2e-mac-cleanup.mjs (Playwright + Chromium installed).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { chromium, devices } from 'playwright';

const check = (ok, label) => { assert.ok(ok, label); console.log('  ok   ' + label); };
const state = await mkdtemp(tmpdir() + '/tiksi-mac-cleanup-test-');
const history = state + '/workspace/history', blobs = state + '/workspace/blobs';
await mkdir(history, { recursive: true }); await mkdir(blobs, { recursive: true });
const longAgo = days => (Date.now() - days * 86400000) / 1000;
// Sixty saved copies from one day 200 days ago: the newest fifty and one for that month stay, so
// a clean-up may remove the ten oldest. Their numbers are far above the ones this run saves.
for (let n = 100001; n <= 100060; n++) {
  const file = `${history}/${n}.json`;
  await writeFile(file, JSON.stringify({ revision: n, data: { version: 1, properties: [] }, assets: {} }));
  await utimes(file, longAgo(200), longAgo(200));
}
// Stored originals nothing refers to, last sent 40 days ago.
const orphan = async size => {
  const name = randomBytes(32).toString('hex');
  await writeFile(`${blobs}/${name}`, randomBytes(size));
  await utimes(`${blobs}/${name}`, longAgo(40), longAgo(40));
  return name;
};
await orphan(1000); await orphan(2000);

const socket = net.createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const child = spawn('python3', ['tools/serve.py', '--port', String(port), '--state-dir', state, '--projects-dir', state + '/projects'], { stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.resume(); child.stderr.resume();
const url = 'http://127.0.0.1:' + port;
let browser;
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [];
  const open = async (options = {}, prepare) => {
    const context = await browser.newContext({ ...options, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    if (prepare) await prepare(page);
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('#save-status')?.textContent === 'SAVED TO DISK', null, { timeout: 120000 });
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('tiksi:files', { detail: { tab: 'settings' } })));
    await page.locator('[data-file-dialog] details summary', { hasText: 'Workspace backup' }).click();
    return { context, page };
  };
  const plan = page => page.locator('[data-mac-cleanup-plan]');
  const remove = page => page.locator('[data-mac-cleanup-remove]');
  const status = page => page.locator('[data-file-status]');

  // A server without the call: no control.
  {
    const { context, page } = await open({}, page => page.route('**/api/workspace/capabilities', async route => {
      const response = await route.fetch(); const body = await response.json();
      await route.fulfill({ response, json: { ...body, features: body.features.filter(f => f !== 'storage-cleanup') } });
    }));
    await page.waitForTimeout(1000);
    check(await page.locator('[data-mac-cleanup]').isHidden(), 'no clean-up control against a server without the call');
    check(await page.locator('[data-storage]').isHidden(), "the browser's own clean-up stays hidden for project files on the Mac");
    await context.close();
  }

  // A phone: the list, no REMOVE.
  {
    const { defaultBrowserType, ...iphone } = devices['iPhone 13'];
    const { context, page } = await open(iphone);
    await page.locator('[data-mac-cleanup-list]').click();
    await page.waitForFunction(() => document.querySelector('[data-mac-cleanup-plan]')?.textContent);
    const text = await plan(page).textContent();
    check(/^A clean-up would remove 10 saved copies and 2 stored originals, .+ in all\./.test(text), 'the phone shows what a clean-up would remove: ' + text.split('.')[0]);
    check(/Always kept: the newest saved copy holding each property, every original a project file or a kept copy refers to/.test(text), 'and what always stays');
    check(/Removing is done from Tiksi on the Mac itself/.test(text) && await remove(page).isHidden(), 'and offers no REMOVE');
    await context.close();
  }
  check((await readdir(history)).filter(n => n.startsWith('1000')).length === 60 && (await readdir(blobs)).length >= 2, 'listing removed nothing');

  // The Mac: list, a list that changed, remove, then nothing to remove.
  {
    const { context, page } = await open({ viewport: { width: 1280, height: 900 } });
    await page.locator('[data-mac-cleanup-list]').click();
    await page.waitForFunction(() => /would remove/.test(document.querySelector('[data-mac-cleanup-plan]')?.textContent || ''));
    const first = await plan(page).textContent();
    check(/^A clean-up would remove 10 saved copies and 2 stored originals, /.test(first), 'the list comes first: ' + first.split('.')[0]);
    check(await remove(page).isVisible(), 'with REMOVE on the Mac');
    check(/Nothing is removed until REMOVE is pressed/.test(await status(page).textContent()), 'and nothing is removed yet');
    const late = await orphan(4000);
    await remove(page).click();
    await page.waitForFunction(() => /changed since it was listed/.test(document.querySelector('[data-mac-cleanup-plan]')?.textContent || ''));
    const changed = await plan(page).textContent();
    check(/nothing was removed\. The new list: A clean-up would remove 10 saved copies and 3 stored originals/.test(changed), 'a list that changed meanwhile is shown again: ' + changed.split(':')[0]);
    check((await readdir(blobs)).includes(late) && (await readdir(history)).filter(n => n.startsWith('1000')).length === 60, 'and nothing was removed');
    check(await remove(page).isVisible(), 'REMOVE asks again');
    await remove(page).click();
    await page.waitForFunction(() => /^Removed /.test(document.querySelector('[data-mac-cleanup-plan]')?.textContent || ''));
    const done = await plan(page).textContent();
    check(/^Removed 10 saved copies and 3 stored originals from the Mac; .+ freed\.$/.test(done), 'the result says what went and how much was freed: ' + done);
    check(await remove(page).isHidden(), 'REMOVE goes away after removing');
    const left = (await readdir(history)).filter(n => n.startsWith('1000')).sort();
    check(left.length === 50 && left[0] === '100011.json', 'the ten oldest copies went and the newest fifty stayed');
    check(!(await readdir(blobs)).includes(late), 'the originals nothing refers to went');
    await page.locator('[data-mac-cleanup-list]').click();
    await page.waitForFunction(() => /^Nothing on the Mac can be removed/.test(document.querySelector('[data-mac-cleanup-plan]')?.textContent || ''));
    check(await remove(page).isHidden(), 'with nothing to remove it says so and offers no REMOVE');
    check(/Nothing to remove/.test(await status(page).textContent()), 'and the status line agrees');
    await context.close();
  }
  assert.deepEqual(errors, [], 'no page errors');
  console.log('Mac clean-up passed.');
} finally {
  if (browser) await browser.close();
  child.kill();
  await rm(state, { recursive: true, force: true });
}
