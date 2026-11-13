import { Vector2, ShapeUtils } from '../vendor/three.module.min.js';
import { wallFrame, wallEnds } from './wall-joins.js';
import { trimLayout } from './trims.js';
import { sectionOf } from './trim-profiles.js';

// ---------- wall trim ----------
// Each trim record (trims.js) is a group in its wall's frame, like the wall itself: every part
// of its layout swept from its section (trim-profiles.js). A run that reaches the end of its
// wall is mitred there, each point of its section stopping where the wall's face, thickened
// by that point's depth, meets the next wall's face thickened the same: the baseboard of the
// next wall meets it at the corner. The section's depth varies linearly between the face (no
// thickening) and the profile's full depth, so the two face cuts bound every point.
function sweepInto(out, sec, at, inward, outDir, capStart, capEnd) {
  // sec: [a, d] points; at(k, end) -> [x, y, z] of section point k at the start (0) or end (1).
  const n = sec.length;
  let area = 0;
  for (let i = 0; i < n; i++) { const [a0, d0] = sec[i], [a1, d1] = sec[(i + 1) % n]; area += a0 * d1 - a1 * d0; }
  const ccw = area > 0;
  const tri = (p, q, r, want) => {
    const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2], vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) return;
    if (nx * want[0] + ny * want[1] + nz * want[2] < 0) { [q, r] = [r, q]; nx = -nx; ny = -ny; nz = -nz; }
    out.P.push(...p, ...q, ...r);
    for (let i = 0; i < 3; i++) out.N.push(nx / len, ny / len, nz / len);
    out.UV.push(p[0] + p[2], p[1], q[0] + q[2], q[1], r[0] + r[2], r[1]);
  };
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    const da = sec[j][0] - sec[k][0], dd = sec[j][1] - sec[k][1];
    if (Math.abs(da) + Math.abs(dd) < 1e-9) continue;
    // The edge's outward normal in the section plane, then in 3D.
    const na = ccw ? dd : -dd, nd = ccw ? -da : da;
    const want = [inward[0] * na + outDir[0] * nd, inward[1] * na + outDir[1] * nd, inward[2] * na + outDir[2] * nd];
    const s0 = at(k, 0), s1 = at(j, 0), e0 = at(k, 1), e1 = at(j, 1);
    tri(s0, s1, e1, want); tri(s0, e1, e0, want);
  }
  const contour = [];
  for (const [a, d] of sec) { const v = new Vector2(a, d); if (!contour.length || contour[contour.length - 1].distanceTo(v) > 1e-7) contour.push(v); }
  if (contour.length > 2 && contour[0].distanceTo(contour[contour.length - 1]) < 1e-7) contour.pop();
  if (contour.length < 3) return;
  const idx = sec.map(([a, d]) => contour.findIndex(v => Math.abs(v.x - a) < 1e-7 && Math.abs(v.y - d) < 1e-7));
  const back = new Map(); idx.forEach((ci, k) => { if (!back.has(ci)) back.set(ci, k); });
  for (const [i, j, k] of ShapeUtils.triangulateShape(contour, [])) {
    const ki = back.get(i), kj = back.get(j), kk = back.get(k);
    if (ki == null || kj == null || kk == null) continue;
    tri(at(ki, 0), at(kj, 0), at(kk, 0), capStart);
    tri(at(ki, 1), at(kj, 1), at(kk, 1), capEnd);
  }
}

