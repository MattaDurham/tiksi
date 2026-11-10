import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { groupSuites, parseGroup, DEFAULT_SECONDS, FIRST_GROUP_EXTRA } from '../scripts/e2e-groups.mjs';

const suites = readdirSync(new URL('../tools/', import.meta.url)).filter(name => /^e2e-.*\.mjs$/.test(name));
const durations = JSON.parse(readFileSync(new URL('../scripts/e2e-durations.json', import.meta.url), 'utf8'));

test('every browser suite runs in exactly one CI group', () => {
  for (const count of [1, 2, 4]) {
    const placed = groupSuites(suites, durations, count).flatMap(group => group.files);
    assert.deepEqual([...placed].sort(), [...suites].sort(), `${count} groups`);
  }
});

test('groups come out the same whatever order the folder lists the suites in', () => {
  assert.deepEqual(groupSuites([...suites].reverse(), durations, 4), groupSuites(suites, durations, 4));
});

test('the four CI groups stay within a few minutes of each other', () => {
  const seconds = groupSuites(suites, durations, 4).map(group => group.seconds);
  const longestSuite = Math.max(...suites.map(file => durations[file.replace(/\.mjs$/, '')] ?? DEFAULT_SECONDS));
  assert.ok(Math.max(...seconds) - Math.min(...seconds) <= Math.max(longestSuite, FIRST_GROUP_EXTRA), String(seconds));
});

test('a new suite with no recorded time still gets a group', () => {
  const groups = groupSuites([...suites, 'e2e-brand-new.mjs'], durations, 4);
  assert.equal(groups.filter(group => group.files.includes('e2e-brand-new.mjs')).length, 1);
});

test('group arguments must name a group that exists', () => {
  assert.deepEqual(parseGroup('3/4'), { index: 3, count: 4 });
  for (const bad of ['0/4', '5/4', '1/0', 'two', '', undefined]) assert.throws(() => parseGroup(bad));
});

// The runner itself, on synthetic suites in a temporary folder: no browser is started.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'e2e.mjs');
function runner(suites, ...args) {
  const root = mkdtempSync(path.join(tmpdir(), 'tiksi-e2e-runner-'));
  mkdirSync(path.join(root, 'tools'));
  writeFileSync(path.join(root, 'tools', 'fixture-room.mjs'), '');
  for (const [name, body] of Object.entries(suites)) writeFileSync(path.join(root, 'tools', name), body);
  const result = spawnSync(process.execPath, [RUNNER, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
  return { root, code: result.status, out: result.stdout + result.stderr, done: () => rmSync(root, { recursive: true, force: true }) };
}
const mark = name => `import { writeFileSync } from 'node:fs'; writeFileSync('ran-${name}', process.env.E2E_BROWSER || 'chromium');`;

test('a failing suite does not stop the rest of its group, and every failure is named', () => {
  const run = runner({
    'e2e-a.mjs': `${mark('a')} process.exit(1);`,
    'e2e-b.mjs': mark('b'),
    'e2e-c.mjs': `${mark('c')} process.exit(3);`,
  });
  try {
    assert.equal(run.code, 1, run.out);
    for (const name of ['a', 'b', 'c']) assert.ok(existsSync(path.join(run.root, 'ran-' + name)), `${name} ran\n${run.out}`);
    assert.match(run.out, /tools\/e2e-a\.mjs failed twice/);
    assert.match(run.out, /tools\/e2e-c\.mjs failed twice/);
    assert.match(run.out, /Browser suites failed: 2 of 3 \(e2e-a\.mjs, e2e-c\.mjs\)/);
    const record = JSON.parse(readFileSync(path.join(run.root, 'test-results', 'e2e-all.json'), 'utf8'));
    assert.deepEqual(record.suites.map(s => [s.file, !!s.failed, s.tries.length]), [['e2e-a.mjs', true, 2], ['e2e-b.mjs', false, 1], ['e2e-c.mjs', true, 2]]);
  } finally { run.done(); }
});

test('a suite that passes on its second try is a warning and is written to the record', () => {
  const flaky = `import { existsSync, writeFileSync } from 'node:fs'; if (!existsSync('tried')) { writeFileSync('tried', ''); process.exit(1); }`;
  const run = runner({ 'e2e-flaky.mjs': flaky });
  try {
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /Warning: tools\/e2e-flaky\.mjs failed once and passed on its second try/);
    const record = JSON.parse(readFileSync(path.join(run.root, 'test-results', 'e2e-all.json'), 'utf8'));
    assert.equal(record.suites[0].attempts, 2);
  } finally { run.done(); }
});

test('--webkit runs only the phone suites, on Safari\'s engine', () => {
  const run = runner({ 'e2e-field-view.mjs': mark('field'), 'e2e-other.mjs': mark('other') }, '--webkit');
  try {
    assert.equal(run.code, 0, run.out);
    assert.equal(readFileSync(path.join(run.root, 'ran-field'), 'utf8'), 'webkit');
    assert.ok(!existsSync(path.join(run.root, 'ran-other')));
  } finally { run.done(); }
  const bad = runner({}, '--webkit', 'extra');
  try { assert.notEqual(bad.code, 0); } finally { bad.done(); }
  // A Safari-engine run whose listed suite is missing fails instead of passing with nothing run.
  const none = runner({ 'e2e-other.mjs': mark('other') }, '--webkit');
  try {
    assert.equal(none.code, 1, none.out);
    assert.match(none.out, /not in tools\/: e2e-field-view\.mjs/);
    assert.doesNotMatch(none.out, /Browser suites passed/);
  } finally { none.done(); }
});
