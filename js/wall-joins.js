// Shared wall-joint geometry for the scene builder and native model export.
// Pure plan mathematics: no renderer or workspace state.

const EPS = 0.0005;               // buried-face margin so joined solids never share a plane
const JOIN_TOL = 0.012;           // wall endpoints closer than this meet at one joint
const COLLINEAR = 0.3;            // sin of the deflection below which a neighbour continues the wall

export function wallFrame(wall) {
  const L = Math.hypot(wall.bx - wall.ax, wall.by - wall.ay);
  const d = L || 1;
  const ux = (wall.bx - wall.ax) / d, uy = (wall.by - wall.ay) / d;
  return { L, ux, uy, nx: -uy, ny: ux, h: (wall.thickness || 0.114) / 2 };
}

// Parameter along (dx, dy) from (ax, ay) where that line meets the line through (bx, by)
// with direction (qx, qy); null when the lines are parallel.
function lineHit(ax, ay, dx, dy, bx, by, qx, qy) {
  const den = dx * qy - dy * qx;
  if (Math.abs(den) < 1e-6) return null;
  return ((bx - ax) * qy - (by - ay) * qx) / den;
}

// Two directions out of a shared point that run (nearly) opposite: one wall carrying on as the other.
function continues(ax, ay, bx, by) {
  return ax * bx + ay * by < 0 && Math.abs(ax * by - ay * bx) < COLLINEAR;
}

// Deterministic winner between two straight runs crossing at a point: thicker, then lower id,
// so both runs agree on which one passes through and which is cut at its face.
function outranks(p, q) {
  const tp = Math.max(p[0].thickness || 0.114, p[1].thickness || 0.114);
  const tq = Math.max(q[0].thickness || 0.114, q[1].thickness || 0.114);
  if (tp !== tq) return tp > tq;
  return [String(p[0].id), String(p[1].id)].sort()[0] < [String(q[0].id), String(q[1].id)].sort()[0];
}

