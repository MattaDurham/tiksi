// Shared data goes into the objects that are already open (store.js adoptRecord): whoever
// holds a record, or anything inside it, keeps holding the live one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { adoptRecord } from '../js/store.js';

test('a record keeps its object, and so does every record inside it that is still there', () => {
  const wall = { id: 'w1', ax: 1 }, level = { id: 'l1', name: 'Main', plan: { opacity: 0.5 } };
  const prop = { id: 'p', name: 'A', walls: [wall, { id: 'w2', ax: 2 }], levels: [level], gone: true };
  const walls = prop.walls, plan = level.plan;
  adoptRecord(prop, { id: 'p', name: 'B', walls: [{ id: 'w3', ax: 9 }, { id: 'w1', ax: 5 }], levels: [{ id: 'l1', name: 'Main', plan: { opacity: 0.8 } }] });
  assert.equal(prop.walls, walls, 'the list of walls is the same array');
  assert.deepEqual(prop.walls.map(w => w.id), ['w3', 'w1'], 'in the new order, without the wall that was removed');
  assert.equal(prop.walls[1], wall); assert.equal(wall.ax, 5);
  assert.equal(prop.levels[0], level); assert.equal(level.plan, plan); assert.equal(plan.opacity, 0.8);
  assert.equal('gone' in prop, false); assert.equal(prop.name, 'B');
});

test('in a list without ids, an item equal to the one in its place stays the same object', () => {
  const first = { n: 1, date: '2026-11-01', documentId: 'doc-1' }, second = { n: 2, date: '2026-11-05', documentId: 'doc-2' };
  const page = { id: 'p', onePager: { versions: [first, second] }, pts: [[0, 0], [4, 0]] };
  const versions = page.onePager.versions, corner = page.pts[0];
  adoptRecord(page, { id: 'p', onePager: { versions: [{ ...first }, { ...second }, { n: 3, date: '2026-11-09', documentId: 'doc-3' }] }, pts: [[0, 0], [5, 0]] });
  assert.equal(page.onePager.versions, versions);
  assert.equal(versions[0], first, 'an unchanged version is not replaced');
  assert.equal(versions[1], second);
  assert.equal(versions.length, 3);
  assert.equal(page.pts[0], corner, 'an unchanged point is not replaced');
  assert.deepEqual(page.pts[1], [5, 0]);
});

test('a list that gets shorter loses its last items and keeps the equal ones', () => {
  const kept = { n: 1 }, page = { id: 'p', versions: [kept, { n: 2 }, { n: 3 }] };
  adoptRecord(page, { id: 'p', versions: [{ n: 1 }] });
  assert.deepEqual(page.versions, [{ n: 1 }]); assert.equal(page.versions[0], kept);
});
