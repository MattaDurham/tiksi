import { floorDetectionReport } from './scan-surfaces.js';

// Adding a scan to a property that already has a plan. A second capture lives in its own
// frame, so before it can join the plan it has to be placed: turned to the same axes, slid
// onto the building and lifted to the right floor. This module scores where a new scan's
// proposal fits against the existing plan and says what it most likely is:
//
//   replace  a rescan of a floor that is already here (walls line up inside and out)
//   level    the next floor up (same outline, different rooms inside)
//   beside   another structure on the property (a garage, a studio): placed next to it
//
// The suggestion is only that: the person adding the scan confirms or picks another, and
// can keep the scan as reference geometry without touching the plan. Pure data, no three.js:
// the result shape is scan2plan-core's (levels of walls, openings and rooms in plan metres).

const NEAR = 0.35;          // a sampled point this close to an existing wall counts as on it
const STEP = 0.25;          // sample spacing along a wall
const STOREY_GAP = 0.25;    // floor structure between a stacked level and the one below
const BESIDE_GAP = 3;       // clear distance to a separate structure
const SAME_FLOOR = 0.3;     // levels this close in elevation are the same floor

// Rotation about the vertical axis, three.js convention (object.rotation.y), on plan (x, y) = world (x, z).
export function rotatePlan(x, y, deg) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [c * x + s * y, -s * x + c * y];
}

function bounds(walls) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const w of walls) for (const [x, y] of [[w.ax, w.ay], [w.bx, w.by]]) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return isFinite(x0) ? { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 } : null;
}

function segDist(px, py, w) {
  const dx = w.bx - w.ax, dy = w.by - w.ay, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((px - w.ax) * dx + (py - w.ay) * dy) / L2)) : 0;
  return Math.hypot(px - (w.ax + t * dx), py - (w.ay + t * dy));
}

// Share of the length of `walls` that runs along some wall of `target`.
function overlap(walls, target) {
  let on = 0, all = 0;
  for (const w of walls) {
    const L = Math.hypot(w.bx - w.ax, w.by - w.ay);
    const n = Math.max(1, Math.round(L / STEP));
    for (let i = 0; i <= n; i++) {
      const t = i / n, x = w.ax + (w.bx - w.ax) * t, y = w.ay + (w.by - w.ay) * t;
      all++;
      if (target.some(o => segDist(x, y, o) < NEAR)) on++;
    }
  }
  return all ? on / all : 0;
}

function moveWalls(walls, rot, dx, dy) {
  return walls.map(w => {
    const [ax, ay] = rotatePlan(w.ax, w.ay, rot), [bx, by] = rotatePlan(w.bx, w.by, rot);
    return Object.assign({}, w, { ax: ax + dx, ay: ay + dy, bx: bx + dx, by: by + dy });
  });
}

const r3 = v => Math.round(v * 1000) / 1000;

