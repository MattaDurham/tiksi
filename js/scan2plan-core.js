// scan2plan: turn a lidar mesh (phone scan) into levels, walls, openings and rooms.
//
// Pure functions over typed arrays; no DOM, no three.js, so the same module runs
// in a Web Worker in the app and under Node for testing. Input is a triangle mesh
// in meters, Y up (glTF convention). Output uses tiksi plan coordinates:
// plan x = world x, plan y = world z, heights relative to each level's floor.
//
// Method, in order:
//   1. Triangle normals and areas.
//   2. Dominant wall orientation (area-weighted histogram of horizontal normals,
//      mod 90 degrees); rotate the scan so walls become axis-aligned.
//   3. Floor levels from the height histogram of up-facing area; ceilings from
//      down-facing area between consecutive floors.
//   4. Per level, rasterize to a 2D grid: floor area, ceiling area, and a bitmask
//      of 10 cm height slices with vertical geometry ("column coverage").
//      A wall covers nearly every slice; furniture covers a few; a doorway none.
//   5. Wall mask = high coverage, filtered to thin straight runs (blobs are
//      furniture). Runs group into axis-aligned bands; bands become wall segments;
//      collinear segments merge across door-sized gaps; corners get snapped.
//   6. Openings from the coverage profile along each wall: empty from the floor
//      up is a door, a sill with an empty band above it is a window.
//   7. Rooms = footprint (floor or ceiling) minus walls, as connected components,
//      traced, simplified to rectilinear polygons and snapped to wall lines.

const DEG = Math.PI / 180;

export const DEFAULTS = {
  cell: 0.02,             // raster cell, meters
  slice: 0.1,             // coverage slice height
  sliceFrom: 0.25,        // first slice starts this far above the floor
  sliceBelowCeil: 0.15,   // last slice ends this far below the ceiling
  floorMinArea: 5,        // m2 of up-facing area to count as a floor level
  levelMinSep: 1.8,       // minimum vertical distance between floors
  covDilate: 2,           // cells of lateral OR-dilation on the coverage bitmask (absorbs scan noise)
  wallCoverage: 0.55,     // fraction of slices present to call a cell "wall"
  wallMinLen: 0.6,        // shortest straight run treated as a wall
  wallMaxThick: 0.40,     // runs thicker than this are furniture, not walls
  mergeGap: 1.4,          // collinear walls closer than this merge (gap = opening)
  windowGap: 3.2,         // exterior walls merge across gaps up to this (windows)
  cornerSnap: 0.35,       // endpoints within this of a perpendicular wall snap to it
  roomMinArea: 1.0,       // m2
  roomMinEdge: 0.3,       // room outline edges shorter than this are absorbed
  doorMin: 0.5, doorMax: 2.6,
  windowMin: 0.4,
};

// ---------- small raster helpers ----------

function popcount(x) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
}

function dilate(mask, W, H, r) {
  const out = new Uint8Array(W * H);
  // Separable square dilation.
  const tmp = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) {
    let run = 0;
    for (let i = 0; i < W + r; i++) {
      if (i < W && mask[j * W + i]) run = 2 * r + 1;
      if (run > 0 && i - r >= 0 && i - r < W) tmp[j * W + i - r] = 1;
      run--;
    }
  }
  for (let i = 0; i < W; i++) {
    let run = 0;
    for (let j = 0; j < H + r; j++) {
      if (j < H && tmp[j * W + i]) run = 2 * r + 1;
      if (run > 0 && j - r >= 0 && j - r < H) out[(j - r) * W + i] = 1;
      run--;
    }
  }
  return out;
}
function erode(mask, W, H, r) {
  const inv = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) inv[k] = mask[k] ? 0 : 1;
  // Treat outside as empty so borders erode.
  const d = dilate(inv, W, H, r);
  const out = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) out[k] = d[k] ? 0 : 1;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    if (i < r || j < r || i >= W - r || j >= H - r) out[j * W + i] = 0;
  }
  return out;
}
const close = (m, W, H, r) => erode(dilate(m, W, H, r), W, H, r);
const open = (m, W, H, r) => dilate(erode(m, W, H, r), W, H, r);

// 4-connected components; returns {labels:Int32Array, sizes:[], count}
function components(mask, W, H) {
  const labels = new Int32Array(W * H).fill(-1);
  const sizes = [];
  const stack = new Int32Array(W * H);
  let count = 0;
  for (let s = 0; s < W * H; s++) {
    if (!mask[s] || labels[s] >= 0) continue;
    let sp = 0; stack[sp++] = s; labels[s] = count; let size = 0;
    while (sp) {
      const k = stack[--sp]; size++;
      const i = k % W, j = (k - i) / W;
      if (i > 0 && mask[k - 1] && labels[k - 1] < 0) { labels[k - 1] = count; stack[sp++] = k - 1; }
      if (i < W - 1 && mask[k + 1] && labels[k + 1] < 0) { labels[k + 1] = count; stack[sp++] = k + 1; }
      if (j > 0 && mask[k - W] && labels[k - W] < 0) { labels[k - W] = count; stack[sp++] = k - W; }
      if (j < H - 1 && mask[k + W] && labels[k + W] < 0) { labels[k + W] = count; stack[sp++] = k + W; }
    }
    sizes.push(size); count++;
  }
  return { labels, sizes, count };
}

// Fill enclosed holes smaller than maxCells.
function fillHoles(mask, W, H, maxCells) {
  const inv = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) inv[k] = mask[k] ? 0 : 1;
  const { labels, sizes } = components(inv, W, H);
  // Components touching the border are outside, keep them empty.
  const border = new Set();
  for (let i = 0; i < W; i++) { if (labels[i] >= 0) border.add(labels[i]); if (labels[(H - 1) * W + i] >= 0) border.add(labels[(H - 1) * W + i]); }
  for (let j = 0; j < H; j++) { if (labels[j * W] >= 0) border.add(labels[j * W]); if (labels[j * W + W - 1] >= 0) border.add(labels[j * W + W - 1]); }
  const out = new Uint8Array(mask);
  for (let k = 0; k < W * H; k++) {
    const l = labels[k];
    if (l >= 0 && !border.has(l) && sizes[l] <= maxCells) out[k] = 1;
  }
  return out;
}

function keepLargeComponents(mask, W, H, minCells) {
  const { labels, sizes } = components(mask, W, H);
  const out = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) if (labels[k] >= 0 && sizes[labels[k]] >= minCells) out[k] = 1;
  return out;
}

// ---------- 1 + 2: triangles and orientation ----------