// Wall-local, unrounded metre coordinates shared by rendering and native export.
// The only Three dependency is CPU section triangulation from the vendored module.
export function trimMeshParts(t, wall, view, openings) {
  const f = wallFrame(wall);
  if (f.L < 0.01) return { parts: [], layout: null };
  const H = wall.height || view.wallHeight || 2.44;
  const side = t.side === -1 ? -1 : 1, h = f.h;
  const walls = view.walls || [];
  const endsAt = new Map();
  const faceEnds = (inflate) => {
    const key = Math.round(inflate * 1e5);
    if (!endsAt.has(key)) endsAt.set(key, wallEnds(wall, walls, inflate));
    const e = endsAt.get(key);
    return side > 0 ? [e.a.pos, e.b.pos] : [e.a.neg, e.b.neg];
  };
  const [e0, e1] = faceEnds(0);
  const lay = trimLayout(t, wall, openings, { L: f.L, H, x0: e0, x1: e1 });
  const z = d => side * (h + d);
  const main = { P: [], N: [], UV: [] }, backer = { P: [], N: [], UV: [] };
  const OUT = [0, 0, side];
  for (const part of lay.parts) {
    const out = part.role === 'backer' ? backer : main;
    const lift = part.d || 0;
    if (part.kind === 'run') {
      const sec = sectionOf(part.profile, part.W, part.T);
      const [o0, o1] = part.mitreA || part.mitreB ? faceEnds(part.T) : [part.x0, part.x1];
      const xs = d => part.mitreA ? part.x0 + (o0 - part.x0) * d / part.T : part.x0;
      const xe = d => part.mitreB ? part.x1 + (o1 - part.x1) * d / part.T : part.x1;
      const yOf = a => part.crown ? H - a : part.y + a;
      sweepInto(out, sec, (k, end) => { const [a, d] = sec[k]; return [end ? xe(d) : xs(d), yOf(a), z(d)]; },
        [0, part.crown ? -1 : 1, 0], OUT, [-1, 0, 0], [1, 0, 0]);
    } else if (part.kind === 'frame') {
      const sec = sectionOf(part.profile, part.W, part.T);
      const { x0, x1, y0, y1 } = part;
      // Bottom, top, left, right: each mitred at 45 degrees, its inner edge shorter by its width.
      sweepInto(out, sec, (k, end) => { const [w, d] = sec[k]; return [end ? x1 - w : x0 + w, y0 + w, z(d + lift)]; }, [0, 1, 0], OUT, [-1, 0, 0], [1, 0, 0]);
      sweepInto(out, sec, (k, end) => { const [w, d] = sec[k]; return [end ? x1 - w : x0 + w, y1 - w, z(d + lift)]; }, [0, -1, 0], OUT, [-1, 0, 0], [1, 0, 0]);
      sweepInto(out, sec, (k, end) => { const [w, d] = sec[k]; return [x0 + w, end ? y1 - w : y0 + w, z(d + lift)]; }, [1, 0, 0], OUT, [0, -1, 0], [0, 1, 0]);
      sweepInto(out, sec, (k, end) => { const [w, d] = sec[k]; return [x1 - w, end ? y1 - w : y0 + w, z(d + lift)]; }, [-1, 0, 0], OUT, [0, -1, 0], [0, 1, 0]);
    } else if (part.kind === 'board') {
      const { x0, x1, y0, y1 } = part;
      if (part.dir === 'v') {
        const sec = sectionOf(part.profile, x1 - x0, part.T);
        sweepInto(out, sec, (k, end) => { const [a, d] = sec[k]; return [x0 + a, end ? y1 : y0, z(d + lift)]; }, [1, 0, 0], OUT, [0, -1, 0], [0, 1, 0]);
      } else {
        const sec = sectionOf(part.profile, y1 - y0, part.T);
        sweepInto(out, sec, (k, end) => { const [a, d] = sec[k]; return [end ? x1 : x0, y0 + a, z(d + lift)]; }, [0, 1, 0], OUT, [-1, 0, 0], [1, 0, 0]);
      }
    }
  }
  const parts = [];
  for (const [role, buf] of [['main', main], ['backer', backer]]) {
    if (buf.P.length) parts.push({ role, positions: buf.P, normals: buf.N, uv: buf.UV });
  }
  return { parts, layout: { rects: lay.rects, boxes: lay.boxes, cols: lay.cols, H, side, h } };
}
