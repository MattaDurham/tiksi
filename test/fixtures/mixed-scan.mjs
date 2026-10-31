// Entirely synthetic geometry, shared by Node and browser regressions.
export function mixedScan({ yard = true, landing = true, porch = true, slope = false, reverse = false, unsigned = false, indoorCeiling = true, porchHeight = 3.0, noise = false, ceilingSlope = 0 } = {}) {
  const positions = [], indices = [];
  let face = 0;
  function quad(a, b, c, d) {
    const start = positions.length / 3;
    positions.push(...a, ...b, ...c, ...d);
    const flip = reverse || (unsigned && face++ % 2);
    indices.push(...(flip ? [start, start + 2, start + 1, start, start + 3, start + 2] : [start, start + 1, start + 2, start, start + 2, start + 3]));
  }
  function slab(x0, z0, x1, z1, y, up, tilt = 0) {
    for (let x = x0; x < x1; x += 0.25) for (let z = z0; z < z1; z += 0.25) {
      const xx = Math.min(x + 0.25, x1), zz = Math.min(z + 0.25, z1);
      const at = (u, v) => [u, y + (u - x0) * tilt + (noise ? 0.008 * Math.sin(5 * u + 3 * v) : 0), v];
      if (up) quad(at(x, z), at(x, zz), at(xx, zz), at(xx, z));
      else quad(at(x, z), at(xx, z), at(xx, zz), at(x, zz));
    }
  }
  function wall(x0, z0, x1, z1) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    for (let s = 0; s < len; s += 0.25) for (let y = 0; y < 2.6; y += 0.25) {
      const at = (u, v) => [x0 + (x1 - x0) * u / len, v, z0 + (z1 - z0) * u / len];
      const end = Math.min(s + 0.25, len), top = Math.min(y + 0.25, 2.6);
      quad(at(s, y), at(end, y), at(end, top), at(s, top));
    }
  }
  slab(0, 0, 4, 5, 0, true);
  if (indoorCeiling) slab(0, 0, 4, 5, 2.6, false, ceilingSlope);
  wall(0, 0, 4, 0); wall(4, 0, 4, 5); wall(4, 5, 0, 5); wall(0, 5, 0, 0);
  if (yard) slab(4, 0, 14, 8, 0.55, true, slope ? 0.012 : 0);
  // Larger overhead than the interior ceiling, but in a different region.
  if (porch) slab(4, 0, 12, 5, porchHeight, false);
  if (landing) slab(4, -1.25, 5, -0.25, -2.15, true);
  return { pos: new Float32Array(positions), idx: new Uint32Array(indices) };
}
