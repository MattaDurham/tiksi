// Going to a spot while walking (MODEL's WALK and the client page in the lab): where a
// double-click or a double tap on the floor takes a person, and how long the glide there lasts.
// Pure functions; the viewer finds what is in the way (walk-collide.js) and moves the camera.
// Plan x/y are world x/z.

export const STOP_SHORT = 0.45;       // a walk toward a surface stops this far before it

// Where a person at `from` (x, z) who chose a point `at` (x, z) goes: the point itself, or
// short of it when `blockedAt` (the distance along the way to the first solid surface, or
// Infinity) comes first. null when it is too close to bother.
export function walkTarget(from, at, blockedAt = Infinity) {
  const dx = at.x - from.x, dz = at.z - from.z, dist = Math.hypot(dx, dz);
  const reach = Math.min(dist, blockedAt - STOP_SHORT);
  if (!(reach > 0.15)) return null;
  return { x: from.x + dx / dist * reach, z: from.z + dz / dist * reach, dist: reach };
}

// How long a glide of `dist` metres takes, in milliseconds: an easy walking pace, never a jump
// and never a long wait.
export function glideMs(dist) { return Math.round(Math.min(2600, Math.max(380, dist / 2.4 * 1000))); }
