// Fixture proposals from a synthetic scan: an 8 x 6 m kitchen-living-bedroom shell seen from
// inside, the way a lidar mesh records it, with an L counter (45° inner corner), wall
// cabinets with a higher run over the range, a fridge, a bed, a round table, a sofa and a
// desk. Negative cases: an empty room, a window sill, a wardrobe, a narrow shelf.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectFixtures } from '../js/scan-fixtures.js';

function mesh() {
  const tris = [];
  const quad = (a, b, c, d) => tris.push([a, b, c], [a, c, d]);
  const api = {
    // Vertical face from (x0,z0) to (x1,z1), heights y0..y1.
    face(x0, z0, x1, z1, y0, y1, step = 0.25) {
      const len = Math.hypot(x1 - x0, z1 - z0), ux = (x1 - x0) / len, uz = (z1 - z0) / len;
      for (let s = 0; s < len - 1e-9; s += step) {
        const s1 = Math.min(len, s + step);
        for (let y = y0; y < y1 - 1e-9; y += step) {
          const yy = Math.min(y1, y + step);
          quad([x0 + ux * s, y, z0 + uz * s], [x0 + ux * s1, y, z0 + uz * s1], [x0 + ux * s1, yy, z0 + uz * s1], [x0 + ux * s, yy, z0 + uz * s]);
        }
      }
    },
    // Horizontal surface over the cells of [x0,x1] x [z0,z1] whose centre passes `keep`.
    slab(x0, z0, x1, z1, y, up, keep, step = 0.05) {
      for (let x = x0; x < x1 - 1e-9; x += step) for (let z = z0; z < z1 - 1e-9; z += step) {
        const xx = Math.min(x1, x + step), zz = Math.min(z1, z + step);
        if (keep && !keep((x + xx) / 2, (z + zz) / 2)) continue;
        if (up) quad([x, y, z], [x, y, zz], [xx, y, zz], [xx, y, z]);
        else quad([x, y, z], [xx, y, z], [xx, y, zz], [x, y, zz]);
      }
    },
    box(x0, z0, x1, z1, y0, y1) {       // a closed box seen from outside: top and four sides
      api.slab(x0, z0, x1, z1, y1, true);
      api.face(x0, z1, x1, z1, y0, y1, 0.1); api.face(x0, z0, x1, z0, y0, y1, 0.1);
      api.face(x0, z0, x0, z1, y0, y1, 0.1); api.face(x1, z0, x1, z1, y0, y1, 0.1);
    },
    pack(rotDeg = 0, invert = false) {
      const a = rotDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
      const pos = new Float32Array(tris.length * 9), idx = new Uint32Array(tris.length * 3);
      tris.forEach((t, i) => (invert ? [t[0], t[2], t[1]] : t).forEach(([x, y, z], k) => {
        pos.set([x * c - z * s, y, x * s + z * c], (3 * i + k) * 3);
        idx[3 * i + k] = 3 * i + k;
      }));
      return { pos, idx };
    },
  };
  return api;
}

