// Regression test for scan2plan on a synthetic two-storey house.
// Run: node test/scan2plan.test.mjs
//
// Builds a mesh the way a lidar scan would see it (inside faces only): two levels,
// each 8 x 6 m with a partition wall and a doorway, a window in one exterior wall,
// the whole thing rotated 7 degrees, plus a slab of furniture against a wall.
// Asserts levels, wall count, rooms, the door and the window.

import { scanToPlan } from '../js/scan2plan-core.js';

const tris = [];
function quad(a, b, c, d) { tris.push([a, b, c], [a, c, d]); }
// Vertical wall face from (x0,z0) to (x1,z1), heights y0..y1, subdivided so sampling stays dense.
function wallFace(x0, z0, x1, z1, y0, y1, gaps) {
  // gaps: [{s0, s1, y0, y1}] along the wall (0..len) to leave open.
  const len = Math.hypot(x1 - x0, z1 - z0), ux = (x1 - x0) / len, uz = (z1 - z0) / len;
  const step = 0.25;
  for (let s = 0; s < len - 1e-9; s += step) {
    const s1 = Math.min(len, s + step);
    for (let y = y0; y < y1 - 1e-9; y += step) {
      const yy = Math.min(y1, y + step);
      const mid = (s + s1) / 2, ymid = (y + yy) / 2;
      if ((gaps || []).some(g => mid > g.s0 && mid < g.s1 && ymid > g.y0 && ymid < g.y1)) continue;
      quad([x0 + ux * s, y, z0 + uz * s], [x0 + ux * s1, y, z0 + uz * s1], [x0 + ux * s1, yy, z0 + uz * s1], [x0 + ux * s, yy, z0 + uz * s]);
    }
  }
}
function slab(x0, z0, x1, z1, y, up) {
  const step = 0.25;
  for (let x = x0; x < x1 - 1e-9; x += step) for (let z = z0; z < z1 - 1e-9; z += step) {
    const xx = Math.min(x1, x + step), zz = Math.min(z1, z + step);
    if (up) quad([x, y, z], [x, y, zz], [xx, y, zz], [xx, y, z]);
    else quad([x, y, z], [xx, y, z], [xx, y, zz], [x, y, zz]);
  }
}
function level(baseY, H, withWindow) {
  // Exterior 8 x 6 (x 0..8, z 0..6); partition at x = 3 with a 0.9 m door at z 2.5..3.4.
  slab(0, 0, 8, 6, baseY, true);
  slab(0, 0, 8, 6, baseY + H, false);
  wallFace(0, 0, 8, 0, baseY, baseY + H, withWindow ? [{ s0: 5, s1: 6.2, y0: baseY + 0.9, y1: baseY + 2.0 }] : []);
  wallFace(8, 0, 8, 6, baseY, baseY + H);
  wallFace(8, 6, 0, 6, baseY, baseY + H);
  wallFace(0, 6, 0, 0, baseY, baseY + H);
  wallFace(3, 0, 3, 6, baseY, baseY + H, [{ s0: 2.5, s1: 3.4, y0: baseY, y1: baseY + 2.05 }]);
  wallFace(3.12, 6, 3.12, 0, baseY, baseY + H, [{ s0: 2.6, s1: 3.5, y0: baseY, y1: baseY + 2.05 }]);
  // A wardrobe 0.6 deep, 1.8 tall, 1.5 wide against the north wall (z = 0).
  wallFace(6, 0.6, 7.5, 0.6, baseY, baseY + 1.8);
  slab(6, 0, 7.5, 0.6, baseY + 1.8, true);
}
level(0, 2.5, true);
level(2.8, 2.5, false);

// Rotate 7 degrees about Y and pack.
const ang = 7 * Math.PI / 180, c = Math.cos(ang), s = Math.sin(ang);
const pos = new Float32Array(tris.length * 9), idx = new Uint32Array(tris.length * 3);
tris.forEach((t, i) => t.forEach((p, k) => {
  const [x, y, z] = p;
  pos[(3 * i + k) * 3] = x * c - z * s; pos[(3 * i + k) * 3 + 1] = y; pos[(3 * i + k) * 3 + 2] = x * s + z * c;
  idx[3 * i + k] = 3 * i + k;
}));

const res = scanToPlan(pos, idx, {});
let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };

check(Math.abs(((res.rotationDeg % 90) + 90) % 90 - 83) < 1.0 || Math.abs(((res.rotationDeg % 90) + 90) % 90 - 7) < 1.0,
  'rotation recovered (' + res.rotationDeg.toFixed(2) + ' deg)');
check(res.levels.length === 2, 'two levels found (' + res.levels.length + ')');
for (const L of res.levels) {
  const doors = L.openings.filter(o => o.type === 'door'), windows = L.openings.filter(o => o.type === 'window');
  console.log('  ' + L.name + ': h ' + L.height + ', walls ' + L.walls.length + ', rooms ' + L.rooms.length + ' (' + L.rooms.map(r => r.area.toFixed(1)).join(', ') + ' m2), doors ' + doors.length + ', windows ' + windows.length);
  check(Math.abs(L.height - 2.5) < 0.12, L.name + ' height ~2.5 m');
  check(L.walls.length >= 5 && L.walls.length <= 8, L.name + ' has 5..8 walls');
  check(L.rooms.length === 2, L.name + ' has two rooms');
  const areas = L.rooms.map(r => r.area).sort((a, b) => a - b);
  check(areas.length === 2 && Math.abs(areas[0] - 18) < 3 && Math.abs(areas[1] - 30) < 3, L.name + ' room areas ~18 and ~30 m2');
  check(doors.length === 1 && Math.abs(doors[0].width - 0.9) < 0.25, L.name + ' one door ~0.9 m wide');
  check(!L.walls.some(w => Math.hypot(w.bx - w.ax, w.by - w.ay) < 1.6 && w.thickness > 0.3), L.name + ' wardrobe not traced as a wall');
}
const win = res.levels[0].openings.filter(o => o.type === 'window');
check(win.length === 1 && Math.abs(win[0].width - 1.2) < 0.3 && Math.abs((win[0].sill || 0) - 0.9) < 0.2, 'window on level 1 ~1.2 m wide, sill ~0.9 m');
check(res.levels[1].openings.filter(o => o.type === 'window').length === 0, 'no window on level 2');

console.log(failed ? failed + ' check(s) failed' : 'all checks passed');
process.exit(failed ? 1 : 0);
