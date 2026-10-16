// Sticky wall edits: moving a wall or a corner carries everything attached to it.
//
// One rule decides what a floor belongs to: a floor (room) corner is attached to a wall when
// it lies on the wall as drawn, i.e. within its half thickness of the centre line (plus
// FLOOR_TOL), between its ends extended by the same amount. Every edit uses that rule.
//
// A wall drag slides the straight run it belongs to (collinear walls joined end to end)
// along its normal. Walls joined at its ends or abutting it mid-span stretch to stay
// attached, floor corners on it move with it, a floor edge lying along it moves as a whole
// (so floor edges never skew), and doors and windows on a stretched neighbour keep their
// distance from that neighbour's fixed end. A corner drag moves every wall end and floor
// corner at that joint; the walls there pivot about their far ends, and walls and floor
// corners attached along them slide to stay on them. Pure data: callers pass the walls,
// rooms and openings of one level and apply the returned plan as the pointer moves.

export const JOIN_TOL = 0.012;     // ends closer than this share a joint (geometry.js agrees)
export const FLOOR_TOL = 0.02;     // a floor corner this far outside a wall's face is still on it
const COLLINEAR = 0.02;            // sin of the angle below which two lines run together
const STEEP = 0.2;                 // a slide direction must cross its wall at least this steeply

function frame(w) {
  const L = Math.hypot(w.bx - w.ax, w.by - w.ay);
  const d = L || 1;
  const ux = (w.bx - w.ax) / d, uy = (w.by - w.ay) / d;
  return { L, ux, uy, nx: -uy, ny: ux, h: (w.thickness || 0.114) / 2 };
}
const near = (x0, y0, x1, y1, tol) => Math.hypot(x1 - x0, y1 - y0) < tol;

// Where (x, y) sits on wall `w`: s along it from a, d across it (signed, +n side), or null
// when the point is off the wall as drawn.
export function floorPointOnWall(w, x, y) {
  const f = frame(w);
  if (f.L < 1e-6) return null;
  const s = (x - w.ax) * f.ux + (y - w.ay) * f.uy;
  const d = (x - w.ax) * f.nx + (y - w.ay) * f.ny;
  const reach = f.h + FLOOR_TOL;
  return Math.abs(d) <= reach && s >= -reach && s <= f.L + reach ? { s, d } : null;
}