// Close one end of a wall against the walls meeting it. Returns, in wall-local x, where the
// +z face (`pos`) and the -z face (`neg`) stop, plus `tip` (a local {x, z} between the two)
// when the end needs an extra corner: three or more walls meeting at a point, or a pair
// that jogs where we abut it. `inflate` thickens every wall by that much per side, which
// is how wall trim gets mitres matching the faces it sits on.
function wallEnd(wall, end, walls, inflate) {
  inflate = inflate || 0;
  const f = wallFrame(wall);
  const h = f.h + inflate;
  const atStart = end === 'a';
  const px = atStart ? wall.ax : wall.bx, py = atStart ? wall.ay : wall.by;
  const dx = atStart ? -f.ux : f.ux, dy = atStart ? -f.uy : f.uy;   // outward along the axis
  const ex = -dx, ey = -dy;                                          // into this wall
  const local = (a) => atStart ? -a : f.L + a;
  // tip: [outward extension, local z] of an extra footprint vertex between the two face cuts.
  const result = (aPos, aNeg, tip) => ({ pos: local(aPos), neg: local(aNeg), tip: tip ? { x: local(tip[0]), z: tip[1] } : null });

  const joined = [], through = [];
  for (const o of walls) {
    if (o === wall || o.id === wall.id) continue;
    const g = wallFrame(o);
    if (g.L < 0.01) continue;
    const nearA = Math.hypot(o.ax - px, o.ay - py) < JOIN_TOL, nearB = Math.hypot(o.bx - px, o.by - py) < JOIN_TOL;
    if (nearA || nearB) {
      const s = nearA ? 1 : -1;
      const ix = g.ux * s, iy = g.uy * s;                             // from the joint into the neighbour
      if (ix * ex + iy * ey > 0 && Math.abs(ix * ey - iy * ex) < COLLINEAR) continue; // folds back over us
      joined.push({ o, g, ix, iy, cont: continues(ex, ey, ix, iy) });
    } else {
      // A wall running past our endpoint within its own thickness: we abut it mid-span.
      const t = (px - o.ax) * g.ux + (py - o.ay) * g.uy;
      const d = Math.abs((px - o.ax) * g.nx + (py - o.ay) * g.ny);
      if (t > JOIN_TOL && t < g.L - JOIN_TOL && d < g.h + JOIN_TOL) through.push({ o, g });
    }
  }

  // Where our face s (+1 / -1) meets face t of neighbour nb, as an outward extension.
  const hit = (s, nb, t, bury) => {
    const gh = nb.g.h + inflate;
    let a = lineHit(px + f.nx * h * s, py + f.ny * h * s, dx, dy,
      nb.o.ax + nb.g.nx * gh * t, nb.o.ay + nb.g.ny * gh * t, nb.g.ux, nb.g.uy);
    if (a == null) return 0;
    if (bury) a += EPS;                                   // stay a hair inside the wall we abut
    const reach = 6 * Math.max(f.h, nb.g.h);              // acute mitres run away: cap at three thicknesses
    return Math.max(-Math.min(reach, f.L * 0.45), Math.min(reach, a));
  };
  // Which of a corner neighbour's faces pairs with our face s: inner with inner, outer with outer.
  const pair = (s, nb) => s * Math.sign(f.nx * nb.ix + f.ny * nb.iy || 1) * Math.sign(nb.g.nx * ex + nb.g.ny * ey || 1);
  // The face of a passing wall on our side.
  const near = (nb) => Math.sign(nb.g.nx * ex + nb.g.ny * ey || 1);
  // Where face t of neighbour p meets face u of neighbour q, as [outward extension, local z].
  const meet = (p, t, q, u) => {
    const ph = p.g.h + inflate, qh = q.g.h + inflate;
    const ax = p.o.ax + p.g.nx * ph * t, ay = p.o.ay + p.g.ny * ph * t;
    const s = lineHit(ax, ay, p.g.ux, p.g.uy, q.o.ax + q.g.nx * qh * u, q.o.ay + q.g.ny * qh * u, q.g.ux, q.g.uy);
    if (s == null) return null;
    const qx = ax + p.g.ux * s - px, qy = ay + p.g.uy * s - py;
    return [qx * dx + qy * dy, qx * f.nx + qy * f.ny];
  };
  // Keep an extra vertex only if it sits within the wall's width and beyond the straight cut,
  // so the footprint stays convex.
  const beyond = (tip, aPos, aNeg) => {
    if (!tip || Math.abs(tip[1]) > h - 0.001) return null;
    const chord = aNeg + (tip[1] + h) / (2 * h) * (aPos - aNeg);
    return tip[0] > chord + 0.001 ? tip : null;
  };

  if (through.length) {
    const t = near(through[0]);
    return result(hit(1, through[0], t, true), hit(-1, through[0], t, true), null);
  }
  const corners = joined.filter(j => !j.cont);
  const conts = joined.filter(j => j.cont).sort((p, q) => Math.abs(p.ix * ey - p.iy * ex) - Math.abs(q.ix * ey - q.iy * ex));
  // Angular neighbours: the corner wall first met sweeping from our axis towards +z, and towards -z.
  for (const j of corners) j.phi = (Math.atan2(j.ix * f.nx + j.iy * f.ny, j.ix * ex + j.iy * ey) + 2 * Math.PI) % (2 * Math.PI);
  const posNb = corners.length ? corners.reduce((m, j) => j.phi < m.phi ? j : m) : null;
  const negNb = corners.length ? corners.reduce((m, j) => j.phi > m.phi ? j : m) : null;
  // A corner neighbour that carries straight on past the joint cuts us at its face.
  const passes = (nb) => joined.some(k => k !== nb && continues(nb.ix, nb.iy, k.ix, k.iy));

  if (conts.length) {
    const c = conts[0];
    // Two straight runs crossing here: the one that outranks passes, the other is cut.
    if (posNb && negNb && posNb !== negNb && continues(posNb.ix, posNb.iy, negNb.ix, negNb.iy) && outranks([posNb.o, negNb.o], [wall, c.o])) {
      return result(hit(1, posNb, pair(1, posNb), true), hit(-1, negNb, pair(-1, negNb), true), null);
    }
    // Straight on there is nothing to add; a slight jog mitres the faces by a few millimetres.
    return result(hit(1, c, pair(1, c), false), hit(-1, c, pair(-1, c), false), null);
  }
  if (!posNb) return result(0, 0, null);
  const buryPos = passes(posNb), buryNeg = passes(negNb);
  const tPos = pair(1, posNb), tNeg = pair(-1, negNb);
  const aPos = hit(1, posNb, tPos, buryPos), aNeg = hit(-1, negNb, tNeg, buryNeg);
  let tip = null;
  if (posNb !== negNb && !buryPos && !buryNeg) {
    // Three or more walls meeting at a point: the two face cuts leave a wedge in front of
    // the end; a tip on the centreline at the joint fills it, and the neighbours' tips meet it there.
    tip = [0, 0];
  } else if (posNb !== negNb && buryPos && buryNeg) {
    // Abutting a pair that jogs rather than runs straight: the end bends where the two
    // faces meet instead of cutting a straight line between them and leaving a notch.
    tip = meet(posNb, tPos, negNb, tNeg);
  }
  return result(aPos, aNeg, beyond(tip, aPos, aNeg));
}
export function wallEnds(wall, walls, inflate) {
  return { a: wallEnd(wall, 'a', walls, inflate), b: wallEnd(wall, 'b', walls, inflate) };
}

