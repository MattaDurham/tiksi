// Phone-size load budget: the first open of the app on a phone screen, from an empty browser,
// may use at most LIMITS requests and bytes. It fails when the download grows past them, and
// prints what it measured so the limits can be lowered as the download shrinks.
// Synthetic empty project in a temporary state directory; live 8642 is never used.
//
// Requests and bytes count the app's own files: every response except the /api/ calls, whose
// number changes from run to run with how often the empty project is saved; they are printed.
// Bytes are uncompressed bodies, which is what the phone stores and parses (the server does
// not compress). Time to settle is printed, not graded: it depends on the machine.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { chromium, devices, webkit } from 'playwright';

// Measured on 2026-11-10 (main at f292de2), three runs alike: 151 files and 3,842,709 bytes on
// Chromium; WebKit also fetches the 363-byte app manifest. The limits leave 5 percent for
// growth. Lower them when the download shrinks; raise them only with a reason in the commit.
export const LIMITS = { requests: 159, bytes: 4_035_000 };
const ENGINE = process.env.E2E_BROWSER === 'webkit' ? 'webkit' : 'chromium';

const state = await mkdtemp(tmpdir() + '/tiksi-load-budget-test-');
const socket = net.createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const child = spawn('python3', ['tools/serve.py', '--port', String(port), '--state-dir', state], { stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.resume();
child.stderr.resume();
const url = 'http://127.0.0.1:' + port;
let browser;
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  browser = ENGINE === 'webkit' ? await webkit.launch() : await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const { defaultBrowserType, ...iphone } = devices['iPhone 13'];
  const context = await browser.newContext(iphone);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const responses = [];
  page.on('response', response => responses.push(response));
  let failed = 0;
  page.on('requestfailed', () => { failed += 1; });
  const started = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#save-status')?.textContent === 'SAVED TO DISK', null, { timeout: 120000 });
  // Then until nothing new has been asked for in two seconds: late imports count too.
  let count = -1;
  while (count !== responses.length) { count = responses.length; await page.waitForTimeout(2000); }
  const settledMs = Date.now() - started - 2000;
  let bytes = 0;
  const byType = {};
  const api = responses.filter(r => new URL(r.url()).pathname.startsWith('/api/')).length;
  const files = responses.filter(r => !new URL(r.url()).pathname.startsWith('/api/'));
  for (const response of files) {
    const body = await response.body().catch(() => Buffer.alloc(0));
    bytes += body.length;
    const type = (response.headers()['content-type'] || 'other').split(';')[0];
    byType[type] = (byType[type] || 0) + body.length;
  }
  const heaviest = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `${t} ${n.toLocaleString('en-US')}`).join(', ');
  console.log(`Phone first load on ${ENGINE}: ${files.length} files (limit ${LIMITS.requests}), ${bytes.toLocaleString('en-US')} bytes (limit ${LIMITS.bytes.toLocaleString('en-US')}), ${api} calls to the server, settled in ${(settledMs / 1000).toFixed(1)} s. Largest kinds: ${heaviest}.`);
  assert.equal(failed, 0, 'every request of the first load is answered');
  assert.deepEqual(errors, [], 'no page errors on the first load');
  assert.ok(files.length <= LIMITS.requests, `the first load asks for ${files.length} files, over the limit of ${LIMITS.requests}`);
  assert.ok(bytes <= LIMITS.bytes, `the first load downloads ${bytes.toLocaleString('en-US')} bytes, over the limit of ${LIMITS.bytes.toLocaleString('en-US')}`);
  console.log('Load budget passed.');
} finally {
  if (browser) await browser.close();
  child.kill();
  await rm(state, { recursive: true, force: true });
}