const H = 2.3;
const WALLS = [[0, 0, 8, 0], [8, 0, 8, 6], [8, 6, 0, 6], [0, 6, 0, 0]].map(([ax, ay, bx, by], i) => ({ id: 'w' + i, ax, ay, bx, by, thickness: 0.1 }));
function shell(m) {
  m.slab(0.05, 0.05, 7.95, 5.95, 0, true, null, 0.25);
  m.slab(0.05, 0.05, 7.95, 5.95, H, false, null, 0.25);
  m.face(0.05, 0.05, 7.95, 0.05, 0, H); m.face(7.95, 0.05, 7.95, 5.95, 0, H);
  m.face(7.95, 5.95, 0.05, 5.95, 0, H); m.face(0.05, 5.95, 0.05, 0.05, 0, H);
}
function furnished() {
  const m = mesh();
  shell(m);
  // L counter on the north (z = 0.05) and west (x = 0.05) faces: top 0.91, 0.62 deep, fronts
  // 0.60 from the walls, a 45° inner corner (diagonal x + z = 1.69).
  const top = (x, z) => (z <= 0.67 && x <= 3.0) || (x <= 0.67 && z <= 2.5) || x + z <= 1.69;
  m.slab(0.05, 0.05, 3.0, 2.5, 0.91, true, top, 0.02);
  m.face(1.0, 0.65, 3.0, 0.65, 0.1, 0.88, 0.1); m.face(0.65, 1.0, 0.65, 2.5, 0.1, 0.88, 0.1); m.face(1.0, 0.65, 0.65, 1.0, 0.1, 0.88, 0.1);
  m.face(3.0, 0.05, 3.0, 0.65, 0, 0.91, 0.1); m.face(0.05, 2.5, 0.65, 2.5, 0, 0.91, 0.1);
  // Wall cabinets over the north arm, underside 1.386 up to the ceiling, 0.32 deep; over the
  // range (x 2.0..2.76) a shallower box with its underside at 1.84.
  m.slab(0.05, 0.05, 2.0, 0.37, 1.386, false);
  m.face(0.05, 0.37, 2.0, 0.37, 1.386, H, 0.1); m.face(2.0, 0.05, 2.0, 0.37, 1.386, 1.84, 0.1);
  m.slab(2.0, 0.05, 2.76, 0.37, 1.84, false);
  m.face(2.0, 0.37, 2.76, 0.37, 1.84, H, 0.1); m.face(2.76, 0.05, 2.76, 0.37, 1.84, H, 0.1);
  // Fridge beside the counter: 0.75 x 0.70, top 1.75.
  m.box(3.05, 0.05, 3.8, 0.75, 0, 1.75);
  // Bed 1.57 x 2.0, top 0.59.
  m.box(5.9, 0.6, 7.47, 2.6, 0, 0.59);
  // Round dining table, Ø 0.8, top 0.71, on a pedestal.
  m.slab(4.1, 2.6, 4.9, 3.4, 0.71, true, (x, z) => Math.hypot(x - 4.5, z - 3.0) <= 0.4);
  m.face(4.45, 3.0, 4.55, 3.0, 0, 0.7, 0.1);
  // Sofa against the south wall: seat 0.5 (z 5.0..5.7), back 0.82 (z 5.7..5.95), 2.1 long.
  m.box(1.0, 5.0, 3.1, 5.7, 0, 0.5);
  m.box(1.0, 5.7, 3.1, 5.95, 0, 0.82);
  // Desk against the east wall: top 0.76, 1.4 x 0.7.
  m.slab(7.25, 3.5, 7.95, 4.9, 0.76, true);
  m.face(7.25, 3.5, 7.25, 4.9, 0.72, 0.76, 0.04);
  return m;
}
const level = { id: 'lvl-0', name: 'Main', elevation: 0, height: H, walls: WALLS };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, msg + ': ' + a + ' vs ' + b);
const one = (fx, pred, what) => { const hits = fx.filter(pred); assert.equal(hits.length, 1, 'one ' + what + ' (got ' + hits.length + ': ' + fx.map(f => f.kind + '/' + (f.subtype || '') + ' ' + f.evidence).join('; ') + ')'); return hits[0]; };

test('a furnished room yields counters, cabinets, an appliance and furniture at their measured sizes', () => {
  const { pos, idx } = furnished().pack();
  const { fixtures: fx, levels } = detectFixtures(pos, idx, { levels: [level] });
  assert.equal(levels[0].inverted, false);
  for (const f of fx) assert.equal(f.provenance.source, 'scan'), assert.ok(f.provenance.confidence > 0 && f.provenance.confidence < 1, 'confidence is a fraction');

  const counter = one(fx, f => f.kind === 'base-run', 'counter run');
  near(counter.h, 0.91, 0.02, 'counter height');
  near(counter.depth, 0.62, 0.03, 'counter depth');
  near(counter.depth - counter.overhang, 0.60, 0.03, 'fronts from the wall');
  assert.equal(counter.pts.length, 3, 'the north and west runs join at the corner');
  const corner = counter.pts[1];
  near(corner[0], 0.05, 0.03, 'corner x'); near(corner[1], 0.05, 0.03, 'corner y');
  const reach = counter.corners[1];
  assert.ok(reach > 1.0 && reach < 1.25, 'diagonal corner kept: reach ' + reach);
  const ends = [counter.pts[0], counter.pts[2]].sort((a, b) => b[0] - a[0]);
  near(ends[0][0], 3.0, 0.08, 'north arm ends with the counter'); near(ends[1][1], 2.5, 0.08, 'west arm ends with the counter');

  const cabinets = fx.filter(f => f.kind === 'wall-run').sort((a, b) => a.y0 - b.y0);
  assert.equal(cabinets.length, 2, 'two wall-cabinet runs: ' + cabinets.map(c => c.evidence).join('; '));
  near(cabinets[0].y0, 1.386, 0.02, 'underside'); near(cabinets[0].y0 + cabinets[0].h, H, 0.03, 'runs to the ceiling');
  near(cabinets[0].depth, 0.32, 0.03, 'cabinet depth');
  near(cabinets[1].y0, 1.84, 0.02, 'higher underside over the range');

  const fridge = one(fx, f => f.kind === 'appliance', 'tall appliance');
  assert.equal(fridge.subtype, 'fridge', 'beside the counter it reads as a fridge');
  near(fridge.h, 1.75, 0.03, 'fridge top'); near(fridge.w, 0.75, 0.08, 'fridge width');

  const bed = one(fx, f => f.subtype === 'bed', 'bed');
  near(bed.h, 0.59, 0.03, 'bed top'); near(bed.w, 2.0, 0.08, 'bed length'); near(bed.d, 1.57, 0.08, 'bed width');
  near(bed.x, 6.685, 0.06, 'bed centre x'); near(bed.y, 1.6, 0.06, 'bed centre y');

  const table = one(fx, f => f.subtype === 'table-round', 'round table');
  near(table.h, 0.71, 0.02, 'table top'); near(table.w, 0.8, 0.08, 'table diameter');

  const sofa = one(fx, f => f.subtype === 'sofa', 'sofa');
  near(sofa.seat, 0.5, 0.03, 'seat'); near(sofa.h, 0.82, 0.03, 'back'); near(sofa.w, 2.1, 0.08, 'sofa length');
  // Local +v is the back: it points at the south wall.
  const a = sofa.rot * Math.PI / 180;
  assert.ok(Math.cos(a) > 0.9, 'back faces +y, the south wall (rot ' + sofa.rot + ')');

  const desk = one(fx, f => f.subtype === 'desk', 'desk');
  near(desk.h, 0.76, 0.02, 'desk top'); near(desk.w, 1.4, 0.08, 'desk length');
  assert.equal(fx.filter(f => f.subtype === 'table-rect' || f.subtype === 'storage' || f.kind === 'bath').length, 0, 'no stray proposals');
});

