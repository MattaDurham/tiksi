// Printing a prepared sheet: the budget report's PRINT and a product cut sheet's PRINT each
// print their own sheet (paper then shows only the sheet), and a Cmd+P afterwards prints the
// page, not the sheet left behind. The browser's print is stood in for: like a real one it
// fires beforeprint first (twice, as Safari does when the paper size changes) and then
// afterprint. (This suite once held PLAN's guards; PLAN and hand editing are gone, and only
// the print check, which never needed PLAN, is left.)
// Synthetic product, ephemeral origin and browser profile; no live state.
// Run: node tools/e2e-print-sheets.mjs (Playwright + Chromium installed). E2E_ROOT serves another
// checkout's files instead of this one (to see the check fail without its fix).
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(process.env.E2E_ROOT || fileURLToPath(new URL('../', import.meta.url)));
const server = http.createServer(async (req, res) => {
  const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!path.startsWith(root + sep) && path !== root) { res.writeHead(404).end(); return; }
  try {
    const file = path === root ? resolve(root, 'index.html') : path;
    const bytes = await readFile(file);
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.wasm': 'application/wasm' })[extname(file)] || 'application/octet-stream');
    res.end(bytes);
  } catch { res.writeHead(404).end(); }
});

let browser;
try {
  await new Promise(r => server.listen(Number(process.env.E2E_APP_PORT) || 0, 'localhost', r));
  const url = `http://localhost:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', d => d.accept());
  await page.goto(url + '/#/budget');
  await page.locator('#cap-input').waitFor();

  await page.evaluate(() => {
    window.__prints = [];
    window.print = () => {
      window.dispatchEvent(new Event('beforeprint'));
      window.dispatchEvent(new Event('beforeprint'));
      const root = document.getElementById('print-root');
      window.__prints.push({ sheet: root.firstElementChild ? root.firstElementChild.className : '', text: root.innerText.slice(0, 200) });
      window.dispatchEvent(new Event('afterprint'));
    };
    // Cmd+P: the key, then the browser's own print of the page (no PRINT button).
    window.__cmdP = () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true, bubbles: true }));
      window.dispatchEvent(new Event('beforeprint'));
      return document.getElementById('print-root').children.length;
    };
  });
  const appOnPaper = async () => { await page.emulateMedia({ media: 'print' }); const d = await page.locator('#app').evaluate(e => getComputedStyle(e).display); await page.emulateMedia({ media: 'screen' }); return d; };

  // The budget report: its PRINT prints it, and while it is there paper shows only it; a later
  // Cmd+P does not.
  await page.locator('#print-report').click();
  await page.waitForFunction(() => window.__prints.length === 1);
  assert.ok((await page.evaluate(() => window.__prints[0].text)).length > 0, 'the budget PRINT printed its report');
  assert.equal(await appOnPaper(), 'none', 'while the sheet is there, paper shows only the sheet');
  assert.equal(await page.evaluate(() => window.__cmdP()), 0, 'Cmd+P after a budget print empties the old report');
  assert.notEqual(await appOnPaper(), 'none', 'and prints the page instead');

  // A product cut sheet.
  await page.evaluate(async () => { const s = await import('/js/store.js'); s.ws.data.products.push({ id: 'prod-print-check', name: 'Synthetic faucet', category: 'plumbing', price: 100 }); s.touch(); location.hash = '#/sheets'; });
  await page.locator('#print-sheet').click();
  await page.waitForFunction(() => window.__prints.length === 2);
  assert.ok((await page.evaluate(() => window.__prints[1].text)).length > 0, 'the cut sheet PRINT printed its sheet');
  assert.equal(await appOnPaper(), 'none', 'while the cut sheet is there, paper shows only it');
  assert.equal(await page.evaluate(() => window.__cmdP()), 0, 'Cmd+P after a cut sheet print empties it');
  assert.notEqual(await appOnPaper(), 'none', 'and prints the page instead');
  await page.evaluate(async () => { const s = await import('/js/store.js'); s.ws.data.products = s.ws.data.products.filter(p => p.id !== 'prod-print-check'); s.touch(); });

  assert.deepEqual(errors, [], 'no page errors');
  console.log('print: each PRINT prints its own sheet; Cmd+P afterwards prints the page.');
} finally {
  if (browser) await browser.close();
  await new Promise(r => server.close(r));
}
