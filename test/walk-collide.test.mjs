// Solid surfaces while walking (walk-collide.js): a body that stops at walls, slides along
// them, fits through a doorway and never ends up through or against a surface. The world here
// is flat: walls are line segments seen from above, as a level ray in MODEL sees them.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const C = await import('../js/walk-collide.js');
const { BODY } = C;

// A world of wall segments [[ax, az, bx, bz], ...] and its cast.
function world(segments) {
  const cast = (x, z, dx, dz, far) => {
    let best = null;
    for (const [ax, az, bx, bz] of segments) {
      const ex = bx - ax, ez = bz - az, den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((ax - x) * ez - (az - z) * ex) / den, u = ((ax - x) * dz - (az - z) * dx) / den;
      if (t < 1e-9 || t > far || u < 0 || u > 1) continue;
      if (!best || t < best.distance) best = { distance: t, nx: -ez, nz: ex };
    }
    return best;
  };
  return cast;
}
// The nearest any segment comes to (x, z).
function nearest(segments, x, z) {
  let best = Infinity;
  for (const [ax, az, bx, bz] of segments) {
    const ex = bx - ax, ez = bz - az, k = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez)));
    best = Math.min(best, Math.hypot(x - ax - ex * k, z - az - ez * k));
  }
  return best;
}
// A wall with thickness, as its four faces.
function slab(ax, az, bx, bz, t = 0.12) {
  const ex = bx - ax, ez = bz - az, L = Math.hypot(ex, ez), px = -ez / L * t / 2, pz = ex / L * t / 2;
  return [[ax + px, az + pz, bx + px, bz + pz], [bx - px, bz - pz, ax - px, az - pz], [ax + px, az + pz, ax - px, az - pz], [bx + px, bz + pz, bx - px, bz - pz]];
}
// A 4 m by 4 m room from (0, 0) to (4, 4), with a doorway 0.8 m wide in the wall at x = 4.
const ROOM = [...slab(0, 0, 4, 0), ...slab(0, 4, 4, 4), ...slab(0, 0, 0, 4), ...slab(4, 0, 4, 1.6), ...slab(4, 2.4, 4, 4)];
function seeded(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

test('walking straight at a wall stops a body away from it', () => {
  const cast = world(ROOM);
  let at = { x: 2, z: 1 };
  for (let i = 0; i < 200; i++) at = C.walkStep(at, -0.09, 0, cast);
  assert.ok(Math.abs(at.x - (0.06 + BODY)) < 0.02, 'it stands ' + at.x + ' from the origin, a body off the wall face at 0.06');
  assert.equal(at.z, 1);
  assert.equal(C.walkStep(at, -0.09, 0, cast).blocked, true);
});

test('a move with nothing in the way is taken whole', () => {
  const step = C.walkStep({ x: 2, z: 2 }, 0.05, -0.03, world(ROOM));
  assert.deepEqual([step.x, step.z, step.blocked], [2.05, 1.97, false]);
});

test('walking into a wall at a slant slides along it', () => {
  const cast = world(ROOM);
  let at = { x: 1, z: 1 };
  for (let i = 0; i < 120; i++) at = C.walkStep(at, 0.04, -0.04, cast);
  assert.ok(at.x > 3, 'it carried on along the wall to x = ' + at.x);
  assert.ok(at.z >= 0.06 + BODY - 0.03 && at.z < 0.5, 'and stayed a body off it, at z = ' + at.z);
});

test('a doorway lets a body through, even from off its middle', () => {
  const cast = world(ROOM);
  for (const z of [1.75, 2, 2.25]) {
    let at = { x: 2, z };
    for (let i = 0; i < 150; i++) at = C.walkStep(at, 0.05, 0, cast);
    assert.ok(at.x > 5, 'starting at z = ' + z + ' it reached x = ' + at.x);
    assert.ok(at.z > 1.6 && at.z < 2.4);
  }
});

test('a gap narrower than the body stops it', () => {
  const cast = world([...slab(0, 0, 4, 0), ...slab(0, 4, 4, 4), ...slab(0, 0, 0, 4), ...slab(4, 0, 4, 1.8), ...slab(4, 2.2, 4, 4)]);
  let at = { x: 2, z: 2 };
  for (let i = 0; i < 200; i++) at = C.walkStep(at, 0.05, 0, cast);
  assert.ok(at.x < 4, 'it stopped at x = ' + at.x);
});

// Whether the straight line from p to q crosses any segment.
function crosses(segments, p, q) {
  const dx = q.x - p.x, dz = q.z - p.z;
  for (const [ax, az, bx, bz] of segments) {
    const ex = bx - ax, ez = bz - az, den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((ax - p.x) * ez - (az - p.z) * ex) / den, u = ((ax - p.x) * dz - (az - p.z) * dx) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return true;
  }
  return false;
}

test('no walk ends through, inside or against a wall', () => {
  const walls = [...slab(0, 0, 4, 0), ...slab(0, 4, 4, 4), ...slab(0, 0, 0, 4), ...slab(4, 0, 4, 4), ...slab(1.5, 0, 1.5, 2.2, 0.1), ...slab(2.6, 4, 2.6, 2.9, 0.1)];
  const face = [[2.2, 1.2, 3.1, 1.9]];     // a single face with no thickness (a curtain, a pane)
  const all = [...walls, ...face];
  const cast = world(all);
  const rnd = seeded(7);
  let at = { x: 0.8, z: 3 }, worst = Infinity;
  assert.ok(C.isClear(at.x, at.z, cast));
  for (let i = 0; i < 6000; i++) {
    // A heading held for a while, as a person holds a key down, at a walk or a run.
    const turn = rnd() * Math.PI * 2, step = rnd() < 0.3 ? 0.18 : 0.03 + rnd() * 0.06;
    for (let k = 0; k < 12; k++) {
      const next = C.walkStep(at, Math.cos(turn) * step, Math.sin(turn) * step, cast);
      assert.ok(!crosses(all, at, next), 'crossed a surface at step ' + i + ': ' + JSON.stringify([at, next]));
      at = next;
      worst = Math.min(worst, nearest(walls, at.x, at.z));
      assert.ok(at.x > 0 && at.x < 4 && at.z > 0 && at.z < 4, 'left the room at step ' + i + ': ' + at.x + ', ' + at.z);
    }
  }
  // The eye keeps clear of every wall by more than the near edge of the view (0.12 m).
  assert.ok(worst > 0.13, 'the nearest it came to a wall was ' + worst);
});

test('a long move is walked in short steps, so it cannot jump a thin wall', () => {
  const cast = world(ROOM);
  const end = C.walkStep({ x: 2, z: 1 }, 0, -3, cast);
  assert.ok(end.z > 0.06 && end.z < 0.06 + BODY + 0.03, 'it ended at z = ' + end.z);
});

test('a place too close to a wall is moved clear; the inside of a tight gap is not a place', () => {
  const cast = world(ROOM);
  const near = C.settle(0.2, 2, cast);
  assert.ok(near && Math.abs(near.x - (0.06 + BODY)) < 0.02 && Math.abs(near.z - 2) < 1e-9);
  assert.deepEqual(C.settle(2, 2, cast), { x: 2, z: 2 });
  const tight = world([[0, 0, 0, 4], [0.3, 4, 0.3, 0]]);
  assert.equal(C.settle(0.15, 2, tight), null);
  const found = C.findClear(0.15, 2, tight);
  assert.ok(found && (found.x < -BODY + 0.02 || found.x > 0.3 + BODY - 0.02), 'the nearest clear place is outside the gap');
});

test('a glide ends at the clear place nearest where it was sent', () => {
  const cast = world(ROOM);
  // Sent to a point against the far wall: it ends a body short of the wall, on the way there.
  const end = C.glideEnd({ x: 2, z: 2 }, { x: 2, z: 0.1 }, cast);
  assert.ok(end && Math.abs(end.x - 2) < 1e-6 && end.z >= 0.06 + BODY - 0.02 && end.z < 0.6);
  assert.deepEqual(C.glideEnd({ x: 2, z: 2 }, { x: 3, z: 3 }, cast), { x: 3, z: 3 });
  assert.equal(C.glideEnd({ x: 2, z: 2 }, { x: 2, z: 2 }, cast), null);
});
