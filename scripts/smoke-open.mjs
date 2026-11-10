#!/usr/bin/env node
// The merge check's one browser step: open the app in the current folder once in a windowless
// Chromium, on a private port with an empty temporary state folder, visit every page in the
// rail, and fail on any page error. It takes about ten seconds; the full browser suites run
// in the online checks. Live 8642 is never used.
//
//   node scripts/smoke-open.mjs
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const LIMIT_MS = Number(process.env.SMOKE_LIMIT_MS) || 90000;
if (process.argv.length > 2) { console.error(`Unknown argument ${process.argv[2]}`); process.exit(2); }

// Playwright from the tree being opened, so the live checkout's copy of this file can open a
// branch copy.
let chromium;
try { ({ chromium } = createRequire(path.join(process.cwd(), 'package.json'))('playwright')); }
catch { console.error('smoke-open: Playwright is not installed in this folder; run npm ci here first.'); process.exit(1); }

const state = await mkdtemp(path.join(tmpdir(), 'tiksi-smoke-open-'));
const socket = net.createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const server = spawn('python3', ['tools/serve.py', '--host', '127.0.0.1', '--port', String(port), '--state-dir', state],
  { stdio: ['ignore', 'ignore', 'pipe'] });
const serverErr = [];
server.stderr.on('data', d => { serverErr.push(String(d)); serverErr.splice(0, Math.max(0, serverErr.length - 50)); });
const url = `http://127.0.0.1:${port}/`;
const started = Date.now();
let browser;
const timer = setTimeout(() => { console.error(`smoke-open: the app did not open within ${LIMIT_MS / 1000} s.`); finish(1); }, LIMIT_MS);
let finishing = false;
async function finish(code) {
  if (finishing) return;
  finishing = true;
  clearTimeout(timer);
  try { if (browser) await browser.close(); } catch {}
  server.kill();
  await rm(state, { recursive: true, force: true }).catch(() => {});
  process.exit(code);
}
try {
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(url)).ok) break; } catch {}
    if (server.exitCode !== null) throw new Error('the server stopped: ' + serverErr.join('').slice(-800));
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#save-status')?.textContent === 'SAVED TO DISK', null, { timeout: LIMIT_MS });
  const views = await page.locator('#rail a[data-view]').evaluateAll(links => links.map(a => a.getAttribute('href')).filter(h => h && h.startsWith('#/')));
  for (const hash of views) {
    await page.evaluate(h => { location.hash = h; }, hash);
    await page.waitForTimeout(250);
  }
  if (errors.length) {
    console.error(`smoke-open: the app raised ${errors.length} page error${errors.length === 1 ? '' : 's'}:`);
    for (const error of errors) console.error('  ' + error);
    await finish(1);
  }
  console.log(`smoke-open: the app opened and showed ${views.length} pages with no page errors in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
  await finish(0);
} catch (error) {
  console.error('smoke-open: ' + (error.message || error));
  await finish(1);
}