function triangleData(pos, idx) {
  const nT = (idx.length / 3) | 0;
  const ny = new Float32Array(nT), area = new Float32Array(nT), ang = new Float32Array(nT);
  for (let t = 0; t < nT; t++) {
    const a = idx[3 * t] * 3, b = idx[3 * t + 1] * 3, c = idx[3 * t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, nyy = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, nyy, nz);
    area[t] = len / 2;
    ny[t] = len ? nyy / len : 0;
    ang[t] = Math.atan2(nz, nx);
  }
  return { nT, ny, area, ang };
}

export function dominantAngle(tri) {
  // Histogram of horizontal normal direction mod 90 deg, 0.25 deg bins, area weighted.
  const bins = 360, hist = new Float64Array(bins);
  for (let t = 0; t < tri.nT; t++) {
    if (Math.abs(tri.ny[t]) > 0.25) continue;
    let d = tri.ang[t] / DEG; d = ((d % 90) + 90) % 90;
    hist[Math.floor(d / 0.25) % bins] += tri.area[t];
  }
  // Circular smoothing (5 bins) and peak.
  const sm = new Float64Array(bins);
  for (let i = 0; i < bins; i++) for (let k = -2; k <= 2; k++) sm[i] += hist[(i + k + bins) % bins];
  let best = 0; for (let i = 1; i < bins; i++) if (sm[i] > sm[best]) best = i;
  // Weighted mean within +-2 deg of the peak, on the 4x circle to stay continuous at 0/90.
  let sx = 0, sy = 0;
  for (let k = -8; k <= 8; k++) {
    const i = (best + k + bins) % bins;
    const a = (i + 0.5) * 0.25 * DEG * 4;
    sx += Math.cos(a) * hist[i]; sy += Math.sin(a) * hist[i];
  }
  const deg = (Math.atan2(sy, sx) / 4) / DEG;
  // Confidence: share of vertical area within +-3 deg of the two axes.
  let near = 0, total = 0;
  for (let i = 0; i < bins; i++) {
    total += hist[i];
    const d = Math.min(Math.abs(i * 0.25 - ((deg % 90) + 90) % 90), 90 - Math.abs(i * 0.25 - ((deg % 90) + 90) % 90));
    if (d <= 3) near += hist[i];
  }
  return { deg, manhattanShare: total ? near / total : 0 };
}

function rotateXZ(pos, deg) {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    out[i] = x * c + z * s; out[i + 1] = y; out[i + 2] = -x * s + z * c;
  }
  return out;
}

// ---------- 3: levels ----------

export function findLevels(pos, idx, tri, o) {
  let minY = Infinity, maxY = -Infinity;
  for (let i = 1; i < pos.length; i += 3) { if (pos[i] < minY) minY = pos[i]; if (pos[i] > maxY) maxY = pos[i]; }
  const bin = 0.02, nb = Math.ceil((maxY - minY) / bin) + 1;
  const all = new Float64Array(nb), up = new Float64Array(nb), down = new Float64Array(nb);
  for (let t = 0; t < tri.nT; t++) {
    if (Math.abs(tri.ny[t]) < 0.85) continue;
    const a = idx[3 * t] * 3 + 1, b = idx[3 * t + 1] * 3 + 1, c = idx[3 * t + 2] * 3 + 1;
    const k = Math.floor(((pos[a] + pos[b] + pos[c]) / 3 - minY) / bin);
    all[k] += tri.area[t];
    if (tri.ny[t] > 0) up[k] += tri.area[t]; else down[k] += tri.area[t];
  }
  const runs = (arr, thr) => {
    const out = []; let r = null;
    for (let k = 0; k < nb; k++) {
      if (arr[k] > thr) { if (!r) r = { k0: k, k1: k, area: 0, peak: 0, pk: k }; r.k1 = k; r.area += arr[k]; if (arr[k] > r.peak) { r.peak = arr[k]; r.pk = k; } }
      else if (r) { out.push(r); r = null; }
    }
    if (r) out.push(r);
    return out.map(r => ({ y: minY + (r.pk + 0.5) * bin, area: r.area, k0: r.k0, k1: r.k1 }));
  };
  const share = (r, arr) => { let s = 0; for (let k = r.k0; k <= r.k1; k++) s += arr[k]; return r.area ? s / r.area : 0; };
  const mergeClose = list => {
    const out = [];
    for (const f of list) {
      const last = out[out.length - 1];
      if (last && f.y - last.y < o.levelMinSep) { if (f.area > last.area) out[out.length - 1] = f; }
      else out.push(f);
    }
    return out;
  };

  // Is the mesh consistently oriented? The lowest large horizontal surface is a floor; the
  // first surface at least 1.8 m above it is that floor's ceiling and must face the other
  // way. Scans are; some exporters and synthetic meshes are not, and some are inside out.
  const surfaces = runs(all, 0.8).filter(r => r.area >= 3).sort((x, y) => x.y - y.y);
  const largest = Math.max(...surfaces.map(r => r.area), 0);
  const bigEnough = r => r.area >= Math.max(o.floorMinArea, 0.12 * largest);
  const lowest = surfaces.find(bigEnough);
  let signed = false;
  if (lowest) {
    const upShare = share(lowest, up);
    const polarity = upShare >= 0.75 ? 1 : (upShare <= 0.25 ? -1 : 0);
    const above = surfaces.find(r => r.y >= lowest.y + 1.8);
    const aboveShare = above ? share(above, polarity === 1 ? down : up) : 1;
    signed = polarity !== 0 && aboveShare >= 0.75;
    if (signed && polarity === -1) {
      // Inside out: flip every normal so floors face up, and swap the histograms to match.
      for (let t = 0; t < tri.nT; t++) tri.ny[t] = -tri.ny[t];
      for (let k = 0; k < nb; k++) { const u = up[k]; up[k] = down[k]; down[k] = u; }
    }
  }

  let levels;
  if (signed) {
    // Floors are up-facing peaks; each level's ceiling is the largest down-facing peak
    // between its floor and the next.
    const floors = mergeClose(runs(up, 0.8).filter(bigEnough).sort((x, y) => x.y - y.y));
    const ceils = runs(down, 0.8).filter(c => c.area >= 3);
    levels = floors.map((f, i) => {
      const next = floors[i + 1] ? floors[i + 1].y : maxY + 1;
      const cands = ceils.filter(c => c.y > f.y + 1.8 && c.y < next - 0.05);
      let ceil, flat = true;
      if (cands.length) ceil = cands.reduce((x, y) => (y.area > x.area ? y : x)).y;
      else { flat = false; ceil = Math.min(f.y + 2.7, floors[i + 1] ? next - 0.25 : maxY - 0.05); }
      return { floorY: f.y, ceilY: ceil, floorArea: f.area, flatCeiling: flat };
    });
  } else {
    // Pair surfaces by height alone: a floor, then the first surface at least 1.8 m above
    // it is its ceiling, and a surface within 0.7 m above that ceiling is the next floor.
    levels = [];
    const floorsOnly = mergeClose(surfaces.filter(bigEnough));
    let f = floorsOnly[0] || null;
    while (f) {
      const c = surfaces.find(r => r.y >= f.y + 1.8);
      if (!c) { levels.push({ floorY: f.y, ceilY: Math.min(f.y + 2.7, maxY - 0.05), floorArea: f.area, flatCeiling: false }); break; }
      levels.push({ floorY: f.y, ceilY: c.y, floorArea: f.area, flatCeiling: true });
      f = floorsOnly.find(r => r.y > c.y + 0.05 && r.y <= c.y + 0.7) || null;
    }
  }
  return { levels, minY, maxY, signed };
}

