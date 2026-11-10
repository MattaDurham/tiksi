#!/usr/bin/env node
// Finds names that do not exist, before a browser ever runs the code:
//   - a name used in a script file that nothing defines (a typo, or a function removed while
//     something still calls it);
//   - a name used in an app file that Safari's engine (WebKit) does not have, unless the file
//     tests for it first with `typeof name`;
//   - an import of a file that is not there, or of a name the other file does not export, for
//     static imports and for `import('/js/x.js')` with the names read from it;
//   - an import that nothing in the file uses.
//
//   node scripts/check-names.mjs               check the tree in the current folder
//   node scripts/check-names.mjs --refresh     rewrite scripts/browser-globals.json from the
//                                              installed Chromium and WebKit builds
//
// It parses with the Babel parser that ships inside Playwright, the project's one dev
// dependency, so it adds no package. Known cases that are not fixed yet are listed, with a
// reason each, in scripts/check-names-allow.json; an entry that no longer matches anything is
// named in a warning, so the list only shrinks.
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLOBALS_FILE = path.join(HERE, 'browser-globals.json');
const ALLOW_FILE = path.join(HERE, 'check-names-allow.json');

const args = process.argv.slice(2);
for (const arg of args) if (arg !== '--refresh') { console.error(`Unknown argument ${arg}`); process.exit(2); }

// Resolve Playwright from the tree being checked, so this file works when it is run from
// another checkout against a branch copy.
const requireHere = createRequire(path.join(ROOT, 'package.json'));

if (args.includes('--refresh')) {
  const { chromium, webkit } = requireHere('playwright');
  const out = {};
  for (const type of [chromium, webkit]) {
    const browser = await type.launch();
    const page = await browser.newPage();
    out[type.name()] = (await page.evaluate(() => {
      const names = new Set();
      for (let o = window; o; o = Object.getPrototypeOf(o)) for (const n of Object.getOwnPropertyNames(o)) names.add(n);
      return [...names];
    })).filter(n => /^[A-Za-z_$][\w$]*$/.test(n)).sort();
    await browser.close();
  }
  writeFileSync(GLOBALS_FILE, JSON.stringify(out, null, 0).replace(/\],/g, '],\n') + '\n');
  console.log(`Wrote ${path.relative(ROOT, GLOBALS_FILE)}: ${out.chromium.length} Chromium and ${out.webkit.length} WebKit names.`);
  process.exit(0);
}

let babel;
try { babel = requireHere('playwright/lib/transform/babelBundle'); }
catch { try { babel = createRequire(import.meta.url)('playwright/lib/transform/babelBundle'); } catch (error) {
  console.error('check-names: Playwright is not installed in this folder (npm ci), so names cannot be checked.');
  console.error(String(error.message || error).split('\n')[0]);
  process.exit(1);
} }
const { babelParse, traverse } = babel;

const engines = JSON.parse(readFileSync(GLOBALS_FILE, 'utf8'));
const webkitNames = new Set(engines.webkit);
const anyBrowser = new Set([...engines.chromium, ...engines.webkit]);
// Names a module worker has that a window does not.
const workerNames = new Set(['importScripts', 'WorkerGlobalScope', 'DedicatedWorkerGlobalScope']);
const nodeNames = new Set([...Object.getOwnPropertyNames(globalThis), 'require', 'module', 'exports', '__dirname', '__filename']);
const languageNames = new Set(['undefined', 'NaN', 'Infinity', 'arguments', 'globalThis']);

const allowed = existsSync(ALLOW_FILE) ? JSON.parse(readFileSync(ALLOW_FILE, 'utf8')).allow || [] : [];
const used = new Set();
const problems = [];
function report(file, line, kind, name, text) {
  const index = allowed.findIndex(a => a.file === file && a.kind === kind && a.name === name);
  if (index >= 0) { used.add(index); return; }
  problems.push(`${file}:${line}: ${text}`);
}

function walk(folder, test) {
  const dir = path.join(ROOT, folder);
  if (!existsSync(dir)) return [];
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) continue;
    if (test(name)) files.push(path.join(folder, name));
  }
  return files;
}
const appFiles = walk('js', n => n.endsWith('.js'));
const nodeFiles = ['scripts', 'tools', 'test', 'tests'].flatMap(f => walk(f, n => /\.(mjs|js)$/.test(n)));

const importMap = (() => {
  try {
    const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const block = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
    return block ? JSON.parse(block[1]).imports || {} : {};
  } catch { return {}; }
})();