// existing: { levels: [{ id, name, elevation, height, walls: [...], rooms: [...] }] } from the property.
// result: the scan2plan proposal (levels in its own squared-up frame, lowest floor at 0).
export function fitScan(existing, result) {
  const levels = (existing.levels || []).filter(l => l.walls && l.walls.length);
  const main = result.levels[result.mainLevelIndex] || result.levels[0];
  if (!levels.length || !main || !main.walls.length) return null;
  const top = (existing.levels || []).reduce((m, l) => Math.max(m, l.elevation + (l.height || 2.44)), 0);
  // The outline says whether it is this building; the interior walls say whether it is this
  // floor. Every floor with walls is tried at every right angle; the best match is the reference.
  const ext = main.walls.filter(w => w.exterior);
  const hasInner = main.walls.length > ext.length;
  let best = null;
  for (const level of levels) {
    const B0 = bounds(level.walls);
    for (const rot of [0, 90, 180, 270]) {
      const B = bounds(moveWalls(main.walls, rot, 0, 0));
      const dx = B0.cx - B.cx, dy = B0.cy - B.cy;
      const placed = moveWalls(main.walls, rot, dx, dy);
      const outline = overlap(ext.length ? placed.filter(w => w.exterior) : placed, level.walls);
      const inner = overlap(hasInner ? placed.filter(w => !w.exterior) : placed, level.walls);
      const size = Math.min(B.w * B.h, B0.w * B0.h) / Math.max(B.w * B.h, B0.w * B0.h, 1e-6);
      const score = outline + 0.5 * inner + 0.25 * size;
      if (!best || score > best.score) best = { level, B0, rot, dx, dy, outline, inner, size, score };
    }
  }
  const ref = best.level, B0 = best.B0;
  const baseElev = main.elevation || 0;
  const lowest = result.levels.reduce((m, l) => Math.min(m, l.elevation), Infinity);
  const placements = {
    replace: { rot: best.rot, dx: r3(best.dx), dz: r3(best.dy), dElev: r3(ref.elevation - baseElev) },
    level: { rot: best.rot, dx: r3(best.dx), dz: r3(best.dy), dElev: r3(top + STOREY_GAP - lowest) },
    beside: (() => {
      const B = bounds(main.walls);
      return { rot: 0, dx: r3(B0.x1 + BESIDE_GAP - B.x0), dz: r3(B0.y0 - B.y0), dElev: r3(ref.elevation - baseElev) };
    })(),
  };
  const pct = v => Math.round(v * 100) + '%';
  let suggestion, reason;
  if (best.size > 0.8 && best.outline > 0.6 && best.inner > 0.6) {
    suggestion = 'replace';
    reason = 'Its outline and ' + pct(best.inner) + ' of its inside walls land on ' + ref.name + ': it reads as a rescan of that floor.';
  } else if (best.size > 0.55 && best.outline > 0.5) {
    suggestion = 'level';
    reason = 'Its outline matches ' + ref.name + ' (' + pct(best.outline) + ') but the rooms inside differ: it reads as another floor.';
  } else {
    suggestion = 'beside';
    reason = 'Its outline does not match ' + ref.name + ' (' + pct(best.outline) + ' overlap, ' + pct(best.size) + ' of the size): it reads as a separate structure.';
  }
  return { suggestion, reason, ref: { id: ref.id, name: ref.name }, scores: { outline: best.outline, inner: best.inner, size: best.size }, placements };
}

// The proposal moved by a placement: every level's walls, rooms and elevation, the scan
// transform (so mesh, underlays and walls stay on top of each other) and the underlay grid.
export function placeResult(result, place) {
  if (!place) return result;
  const { rot = 0, dx = 0, dz = 0, dElev = 0 } = place;
  const mv = ([x, y]) => { const [u, v] = rotatePlan(x, y, rot); return [r3(u + dx), r3(v + dz)]; };
  const levels = result.levels.map(L => Object.assign({}, L, {
    elevation: L.elevation + dElev,
    underlayMin: L.underlayMin == null ? undefined : L.underlayMin + dElev,
    walls: L.walls.map(w => { const [ax, ay] = mv([w.ax, w.ay]), [bx, by] = mv([w.bx, w.by]); return Object.assign({}, w, { ax, ay, bx, by }); }),
    rooms: L.rooms.map(r => Object.assign({}, r, { pts: r.pts.map(mv) })),
    openings: L.openings.map(o => Object.assign({}, o)),
  }));
  const t = result.transform;
  const transform = { pos: [t.pos[0] + dx, t.pos[1] + dElev, t.pos[2] + dz], rot: [0, t.rot[1] + rot, 0] };
  let grid = result.grid;
  if (grid) {
    const { W, H, ox, oz, cell } = grid;
    const pts = [[ox, oz], [ox + W * cell, oz], [ox, oz + H * cell], [ox + W * cell, oz + H * cell]].map(mv);
    const x0 = Math.min(...pts.map(p => p[0])), x1 = Math.max(...pts.map(p => p[0]));
    const z0 = Math.min(...pts.map(p => p[1])), z1 = Math.max(...pts.map(p => p[1]));
    grid = Object.assign({}, grid, { ox: x0, oz: z0, W: Math.ceil((x1 - x0) / cell), H: Math.ceil((z1 - z0) / cell) });
  }
  const surfaces = result.surfaces?.map(s => {
    const b = s.bounds, corners = [[b.x0, b.z0], [b.x1, b.z0], [b.x0, b.z1], [b.x1, b.z1]].map(mv);
    return { ...s, elevation: s.elevation + dElev, minElevation: s.minElevation + dElev, maxElevation: s.maxElevation + dElev,
      bounds: { x0: Math.min(...corners.map(p => p[0])), x1: Math.max(...corners.map(p => p[0])),
        z0: Math.min(...corners.map(p => p[1])), z1: Math.max(...corners.map(p => p[1])) } };
  });
  return Object.assign({}, result, { levels, surfaces, transform, grid, wallHeight: result.wallHeight });
}