// Whether a floor corner is attached to any of `walls`.
export function floorCornerAttached(walls, x, y) {
  return walls.some(w => floorPointOnWall(w, x, y));
}

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
  const across = (x, y) => (x - wall.ax) * f.nx + (y - wall.ay) * f.ny;
  const onLine = (x, y, tol) => {
    const t = (x - wall.ax) * f.ux + (y - wall.ay) * f.uy;
    return t > t0 - tol && t < t1 + tol && Math.abs(across(x, y)) < tol;
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
  // Floor corners on the run, then the far corner of any floor edge lying along the run's
  // line beyond its end (an open-plan edge): the edge moves as a whole instead of skewing.
  const corners = [];
  for (const r of rooms || []) {
    const pts = r.pts || [];
    const on = pts.map(p => run.some(w => floorPointOnWall(w, p[0], p[1])));
    const along = new Array(pts.length).fill(false);
    pts.forEach((p, i) => {
      if (on[i]) return;
      for (const j of [(i + pts.length - 1) % pts.length, (i + 1) % pts.length]) {
        if (j === i || !on[j]) continue;
        const q = pts[j], ex = p[0] - q[0], ey = p[1] - q[1], el = Math.hypot(ex, ey);
        if (el < 1e-6 || Math.abs(ex * f.uy - ey * f.ux) / el > COLLINEAR) continue;
        if (Math.abs(across(p[0], p[1])) <= h + FLOOR_TOL) along[i] = true;
      }
    });
    pts.forEach((p, i) => { if (on[i] || along[i]) corners.push({ r, i, x0: p[0], y0: p[1] }); });
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

// The direction a floor corner slides in to stay on a wall that turns: along whichever of
// its two edges leaves the wall most steeply (that edge keeps its direction), or null when
// both run along the wall.
function slideDir(pts, i, f) {
  let best = null, bestSin = STEEP;
  for (const j of [(i + pts.length - 1) % pts.length, (i + 1) % pts.length]) {
    const ex = pts[i][0] - pts[j][0], ey = pts[i][1] - pts[j][1], el = Math.hypot(ex, ey);
    if (el < 1e-6) continue;
    const sin = Math.abs(ex * f.uy - ey * f.ux) / el;
    if (sin > bestSin) { bestSin = sin; best = [ex / el, ey / el]; }
  }
  return best;
}

// Everything at the joint where `wall`'s `end` sits, plus what is attached along the walls
// that meet there (they pivot about their far ends as the joint moves).
export function planCornerMove(wall, end, walls, rooms, openings) {
  const px = wall[end + 'x'], py = wall[end + 'y'];
  const ends = [{ w: wall, end }];
  for (const o of walls) {
    if (o === wall || o.id === wall.id) continue;
    for (const e of ['a', 'b']) if (near(o[e + 'x'], o[e + 'y'], px, py, JOIN_TOL)) ends.push({ w: o, end: e });
  }
  const jointIds = new Set(ends.map(e => e.w.id));
  const jointWalls = ends.map(e => e.w);
  let hMax = 0;
  for (const w of jointWalls) hMax = Math.max(hMax, frame(w).h);
  // Each wall at the joint pivots about its far end; remember its old frame from there.
  const pivots = ends.map(e => {
    const fe = e.end === 'a' ? 'b' : 'a';
    const fx = e.w[fe + 'x'], fy = e.w[fe + 'y'];
    const L = Math.hypot(px - fx, py - fy);
    if (L < 1e-6) return null;
    const ux = (px - fx) / L, uy = (py - fy) / L;
    return { w: e.w, fx, fy, ux, uy, nx: -uy, ny: ux, h: frame(e.w).h, L };
  }).filter(Boolean);
  const local = (p, x, y) => ({ s: (x - p.fx) * p.ux + (y - p.fy) * p.uy, d: (x - p.fx) * p.nx + (y - p.fy) * p.ny });
  // Floor corners at the joint translate with it; floor corners further along a pivoting
  // wall slide along their own edge to stay on it, at the same offset from its centre line.
  const corners = [], hosted = [];
  const jointReach = hMax * Math.SQRT2 + FLOOR_TOL;
  for (const r of rooms || []) {
    const pts = r.pts || [];
    pts.forEach((p, i) => {
      const onJointWall = jointWalls.some(w => floorPointOnWall(w, p[0], p[1]));
      if (!onJointWall) return;
      if (near(p[0], p[1], px, py, jointReach)) { corners.push({ r, i, x0: p[0], y0: p[1] }); return; }
      const pv = pivots.find(q => floorPointOnWall(q.w, p[0], p[1]));
      if (!pv) return;
      const { s, d } = local(pv, p[0], p[1]);
      hosted.push({ kind: 'corner', r, i, x0: p[0], y0: p[1], pv, s, d, dir: slideDir(pts, i, pv) });
    });
  }
  // Walls abutting a pivoting wall mid-span keep their direction and stretch to meet it.
  const hostedEnds = [];
  for (const o of walls) {
    if (jointIds.has(o.id)) continue;
    for (const e of ['a', 'b']) {
      const x = o[e + 'x'], y = o[e + 'y'];
      const pv = pivots.find(q => {
        const { s, d } = local(q, x, y);
        return Math.abs(d) < q.h + JOIN_TOL && s > -JOIN_TOL && s < q.L + JOIN_TOL;
      });
      if (!pv || near(x, y, pv.fx, pv.fy, JOIN_TOL)) continue;   // joined at the far end, which stays
      const other = e === 'a' ? 'b' : 'a';
      const ex = x - o[other + 'x'], ey = y - o[other + 'y'], el = Math.hypot(ex, ey);
      const { s, d } = local(pv, x, y);
      const h = { kind: 'end', w: o, end: e, x0: x, y0: y, pv, s, d, dir: el > 1e-6 ? [ex / el, ey / el] : null };
      hosted.push(h); hostedEnds.push(h);
    }
  }
  const snap = snapshotEnds(ends);
  return {
    kind: 'corner', x0: px, y0: py, ends: snap, corners, hosted,
    anchors: openingAnchors(openings, [...snap, ...hostedEnds], new Set()),
    wallIds: snap.map(e => e.w.id),
  };
}

// Where a hosted point lands when its wall now runs from its pivot to (x, y).
function rehost(hp, x, y) {
  const p = hp.pv;
  const L = Math.hypot(x - p.fx, y - p.fy);
  if (L < 1e-6) return [hp.x0, hp.y0];
  const vx = (x - p.fx) / L, vy = (y - p.fy) / L, mx = -vy, my = vx;
  if (hp.dir) {
    const dm = hp.dir[0] * mx + hp.dir[1] * my;
    if (Math.abs(dm) >= STEEP) {
      const t = (hp.d - ((hp.x0 - p.fx) * mx + (hp.y0 - p.fy) * my)) / dm;
      return [hp.x0 + hp.dir[0] * t, hp.y0 + hp.dir[1] * t];
    }
  }
  return [p.fx + vx * hp.s + mx * hp.d, p.fy + vy * hp.s + my * hp.d];
}

// Put the joint at (x, y).
export function applyCornerMove(plan, x, y) {
  const dx = x - plan.x0, dy = y - plan.y0;
  for (const e of plan.ends) { e.w[e.end + 'x'] = e.x0 + dx; e.w[e.end + 'y'] = e.y0 + dy; }
  for (const c of plan.corners) c.r.pts[c.i] = [c.x0 + dx, c.y0 + dy];
  for (const hp of plan.hosted) {
    const [nx, ny] = rehost(hp, x, y);
    if (hp.kind === 'corner') hp.r.pts[hp.i] = [nx, ny];
    else { hp.w[hp.end + 'x'] = nx; hp.w[hp.end + 'y'] = ny; }
  }
  placeOpenings(plan.anchors);
}

// The floor corners a move plan carries, as {r, i}: the canvas marks them while dragging so
// what is attached is visible.
export function floorCornersOf(plan) {
  if (!plan) return [];
  const out = plan.corners.map(c => ({ r: c.r, i: c.i }));
  for (const hp of plan.hosted || []) if (hp.kind === 'corner') out.push({ r: hp.r, i: hp.i });
  return out;
}

// Attach a floor's loose corners: each corner that is not on a wall but lies within `reach`
// of one moves onto it, to a wall end when one is that close, else onto the nearest wall's
// centre line. Returns how many corners moved.
export function snapFloorToWalls(room, walls, reach = 0.3) {
  let moved = 0;
  room.pts = (room.pts || []).map(p => {
    if (floorCornerAttached(walls, p[0], p[1])) return p;
    let best = null, bestD = reach;
    for (const w of walls) for (const [x, y] of [[w.ax, w.ay], [w.bx, w.by]]) {
      const d = Math.hypot(x - p[0], y - p[1]);
      if (d < bestD) { bestD = d; best = [x, y]; }
    }
    if (!best) {
      let bestLine = Infinity;
      for (const w of walls) {
        const f = frame(w);
        if (f.L < 1e-6) continue;
        const s = Math.max(0, Math.min(f.L, (p[0] - w.ax) * f.ux + (p[1] - w.ay) * f.uy));
        const qx = w.ax + f.ux * s, qy = w.ay + f.uy * s;
        const d = Math.hypot(p[0] - qx, p[1] - qy);
        if (d < f.h + reach && d < bestLine) { bestLine = d; best = [qx, qy]; }
      }
    }
    if (!best) return p;
    moved++;
    return [best[0], best[1]];
  });
  return moved;
}