// ---------- 4: rasterize ----------

function rasterize(pos, idx, tri, levels, o) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i] < minX) minX = pos[i]; if (pos[i] > maxX) maxX = pos[i];
    if (pos[i + 2] < minZ) minZ = pos[i + 2]; if (pos[i + 2] > maxZ) maxZ = pos[i + 2];
  }
  const cell = o.cell, pad = 0.4;
  const ox = minX - pad, oz = minZ - pad;
  const W = Math.ceil((maxX - minX + 2 * pad) / cell), H = Math.ceil((maxZ - minZ + 2 * pad) / cell);
  const grid = { W, H, ox, oz, cell };
  for (const L of levels) {
    L.floor = new Float32Array(W * H); L.ceil = new Float32Array(W * H); L.cov = new Uint32Array(W * H);
    L.nSlices = Math.max(4, Math.min(30, Math.floor((L.ceilY - o.sliceBelowCeil - L.floorY - o.sliceFrom) / o.slice)));
  }
  // Level lookup by height: level i owns [floorY - 0.25, nextFloorY - 0.25).
  const lo = levels[0].floorY - 0.3, hi = levels[levels.length - 1].ceilY + 0.3;
  const LUT_RES = 0.01, lutN = Math.ceil((hi - lo) / LUT_RES) + 1;
  const lut = new Int8Array(lutN).fill(-1);
  for (let k = 0; k < lutN; k++) {
    const y = lo + k * LUT_RES;
    for (let i = levels.length - 1; i >= 0; i--) if (y >= levels[i].floorY - 0.25) { lut[k] = i; break; }
  }
  const spacing = cell;
  for (let t = 0; t < tri.nT; t++) {
    const a = idx[3 * t] * 3, b = idx[3 * t + 1] * 3, c = idx[3 * t + 2] * 3;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2], bx = pos[b], by = pos[b + 1], bz = pos[b + 2], cx = pos[c], cy = pos[c + 1], cz = pos[c + 2];
    const ny = tri.ny[t], area = tri.area[t];
    const e = Math.max(Math.hypot(bx - ax, by - ay, bz - az), Math.hypot(cx - ax, cy - ay, cz - az), Math.hypot(cx - bx, cy - by, cz - bz));
    const n = Math.max(1, Math.ceil(e / spacing));
    const w = area / ((n + 1) * (n + 2) / 2);
    const vertical = Math.abs(ny) < 0.35, horizontal = Math.abs(ny) > 0.8;
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
      const u = i / n, v = j / n, r = 1 - u - v;
      const x = ax * r + bx * u + cx * v, y = ay * r + by * u + cy * v, z = az * r + bz * u + cz * v;
      const ci = Math.floor((x - ox) / cell), cj = Math.floor((z - oz) / cell);
      if (ci < 0 || cj < 0 || ci >= W || cj >= H) continue;
      const lk = Math.floor((y - lo) / LUT_RES);
      if (lk < 0 || lk >= lutN) continue;
      const li = lut[lk]; if (li < 0) continue;
      const L = levels[li], k = cj * W + ci;
      if (horizontal) {
        // Floor or ceiling by height alone, so winding never matters here.
        if (y > L.floorY - 0.15 && y < L.floorY + 0.12) L.floor[k] += w;
        else if (Math.abs(y - L.ceilY) < 0.15) L.ceil[k] += w;
      } else if (vertical) {
        const h = y - L.floorY - o.sliceFrom;
        if (h >= 0 && y < L.ceilY - o.sliceBelowCeil) {
          const sl = Math.floor(h / o.slice);
          if (sl < L.nSlices) L.cov[k] |= (1 << sl);
        }
      }
    }
  }
  // Lateral OR-dilation of the coverage bits (radius covDilate cells). Scan noise
  // spreads a wall face over a few cells; without this no single column sees every slice.
  const r = o.covDilate;
  for (const L of levels) {
    const tmp = new Uint32Array(W * H), out = new Uint32Array(W * H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      let b = 0;
      for (let d = -r; d <= r; d++) { const ii = i + d; if (ii >= 0 && ii < W) b |= L.cov[j * W + ii]; }
      tmp[j * W + i] = b;
    }
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      let b = 0;
      for (let d = -r; d <= r; d++) { const jj = j + d; if (jj >= 0 && jj < H) b |= tmp[jj * W + i]; }
      out[j * W + i] = b;
    }
    L.covD = out;
  }
  return grid;
}

// ---------- 5: walls ----------

function runLengths(mask, W, H) {
  const hRun = new Uint16Array(W * H), vRun = new Uint16Array(W * H);
  for (let j = 0; j < H; j++) {
    let i = 0;
    while (i < W) {
      if (!mask[j * W + i]) { i++; continue; }
      let e = i; while (e < W && mask[j * W + e]) e++;
      for (let k = i; k < e; k++) hRun[j * W + k] = e - i;
      i = e;
    }
  }
  for (let i = 0; i < W; i++) {
    let j = 0;
    while (j < H) {
      if (!mask[j * W + i]) { j++; continue; }
      let e = j; while (e < H && mask[e * W + i]) e++;
      for (let k = j; k < e; k++) vRun[k * W + i] = e - j;
      j = e;
    }
  }
  return { hRun, vRun };
}

