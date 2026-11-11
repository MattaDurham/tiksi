// Phone-size load budget: the first open of the app on a phone screen, from an empty browser,
// may use at most LIMITS files and bytes. It fails when the download grows past them, and
// prints what it measured so the limits can be lowered as the download shrinks.
// Synthetic empty project in a temporary state directory; live 8642 is never used.
//
// Files and bytes count the app's own files: every response except the /api/ calls, whose
// number changes from run to run with how often the empty project is saved; they are printed.
// Bytes are what the phone downloads: each file's body as sent, compressed where the server
// compresses it. The uncompressed total, what the phone stores and parses, is printed beside
// it for reference. Time to settle is printed, not graded: it depends on the machine.
//
// Every request of the first load must be answered. Chromium also reports a request as
// cancelled when the page has read its whole answer but lets go of it before the browser has
// noted the request finished; on Chromium such a request, with every declared byte received,
// is printed and not counted as a failure.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { chromium, devices, webkit } from 'playwright';

// Measured on 2026-11-10 on the combined audit branch (codex/audit-fixes-4 at eab73c8), three
// runs alike on Chromium: 159 files and 1,191,021 bytes downloaded (4,062,859 uncompressed).
// WebKit also fetches the 363-byte app manifest. The limits leave about 5 percent for growth.
// Lower them when the download shrinks; raise them only with a reason in the commit.
export const LIMITS = { requests: 167, bytes: 1_250_000 };
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
  const failures = [];
  page.on('requestfailed', request => failures.push(request));
  // What Chromium itself saw of each request: how many bytes it declared and received.
  const seen = new Map();
  if (ENGINE === 'chromium') {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    const entry = id => seen.get(id) || seen.set(id, { received: 0 }).get(id);
    cdp.on('Network.requestWillBeSent', e => { entry(e.requestId).url = e.request.url; });
    cdp.on('Network.responseReceived', e => {
      const headers = Object.fromEntries(Object.entries(e.response.headers).map(([k, v]) => [k.toLowerCase(), v]));
      Object.assign(entry(e.requestId), { status: e.response.status, declared: Number(headers['content-length']), encoded: !!headers['content-encoding'] });
    });
    cdp.on('Network.dataReceived', e => { const r = entry(e.requestId); r.received += r.encoded ? e.encodedDataLength : e.dataLength; });
    cdp.on('Network.loadingFailed', e => Object.assign(entry(e.requestId), { canceled: e.canceled }));
  }
  // Each failure Playwright reports is matched, in order, with the one Chromium saw fail.
  const used = new Set();
  const whole = request => {
    const r = [...seen.values()].find(r => !used.has(r) && 'canceled' in r && r.url === request.url());
    if (!r) return false;
    used.add(r);
    return r.canceled && r.status >= 200 && r.status < 300 && Number.isInteger(r.declared) && r.received >= r.declared;
  };
  const started = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#save-status')?.textContent === 'SAVED TO DISK', null, { timeout: 120000 });
  // Then until nothing new has been asked for in two seconds: late imports count too.
  let count = -1;
  while (count !== responses.length) { count = responses.length; await page.waitForTimeout(2000); }
  const settledMs = Date.now() - started - 2000;
  let bytes = 0, decoded = 0;
  const byType = {};
  const api = responses.filter(r => new URL(r.url()).pathname.startsWith('/api/')).length;
  const files = responses.filter(r => !new URL(r.url()).pathname.startsWith('/api/'));
  for (const response of files) {
    const body = await response.body().catch(() => Buffer.alloc(0));
    const sent = (await response.request().sizes().catch(() => null))?.responseBodySize ?? body.length;
    bytes += sent;
    decoded += body.length;
    const type = (response.headers()['content-type'] || 'other').split(';')[0];
    byType[type] = (byType[type] || 0) + sent;
  }
  const heaviest = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `${t} ${n.toLocaleString('en-US')}`).join(', ');
  console.log(`Phone first load on ${ENGINE}: ${files.length} files (limit ${LIMITS.requests}), ${bytes.toLocaleString('en-US')} bytes downloaded (limit ${LIMITS.bytes.toLocaleString('en-US')}), ${decoded.toLocaleString('en-US')} bytes uncompressed, ${api} calls to the server, settled in ${(settledMs / 1000).toFixed(1)} s. Largest kinds downloaded: ${heaviest}.`);
  const named = request => `${request.method()} ${new URL(request.url()).pathname} (${request.failure()?.errorText || 'failed'})`;
  const late = [], failed = [];
  for (const request of failures) (whole(request) ? late : failed).push(request);
  if (late.length) console.log(`Answered in full, then reported cancelled by Chromium: ${late.map(named).join(', ')}.`);
  assert.deepEqual(failed.map(named), [], 'every request of the first load is answered');
  assert.deepEqual(errors, [], 'no page errors on the first load');
  assert.ok(files.length <= LIMITS.requests, `the first load asks for ${files.length} files, over the limit of ${LIMITS.requests}`);
  assert.ok(bytes <= LIMITS.bytes, `the first load downloads ${bytes.toLocaleString('en-US')} bytes, over the limit of ${LIMITS.bytes.toLocaleString('en-US')}`);
  console.log('Load budget passed.');
} finally {
  if (browser) await browser.close();
  child.kill();
  await rm(state, { recursive: true, force: true });
}
