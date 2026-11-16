// The standard view set every project gets, the views construction documents are made from:
// an overview, a plan from above for each level (parallel, north up, cut 4'-0" above the floor)
// and one cut-open parallel elevation for each wall of each room. MODEL makes or refreshes the
// set as saved views (saved-views.js); the SketchUp sync file carries saved views as scenes
// (sketchup-mirror.js), and the SketchUp build scripts make the same scenes by the same rules
// (server/standard_scenes.py, scripts/standard-scenes.py). Pure data only, so Node tests run it.
//
// The rules work on a plain description of the building, so the Python copy can be fed the
// same thing from a SketchUp file:
//   input = { north: degrees, levels: [{ id, name, elevation, height }],
//             rooms: [{ id, name, level, z, height, pts: [[x, y]] }],
//             walls: [{ level, ax, ay, bx, by }] }
// in Tiksi's plan metres (world x = plan x, world z = plan y, world y up). The fixture
// test/fixtures/standard-views.json holds inputs and the sets both copies must make from them.
//
// An odd-shaped room: its outline is walked side by side; sides that carry on in a straight
// line are one wall; a wall shorter than 2'-0" gets no elevation. Each elevation looks square
// at its wall from inside the room; its cut stands 1" short of the room's farthest point from
// that wall, so it opens the room and keeps everything in it.

import { normalizeSavedView } from './saved-views.js';

export const RULES = {
  fov: 50,                 // degrees, Tiksi's default lens
  aspect: 1.5,             // picture width to height the parallel views are framed for
  margin: 1.12,            // room around what a parallel view frames
  planCut: 1.2192,         // 4'-0": a plan's cut above its floor
  minWall: 0.6096,         // 2'-0": shorter walls get no elevation
  cutInset: 0.0254,        // 1": the elevation's cut stands this far inside the room's far side
  straight: 1,             // degrees: sides turning less than this are one wall
  height: 2.44,            // a level or room with no height (store.js levelHeight)
};
const DEG = Math.PI / 180, R = Math.SQRT1_2;
const r6 = v => Math.round(v * 1e6) / 1e6 + 0;
const v6 = a => a.map(r6);
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

// What the rules read from a property.
export function standardInput(prop) {
  const fallback = Number(prop.wallHeight) > 0 ? Number(prop.wallHeight) : RULES.height;
  const levels = (prop.levels || []).filter(l => l && typeof l.id === 'string').map(l => ({
    id: l.id, name: String(l.name || l.id), elevation: Number(l.elevation) || 0, height: Number(l.height) > 0 ? Number(l.height) : fallback }));
  const lv = id => levels.find(l => l.id === id) || levels[0] || { id: '', elevation: 0, height: fallback };
  const rooms = (prop.rooms || []).filter(r => r && Array.isArray(r.pts) && r.pts.length >= 3).map(r => {
    const l = lv(r.level);
    return { id: String(r.id), name: String(r.name || ''), level: l.id, z: l.elevation, height: Number(r.ceilingHeight) > 0 ? Number(r.ceilingHeight) : l.height, pts: r.pts.map(p => [Number(p[0]), Number(p[1])]) };
  });
  const walls = (prop.walls || []).filter(w => w && [w.ax, w.ay, w.bx, w.by].every(Number.isFinite)).map(w => ({ level: lv(w.level).id, ax: w.ax, ay: w.ay, bx: w.bx, by: w.by }));
  return { north: Number(prop.env && prop.env.north) || 0, levels, rooms, walls };
}

function area(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}

// A room outline's walls: straight runs of its sides, each { a, b, length }, in outline order.
export function roomWalls(pts) {
  const ring = pts.filter((p, i) => { const q = pts[(i + 1) % pts.length]; return Math.hypot(q[0] - p[0], q[1] - p[1]) > 1e-6; });
  const turn = Math.sin(RULES.straight * DEG);
  for (let i = 0; ring.length > 3 && i < ring.length;) {
    const p = ring[(i + ring.length - 1) % ring.length], q = ring[i], s = ring[(i + 1) % ring.length];
    const d1 = [q[0] - p[0], q[1] - p[1]], d2 = [s[0] - q[0], s[1] - q[1]];
    const cross = (d1[0] * d2[1] - d1[1] * d2[0]) / (Math.hypot(...d1) * Math.hypot(...d2));
    if (Math.abs(cross) < turn && d1[0] * d2[0] + d1[1] * d2[1] > 0) { ring.splice(i, 1); i = 0; } else i++;
  }
  return ring.map((a, i) => { const b = ring[(i + 1) % ring.length]; return { a, b, length: Math.hypot(b[0] - a[0], b[1] - a[1]) }; });
}