// Extract axis-aligned wall segments from a wall mask.
// Returns [{dir:'h'|'v', c: cross coordinate (world), a0, a1: along extents (world), thick}]
function extractSegments(wallMask, grid, o) {
  const { W, H, cell, ox, oz } = grid;
  const { hRun, vRun } = runLengths(wallMask, W, H);
  // Short stubs (a jamb beside a door) are kept here as evidence for merging; the
  // final length filter runs after merge and corner snapping.
  const minLen = Math.round(0.3 / cell), maxTh = Math.round(o.wallMaxThick / cell);
  const segs = [];
  for (const dir of ['h', 'v']) {
    const m = new Uint8Array(W * H);
    for (let k = 0; k < W * H; k++) {
      if (!wallMask[k]) continue;
      const along = dir === 'h' ? hRun[k] : vRun[k], across = dir === 'h' ? vRun[k] : hRun[k];
      if (along >= minLen && across <= maxTh) m[k] = 1;
    }
    const { labels, count } = components(m, W, H);
    const acc = Array.from({ length: count }, () => ({ n: 0, sumC: 0, a0: Infinity, a1: -Infinity, th: [] }));
    for (let k = 0; k < W * H; k++) {
      const l = labels[k]; if (l < 0) continue;
      const i = k % W, j = (k - i) / W;
      const along = dir === 'h' ? i : j, cross = dir === 'h' ? j : i;
      const A = acc[l]; A.n++; A.sumC += cross; if (along < A.a0) A.a0 = along; if (along > A.a1) A.a1 = along;
      A.th.push(dir === 'h' ? vRun[k] : hRun[k]);
    }
    for (const A of acc) {
      if (A.a1 - A.a0 + 1 < minLen) continue;
      A.th.sort((x, y) => x - y);
      const th = A.th[Math.floor(A.th.length / 2)] * cell;
      const c = (A.sumC / A.n + 0.5) * cell + (dir === 'h' ? oz : ox);
      const off = dir === 'h' ? ox : oz;
      segs.push({ dir, c, a0: A.a0 * cell + off, a1: (A.a1 + 1) * cell + off, thick: th, cells: A.n });
    }
  }
  return segs;
}

// Merge collinear segments (same dir, cross within tol) whose gap is smaller than mergeGap.
function mergeCollinear(segs, o) {
  const out = [];
  for (const dir of ['h', 'v']) {
    const list = segs.filter(s => s.dir === dir).sort((a, b) => a.c - b.c || a.a0 - b.a0);
    // Group by cross coordinate (walls within 0.10 m are the same line).
    const groups = [];
    for (const s of list) {
      const g = groups.find(g => Math.abs(g.c - s.c) < 0.10 && g.members.some(m => s.a0 < m.a1 + o.mergeGap && s.a1 > m.a0 - o.mergeGap));
      if (g) { g.members.push(s); g.c = g.members.reduce((n, m) => n + m.c * (m.a1 - m.a0), 0) / g.members.reduce((n, m) => n + (m.a1 - m.a0), 0); }
      else groups.push({ c: s.c, members: [s] });
    }
    for (const g of groups) {
      const ms = g.members.sort((a, b) => a.a0 - b.a0);
      let cur = { dir, c: g.c, a0: ms[0].a0, a1: ms[0].a1, thick: ms[0].thick, gaps: [], parts: [ms[0]] };
      for (let i = 1; i < ms.length; i++) {
        const s = ms[i];
        if (s.a0 <= cur.a1 + o.mergeGap) {
          if (s.a0 > cur.a1 + 0.05) cur.gaps.push([cur.a1, s.a0]);
          cur.a1 = Math.max(cur.a1, s.a1); cur.parts.push(s);
        } else { out.push(cur); cur = { dir, c: g.c, a0: s.a0, a1: s.a1, thick: s.thick, gaps: [], parts: [s] }; }
      }
      out.push(cur);
    }
  }
  for (const s of out) {
    // Thickness: length-weighted median-ish of parts.
    const tot = s.parts.reduce((n, p) => n + (p.a1 - p.a0), 0);
    s.thick = s.parts.reduce((n, p) => n + p.thick * (p.a1 - p.a0), 0) / tot;
    delete s.parts;
  }
  return out;
}

// Extend or trim endpoints to meet perpendicular walls (corners and T junctions).
// An end within cornerSnap of a perpendicular wall snaps to it. An end that stops
// short of a perpendicular wall by up to extendGap (a door beside a corner, a cased
// opening at a hallway) extends to it and the extension is recorded as a gap, which
// the opening classifier then inspects.
function snapCorners(segs, o) {
  const tol = o.cornerSnap, ext = o.mergeGap;
  for (let pass = 0; pass < 2; pass++) {
    for (const s of segs) {
      const perp = segs.filter(p => p.dir !== s.dir);
      for (const end of ['a0', 'a1']) {
        const outward = end === 'a0' ? -1 : 1;
        let best = null, bestD = Infinity;
        for (const p of perp) {
          if (s.c < p.a0 - tol || s.c > p.a1 + tol) continue;
          const d = (p.c - s[end]) * outward; // positive = beyond the end
          if (d < -tol || d > ext) continue;
          if (Math.abs(d) < bestD) { bestD = Math.abs(d); best = p; }
        }
        if (!best) continue;
        const old = s[end];
        s[end] = best.c;
        s[end === 'a0' ? 'j0' : 'j1'] = true;
        if ((best.c - old) * outward > 0.15) s.gaps.push(end === 'a0' ? [best.c, old] : [old, best.c]);
        // Make sure the perpendicular wall actually reaches this junction.
        if (s.c < best.a0) best.a0 = s.c; else if (s.c > best.a1) best.a1 = s.c;
      }
      if (s.a1 < s.a0 + 0.2) { const m = (s.a0 + s.a1) / 2; s.a0 = m - 0.1; s.a1 = m + 0.1; }
    }
  }
  return segs;
}

// Exterior walls break at windows (glass returns nothing to lidar). Merge collinear
// exterior segments across gaps up to windowGap when the room's footprint runs along
// the gap on the inside; the opening classifier then reads the sill and header.
function mergeExteriorAcrossWindows(segs, fp, grid, o) {
  const { W, H, cell, ox, oz } = grid;
  const fpAt = (x, z) => { const i = Math.floor((x - ox) / cell), j = Math.floor((z - oz) / cell); return i >= 0 && j >= 0 && i < W && j < H && fp[j * W + i]; };
  const out = [];
  for (const dir of ['h', 'v']) {
    const list = segs.filter(s => s.dir === dir).sort((a, b) => a.c - b.c || a.a0 - b.a0);
    const used = new Set();
    for (let i = 0; i < list.length; i++) {
      if (used.has(i)) continue;
      const cur = list[i]; used.add(i);
      let merged = true;
      while (merged) {
        merged = false;
        for (let j = 0; j < list.length; j++) {
          if (used.has(j)) continue;
          const s = list[j];
          if (!cur.exterior || !s.exterior || Math.abs(s.c - cur.c) > 0.12) continue;
          const g0 = Math.min(cur.a1, s.a1), g1 = Math.max(cur.a0, s.a0);
          if (g1 <= g0) { // overlap
            cur.a0 = Math.min(cur.a0, s.a0); cur.a1 = Math.max(cur.a1, s.a1); used.add(j); merged = true; continue;
          }
          if (g1 - g0 > o.windowGap) continue;
          // Footprint along the gap on the inside.
          let hits = 0, n = 0;
          for (let a = g0 + 0.05; a < g1; a += 0.1) {
            n++;
            const off = cur.inSide * 0.35;
            const x = dir === 'h' ? a : cur.c + off, z = dir === 'h' ? cur.c + off : a;
            if (fpAt(x, z)) hits++;
          }
          if (n && hits / n >= 0.6) {
            cur.gaps.push([g0, g1]);
            cur.a0 = Math.min(cur.a0, s.a0); cur.a1 = Math.max(cur.a1, s.a1);
            cur.gaps.push(...s.gaps);
            used.add(j); merged = true;
          }
        }
      }
      out.push(cur);
    }
  }
  return out;
}

