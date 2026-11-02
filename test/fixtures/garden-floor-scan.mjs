// Entirely synthetic: a garden-floor flat scanned with its surroundings, at the raw heights a
// phone scan reports (the flat's floor is not at y = 0). Signed winding: floors face up.
//
//   flat     x 0..5, z 0..14, floor y = F, ceiling F + 2.3, walls seen from inside
//   garden   raised terrace in front, z -8..0, F + 0.42, with 1.8 m boundary walls
//   deck     overhead deck underside over the front of the garden, F + 2.64
//   porch    small rear porch just below the floor, z 14..16, F - 0.06
//   well     cellar stair inside the flat (x 3.5..4.5, z 9..12.5): treads down to F - 2.34
//   fringe   a run of narrow ledges along the east wall stepping 12 cm at a time from the
//            floor to just under the ceiling: shelf edges, step nosings and mesh fringe
//            that a decimated scan leaves between surfaces
//   soffit   a 12 cm bulkhead over part of the ceiling
export const FLOOR_Y = -1.34;
export function gardenFloorScan({ fringe = true, soffit = true } = {}) {
  const positions = [], indices = [];
  const F = FLOOR_Y, H = 2.3, step = 0.25;
  function quad(a, b, c, d) {
    const s = positions.length / 3;
    positions.push(...a, ...b, ...c, ...d);
    indices.push(s, s + 1, s + 2, s, s + 2, s + 3);
  }
  function slab(x0, z0, x1, z1, y, up, skip = () => false) {
    for (let x = x0; x < x1 - 1e-9; x += step) for (let z = z0; z < z1 - 1e-9; z += step) {
      const xx = Math.min(x1, x + step), zz = Math.min(z1, z + step);
      if (skip((x + xx) / 2, (z + zz) / 2)) continue;
      if (up) quad([x, y, z], [x, y, zz], [xx, y, zz], [xx, y, z]);
      else quad([x, y, z], [xx, y, z], [xx, y, zz], [x, y, zz]);
    }
  }
  function face(x0, z0, x1, z1, y0, y1, gaps = []) {
    const len = Math.hypot(x1 - x0, z1 - z0), ux = (x1 - x0) / len, uz = (z1 - z0) / len;
    for (let s = 0; s < len - 1e-9; s += step) for (let y = y0; y < y1 - 1e-9; y += step) {
      const s1 = Math.min(len, s + step), yy = Math.min(y1, y + step);
      if (gaps.some(g => (s + s1) / 2 > g.s0 && (s + s1) / 2 < g.s1 && (y + yy) / 2 < g.y1)) continue;
      quad([x0 + ux * s, y, z0 + uz * s], [x0 + ux * s1, y, z0 + uz * s1], [x0 + ux * s1, yy, z0 + uz * s1], [x0 + ux * s, yy, z0 + uz * s]);
    }
  }
  const inWell = (x, z) => x > 3.5 && x < 4.5 && z > 9 && z < 12.5;
  const inSoffit = (x, z) => soffit && x > 3 && z > 1 && z < 4;
  // The flat.
  slab(0, 0, 5, 14, F, true, inWell);
  slab(0, 0, 5, 14, F + H, false, (x, z) => inSoffit(x, z));
  if (soffit) { slab(3, 1, 5, 4, F + H - 0.12, false); face(3, 1, 3, 4, F + H - 0.12, F + H); face(3, 4, 5, 4, F + H - 0.12, F + H); face(5, 1, 3, 1, F + H - 0.12, F + H); }
  const door = [{ s0: 2, s1: 2.9, y1: F + 2.05 }];
  face(0, 0, 5, 0, F, F + H, door); face(5, 0, 5, 14, F, F + H); face(5, 14, 0, 14, F, F + H, door); face(0, 14, 0, 0, F, F + H);
  // Cellar stair: 11 treads, 0.195 m apart, then a 1 m2 landing at the cellar floor.
  for (let k = 1; k <= 11; k++) slab(3.5, 9 + (k - 1) * 0.2, 4.5, 9 + k * 0.2, F - 0.195 * k, true);
  slab(3.5, 11.5, 4.5, 12.5, F - 2.34, true);
  face(3.5, 9, 3.5, 12.5, F - 2.34, F); face(4.5, 12.5, 4.5, 9, F - 2.34, F);
  // Raised garden with its boundary walls, and the deck over the front of it.
  slab(0, -8, 5, 0, F + 0.42, true);
  face(0, -8, 5, -8, F + 0.42, F + 2.22); face(0, 0, 0, -8, F + 0.42, F + 2.22); face(5, -8, 5, 0, F + 0.42, F + 2.22);
  slab(0, -3.5, 5, 0, F + 2.64, false);
  // Rear porch, a step down.
  slab(0, 14, 5, 16, F - 0.06, true);
  // Fringe: 25 cm long, 4 cm deep ledges, each 12 cm above the last, from floor to ceiling.
  if (fringe) for (let k = 1; k * 0.12 < H - 0.1; k++) {
    const z = 0.5 + k * 0.25, y = F + k * 0.12;
    quad([4.9, y, z], [4.9, y, z + 0.25], [4.94, y, z + 0.25], [4.94, y, z]);
  }
  return { pos: new Float32Array(positions), idx: new Uint32Array(indices) };
}
