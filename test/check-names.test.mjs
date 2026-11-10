// The name checks catch a broken import, a typo'd name, a name Safari's engine lacks and an
// unused import, in synthetic trees in a temporary folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

function tree(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'tiksi-check-names-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.join(root, path.dirname(name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
  return root;
}
function run(files, command) {
  const root = tree(files);
  try {
    const result = spawnSync(command[0], command.slice(1), { cwd: root, encoding: 'utf8' });
    return { code: result.status, out: result.stdout + result.stderr };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const js = files => run(files, [process.execPath, path.join(SCRIPTS, 'check-names.mjs')]);
const py = files => run(files, ['python3', path.join(SCRIPTS, 'check-names.py')]);

const lib = { 'js/lib.js': 'export function shown() { return document.title; }\nexport const size = 2;\n' };

test('a clean tree passes', () => {
  const result = js({ ...lib, 'js/app.js': "import { shown, size } from './lib.js';\nconsole.log(shown(), size, window.innerWidth);\n" });
  assert.equal(result.code, 0, result.out);
});

test('an import of a name the other file does not export fails', () => {
  const result = js({ ...lib, 'js/app.js': "import { shown, hidden } from './lib.js';\nshown(); hidden();\n" });
  assert.equal(result.code, 1);
  assert.match(result.out, /js\/app\.js:1: imports hidden from \.\/lib\.js, which does not export it/);
});

test('an import of a file that is not there fails', () => {
  const result = js({ 'js/app.js': "import { a } from './gone.js';\na();\n" });
  assert.equal(result.code, 1);
  assert.match(result.out, /imports \.\/gone\.js, which does not exist/);
});

test('a name nothing defines fails, a typeof test does not', () => {
  let result = js({ 'js/app.js': 'export function title() { return documnet.title; }\n' });
  assert.equal(result.code, 1);
  assert.match(result.out, /js\/app\.js:1: documnet is not defined anywhere/);
  result = js({ 'js/app.js': "export const has = typeof documnet !== 'undefined';\n" });
  assert.equal(result.code, 0, result.out);
});

test('a name Safari\'s engine lacks fails unless the file tests for it', () => {
  // Chromium has requestIdleCallback; Playwright's WebKit build does not.
  let result = js({ 'js/app.js': 'export function later(f) { requestIdleCallback(f); }\n' });
  assert.equal(result.code, 1);
  assert.match(result.out, /requestIdleCallback does not exist in Safari's engine/);
  result = js({ 'js/app.js': "const idle = typeof requestIdleCallback === 'function';\nexport function later(f) { if (idle) requestIdleCallback(f); else setTimeout(f); }\n" });
  assert.equal(result.code, 0, result.out);
});

test('an import nothing uses fails', () => {
  const result = js({ ...lib, 'js/app.js': "import { shown, size } from './lib.js';\nshown();\n" });
  assert.equal(result.code, 1);
  assert.match(result.out, /imports size and never uses it/);
});

test('a test that reads a removed export off a page import fails', () => {
  const page = name => `export async function check(page) { return page.evaluate(async () => (await import('/js/lib.js')).${name}()); }\n`;
  assert.equal(js({ ...lib, 'tools/e2e-x.mjs': page('shown') }).code, 0);
  const result = js({ ...lib, 'tools/e2e-x.mjs': page('vanished') });
  assert.equal(result.code, 1);
  assert.match(result.out, /imports vanished from \/js\/lib\.js/);
});

test('Python: a name nothing defines and a missing project import fail; clean code passes', () => {
  const server = { 'server/__init__.py': '', 'server/store.py': 'def load():\n    return 1\n' };
  assert.equal(py({ ...server, 'scripts/tool.py': 'from server.store import load\nprint(load())\n' }).code, 0);
  let result = py({ ...server, 'scripts/tool.py': 'from server.store import load\n\ndef main():\n    return lod()\n\nprint(load())\n' });
  assert.equal(result.code, 1);
  assert.match(result.out, /scripts\/tool\.py:4: lod is not defined anywhere/);
  result = py({ ...server, 'scripts/tool.py': 'from server.store import save\nprint(save())\n' });
  assert.equal(result.code, 1);
  assert.match(result.out, /imports save from server\.store, which does not define it/);
  result = py({ ...server, 'scripts/tool.py': 'import json\nprint(1)\n' });
  assert.equal(result.code, 1);
  assert.match(result.out, /imports json and never uses it/);
});

test('Python: a name only another function sets is not defined', () => {
  const result = py({ 'scripts/tool.py': 'def setup():\n    shared = 1\n    return shared\n\ndef use():\n    return shared\n\nprint(setup(), use())\n' });
  assert.equal(result.code, 1);
  assert.match(result.out, /scripts\/tool\.py:6: shared is not defined anywhere/);
  // A function that declares it global and sets it does define it for the module.
  assert.equal(py({ 'scripts/tool.py': 'def setup():\n    global shared\n    shared = 1\n\ndef use():\n    return shared\n\nsetup(); print(use())\n' }).code, 0);
});

test('Python: a string holding an import\'s name is not a use, except in __all__', () => {
  let result = py({ 'scripts/tool.py': "import json\nprint('json')\n" });
  assert.equal(result.code, 1);
  assert.match(result.out, /imports json and never uses it/);
  assert.equal(py({ 'scripts/tool.py': "import json\n__all__ = ['json']\n" }).code, 0);
});

test('Python: import * from a project file brings its names; from a package it is noted', () => {
  const server = { 'server/__init__.py': '', 'server/store.py': 'def load():\n    return 1\n' };
  assert.equal(py({ ...server, 'scripts/tool.py': 'from server.store import *\nprint(load())\n' }).code, 0);
  let result = py({ ...server, 'scripts/tool.py': 'from server.store import *\nprint(save())\n' });
  assert.equal(result.code, 1);
  assert.match(result.out, /save is not defined anywhere/);
  result = py({ 'scripts/tool.py': 'from os.path import *\nprint(join("a", "b"))\n' });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /note: scripts\/tool\.py imports \* from os\.path/);
});