function classifyExterior(segs, fp, grid) {
  const { W, H, cell, ox, oz } = grid;
  for (const s of segs) {
    const q = Math.round((s.thick / 2 + 0.3) / cell);
    const side = sign => {
      let hits = 0, tries = 0;
      for (let f = 0.15; f <= 0.85; f += 0.1) {
        const along = s.a0 + (s.a1 - s.a0) * f;
        const x = s.dir === 'h' ? along : s.c + sign * q * cell, z = s.dir === 'h' ? s.c + sign * q * cell : along;
        const i = Math.floor((x - ox) / cell), j = Math.floor((z - oz) / cell);
        tries++;
        if (i >= 0 && j >= 0 && i < W && j < H && fp[j * W + i]) hits++;
      }
      return hits / tries;
    };
    const a = side(-1), b = side(1);
    s.exterior = Math.min(a, b) < 0.3;
    s.inSide = a >= b ? -1 : 1;
  }
}

// ---------- 6: openings ----------

function profileOpenings(seg, L, grid, o) {
  const { W, H, cell, ox, oz } = grid;
  const len = seg.a1 - seg.a0;
  const n = Math.round(len / cell);
  if (n < 4) return [];
  const half = Math.round((seg.thick / 2 + 0.05) / cell);
  const S = L.nSlices, sl = o.slice, from = o.sliceFrom;
  const hAt = i => from + (i + 0.5) * sl; // height of slice center above floor
  // Slice index ranges.
  const lowEnd = Math.min(S, Math.floor((1.75 - from) / sl));      // slices below 1.75 m
  const lowMask = (1 << lowEnd) - 1;
  const winLo = Math.max(0, Math.floor((0.55 - from) / sl)), winHi = Math.min(S, Math.ceil((2.1 - from) / sl));
  const cls = new Uint8Array(n); // 0 solid, 1 open, 2 window
  const bitsAt = new Uint32Array(n);
  const floorAt = new Uint8Array(n); // floor visible at the wall line (a real doorway has a threshold)
  const bandAt = new Int16Array(n * 2); // per position: [first empty slice, last empty slice] of the window band
  for (let p = 0; p < n; p++) {
    const along = seg.a0 + (p + 0.5) * cell;
    let bits = 0, fl = 0;
    for (let q = -half; q <= half; q++) {
      const x = seg.dir === 'h' ? along : seg.c + q * cell, z = seg.dir === 'h' ? seg.c + q * cell : along;
      const i = Math.floor((x - ox) / cell), j = Math.floor((z - oz) / cell);
      if (i < 0 || j < 0 || i >= W || j >= H) continue;
      bits |= L.cov[j * W + i];
      if (L.floor[j * W + i] > 0) fl = 1;
    }
    bitsAt[p] = bits; floorAt[p] = fl;
    const lowFrac = popcount(bits & lowMask) / Math.max(1, lowEnd);
    if (lowFrac < 0.15) { cls[p] = 1; continue; }
    if (!seg.exterior) continue;
    // Window: the longest empty band between 0.55 and 2.1 m, at least 0.4 m tall, with wall
    // above it and either wall below it or a sill higher than 0.85 m (furniture often hides
    // the wall under a sill, so "wall below" cannot be required).
    let b0 = -1, b1 = -1, cur0 = -1;
    for (let i = winLo; i <= winHi; i++) {
      const empty = i < winHi && i < S && !(bits & (1 << i));
      if (empty) { if (cur0 < 0) cur0 = i; }
      else if (cur0 >= 0) { if (i - cur0 > b1 - b0) { b0 = cur0; b1 = i; } cur0 = -1; }
    }
    if (b0 < 0 || (b1 - b0) * sl < 0.4) continue;
    let above = 0; for (let i = b1; i < S; i++) if (bits & (1 << i)) above++;
    let below = 0; for (let i = 0; i < b0; i++) if (bits & (1 << i)) below++;
    const sillH = from + b0 * sl;
    if (above >= 2 && (below >= 2 || sillH >= 0.85)) { cls[p] = 2; bandAt[2 * p] = b0; bandAt[2 * p + 1] = b1; }
  }
  // Runs, skipping the first/last 3 cells of the wall.
  const out = [];
  let p = 0;
  while (p < n) {
    const c = cls[p]; if (!c) { p++; continue; }
    let e = p; while (e < n && cls[e] === c) e++;
    const w = (e - p) * cell;
    const s0 = seg.a0 + p * cell, s1 = seg.a0 + e * cell;
    const inside = (p > 2 || seg.j0) && (e < n - 2 || seg.j1);
    if (c === 1 && inside) {
      // Header: lowest slice above 1.75 m present across most of the run.
      let header = null;
      for (let i = lowEnd; i < S; i++) {
        let present = 0; for (let q = p; q < e; q++) if (bitsAt[q] & (1 << i)) present++;
        if (present > (e - p) * 0.35) { header = hAt(i) - sl / 2; break; }
      }
      // Floor visible across the gap means a threshold: a door. Furniture against a
      // wall hides the floor; on an exterior wall an empty band that only shows wall
      // again from 1.45 m up is a window over furniture (a wardrobe shows wall lower).
      let fl = 0; for (let q = p; q < e; q++) fl += floorAt[q];
      if (fl >= (e - p) * 0.3 && w >= o.doorMin && w <= o.doorMax) {
        out.push({ type: 'door', s0, s1, width: w, height: header ? Math.max(1.8, Math.min(2.4, header)) : 2.032 });
      } else if (seg.exterior && header && header >= 1.45 && w >= o.windowMin && w <= 3.5) {
        const sill = 0.76;
        out.push({ type: 'window', s0, s1, width: w, sill, height: Math.max(0.4, header - sill) });
      }
    } else if (c === 2 && inside && w >= o.windowMin) {
      // Sill and head from the median empty band across the run.
      const b0s = [], b1s = [];
      for (let q = p; q < e; q++) { b0s.push(bandAt[2 * q]); b1s.push(bandAt[2 * q + 1]); }
      b0s.sort((a, b) => a - b); b1s.sort((a, b) => a - b);
      const sill = from + b0s[b0s.length >> 1] * sl, head = from + b1s[b1s.length >> 1] * sl;
      out.push({ type: 'window', s0, s1, width: w, sill: Math.max(0.2, Math.min(1.5, sill)), height: Math.max(0.4, head - sill) });
    }
    p = e;
  }
  return out;
}

