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

test('a plain list changed on one side is taken whole; changed on both sides it is a visible choice', () => {
  const base = { id: 'room', pts: [[0, 0], [4, 0], [4, 3]] };
  const moved = { id: 'room', pts: [[0, 0], [5, 0], [5, 3]] }, other = { id: 'room', pts: [[0, 0], [4, 0], [4, 2]] };
  assert.deepEqual(mergeShared(base, moved, base), { value: moved, conflicts: [] });
  assert.deepEqual(mergeShared(base, base, moved), { value: moved, conflicts: [] });
  const both = mergeShared(base, moved, other);
  assert.deepEqual(both.conflicts, ['pts']);
  assert.deepEqual(both.value.pts, moved.pts, 'until chosen, this side stays as it is: nothing is mixed point by point');
  // The same choice made the other way round keeps the other list whole.
  assert.deepEqual(mergeShared(base, other, moved).value.pts, other.pts);
});

test('records that share an id are never matched up by it: the list is one value', () => {
  const base = { items: [{ id: 'x', n: 1 }, { id: 'x', n: 2 }] };
  const local = { items: [{ id: 'x', n: 1 }, { id: 'x', n: 2 }, { id: 'y', n: 3 }] };
  const remote = { items: [{ id: 'x', n: 1 }, { id: 'x', n: 9 }] };
  assert.deepEqual(mergeShared(base, local, base), { value: local, conflicts: [] });
  const both = mergeShared(base, local, remote);
  assert.deepEqual(both.conflicts, ['items'], 'two edits to a list with a repeated id are put to the person');
  assert.equal(both.value.items.length, 3, 'and neither record with the repeated id is dropped');
});

test('a record removed on one side and untouched on the other goes; an added record stays on both', () => {
  const base = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
  assert.deepEqual(mergeShared(base, [base[0]], base).value, [base[0]]);
  assert.deepEqual(mergeShared(base, base, [base[1]]).value, [base[1]]);
  const added = mergeShared(base, [...base, { id: 'c', name: 'C' }], [...base, { id: 'd', name: 'D' }]);
  assert.deepEqual(added.conflicts, []);
  assert.deepEqual(new Set(added.value.map(r => r.id)), new Set(['a', 'b', 'c', 'd']));
});

test('a camera view, a pin, a lens and a wall place merge whole, never part by part', () => {
  const base = { id: 'ph', view: { position: [0, 0, 0], target: [1, 0, 0], fov: 50 } };
  const local = { id: 'ph', view: { position: [2, 0, 0], target: [1, 0, 0], fov: 50 } };
  const remote = { id: 'ph', view: { position: [0, 0, 0], target: [1, 1, 0], fov: 50 } };
  const result = mergeShared(base, local, remote);
  assert.deepEqual(result.conflicts, ['view']);
  assert.deepEqual(result.value.view, local.view, 'not a third camera made of one side\'s position and the other\'s target');
});

test('two drafts of a one-pager nobody wrote by hand are not a conflict; hand-written text is', () => {
  const draft = text => ({ id: 'p', onePager: { headline: text, customized: false, draftedAt: '1970-01-01T00:00:00.000Z' } });
  const result = mergeShared(draft('Old'), draft('Drafted here'), draft('Drafted on the Mac'));
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.value.onePager.headline, 'Drafted on the Mac', 'the saved draft stays');
  const written = { id: 'p', onePager: { headline: 'Written by hand', customized: true } };
  assert.ok(mergeShared(draft('Old'), written, draft('Drafted on the Mac')).conflicts.includes('onePager.headline'), 'hand-written text against a new draft is put to the person');
});

test('the same project drafted by two devices saves the same one-pager record', async () => {
  const { draftOnePager } = await import('../js/one-pager.js');
  const { propertyTemplate, emptyWorkspace } = await import('../js/store.js');
  const data = emptyWorkspace(), a = propertyTemplate('Harbour house'), b = JSON.parse(JSON.stringify(a));
  draftOnePager(a, data);
  await new Promise(resolve => setTimeout(resolve, 15));
  draftOnePager(b, data);
  assert.deepEqual(b.onePager, a.onePager, 'no clock time in a draft');
  assert.ok(a.onePager.draftedAt, 'and it still says a draft was written');
});
