// Solid surfaces while walking (MODEL's WALK): a person is a body BODY metres in radius that
// stops at every surface it can see and slides along it, so no walk, tap or key takes the eye
// through a wall. Looking around only turns the eye where it stands, so a place the body may
// stand is a place the whole view stays on its own side of the walls.
//
// Pure functions over a `cast` the viewer supplies; plan x/y are world x/z, in metres.
//   cast(x, z, dx, dz, far) -> { distance, nx, nz } | null
// is the nearest surface along the level ray from (x, z) toward the unit direction (dx, dz),
// no further than `far`, with the surface's level normal (any sign, any length; 0, 0 when it
// has none). The viewer tests each ray at knee, waist and eye height.
//
// A place is clear when no surface is nearer than BODY along any of the RING directions.
// Every place a walk rests at is clear, which is what keeps a step from starting inside a wall.

export const BODY = 0.3;            // metres from the eye to the nearest surface (about 1 ft)
export const MAX_STEP = 0.2;        // the longest single step; longer moves are cut into these
const SLACK = 0.012;                // how far inside BODY still counts as clear
const RING = 12;
const DIRS = Array.from({ length: RING }, (_, k) => [Math.cos(k * 2 * Math.PI / RING), Math.sin(k * 2 * Math.PI / RING)]);

// The surface's normal turned to face the ray it was hit by, level and of length one.
function facing(hit, dx, dz) {
  let nx = Number(hit.nx) || 0, nz = Number(hit.nz) || 0;
  const len = Math.hypot(nx, nz);
  if (len < 1e-6) return [-dx, -dz];
  nx /= len; nz /= len;
  return nx * dx + nz * dz > 0 ? [-nx, -nz] : [nx, nz];
}

// How far the body at (x, z) has to move to stand clear of the surface the ring of rays finds
// nearest: null when nothing is too close, else [dx, dz]. It backs away along the ray that
// found it: square off a wall it faces, and round a corner it has clipped (a door jamb)
// instead of being held there. settle() asks again until nothing is too close.
function pushOut(x, z, cast) {
  let worst = null, at = BODY - SLACK;
  for (const d of DIRS) {
    const hit = cast(x, z, d[0], d[1], BODY);
    if (hit && hit.distance < at) { at = hit.distance; worst = d; }
  }
  return worst ? [-worst[0] * (BODY - at), -worst[1] * (BODY - at)] : null;
}

// Whether a body may stand at (x, z).
export function isClear(x, z, cast) { return pushOut(x, z, cast) === null; }

// The clear place nearest (x, z) that a few small moves away from the surfaces reach, or null
// (a gap too narrow for the body, or the inside of something solid).
export function settle(x, z, cast, passes = 6) {
  for (let i = 0; i < passes; i++) {
    const push = pushOut(x, z, cast);
    if (!push) return { x, z };
    const len = Math.hypot(push[0], push[1]);
    if (len < 1e-5 || len > BODY * 2) return null;
    // Moving clear of one surface must not cross another on the way.
    const hit = cast(x, z, push[0] / len, push[1] / len, len + BODY * 0.5);
    if (hit && hit.distance < len + 0.02) return null;
    x += push[0]; z += push[1];
  }
  return isClear(x, z, cast) ? { x, z } : null;
}

// How far the body can go from (x, z) along the unit direction (dx, dz), up to `len`, before the
// surface ahead is BODY away from it (measured square to the surface, so a wall met at a slant
// is not crept up on): { go, hit } (hit is what stopped it, or null).
function advance(x, z, dx, dz, len, cast) {
  const hit = cast(x, z, dx, dz, len + BODY);
  if (!hit) return { go: len, hit: null };
  const [nx, nz] = facing(hit, dx, dz);
  const closing = Math.max(0.2, -(dx * nx + dz * nz));
  return { go: Math.max(0, Math.min(len, hit.distance - BODY / closing)), hit };
}

// One step of a walk: the body at `from` ({ x, z }, a clear place) wants to move by (mx, mz).
// Returns where it ends up, { x, z, blocked }: the whole move when nothing is in the way,
// else as far as it goes and then along the surface that stopped it. It never ends nearer a
// surface than BODY, and never crosses one.
export function walkStep(from, mx, mz, cast) {
  const total = Math.hypot(mx, mz);
  if (!(total > 1e-9)) return { x: from.x, z: from.z, blocked: false };
  // A long move (a slow frame, a fast runner) is walked as several short ones.
  if (total > MAX_STEP) {
    const n = Math.ceil(total / MAX_STEP);
    let at = { x: from.x, z: from.z }, blocked = false;
    for (let i = 0; i < n; i++) {
      const next = walkStep(at, mx / n, mz / n, cast);
      blocked = blocked || next.blocked;
      if (next.x === at.x && next.z === at.z) break;
      at = next;
    }
    return { x: at.x, z: at.z, blocked };
  }
  const dx = mx / total, dz = mz / total;
  const a = advance(from.x, from.z, dx, dz, total, cast);
  let x = from.x + dx * a.go, z = from.z + dz * a.go;
  if (a.hit) {
    // What is left of the move goes along the surface instead of into it.
    const [nx, nz] = facing(a.hit, dx, dz);
    const left = total - a.go, into = dx * nx + dz * nz;
    let sx = (dx - nx * into) * left, sz = (dz - nz * into) * left;
    const slide = Math.hypot(sx, sz);
    if (slide > 1e-6) {
      sx /= slide; sz /= slide;
      const s = advance(x, z, sx, sz, slide, cast);
      x += sx * s.go; z += sz * s.go;
    }
  }
  const rest = settle(x, z, cast);
  if (rest) return { x: rest.x, z: rest.z, blocked: !!a.hit };
  // The slide ended somewhere too tight: keep the straight part of the move if that is clear.
  if (a.hit && a.go > 1e-6) {
    const straight = settle(from.x + dx * a.go, from.z + dz * a.go, cast);
    if (straight) return { x: straight.x, z: straight.z, blocked: true };
  }
  return { x: from.x, z: from.z, blocked: true };
}

// A clear place at or near (x, z): the place itself moved clear, else the nearest of the
// places round it out to `reach` metres that can be, else null. For where a walk starts.
export function findClear(x, z, cast, reach = 2.4) {
  const here = settle(x, z, cast);
  if (here) return here;
  for (let r = BODY; r <= reach + 1e-9; r += BODY) {
    for (const [dx, dz] of DIRS) {
      const there = settle(x + dx * r, z + dz * r, cast);
      if (there) return there;
    }
  }
  return null;
}

// Where a glide from `from` toward `to` (both { x, z }) may end: the clear place nearest `to`
// on the way there, stepping back toward `from` until one is found; null when there is none
// worth going to.
export function glideEnd(from, to, cast) {
  const dx = to.x - from.x, dz = to.z - from.z, dist = Math.hypot(dx, dz);
  if (!(dist > 1e-6)) return null;
  for (let back = 0; back < dist - 0.15; back += 0.15) {
    const k = (dist - back) / dist;
    const rest = settle(from.x + dx * k, from.z + dz * k, cast);
    if (rest) return rest;
  }
  return null;
}