// Write a placed proposal into the property. `replace` rebuilds the floors it lands on
// (their walls, rooms, openings and underlays) and keeps the others; when it rebuilds every
// floor, the mesh scans it supersedes leave the property. `level` stacks the new levels on
// top. `beside` adds walls and rooms to the level at the same height, or a new level.
// Returns what was added, in applyProposal's shape, plus the ids of superseded scans.
export function mergeProposal(prop, scan, result, underlays, mode, uid) {
  const levels = [], walls = [], openings = [], rooms = [];
  const kept = prop.levels.slice();
  const before = new Set(kept.filter(l => prop.walls.some(w => w.level === l.id)).map(l => l.id));
  const cleared = new Set();
  const names = new Set(kept.map(l => l.name));
  let mainLevel = null;
  const placedLevels = result.levels.map(L => {
    const match = mode === 'level' ? null : kept.find(l => Math.abs(l.elevation - L.elevation) < SAME_FLOOR);
    if (match && mode === 'replace' && !cleared.has(match.id)) {
      cleared.add(match.id);
      const gone = new Set(prop.walls.filter(w => w.level === match.id).map(w => w.id));
      prop.walls = prop.walls.filter(w => !gone.has(w.id));
      prop.openings = prop.openings.filter(o => !gone.has(o.wallId));
      prop.rooms = prop.rooms.filter(r => r.level !== match.id);
      match.plan = null;
      match.height = L.height;
    }
    return match;
  });
  let roomNo = prop.rooms.length;
  result.levels.forEach((L, li) => {
    let lvl = placedLevels[li];
    if (!lvl) {
      let name = L.name;
      if (names.has(name)) name = mode === 'level' ? 'Floor ' + (kept.length + levels.length + 1) : name + ' (' + (scan && scan.name || 'scan') + ')';
      names.add(name);
      lvl = { id: uid('lvl'), name, elevation: L.elevation, height: L.height, plan: null };
      levels.push(lvl);
    }
    const u = underlays && underlays[li];
    if (u && !(lvl.plan && lvl.plan.img)) lvl.plan = Object.assign({ opacity: 0.6, calibrated: true, source: 'scan' }, u);
    if (li === result.mainLevelIndex) mainLevel = lvl;
    const ids = {};
    for (const w of L.walls) {
      const id = uid('w'); ids[w.id] = id;
      walls.push({ id, level: lvl.id, ax: w.ax, ay: w.ay, bx: w.bx, by: w.by, thickness: w.thickness, height: null, material: w.exterior ? 'mat-fiber' : 'mat-drywall' });
    }
    for (const o of L.openings) {
      if (!ids[o.wallId]) continue;
      const rec = { id: uid('o'), wallId: ids[o.wallId], type: o.type, t: o.t, width: o.width, height: o.height };
      if (o.type === 'window') rec.sill = o.sill;
      openings.push(rec);
    }
    for (const r of L.rooms) rooms.push({ id: uid('r'), level: lvl.id, name: 'Room ' + (++roomNo), material: null, ceilingMaterial: null, pts: r.pts });
  });
  let superseded = [];
  if (mode === 'replace' && [...before].every(id => cleared.has(id))) {
    superseded = (prop.scans || []).filter(s => s !== scan && s.kind === 'mesh').map(s => s.id);
    prop.scans = (prop.scans || []).filter(s => !superseded.includes(s.id));
    prop.wallHeight = result.wallHeight;
  }
  prop.levels = kept.concat(levels).sort((a, b) => a.elevation - b.elevation);
  prop.walls = prop.walls.concat(walls);
  prop.openings = prop.openings.concat(openings);
  prop.rooms = prop.rooms.concat(rooms);
  prop.activeLevelId = (mainLevel || prop.levels[0]).id;
  if (scan) {
    scan.pos = result.transform.pos.slice();
    scan.rot = result.transform.rot.slice();
    scan.rotY = scan.rot[1];
    scan.scale = 1;
    scan.flip = false;
    scan.planned = new Date().toISOString();
    scan.floorDetection = floorDetectionReport(result);
  }
  const touched = new Set(walls.map(w => w.level).concat(rooms.map(r => r.level)));
  return { levels: prop.levels.filter(l => touched.has(l.id)), walls, openings, rooms, superseded, mode };
}

// The property's plan per level, in fitScan's input shape.
export function existingPlan(prop, levelOf) {
  return {
    levels: (prop.levels || []).map(l => ({
      id: l.id, name: l.name, elevation: l.elevation, height: l.height,
      walls: prop.walls.filter(w => levelOf(w) === l.id),
      rooms: prop.rooms.filter(r => levelOf(r) === l.id),
    })),
  };
}
