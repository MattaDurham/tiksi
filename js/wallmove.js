// Sticky wall edits: moving a wall or a corner carries everything attached to it.
//
// A wall drag slides the straight run it belongs to (collinear walls joined end to end)
// along its normal. Walls joined at its ends or abutting it mid-span stretch to stay
// attached, room corners on its line move with it, and doors and windows on a stretched
// neighbour keep their distance from that neighbour's fixed end. A corner drag moves every
// wall end and room corner at that joint. Pure data: callers pass the walls, rooms and
// openings of one level and apply the returned plan as the pointer moves.

export const JOIN_TOL = 0.012;     // ends closer than this share a joint (geometry.js agrees)
const COLLINEAR = 0.02;            // sin of the angle below which two walls run in one line
const ROOM_TOL = 0.025;            // a room corner this close to a joint belongs to it

function frame(w) {
  const L = Math.hypot(w.bx - w.ax, w.by - w.ay);
  const d = L || 1;
  const ux = (w.bx - w.ax) / d, uy = (w.by - w.ay) / d;
  return { L, ux, uy, nx: -uy, ny: ux, h: (w.thickness || 0.114) / 2 };
}
const near = (x0, y0, x1, y1, tol) => Math.hypot(x1 - x0, y1 - y0) < tol;

// Walls that continue `wall` in a straight line through shared ends, including itself.
function straightRun(wall, walls) {
  const f = frame(wall);
  const run = [wall];
  const seen = new Set([wall.id]);
  for (let k = 0; k < run.length; k++) {
    const w = run[k];
    for (const o of walls) {
      if (seen.has(o.id)) continue;
      const g = frame(o);
      if (g.L < 0.01 || Math.abs(f.ux * g.uy - f.uy * g.ux) > COLLINEAR) continue;
      // On the same line, not merely parallel.
      if (Math.abs((o.ax - wall.ax) * f.nx + (o.ay - wall.ay) * f.ny) > JOIN_TOL) continue;
      const touches = [[o.ax, o.ay], [o.bx, o.by]].some(([x, y]) =>
        near(x, y, w.ax, w.ay, JOIN_TOL) || near(x, y, w.bx, w.by, JOIN_TOL));
      if (touches) { seen.add(o.id); run.push(o); }
    }
  }
  return run;
}

function snapshotEnds(entries) {
  return entries.map(e => ({ ...e, x0: e.w[e.end + 'x'], y0: e.w[e.end + 'y'] }));
}

// Openings on walls whose ends move: remember where each one sits, measured from the end
// that stays, so a stretched wall does not drag its door along proportionally.
function openingAnchors(openings, movedEnds, rigid) {
  const byWall = new Map();
  for (const e of movedEnds) {
    if (rigid.has(e.w.id)) continue;
    const s = byWall.get(e.w.id) || { w: e.w, ends: new Set() };
    s.ends.add(e.end);
    byWall.set(e.w.id, s);
  }
  const out = [];
  for (const o of openings || []) {
    const s = byWall.get(o.wallId);
    if (!s || s.ends.size !== 1) continue;            // both ends moving = translation, t holds
    const L0 = frame(s.w).L;
    if (L0 < 1e-6) continue;
    const fromA = s.ends.has('b');                     // b moves, so measure from a
    out.push({ o, w: s.w, fromA, dist: fromA ? o.t * L0 : (1 - o.t) * L0, t0: o.t });
  }
  return out;
}

function placeOpenings(anchors) {
  for (const a of anchors) {
    const L = frame(a.w).L;
    if (L < 1e-6) { a.o.t = a.t0; continue; }
    const half = Math.min(0.5, (a.o.width || 0) / 2 / L);
    const t = a.fromA ? a.dist / L : 1 - a.dist / L;
    a.o.t = Math.max(half, Math.min(1 - half, t));
  }
}

