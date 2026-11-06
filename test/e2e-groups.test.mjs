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