const parsed = new Map();
function parse(file) {
  if (parsed.has(file)) return parsed.get(file);
  let result = null;
  try {
    const code = readFileSync(path.join(ROOT, file), 'utf8');
    result = { code, ast: babelParse(code, file, true) };
  } catch (error) {
    result = { error: String(error.message || error).split('\n')[0] };
  }
  parsed.set(file, result);
  return result;
}

// Where an import specifier points, as a path from ROOT, or null for a package or Node module.
function resolve(fromFile, spec, browserPaths) {
  if (spec.startsWith('node:')) return null;
  for (const [key, target] of Object.entries(importMap)) {
    if (key.endsWith('/') ? spec.startsWith(key) : spec === key) {
      return path.normalize(path.join(target, spec.slice(key.length)));
    }
  }
  if (spec.startsWith('/')) return browserPaths ? path.normalize(spec.slice(1)) : null;
  if (spec.startsWith('.')) return path.normalize(path.join(path.dirname(fromFile), spec));
  return null; // a package from node_modules
}

// The names a module exports, following `export * from`.
const exportCache = new Map();
function exportsOf(file, seen = new Set()) {
  if (exportCache.has(file)) return exportCache.get(file);
  if (seen.has(file)) return { names: new Set(), open: false };
  seen.add(file);
  const { ast } = parse(file);
  const names = new Set();
  let open = !ast; // a file that does not parse is reported on its own; do not pile on
  if (ast) for (const node of ast.program.body) {
    if (node.type === 'ExportDefaultDeclaration') names.add('default');
    else if (node.type === 'ExportNamedDeclaration') {
      const d = node.declaration;
      if (d?.id) names.add(d.id.name);
      if (d?.declarations) for (const decl of d.declarations) for (const n of patternNames(decl.id)) names.add(n);
      for (const s of node.specifiers || []) names.add(s.exported.name ?? s.exported.value);
    } else if (node.type === 'ExportAllDeclaration') {
      if (node.exported) { names.add(node.exported.name); continue; }
      const target = resolve(file, node.source.value, true);
      if (!target || !existsSync(path.join(ROOT, target))) { open = true; continue; }
      const inner = exportsOf(target, seen);
      for (const n of inner.names) if (n !== 'default') names.add(n);
      open = open || inner.open;
    }
  }
  const result = { names, open };
  exportCache.set(file, result);
  return result;
}

function patternNames(node) {
  if (!node) return [];
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'ObjectPattern') return node.properties.flatMap(p => patternNames(p.type === 'RestElement' ? p.argument : p.value));
  if (node.type === 'ArrayPattern') return node.elements.flatMap(patternNames);
  if (node.type === 'AssignmentPattern') return patternNames(node.left);
  if (node.type === 'RestElement') return patternNames(node.argument);
  return [];
}

// Inside a function passed to page.evaluate and its relatives: code that runs in the page.
const PAGE_CALLS = new Set(['evaluate', 'evaluateHandle', 'waitForFunction', '$eval', '$$eval', 'addInitScript', 'evaluateAll']);
function inPage(p) {
  for (let at = p; at; at = at.parentPath) {
    if (!at.isFunction()) continue;
    const call = at.parentPath;
    if (call?.isCallExpression() && call.node.arguments.includes(at.node)) {
      const callee = call.node.callee;
      if (callee.type === 'MemberExpression' && !callee.computed && PAGE_CALLS.has(callee.property.name)) return true;
    }
  }
  return false;
}

function checkImported(file, line, target, wanted, spec) {
  const real = path.join(ROOT, target);
  if (!existsSync(real)) { report(file, line, 'missing-file', spec, `imports ${spec}, which does not exist`); return; }
  if (!/\.(m?js)$/.test(target)) return;
  const { names, open } = exportsOf(target);
  if (open) return;
  for (const name of wanted) {
    if (!names.has(name)) report(file, line, 'missing-export', `${spec} ${name}`, `imports ${name} from ${spec}, which does not export it`);
  }
}