// Which way a plan direction points, by the property's north.
function compass(dx, dy, north) {
  const n = north * DEG, N = [Math.sin(n), -Math.cos(n)], E = [Math.cos(n), Math.sin(n)];
  const bearing = Math.atan2(dx * E[0] + dy * E[1], dx * N[0] + dy * N[1]) / DEG;
  return COMPASS[((Math.round(bearing / 45) % 8) + 8) % 8];
}

// A parallel camera that frames `halfH` above and below `target`, looking along `dir` (a unit
// vector): Tiksi's parallel camera shows distance * tan(fov / 2) each way (viewer3d.js viewCamera).
function parallelCamera(target, dir, halfH) {
  const d = halfH / Math.tan(RULES.fov * DEG / 2);
  return { position: v6([target[0] - dir[0] * d, target[1] - dir[1] * d, target[2] - dir[2] * d]), target: v6(target), fov: RULES.fov, parallel: true };
}

function extent(points, axis) {
  let lo = Infinity, hi = -Infinity;
  for (const p of points) { const s = p[0] * axis[0] + p[1] * axis[1]; lo = Math.min(lo, s); hi = Math.max(hi, s); }
  return [lo, hi];
}

// The set, in order: overview, plans, elevations. Each is a saved view without an id, with
// `standard: { key, name }`; `key` says what it shows, so a refresh finds it again.
export function standardSet(input) {
  const out = [];
  const levels = input.levels || [], rooms = input.rooms || [], walls = input.walls || [];
  const used = levels.filter(l => rooms.some(r => r.level === l.id) || walls.some(w => w.level === l.id));
  if (!used.length) return out;
  const pointsOn = id => [...rooms.filter(r => r.level === id).flatMap(r => r.pts), ...walls.filter(w => w.level === id).flatMap(w => [[w.ax, w.ay], [w.bx, w.by]])];
  const others = id => levels.filter(l => l.id !== id).map(l => l.id);
  const view = (key, name, camera, mode, section, hiddenLevels) => ({ name, camera, mode, tags: {}, section, xray: false, hiddenLevels, standard: { key, name } });

  // Overview: Tiksi's ISO direction (viewer3d.js presetView), the whole building in the picture.
  {
    const all = used.flatMap(l => pointsOn(l.id));
    const [x0, x1] = extent(all, [1, 0]), [y0, y1] = extent(all, [0, 1]);
    const z0 = Math.min(...used.map(l => l.elevation)), z1 = Math.max(...used.map(l => l.elevation + l.height));
    const dir = [-0.72, 0.62, 0.72], dl = Math.hypot(...dir);
    const target = [(x0 + x1) / 2, z0 + (z1 - z0) * 0.45, (y0 + y1) / 2];
    const d = Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2 / Math.sin(RULES.fov * DEG / 2) * 1.08;
    out.push(view('overview', 'Overview', { position: v6(target.map((c, i) => c + dir[i] / dl * d)), target: v6(target), fov: RULES.fov }, 'orbit', { on: false, height: 1.2 }, []));
  }

  // A plan from above for each level, north up, cut 4'-0" above its floor.
  const n = (input.north || 0) * DEG, N = [Math.sin(n), -Math.cos(n)], E = [Math.cos(n), Math.sin(n)];
  for (const l of used) {
    const pts = pointsOn(l.id), [e0, e1] = extent(pts, E), [n0, n1] = extent(pts, N);
    const ce = (e0 + e1) / 2, cn = (n0 + n1) / 2;
    const cx = E[0] * ce + N[0] * cn, cy = E[1] * ce + N[1] * cn;
    const halfH = Math.max(n1 - n0, (e1 - e0) / RULES.aspect) / 2 * RULES.margin;
    // Straight down, a hair toward the south so north stays up the screen (presetView 'top').
    const dir = [N[0] * 0.002, -1, N[1] * 0.002], dl = Math.hypot(...dir);
    const cut = { id: 'cut-std-plan', kind: 'level', q: [-R, 0, 0, R], pos: v6([cx, l.elevation + RULES.planCut, cy]) };
    out.push(view('plan:' + l.id, used.length > 1 ? 'Plan, ' + l.name.slice(0, 50) : 'Plan', parallelCamera([cx, l.elevation, cy], dir.map(c => c / dl), halfH), 'top',
      { on: true, height: r6(l.elevation + RULES.planCut), planes: [cut], active: cut.id, done: true }, others(l.id)));
  }

  // One cut-open elevation for each wall of each room.
  rooms.forEach((room, ri) => {
    if (!levels.some(l => l.id === room.level)) return;
    const ccw = area(room.pts) > 0, label = (room.name.trim() || 'Room ' + (ri + 1)).slice(0, 40);
    const seen = {};
    for (const w of roomWalls(room.pts)) {
      if (w.length < RULES.minWall) continue;
      const ux = (w.b[0] - w.a[0]) / w.length, uy = (w.b[1] - w.a[1]) / w.length;
      const nx = ccw ? -uy : uy, ny = ccw ? ux : -ux;            // into the room
      const side = compass(-nx, -ny, input.north || 0);
      seen[side] = (seen[side] || 0) + 1;
      const depth = Math.max(...room.pts.map(p => (p[0] - w.a[0]) * nx + (p[1] - w.a[1]) * ny));
      const cutAt = depth > 2 * RULES.cutInset ? depth - RULES.cutInset : depth / 2;
      const mx = (w.a[0] + w.b[0]) / 2, my = (w.a[1] + w.b[1]) / 2, mid = room.z + room.height / 2;
      const halfH = Math.max(room.height, w.length / RULES.aspect) / 2 * RULES.margin;
      // The cut faces the camera: its cut-away side (+Z turned by q) points into the room.
      const yaw = Math.atan2(nx, ny);
      const cut = { id: 'cut-std-elev', kind: 'custom', q: v6([0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]), pos: v6([mx + nx * cutAt, mid, my + ny * cutAt]) };
      const name = label + ', ' + side + ' wall' + (seen[side] > 1 ? ' ' + seen[side] : '');
      out.push(view('elevation:' + room.id + ':' + side + ':' + seen[side], name, parallelCamera([mx, mid, my], [-nx, 0, -ny], halfH), 'orbit',
        { on: true, height: 1.2, planes: [cut], active: cut.id, done: true }, others(room.level)));
    }
  });
  return out.slice(0, 100);
}