// ---------- 7: rooms ----------

function tracePolygon(mask, W, H) {
  // Find top-left filled cell.
  let start = -1;
  for (let k = 0; k < W * H; k++) if (mask[k]) { start = k; break; }
  if (start < 0) return null;
  return traceBoundaryRobust(mask, W, H, start);
}

// A cleaner crack-follower: state is (corner, direction). At each corner the
// filled cell must be on the right of the direction of travel.
function traceBoundaryRobust(mask, W, H, start) {
  const f = (i, j) => (i >= 0 && j >= 0 && i < W && j < H && mask[j * W + i]) ? 1 : 0;
  const si = start % W, sj = (start - si) / W;
  let x = si, y = sj, dir = 0; // begin moving east along the top edge of the start cell
  const pts = [];
  let guard = 0;
  do {
    pts.push([x, y]);
    // Look at the two cells ahead-left and ahead-right relative to direction.
    // dir 0 (east): ahead corner (x+1,y); cells: left = (x, y-1), right = (x, y)
    // dir 1 (south): left = (x, y), right = (x-1, y)
    // dir 2 (west): left = (x-1, y), right = (x-1, y-1)
    // dir 3 (north): left = (x-1, y-1), right = (x, y-1)
    // Advance one step; then decide the turn at the new corner.
    if (dir === 0) x++; else if (dir === 1) y++; else if (dir === 2) x--; else y--;
    // At the new corner, examine the cells ahead: we want filled on the right, empty on the left.
    let aheadL, aheadR;
    if (dir === 0) { aheadL = f(x, y - 1); aheadR = f(x, y); }
    else if (dir === 1) { aheadL = f(x, y); aheadR = f(x - 1, y); }
    else if (dir === 2) { aheadL = f(x - 1, y); aheadR = f(x - 1, y - 1); }
    else { aheadL = f(x - 1, y - 1); aheadR = f(x, y - 1); }
    if (aheadR && !aheadL) { /* straight */ }
    else if (aheadR && aheadL) dir = (dir + 3) % 4;      // turn left
    else dir = (dir + 1) % 4;                            // turn right (aheadR empty)
    if (++guard > 4 * W * H + 10) break;
  } while (!(x === si && y === sj && dir === 0));
  return pts;
}

function simplifyRectilinear(pts, cell, ox, oz, minEdge) {
  // Convert corner indices to world, drop collinear points.
  let P = pts.map(([i, j]) => [ox + i * cell, oz + j * cell]);
  const dropCollinear = arr => {
    const out = [];
    for (let k = 0; k < arr.length; k++) {
      const a = arr[(k - 1 + arr.length) % arr.length], b = arr[k], c = arr[(k + 1) % arr.length];
      const sameX = Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(b[0] - c[0]) < 1e-9;
      const sameY = Math.abs(a[1] - b[1]) < 1e-9 && Math.abs(b[1] - c[1]) < 1e-9;
      if (!sameX && !sameY) out.push(b);
    }
    return out;
  };
  P = dropCollinear(P);
  // Remove short edges: a short edge between two parallel edges gets absorbed.
  let changed = true, guard = 0;
  while (changed && P.length > 4 && guard++ < 2000) {
    changed = false;
    let bestK = -1, bestLen = minEdge;
    for (let k = 0; k < P.length; k++) {
      const a = P[k], b = P[(k + 1) % P.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < bestLen) { bestLen = len; bestK = k; }
    }
    if (bestK < 0) break;
    const n = P.length;
    const a = P[bestK], b = P[(bestK + 1) % n];
    const prev = P[(bestK - 1 + n) % n], next = P[(bestK + 2) % n];
    const vertical = Math.abs(b[0] - a[0]) < Math.abs(b[1] - a[1]);
    // Neighbours are perpendicular to the short edge, so both are horizontal (if short is vertical) or vertical.
    if (vertical) { const y = (a[1] + b[1]) / 2; prev[1] = y; next[1] = y; }
    else { const x = (a[0] + b[0]) / 2; prev[0] = x; next[0] = x; }
    if (bestK === n - 1) { P.splice(n - 1, 1); P.splice(0, 1); } else P.splice(bestK, 2);
    P = dropCollinear(P);
    changed = true;
  }
  return P;
}

function snapPolygonToWalls(P, segs, tol) {
  const hs = segs.filter(s => s.dir === 'h'), vs = segs.filter(s => s.dir === 'v');
  const out = P.map(([x, y]) => {
    let bx = x, by = y, dx = tol, dy = tol;
    for (const v of vs) { if (y < v.a0 - tol || y > v.a1 + tol) continue; const d = Math.abs(v.c - x); if (d < dx) { dx = d; bx = v.c; } }
    for (const h of hs) { if (x < h.a0 - tol || x > h.a1 + tol) continue; const d = Math.abs(h.c - y); if (d < dy) { dy = d; by = h.c; } }
    return [bx, by];
  });
  // Re-rectilinearize: consecutive points must share x or y; fix by averaging.
  for (let k = 0; k < out.length; k++) {
    const a = out[k], b = out[(k + 1) % out.length];
    const dx = Math.abs(a[0] - b[0]), dy = Math.abs(a[1] - b[1]);
    if (dx > 1e-6 && dy > 1e-6) { if (dx < dy) { const x = (a[0] + b[0]) / 2; a[0] = x; b[0] = x; } else { const y = (a[1] + b[1]) / 2; a[1] = y; b[1] = y; } }
  }
  // Drop duplicates and collinear.
  const res = [];
  for (let k = 0; k < out.length; k++) {
    const p = out[k], q = out[(k + 1) % out.length];
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.02) res.push(p);
  }
  const fin = [];
  for (let k = 0; k < res.length; k++) {
    const a = res[(k - 1 + res.length) % res.length], b = res[k], c = res[(k + 1) % res.length];
    const sameX = Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(b[0] - c[0]) < 1e-6;
    const sameY = Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(b[1] - c[1]) < 1e-6;
    if (!sameX && !sameY) fin.push([round(b[0]), round(b[1])]);
  }
  return fin;
}

