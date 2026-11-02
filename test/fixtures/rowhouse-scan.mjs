// Entirely synthetic: a rowhouse garden floor scanned from inside, so every wall is one face.
// The flat is 5 x 14 m (x across, z along) with party walls at x = 0 and x = 5. A common stair
// the scan never entered runs along the west party wall (x 0..1.7, z 5..10.7): no floor,
// ceiling or party wall there, only the faces of the walls around it seen from the flat. Its
// door (0.72 m, header at 2.0 m, 0.1 m reveals) is in the stair wall at z 6.0..6.72.
//
//   stair: true | false | 'open' (unscanned strip with no walls around it) | 'corner' (the
//          strip reaches the back wall, an L-shaped plan with nothing beyond it)
//   door:  'leaf' (open leaf standing in the stair) | 'beyond' (a stair wall seen through
//          the gap) | 'none' (nothing beyond) | 'noheader' (full-height gap, with a leaf)
//   threshold: floor scanned up to the door (by default it is not: a narrow hall)
//   sideboard: a window in the front wall over a sideboard that hides the floor below it
export function rowhouseScan({ stair = true, door = 'leaf', threshold = false, sideboard = false } = {}) {
  const positions = [], indices = [];
  const H = 2.4, step = 0.25;
  function quad(a, b, c, d) {
    const s = positions.length / 3;
    positions.push(...a, ...b, ...c, ...d);
    indices.push(s, s + 1, s + 2, s, s + 2, s + 3);
  }
  // Vertical face from (x0,z0) to (x1,z1) over y0..y1, leaving `gaps` [{s0, s1, y0, y1}] open.
  function face(x0, z0, x1, z1, y0 = 0, y1 = H, gaps = []) {
    const len = Math.hypot(x1 - x0, z1 - z0), ux = (x1 - x0) / len, uz = (z1 - z0) / len;
    const cuts = [0, len, ...gaps.flatMap(g => [g.s0, g.s1])].filter(v => v >= 0 && v <= len).sort((a, b) => a - b);
    const ys = [y0, y1, ...gaps.flatMap(g => [g.y0, g.y1])].filter(v => v >= y0 && v <= y1).sort((a, b) => a - b);
    const at = (s, y) => [x0 + ux * s, y, z0 + uz * s];
    for (let k = 0; k + 1 < cuts.length; k++) for (let s = cuts[k]; s < cuts[k + 1] - 1e-9; s += step) {
      const sEnd = Math.min(cuts[k + 1], s + step);
      for (let m = 0; m + 1 < ys.length; m++) for (let y = ys[m]; y < ys[m + 1] - 1e-9; y += step) {
        const yEnd = Math.min(ys[m + 1], y + step), sm = (s + sEnd) / 2, ym = (y + yEnd) / 2;
        if (gaps.some(g => sm > g.s0 && sm < g.s1 && ym > g.y0 && ym < g.y1)) continue;
        quad(at(s, y), at(sEnd, y), at(sEnd, yEnd), at(s, yEnd));
      }
    }
  }
  // Floor (up) or ceiling (down) over a rectangle, skipping cells where `skip(x, z)`.
  function slab(x0, z0, x1, z1, y, up, skip = () => false) {
    for (let x = x0; x < x1 - 1e-9; x += step) for (let z = z0; z < z1 - 1e-9; z += step) {
      const xx = Math.min(x1, x + step), zz = Math.min(z1, z + step);
      if (skip((x + xx) / 2, (z + zz) / 2)) continue;
      if (up) quad([x, y, z], [x, y, zz], [xx, y, zz], [xx, y, z]);
      else quad([x, y, z], [xx, y, z], [xx, y, zz], [x, y, zz]);
    }
  }
  const z1 = stair === 'corner' ? 14 : 10.7;
  const inStair = (x, z) => !!stair && x < 1.7 && z > 5 && z < z1;
  const underSideboard = (x, z) => sideboard && x > 2 && x < 3.5 && z < 0.5;
  const atDoor = (x, z) => !threshold && x > 1.7 && x < 2 && z > 6 && z < 6.75;
  slab(0, 0, 5, 14, 0, true, (x, z) => inStair(x, z) || underSideboard(x, z) || atDoor(x, z));
  slab(0, 0, 5, 14, H, false, inStair);
  // Front wall, with a window over the sideboard: no wall seen from the floor to 2.0 m.
  face(5, 0, 0, 0, 0, H, sideboard ? [{ s0: 1.5, s1: 3, y0: 0, y1: 2.0 }] : []);
  if (sideboard) { face(3.5, 0.5, 2, 0.5, 0, 0.9); slab(2, 0, 3.5, 0.5, 0.9, true); }
  face(0, 14, 5, 14);                       // back wall
  face(5, 0, 5, 14);                        // east party wall
  // A partition near the back with both faces scanned and a door with a threshold.
  const pd = [{ s0: 3, s1: 3.9, y0: 0, y1: 2.05 }];
  face(0, 11.94, 5, 11.94, 0, H, pd); face(0, 12.06, 5, 12.06, 0, H, pd);
  if (!stair) { face(0, 14, 0, 0); return pack(); }
  // West party wall: only beside the stair.
  face(0, 5, 0, 0);
  if (stair !== 'corner') face(0, 14, 0, 10.7);
  if (stair === 'open') return pack();
  face(0, 5, 1.7, 5);                       // stair end walls, seen from the flat
  if (stair !== 'corner') face(1.7, 10.7, 0, 10.7);
  // Stair wall with its door, seen from the flat (+x); reveals 0.1 m deep.
  const top = door === 'noheader' ? H : 2.0;
  face(1.7, 5, 1.7, z1, 0, H, [{ s0: 1.0, s1: 1.72, y0: 0, y1: top }]);
  face(1.7, 6.0, 1.6, 6.0, 0, top); face(1.6, 6.72, 1.7, 6.72, 0, top);
  // Open leaf hinged at the north jamb, swung square into the stair.
  if (door === 'leaf' || door === 'noheader') face(1.6, 6.02, 0.88, 6.02, 0, 2.0);
  // The stair's far wall, seen through the doorway.
  if (door === 'beyond') face(0.9, 5.4, 0.9, 7.6);
  return pack();

  function pack() { return { pos: new Float32Array(positions), idx: new Uint32Array(indices) }; }
}
