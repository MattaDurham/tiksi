import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeShared } from '../js/workspace-merge.js';

test('independent device edits and new projects combine by stable identity', () => {
  const base = { properties: [{ id: 'a', name: 'A', notes: '' }] };
  const local = { properties: [{ id: 'a', name: 'A revised', notes: '' }, { id: 'b', name: 'B' }] };
  const remote = { properties: [{ id: 'a', name: 'A', notes: 'Measured' }, { id: 'c', name: 'C' }] };
  const result = mergeShared(base, local, remote);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.value.properties.find(p => p.id === 'a'), { id: 'a', name: 'A revised', notes: 'Measured' });
  assert.deepEqual(new Set(result.value.properties.map(p => p.id)), new Set(['a', 'b', 'c']));
});

test('same-field edits and delete versus edit require a visible choice', () => {
  const base = [{ id: 'a', name: 'A' }];
  assert.deepEqual(mergeShared(base, [{ id: 'a', name: 'Desktop' }], [{ id: 'a', name: 'Phone' }]).conflicts, ['a.name']);
  assert.deepEqual(mergeShared(base, [], [{ id: 'a', name: 'Phone' }]).conflicts, ['a']);
  assert.deepEqual(mergeShared(base, [], base).value, []);
});

test('first migration preserves both sets of projects and reports conflicting originals', () => {
  const result = mergeShared(undefined, { properties: [{ id: 'local' }], assets: { image: { hash: 'first' } } }, { properties: [{ id: 'remote' }], assets: { image: { hash: 'second' } } });
  assert.equal(result.value.properties.length, 2);
  assert.deepEqual(result.conflicts, ['assets.image.hash']);
});