const round = v => Math.round(v * 200) / 200;

function polygonArea(P) {
  let a = 0;
  for (let i = 0; i < P.length; i++) { const [x1, y1] = P[i], [x2, y2] = P[(i + 1) % P.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
}

// ---------- per-level analysis ----------

function analyzeLevel(L, grid, o, debug) {
  const { W, H, cell } = grid;
  const N = W * H;
  const cellsPerM2 = 1 / (cell * cell);
  // Footprint.
  const fp0 = new Uint8Array(N);
  for (let k = 0; k < N; k++) if (L.floor[k] > 0.00003 || L.ceil[k] > 0.00003) fp0[k] = 1;
  let fp = close(fp0, W, H, 3);
  fp = fillHoles(fp, W, H, Math.round(1.0 * cellsPerM2));
  fp = keepLargeComponents(fp, W, H, Math.round(2.0 * cellsPerM2));
  const fpDil = dilate(fp, W, H, Math.round(0.35 / cell));
  // Wall mask.
  // A wall meets the ceiling; a wardrobe or a kitchen unit usually stops short of it. Under
  // a flat ceiling a wall cell must also show geometry in the top two slices (a door's or
  // window's header counts, which keeps walls continuous across openings).
  const topMask = L.flatCeiling ? ((1 << (L.nSlices - 1)) | (1 << (L.nSlices - 2))) : 0;
  const wallRaw = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    if (!fpDil[k] || popcount(L.covD[k]) / L.nSlices < o.wallCoverage) continue;
    if (topMask && !(L.covD[k] & topMask)) continue;
    wallRaw[k] = 1;
  }
  let wall = close(wallRaw, W, H, 1);
  wall = keepLargeComponents(wall, W, H, Math.round(0.02 * cellsPerM2));
  // Segments. Measured band thickness includes the dilation on both sides; take it back off.
  let segs = extractSegments(wall, grid, o);
  for (const s of segs) s.thick = Math.max(0.06, s.thick - 2 * o.covDilate * cell);
  segs = mergeCollinear(segs, o);
  classifyExterior(segs, fp, grid);
  segs = mergeExteriorAcrossWindows(segs, fp, grid, o);
  segs = snapCorners(segs, o);
  segs = segs.filter(s => s.a1 - s.a0 >= o.wallMinLen);
  classifyExterior(segs, fp, grid);
  // Openings.
  for (const s of segs) s.openings = profileOpenings(s, L, grid, o);
  // Rooms: footprint minus drawn walls (with gaps closed).
  const wallDraw = new Uint8Array(N);
  for (const s of segs) {
    const half = Math.max(s.thick / 2, 0.05) + 0.03;
    const i0 = Math.floor(((s.dir === 'h' ? s.a0 : s.c - half) - grid.ox) / cell), i1 = Math.ceil(((s.dir === 'h' ? s.a1 : s.c + half) - grid.ox) / cell);
    const j0 = Math.floor(((s.dir === 'h' ? s.c - half : s.a0) - grid.oz) / cell), j1 = Math.ceil(((s.dir === 'h' ? s.c + half : s.a1) - grid.oz) / cell);
    for (let j = Math.max(0, j0); j < Math.min(H, j1); j++) for (let i = Math.max(0, i0); i < Math.min(W, i1); i++) wallDraw[j * W + i] = 1;
  }
  // Let walls, not the ragged footprint edge, bound rooms wherever a wall exists.
  const fpGrown = dilate(fp, W, H, Math.round(0.12 / cell));
  const roomMask = new Uint8Array(N);
  for (let k = 0; k < N; k++) roomMask[k] = fpGrown[k] && !wallDraw[k] ? 1 : 0;
  const rm = open(roomMask, W, H, 2);
  const { labels, sizes, count } = components(rm, W, H);
  const rooms = [];
  for (let l = 0; l < count; l++) {
    if (sizes[l] < o.roomMinArea * cellsPerM2) continue;
    const m = new Uint8Array(N);
    for (let k = 0; k < N; k++) if (labels[k] === l) m[k] = 1;
    const filled = fillHoles(m, W, H, Math.round(0.6 * cellsPerM2));
    const pts = tracePolygon(filled, W, H);
    if (!pts || pts.length < 4) continue;
    let P = simplifyRectilinear(pts, cell, grid.ox, grid.oz, o.roomMinEdge);
    P = snapPolygonToWalls(P, segs, 0.3);
    P = simplifyRectilinear(P.map(([x, y]) => [(x - grid.ox) / cell, (y - grid.oz) / cell]), cell, grid.ox, grid.oz, o.roomMinEdge);
    if (P.length >= 4 && polygonArea(P) >= o.roomMinArea) rooms.push({ pts: P, area: polygonArea(P), cells: sizes[l] });
  }
  rooms.sort((a, b) => b.area - a.area);
  const result = { segs, rooms, floorArea: fp.reduce((n, v) => n + v, 0) / cellsPerM2 };
  if (debug) result.debug = { fp, wall, wallDraw, roomMask: rm, labels };
  return result;
}

// ---------- level naming ----------

function nameLevels(levels) {
  const n = levels.length;
  const names = [];
  let ordinal = 1;
  for (let i = 0; i < n; i++) {
    const L = levels[i];
    const h = L.ceilY - L.floorY;
    const isBasement = i === 0 && n > 1 && h < 2.25;
    const isAttic = i === n - 1 && n > 1 && !L.flatCeiling;
    if (isBasement) names.push('Basement');
    else if (isAttic) names.push('Attic');
    else { names.push(n === 1 ? 'Main level' : 'Level ' + ordinal); ordinal++; }
  }
  return names;
}

// ---------- public entry ----------

// pos: Float32Array xyz (meters, Y up); idx: Uint32Array/Uint16Array triangle indices.
// Returns { rotationDeg, manhattanShare, origin, levels:[{name, elevation, height, walls, openings, rooms}], grid }
export function scanToPlan(posIn, idx, options, progress) {
  const o = Object.assign({}, DEFAULTS, options || {});
  const debug = !!o.debug;
  const say = (stage, frac) => { if (progress) progress(stage, frac); };

  say('normals', 0.02);
  const tri0 = triangleData(posIn, idx);
  say('orientation', 0.06);
  const { deg, manhattanShare } = dominantAngle(tri0);
  const pos = rotateXZ(posIn, deg);
  const tri = triangleData(pos, idx); // angles change, normals' y and areas do not; recompute cheaply

  say('levels', 0.1);
  const { levels, minY, maxY } = findLevels(pos, idx, tri, o);
  if (!levels.length) throw new Error('No floor level found in the scan (no large horizontal surface).');

  say('rasterize', 0.15);
  const grid = rasterize(pos, idx, tri, levels, o);

  const names = nameLevels(levels);
  const outLevels = [];
  const base = levels[0].floorY;
  levels.forEach((L, li) => {
    say('level ' + names[li], 0.3 + 0.6 * (li / levels.length));
    const r = analyzeLevel(L, grid, o, debug);
    const prefix = 'L' + li + '-';
    const walls = [], openings = [], rooms = [];
    r.segs.forEach((s, si) => {
      const id = prefix + 'w' + (si + 1);
      const ax = s.dir === 'h' ? s.a0 : s.c, ay = s.dir === 'h' ? s.c : s.a0;
      const bx = s.dir === 'h' ? s.a1 : s.c, by = s.dir === 'h' ? s.c : s.a1;
      const thick = Math.max(0.09, Math.min(0.35, s.exterior ? Math.max(s.thick, 0.15) : s.thick));
      walls.push({ id, ax: round(ax), ay: round(ay), bx: round(bx), by: round(by), thickness: Math.round(thick * 1000) / 1000, height: null, material: s.exterior ? 'mat-fiber' : 'mat-drywall', exterior: s.exterior });
      const L2 = s.a1 - s.a0;
      s.openings.forEach((op, oi) => {
        const t = ((op.s0 + op.s1) / 2 - s.a0) / L2;
        const rec = { id: prefix + 'o' + (si + 1) + '-' + (oi + 1), wallId: id, type: op.type, t: Math.round(t * 1000) / 1000, width: round(op.width), height: round(op.height) };
        if (op.type === 'window') rec.sill = round(op.sill);
        openings.push(rec);
      });
    });
    r.rooms.forEach((rm, ri) => rooms.push({ id: prefix + 'r' + (ri + 1), name: 'Room ' + (ri + 1), pts: rm.pts, material: 'mat-oak', area: rm.area }));
    outLevels.push({
      id: 'lvl-' + li, name: names[li], elevation: round(L.floorY - base), height: round(L.ceilY - L.floorY),
      flatCeiling: L.flatCeiling, floorArea: r.floorArea, walls, openings, rooms,
      debug: r.debug ? Object.assign({ floor: L.floor, ceil: L.ceil, cov: L.cov, nSlices: L.nSlices }, r.debug) : undefined,
    });
  });
  say('done', 1);
  return {
    rotationDeg: deg, manhattanShare, baseY: base, minY, maxY,
    grid: { W: grid.W, H: grid.H, ox: grid.ox, oz: grid.oz, cell: grid.cell },
    levels: outLevels,
  };
}

// Convenience: pull a single position/index pair out of a glTF JSON + binary buffer
// (the shape Polycam serves: one mesh, one primitive, one external buffer).
export function gltfToMesh(gltf, buffers) {
  const positions = [], indices = [];
  let vOffset = 0;
  const accessorArray = (ai) => {
    const a = gltf.accessors[ai], bv = gltf.bufferViews[a.bufferView];
    const buf = buffers[bv.buffer];
    const off = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    const n = a.count * comps;
    if (bv.byteStride && bv.byteStride !== comps * (a.componentType === 5126 ? 4 : a.componentType === 5125 ? 4 : a.componentType === 5123 ? 2 : 1)) {
      throw new Error('interleaved glTF buffers are not supported');
    }
    if (a.componentType === 5126) return new Float32Array(buf, off, n);
    if (a.componentType === 5125) return new Uint32Array(buf, off, n);
    if (a.componentType === 5123) return new Uint16Array(buf, off, n);
    if (a.componentType === 5121) return new Uint8Array(buf, off, n);
    throw new Error('unsupported accessor component type ' + a.componentType);
  };
  // Walk nodes with transforms (Polycam uses identity, but be correct).
  const mats = new Map();
  const mul = (A, B) => { const M = new Array(16).fill(0); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) M[c * 4 + r] += A[k * 4 + r] * B[c * 4 + k]; return M; };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const nodeMatrix = node => {
    if (node.matrix) return node.matrix;
    const t = node.translation || [0, 0, 0], q = node.rotation || [0, 0, 0, 1], s = node.scale || [1, 1, 1];
    const [x, y, z, w] = q;
    const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
    return [
      (1 - 2 * (yy + zz)) * s[0], (2 * (xy + wz)) * s[0], (2 * (xz - wy)) * s[0], 0,
      (2 * (xy - wz)) * s[1], (1 - 2 * (xx + zz)) * s[1], (2 * (yz + wx)) * s[1], 0,
      (2 * (xz + wy)) * s[2], (2 * (yz - wx)) * s[2], (1 - 2 * (xx + yy)) * s[2], 0,
      t[0], t[1], t[2], 1,
    ];
  };
  const visit = (ni, parent) => {
    const node = gltf.nodes[ni];
    const M = mul(parent, nodeMatrix(node));
    mats.set(ni, M);
    if (node.mesh != null) {
      for (const prim of gltf.meshes[node.mesh].primitives) {
        if ((prim.mode != null && prim.mode !== 4) || prim.attributes.POSITION == null) continue;
        const P = accessorArray(prim.attributes.POSITION);
        const nV = P.length / 3;
        const out = new Float32Array(P.length);
        for (let i = 0; i < nV; i++) {
          const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
          out[3 * i] = M[0] * x + M[4] * y + M[8] * z + M[12];
          out[3 * i + 1] = M[1] * x + M[5] * y + M[9] * z + M[13];
          out[3 * i + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
        }
        positions.push(out);
        let ind;
        if (prim.indices != null) ind = accessorArray(prim.indices);
        else { ind = new Uint32Array(nV); for (let i = 0; i < nV; i++) ind[i] = i; }
        const shifted = new Uint32Array(ind.length);
        for (let i = 0; i < ind.length; i++) shifted[i] = ind[i] + vOffset;
        indices.push(shifted);
        vOffset += nV;
      }
    }
    for (const c of node.children || []) visit(c, M);
  };
  const scene = gltf.scenes[gltf.scene || 0];
  for (const n of scene.nodes) visit(n, I);
  return concatMesh(positions, indices);
}

export function concatMesh(positions, indices) {
  const nP = positions.reduce((n, p) => n + p.length, 0), nI = indices.reduce((n, p) => n + p.length, 0);
  const pos = new Float32Array(nP), idx = new Uint32Array(nI);
  let po = 0, io = 0;
  for (const p of positions) { pos.set(p, po); po += p.length; }
  for (const i of indices) { idx.set(i, io); io += i.length; }
  return { pos, idx };
}

// Exposed for tests and the Node harness.
export const _internals = { triangleData, dominantAngle, rotateXZ, findLevels, rasterize, analyzeLevel, popcount };