test('an empty room, a window sill, a wardrobe and a narrow shelf propose nothing', () => {
  const m = mesh();
  shell(m);
  m.slab(4.0, 0.05, 5.2, 0.2, 0.9, true);            // sill: 0.15 m deep
  m.box(6.0, 5.35, 7.5, 5.95, 0, 1.8);                // wardrobe 1.5 wide, 1.8 tall
  m.slab(1.0, 0.05, 2.5, 0.27, 1.5, false);           // open shelf underside, no front
  m.slab(1.0, 0.05, 2.5, 0.27, 1.52, true);
  const { pos, idx } = m.pack();
  assert.deepEqual(detectFixtures(pos, idx, { levels: [level] }).fixtures.map(f => f.kind + ' ' + f.evidence), []);
  const bare = mesh(); shell(bare);
  const b = bare.pack();
  assert.deepEqual(detectFixtures(b.pos, b.idx, { levels: [level] }).fixtures, []);
});

test('the scan transform and an inside-out mesh do not change what is found', () => {
  // The mesh rotated 7° in its own frame; the matrix turns it back into plan.
  const { pos, idx } = furnished().pack(7, true);
  const a = -7 * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const matrix = [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1];
  const { fixtures: fx, levels } = detectFixtures(pos, idx, { matrix, levels: [level] });
  assert.equal(levels[0].inverted, true, 'winding read the other way round');
  const counter = one(fx, f => f.kind === 'base-run', 'counter run');
  near(counter.h, 0.91, 0.02, 'counter height');
  near(counter.pts[1][0], 0.05, 0.04, 'corner x in plan');
  one(fx, f => f.subtype === 'bed', 'bed');
});

test('a level above is read at its own floor, and a level with no walls still finds furniture', () => {
  const m = mesh();
  m.slab(0.05, 0.05, 7.95, 5.95, 3.0, true, null, 0.25);
  m.box(5.9, 0.6, 7.47, 2.6, 3.0, 3.59);
  const { pos, idx } = m.pack();
  const { fixtures } = detectFixtures(pos, idx, { levels: [{ id: 'up', elevation: 3.0, height: 2.5, walls: [] }] });
  const bed = one(fixtures, f => f.subtype === 'bed', 'bed upstairs');
  assert.equal(bed.level, 'up'); near(bed.h, 0.59, 0.03, 'height above that floor');
  assert.deepEqual(detectFixtures(pos, idx, { levels: [{ id: 'down', elevation: 0, height: 2.5, walls: [] }] }).fixtures, [], 'nothing on a floor the scan never saw');
  const twice = detectFixtures(pos, idx, { levels: [{ id: 'a', elevation: 3.0, height: 2.5, walls: [] }, { id: 'b', elevation: 2.98, height: 2.6, walls: [] }] }).fixtures;
  assert.equal(twice.filter(f => f.subtype === 'bed').length, 1, 'overlapping level envelopes propose the bed once');
});