function checkFile(file, kind) {
  const { ast, code, error } = parse(file);
  if (!ast) { problems.push(`${file}: does not parse: ${error}`); return; }
  const isWorker = file.endsWith('.worker.js');
  const guarded = new Set([...code.matchAll(/typeof\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
  let program;
  traverse(ast, {
    Program(p) { program = p; },
    ImportDeclaration(p) {
      const spec = p.node.source.value;
      const target = resolve(file, spec, kind === 'app');
      if (target === null) return;
      const wanted = p.node.specifiers.filter(s => s.type === 'ImportSpecifier').map(s => s.imported.name ?? s.imported.value);
      if (p.node.specifiers.some(s => s.type === 'ImportDefaultSpecifier')) wanted.push('default');
      checkImported(file, p.node.loc.start.line, target, wanted, spec);
    },
    'ExportNamedDeclaration|ExportAllDeclaration'(p) {
      if (!p.node.source) return;
      const spec = p.node.source.value;
      const target = resolve(file, spec, kind === 'app');
      if (target === null) return;
      const wanted = (p.node.specifiers || []).filter(s => s.type === 'ExportSpecifier').map(s => s.local.name ?? s.local.value);
      checkImported(file, p.node.loc.start.line, target, wanted, spec);
    },
    // import('/js/x.js'), with the names read straight off it when the code says which.
    Import(p) {
      const call = p.parentPath;
      const source = call.node.arguments[0];
      if (!source || source.type !== 'StringLiteral') return;
      const spec = source.value;
      // In a Node file, '/js/x.js' is a path the page loads (inside page.evaluate), and so is
      // './js/x.js' when no such file sits beside the test.
      let target = resolve(file, spec, true);
      if (target === null) return;
      if (kind === 'node' && inPage(p) && spec.startsWith('./') && !existsSync(path.join(ROOT, target))) target = path.normalize(spec);
      let outer = call.parentPath;
      const awaited = outer.node.type === 'AwaitExpression';
      if (awaited) outer = outer.parentPath;
      const wanted = [];
      if (awaited && outer.node.type === 'MemberExpression' && !outer.node.computed && outer.node.property.type === 'Identifier') {
        wanted.push(outer.node.property.name);
      } else if (awaited && outer.node.type === 'VariableDeclarator' && outer.node.id.type === 'ObjectPattern') {
        for (const prop of outer.node.id.properties) {
          if (prop.type === 'ObjectProperty' && !prop.computed && prop.key.type === 'Identifier') wanted.push(prop.key.name);
        }
      }
      checkImported(file, call.node.loc.start.line, target, wanted, spec);
    },
  });
  // Names nothing defines.
  const refs = new Map();
  traverse(ast, {
    ReferencedIdentifier(p) {
      const name = p.node.name;
      if (p.scope.hasBinding(name, true)) return;
      if (p.parentPath.isUnaryExpression({ operator: 'typeof' })) return;
      // Code a test hands to the page runs there, next to whatever the test page defines.
      if (kind === 'node' && inPage(p)) return;
      if (!refs.has(name)) refs.set(name, p.node.loc.start.line);
    },
  });
  for (const [name, line] of refs) {
    if (languageNames.has(name)) continue;
    if (kind === 'app') {
      if (isWorker && workerNames.has(name)) continue;
      if (!anyBrowser.has(name)) report(file, line, 'undefined', name, `${name} is not defined anywhere`);
      else if (!webkitNames.has(name) && !guarded.has(name)) {
        report(file, line, 'not-in-webkit', name, `${name} does not exist in Safari's engine and the file never checks typeof ${name}`);
      }
    } else if (!nodeNames.has(name) && !anyBrowser.has(name)) {
      report(file, line, 'undefined', name, `${name} is not defined anywhere`);
    }
  }
  // Imports nothing uses.
  for (const [name, binding] of Object.entries(program.scope.bindings)) {
    if (binding.kind === 'module' && !binding.referenced) {
      report(file, binding.identifier.loc.start.line, 'unused-import', name, `imports ${name} and never uses it`);
    }
  }
}

for (const file of appFiles) checkFile(file, 'app');
for (const file of nodeFiles) checkFile(file, 'node');
// A listed case that no longer happens is only a warning: the code was fixed, possibly on
// another branch, and the entry can go.
allowed.forEach((entry, index) => {
  if (/\.m?js$/.test(entry.file) && !used.has(index)) console.log(`Warning: ${entry.file} ${entry.kind} ${entry.name} no longer happens; remove it from scripts/check-names-allow.json`);
});
for (const problem of problems) console.error(problem);
if (problems.length) {
  console.error(`check-names: ${problems.length} problem${problems.length === 1 ? '' : 's'} in ${appFiles.length + nodeFiles.length} files.`);
  process.exit(1);
}
console.log(`check-names: ${appFiles.length + nodeFiles.length} files, every name and import resolves${used.size ? ` (${used.size} known cases listed in scripts/check-names-allow.json)` : ''}.`);