// Everything that moves when `wall` is dragged. Returns null for a zero-length wall.
// `connected` is false when nothing is attached (the caller may then allow a free move).
export function planWallMove(wall, walls, rooms, openings) {
  const f = frame(wall);
  if (f.L < 1e-6) return null;
  const run = straightRun(wall, walls);
  const runIds = new Set(run.map(w => w.id));
  // Extent of the run along its own axis, from wall.a.
  let t0 = Infinity, t1 = -Infinity, h = 0;
  for (const w of run) {
    for (const [x, y] of [[w.ax, w.ay], [w.bx, w.by]]) {
      const t = (x - wall.ax) * f.ux + (y - wall.ay) * f.uy;
      t0 = Math.min(t0, t); t1 = Math.max(t1, t);
    }
    h = Math.max(h, frame(w).h);
  }
  const onLine = (x, y, tol) => {
    const t = (x - wall.ax) * f.ux + (y - wall.ay) * f.uy;
    const d = Math.abs((x - wall.ax) * f.nx + (y - wall.ay) * f.ny);
    return t > t0 - tol && t < t1 + tol && d < tol;
  };
  const runEnds = [];
  for (const w of run) for (const end of ['a', 'b']) runEnds.push({ w, end });
  // Neighbour ends at a joint with the run, or abutting it within its thickness.
  const ends = [];
  for (const o of walls) {
    if (runIds.has(o.id)) continue;
    for (const end of ['a', 'b']) {
      const x = o[end + 'x'], y = o[end + 'y'];
      if (onLine(x, y, h + JOIN_TOL)) ends.push({ w: o, end });
    }
  }
  const corners = [];
  for (const r of rooms || []) {
    (r.pts || []).forEach((p, i) => { if (onLine(p[0], p[1], h + JOIN_TOL)) corners.push({ r, i, x0: p[0], y0: p[1] }); });
  }
  const runSnap = snapshotEnds(runEnds), endSnap = snapshotEnds(ends);
  return {
    kind: 'wall', nx: f.nx, ny: f.ny,
    run: runSnap, ends: endSnap, corners,
    anchors: openingAnchors(openings, endSnap, runIds),
    connected: ends.length > 0 || corners.length > 0 || run.length > 1,
    runIds: [...runIds],
  };
}

// Slide by `offset` metres along the wall normal (positive = the +n side).
export function applyWallMove(plan, offset) {
  const dx = plan.nx * offset, dy = plan.ny * offset;
  for (const e of plan.run) { e.w[e.end + 'x'] = e.x0 + dx; e.w[e.end + 'y'] = e.y0 + dy; }
  for (const e of plan.ends) { e.w[e.end + 'x'] = e.x0 + dx; e.w[e.end + 'y'] = e.y0 + dy; }
  for (const c of plan.corners) c.r.pts[c.i] = [c.x0 + dx, c.y0 + dy];
  placeOpenings(plan.anchors);
}

// The component of a pointer displacement along the plan's normal.
export function normalOffset(plan, dx, dy) { return dx * plan.nx + dy * plan.ny; }

// Everything at the joint where `wall`'s `end` sits.
export function planCornerMove(wall, end, walls, rooms, openings) {
  const px = wall[end + 'x'], py = wall[end + 'y'];
  const ends = [{ w: wall, end }];
  for (const o of walls) {
    if (o === wall || o.id === wall.id) continue;
    for (const e of ['a', 'b']) if (near(o[e + 'x'], o[e + 'y'], px, py, JOIN_TOL)) ends.push({ w: o, end: e });
  }
  const corners = [];
  for (const r of rooms || []) {
    (r.pts || []).forEach((p, i) => { if (near(p[0], p[1], px, py, ROOM_TOL)) corners.push({ r, i, x0: p[0], y0: p[1] }); });
  }
  const snap = snapshotEnds(ends);
  return { kind: 'corner', x0: px, y0: py, ends: snap, corners, anchors: openingAnchors(openings, snap, new Set()), wallIds: snap.map(e => e.w.id) };
}

// Put the joint at (x, y).
export function applyCornerMove(plan, x, y) {
  const dx = x - plan.x0, dy = y - plan.y0;
  for (const e of plan.ends) { e.w[e.end + 'x'] = e.x0 + dx; e.w[e.end + 'y'] = e.y0 + dy; }
  for (const c of plan.corners) c.r.pts[c.i] = [c.x0 + dx, c.y0 + dy];
  placeOpenings(plan.anchors);
}
