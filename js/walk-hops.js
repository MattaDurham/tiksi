// Walking on a phone (MODEL's WALK in the phone layout and the client page in the lab): the
// doorways a person can step through, with an arrow on the floor on each side of each one,
// and where a tap on the floor takes them. Pure functions over plan records; the viewer draws
// the arrows and moves the camera.
//
// A doorway is a door or an opening with no door (a cased or plain opening) in a wall; a
// window is not one. Plan x/y are world x/z.

export const ARROW_OFFSET = 0.55;     // an arrow sits this far out from the wall's face, in metres
export const STEP_THROUGH = 0.9;      // a tap on an arrow ends this far past the wall
export const STOP_SHORT = 0.45;       // a walk toward a wall stops this far before it
export const ARROW_RANGE = 6.5;       // arrows further than this from the person are not shown

function levelElevation(prop, levelId) {
  const l = (prop.levels || []).find(x => x.id === levelId);
  return l && Number.isFinite(l.elevation) ? l.elevation : 0;
}

// Every doorway: { id, x, z, ux, uz (along the wall), nx, nz (through it), width, thickness,
// elevation, level }.
export function doorways(prop) {
  const walls = new Map((prop.walls || []).map(w => [w.id, w]));
  const out = [];
  for (const o of prop.openings || []) {
    if (!o || o.type === 'window') continue;
    const w = walls.get(o.wallId);
    if (!w) continue;
    const L = Math.hypot(w.bx - w.ax, w.by - w.ay);
    if (!(L > 0.05)) continue;
    const ux = (w.bx - w.ax) / L, uz = (w.by - w.ay) / L;
    const width = Math.min(Number(o.width) || 0.8, L);
    if (width < 0.45) continue;
    const t = Math.min(Math.max(Number(o.t) || 0.5, 0), 1);
    const along = Math.min(Math.max(t * L, width / 2), L - width / 2);
    out.push({
      id: o.id, x: w.ax + ux * along, z: w.ay + uz * along, ux, uz, nx: -uz, nz: ux, width,
      thickness: Number(w.thickness) || 0.114, level: w.level || null, elevation: levelElevation(prop, w.level),
    });
  }
  return out;
}

// The two arrows of a doorway: one on each side, each pointing through it, with the point a
// tap on it walks to (on the far side).
export function doorwayArrows(d) {
  const half = d.thickness / 2;
  return [1, -1].map(side => {
    const off = half + ARROW_OFFSET, past = half + STEP_THROUGH;
    return {
      doorway: d.id, side,
      x: d.x + d.nx * off * side, z: d.z + d.nz * off * side,
      // Pointing from this side to the other.
      dx: -d.nx * side, dz: -d.nz * side,
      to: { x: d.x - d.nx * past * side, z: d.z - d.nz * past * side },
      elevation: d.elevation,
    };
  });
}

// The arrows a person standing at (x, z) on the floor at `elevation` should see: the near side
// of each doorway on their floor, within range.
export function arrowsNear(prop, x, z, elevation, range = ARROW_RANGE) {
  const out = [];
  for (const d of doorways(prop)) {
    if (Math.abs(d.elevation - elevation) > 0.5) continue;
    for (const a of doorwayArrows(d)) {
      const dist = Math.hypot(a.x - x, a.z - z);
      if (dist > range) continue;
      // The near side: the arrow is on the person's side of the wall.
      const sideOfPerson = (x - d.x) * d.nx + (z - d.z) * d.nz;
      if (Math.sign(sideOfPerson || 1) !== a.side) continue;
      out.push({ ...a, dist });
    }
  }
  return out.sort((a, b) => a.dist - b.dist);
}

// Where a tap takes a person at `from` (x, z) who tapped a point `at` (x, z): the point
// itself, or short of it when `blockedAt` (the distance along the way to the first wall, or
// Infinity) comes first. null when the tap is too close to bother.
export function walkTarget(from, at, blockedAt = Infinity) {
  const dx = at.x - from.x, dz = at.z - from.z, dist = Math.hypot(dx, dz);
  const reach = Math.min(dist, blockedAt - STOP_SHORT);
  if (!(reach > 0.15)) return null;
  return { x: from.x + dx / dist * reach, z: from.z + dz / dist * reach, dist: reach };
}

// How long a glide of `dist` metres takes, in milliseconds: an easy walking pace, never a jump
// and never a long wait.
export function glideMs(dist) { return Math.round(Math.min(2600, Math.max(380, dist / 2.4 * 1000))); }
