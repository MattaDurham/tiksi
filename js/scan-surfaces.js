// Coarse connected horizontal evidence, independent of the fine wall raster.
// These patches are observations, not authored floors or a claim of indoor use.
export const SURFACE_CELL = 0.25;
const CELL = SURFACE_CELL, HEIGHT = 0.08, JOIN = 0.16, MIN_AREA = 0.35;
const key = (x, z, y) => `${x},${z},${y}`;
const xy = (x, z) => `${x},${z}`;

export function horizontalPatches(pos, idx, tri) {
  const voxels = new Map();
  for (let t = 0; t < tri.nT; t++) {
    if (Math.abs(tri.ny[t]) < 0.85 || !tri.area[t]) continue;
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const edge = Math.max(Math.hypot(pos[a] - pos[b], pos[a + 2] - pos[b + 2]),
      Math.hypot(pos[a] - pos[c], pos[a + 2] - pos[c + 2]), Math.hypot(pos[b] - pos[c], pos[b + 2] - pos[c + 2]));
    const n = Math.max(1, Math.ceil(edge / (CELL / 2))), weight = tri.area[t] / ((n + 1) * (n + 2) / 2);
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
      const u = i / n, v = j / n, r = 1 - u - v;
      const x = Math.floor((pos[a] * r + pos[b] * u + pos[c] * v) / CELL);
      const z = Math.floor((pos[a + 2] * r + pos[b + 2] * u + pos[c + 2] * v) / CELL);
      const y = pos[a + 1] * r + pos[b + 1] * u + pos[c + 1] * v, h = Math.floor(y / HEIGHT);
      const k = key(x, z, h);
      let p = voxels.get(k);
      if (!p) { p = { x, z, h, area: 0, sumY: 0, up: 0, minY: y, maxY: y }; voxels.set(k, p); }
      p.area += weight; p.sumY += y * weight; p.up += tri.ny[t] > 0 ? weight : 0;
      p.minY = Math.min(p.minY, y); p.maxY = Math.max(p.maxY, y);
    }
  }
  const patches = [];
  for (const seed of voxels.values()) {
    if (seed.seen) continue;
    const stack = [seed], cells = new Set(); seed.seen = true;
    let area = 0, sumY = 0, up = 0, minY = Infinity, maxY = -Infinity;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    while (stack.length) {
      const p = stack.pop();
      area += p.area; sumY += p.sumY; up += p.up;
      minY = Math.min(minY, p.minY); maxY = Math.max(maxY, p.maxY);
      x0 = Math.min(x0, p.x * CELL); z0 = Math.min(z0, p.z * CELL);
      x1 = Math.max(x1, (p.x + 1) * CELL); z1 = Math.max(z1, (p.z + 1) * CELL);
      cells.add(xy(p.x, p.z));
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dh = -2; dh <= 2; dh++) {
        const q = voxels.get(key(p.x + dx, p.z + dz, p.h + dh));
        if (!q || q.seen || Math.abs(q.sumY / q.area - p.sumY / p.area) > JOIN) continue;
        q.seen = true; stack.push(q);
      }
    }
    if (area >= MIN_AREA) patches.push({ area, y: sumY / area, minY, maxY, upShare: up / area,
      cells, bounds: { x0, z0, x1, z1 } });
  }
  patches.sort((a, b) => a.y - b.y || a.bounds.x0 - b.bounds.x0 || a.bounds.z0 - b.bounds.z0);
  patches.forEach((p, i) => { p.id = 'surface-' + i; });
  return patches;
}

function overlap(a, b) {
  let shared = 0;
  for (const k of a.cells) if (b.cells.has(k)) shared++;
  return shared / a.cells.size;
}

function wallSupport(pos, idx, tri, f, ceiling) {
  let area = 0;
  for (let t = 0; t < tri.nT; t++) {
    if (Math.abs(tri.ny[t]) > 0.35) continue;
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const y = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3;
    if (y < f.y + 0.3 || y > ceiling - 0.15) continue;
    const x = Math.floor((pos[a] + pos[b] + pos[c]) / (3 * CELL));
    const z = Math.floor((pos[a + 2] + pos[b + 2] + pos[c + 2]) / (3 * CELL));
    if ([-1, 0, 1].some(dx => [-1, 0, 1].some(dz => f.cells.has(xy(x + dx, z + dz))))) area += tri.area[t];
  }
  // A broad roof alone is weak indoor evidence; walls around a supported floor are stronger.
  return Math.min(1, area / (3 * Math.sqrt(f.area) * (ceiling - f.y)));
}