export function isStandard(v) { return !!(v && v.standard && typeof v.standard.key === 'string'); }
export function standardCount(prop) { return (prop.savedViews || []).filter(isStandard).length; }

// Make or refresh the property's standard views. A view of the set made before keeps its id,
// its place among the tabs and a name the owner gave it; one whose room, wall or level is gone
// is taken away. Views the owner saved are never touched. Returns { added, updated, removed,
// skipped } (skipped: no room left, a property keeps at most 100 views).
export function refreshStandardViews(prop) {
  const wanted = standardSet(standardInput(prop));
  const list = Array.isArray(prop.savedViews) ? prop.savedViews : [];
  const keys = new Set(wanted.map(v => v.standard.key));
  let added = 0, updated = 0, removed = 0, skipped = 0;
  const kept = list.filter(v => { if (isStandard(v) && !keys.has(v.standard.key)) { removed++; return false; } return true; });
  const byKey = new Map(kept.filter(isStandard).map(v => [v.standard.key, v]));
  const taken = new Set(kept.map(v => v.id));
  for (const raw of wanted) {
    const old = byKey.get(raw.standard.key);
    if (old) {
      const v = normalizeSavedView({ ...raw, name: old.name !== old.standard.name ? old.name : raw.name, id: old.id }, new Set());
      if (v) { kept[kept.indexOf(old)] = v; updated++; }
      continue;
    }
    if (kept.length >= 100) { skipped++; continue; }
    const v = normalizeSavedView(raw, taken);
    if (v) { taken.add(v.id); kept.push(v); added++; }
  }
  prop.savedViews = kept;
  return { added, updated, removed, skipped };
}
