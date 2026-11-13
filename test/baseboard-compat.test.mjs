// Recorded sections survive the trim editor without creating trim on other faces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const vendor = new URL('../vendor/', import.meta.url).href;
registerHooks({ resolve(spec, ctx, next) {
  if (spec === 'three') return { url: vendor + 'three.module.min.js', shortCircuit: true };
  if (spec.startsWith('three/addons/')) return { url: vendor + 'addons/' + spec.slice(13), shortCircuit: true };
  return next(spec, ctx);
} });
globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
store.ws.data = store.emptyWorkspace();
const { buildWallGroup, disposeBuilt } = await import('../js/geometry.js');
const wall = { id: 'w', ax: 0, ay: 0, bx: 4, by: 0, thickness: .12, height: 2.5 };
const rooms = [{ id: 'a', pts: [[0, .06], [4, .06], [4, 3], [0, 3]] },
  { id: 'b', pts: [[0, -3], [4, -3], [4, -.06], [0, -.06]] }];
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
function outside(fields) {
  const w = { ...wall, ...fields };
  const g = buildWallGroup(w, [], { walls: [w], rooms, wallHeight: 2.5 }, { matOpts: { transparent: true, opacity: .5 } });
  const points = [];
  g.traverse(m => {
    const p = m.geometry?.getAttribute('position');
    if (!p) return;
    for (let i = 0; i < p.count; i++) if (Math.abs(p.getZ(i)) > wall.thickness / 2 + 1e-6) points.push([p.getX(i), p.getY(i), p.getZ(i)]);
  });
  disposeBuilt(g);
  return points;
}

test('one recorded rounded section keeps its dimensions without adding an opposite baseboard', () => {
  const pts = outside({ baseboardPos: { height: .09, depth: .012, profile: 'rounded', radius: .004 } });
  assert.ok(pts.length);
  assert.ok(pts.every(p => p[2] > .06), 'only the recorded positive face projects from the wall');
  near(Math.max(...pts.map(p => p[1])), .09);
  near(Math.max(...pts.map(p => p[2])), .072);
  const top = pts.filter(p => Math.abs(p[1] - .09) < 1e-6);
  assert.ok(top.length);
  near(Math.max(...top.map(p => p[2])), .068);
});

test('an explicit legacy wall profile remains symmetric, while unspecified walls have no baseboard', () => {
  assert.deepEqual(outside({}), []);
  const pts = outside({ profile: { baseboardHeight: .08, baseboardDepth: .01 } });
  assert.ok(pts.some(p => p[2] < -.06) && pts.some(p => p[2] > .06));
  near(Math.max(...pts.map(p => p[1])), .08);
  near(Math.max(...pts.map(p => p[2])), .07);
  near(Math.min(...pts.map(p => p[2])), -.07);
});

test('an explicit zero-height section suppresses that side without suppressing its recorded neighbour', () => {
  const pts = outside({ baseboardPos: { height: 0, depth: .012 }, baseboardNeg: { height: .07, depth: .008 } });
  assert.ok(pts.length && pts.every(p => p[2] < -.06));
  near(Math.max(...pts.map(p => p[1])), .07);
});