export function spatialLevels(pos, idx, tri, o, maxY) {
  const patches = horizontalPatches(pos, idx, tri);
  const large = patches.filter(p => p.area >= o.floorMinArea);
  const lowest = large[0];
  // Determine winding with an overlapping pair, never an unrelated yard/roof pair.
  const opposite = lowest && patches.find(c => c.y > lowest.y + o.levelMinSep && overlap(lowest, c) > 0.35 &&
    ((lowest.upShare > 0.75 && c.upShare < 0.25) || (lowest.upShare < 0.25 && c.upShare > 0.75)));
  const signed = !!opposite, inverted = signed && lowest.upShare < 0.25;
  if (inverted) for (let t = 0; t < tri.nT; t++) tri.ny[t] = -tri.ny[t];
  const upShare = p => inverted ? 1 - p.upShare : p.upShare;
  const candidates = large.filter(p => !signed || upShare(p) > 0.75).map(f => {
    const ceiling = patches.find(c => c.y >= f.y + o.levelMinSep && c.y <= f.y + 5 &&
      (!signed || upShare(c) < 0.25) && overlap(f, c) >= 0.35);
    const ceilY = ceiling ? ceiling.y : Math.max(f.y + 0.6, Math.min(f.y + 2.7, maxY - 0.05));
    const coverage = ceiling ? overlap(f, ceiling) : 0;
    const enclosure = wallSupport(pos, idx, tri, f, ceilY);
    return { f, ceiling, floorY: f.y, ceilY, floorArea: f.area, flatCeiling: !!ceiling && ceiling.maxY - ceiling.minY < 0.15,
      score: 2 * enclosure + coverage, coverage, enclosure };
  });
  const levels = [];
  for (const c of candidates) {
    // In an unsigned mesh, an already paired ceiling is not another floor.
    if (!signed && levels.some(l => l.ceiling && Math.abs(c.floorY - l.ceilY) < 0.15)) continue;
    const last = levels[levels.length - 1];
    if (last && c.floorY - last.floorY < o.levelMinSep) {
      if (c.score > last.score + 0.01 || (Math.abs(c.score - last.score) <= 0.01 && c.floorArea > last.floorArea)) levels[levels.length - 1] = c;
    } else levels.push(c);
  }
  // No supported room above: retain large unpaired patches as evidence, not extra storeys.
  const paired = levels.filter(l => l.ceiling || l.enclosure > 0.5);
  const selected = paired.length ? paired : levels.slice(0, 1);
  for (const L of selected) {
    L.support = new Set();
    // Disconnected rooms at the same datum remain part of the storey; other
    // elevations stay evidence and cannot supply its floor/ceiling footprint.
    for (const p of patches) if ((!signed || upShare(p) > 0.75) && Math.abs(p.y - L.floorY) < 0.12) {
      for (const k of p.cells) {
        const [x, z] = k.split(',').map(Number);
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) L.support.add(xy(x + dx, z + dz));
      }
    }
  }
  return { levels: selected, patches, signed, upShare };
}

// Compact serializable evidence. Geometry samples and Maps never leave the core.
export function surfaceReport(detection, base) {
  return detection.patches.map(p => ({ id: p.id, elevation: p.y - base, minElevation: p.minY - base,
    maxElevation: p.maxY - base, area: p.area, bounds: p.bounds,
    facing: !detection.signed ? 'unknown' : detection.upShare(p) > 0.75 ? 'up' : detection.upShare(p) < 0.25 ? 'down' : 'mixed' }));
}

export function floorReviewText(report) {
  if (!report) return '';
  const datums = report.levels.map(l => `${l.elevation.toFixed(2)} m (${l.datum.confidence})`).join(', ');
  return `${report.required ? 'Review floor datums' : 'Supported floor datums'}: ${datums}. ` +
    (report.required ? 'Mixed or uncertain surfaces remain in the scan; check elevations and room takeoffs.' : 'Scan estimates; verify before using takeoffs.');
}

export function floorDetectionReport(result) {
  if (!result.review) return null;
  return { ...result.review, surfaces: result.surfaces,
    levels: result.levels.map(l => ({ elevation: l.elevation, height: l.height, datum: l.datum, underlayMin: l.underlayMin })) };
}
