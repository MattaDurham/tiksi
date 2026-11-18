// Wall trim designed a room at a time (js/trim-design.js): which sections a change reaches at
// each scope, box counts that follow a width aimed for, one gap and margins for every wall,
// height lines that carry what touches them, one more or fewer box in one stretch, and slivers
// left plain. Synthetic walls and rooms only.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const T = await import('../js/trims.js');
const D = await import('../js/trim-design.js');

const IN = 0.0254;
const near = (a, b, what, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${what}: ${a} is not ${b}`);

// Two rooms side by side, walls 2.5 m high and 0.1 m thick: a 5 x 4 m living room and a
// 3 x 4 m study, sharing the wall `mid`. The living room's north wall has a window, sill at
// 0.8 m; the shared wall has a door.
function house() {
  const wall = (id, ax, ay, bx, by) => ({ id, level: 'l1', ax, ay, bx, by, thickness: 0.1, height: 2.5 });
  const prop = {
    walls: [wall('n1', 0, 0, 5, 0), wall('n2', 5, 0, 8, 0), wall('e', 8, 0, 8, 4), wall('s2', 8, 4, 5, 4), wall('s1', 5, 4, 0, 4), wall('w', 0, 4, 0, 0), wall('mid', 5, 0, 5, 4)],
    rooms: [{ id: 'living', level: 'l1', name: 'Living', pts: [[0, 0], [5, 0], [5, 4], [0, 4]] }, { id: 'study', level: 'l1', name: 'Study', pts: [[5, 0], [8, 0], [8, 4], [5, 4]] }],
    openings: [{ id: 'win', wallId: 'n1', type: 'window', t: 0.5, width: 1.2, height: 1.2, sill: 0.8 }, { id: 'door', wallId: 'mid', type: 'door', t: 0.5, width: 0.8, height: 2.03 }],
    trims: [],
  };
  const env = { prop, projects: [], levelOf: () => 'l1', wallsOn: () => prop.walls, roomsOn: () => prop.rooms, openingsOn: () => prop.openings, heightOf: w => w.height };
  // Which side of each wall looks into which room, found the way MODEL finds it.
  const faces = new Map();
  const d0 = D.trimDesign(env);
  let n = 0;
  const add = (style, wallId, side, at = {}) => {
    const w = prop.walls.find(x => x.id === wallId);
    const t = T.trimTemplate(style, null, w, side, { wallHeight: 2.5, ...at });
    t.id = 't' + (++n);
    prop.trims.push(t);
    return t;
  };
  // The side of `wallId` that faces `roomId`.
  const sideOf = (wallId, roomId) => {
    for (const side of [1, -1]) {
      const probe = { id: 'probe', wallId, side, f0: 0, f1: 1, style: 'chair-rail' };
      if ((d0.info(probe) || {}).roomId === roomId) return side;
    }
    throw new Error(wallId + ' does not face ' + roomId);
  };
  void faces;
  return { prop, env, add, sideOf };
}
const LIVING = ['n1', 's1', 'w', 'mid'], STUDY = ['n2', 'e', 's2', 'mid'];

// A room dressed the usual way: baseboard, a field of boxes above it, a chair rail on the field.
function dress(h, roomId, wallIds, railY = 0.9) {
  const out = { base: [], boxes: [], rail: [] };
  for (const id of wallIds) {
    const side = h.sideOf(id, roomId);
    const base = h.add('baseboard', id, side);
    const baseTop = base.y + T.trimProduct(base).W;
    out.base.push(base);
    out.boxes.push(h.add('picture-frame', id, side, { y: baseTop, h: railY - baseTop }));
    out.rail.push(h.add('chair-rail', id, side, { y: railY }));
  }
  return out;
}

test('a section knows its room, and each scope reaches the right sections', () => {
  const h = house();
  const living = dress(h, 'living', LIVING), study = dress(h, 'study', STUDY);
  const d = D.trimDesign(h.env);
  assert.equal(d.info(living.rail[0]).roomName, 'Living');
  assert.equal(d.info(study.rail[0]).roomName, 'Study');
  assert.notEqual(d.info(living.rail[3]).roomKey, d.info(study.rail[3]).roomKey, 'the two faces of the shared wall belong to different rooms');
  const seed = [living.boxes[0].id];
  assert.deepEqual(d.members(seed, 'selected').map(t => t.id), seed);
  assert.equal(d.members(seed, 'group').length, 4, 'the group is the same trim at the same height round the room');
  assert.equal(d.pool(seed, 'room').length, 12, 'the room is all its trim');
  assert.equal(d.members(seed, 'room').length, 4, 'a design number goes to the same kind only');
  assert.equal(d.members(seed, 'project').length, 8, 'the project is every room');
  const scopes = d.scopes(seed);
  assert.deepEqual(scopes.map(s => [s.id, s.count]), [['selected', 1], ['group', 4], ['room', 4], ['project', 8]]);
  assert.match(scopes[2].title, /Living/);
});

test('a subproject\'s group of pieces is the group; a project is its own pieces', () => {
  const h = house();
  const living = dress(h, 'living', LIVING), study = dress(h, 'study', STUDY);
  h.env.projects = [{ id: 'p', name: 'Wall trim' }, { id: 'sub', parentId: 'p', name: 'Living boxes' }];
  living.boxes[0].projectId = 'sub'; living.rail[0].projectId = 'sub'; living.boxes[1].projectId = 'p';
  const d = D.trimDesign(h.env);
  assert.deepEqual(d.pool([living.boxes[0].id], 'group').map(t => t.id).sort(), [living.boxes[0].id, living.rail[0].id].sort());
  assert.deepEqual(d.members([living.boxes[0].id], 'project').map(t => t.id).sort(), [living.boxes[0].id, living.boxes[1].id].sort(), 'the project and its subprojects');
  assert.equal(d.members([study.boxes[0].id], 'project').length, 6, 'pieces of no project are together');
});

test('boxes follow the width aimed for: each wall takes the count that comes closest', () => {
  const h = house();
  const living = dress(h, 'living', LIVING);
  const d = D.trimDesign(h.env);
  const widths = t => d.layout(t).boxes.filter(b => b.row === 0 && d.layout(t).rects[b.rect].full).map(b => b.x1 - b.x0);
  for (const t of d.members([living.boxes[0].id], 'room')) { D.setDesignParam(t, 'gap', 3 * IN); D.setDesignParam(t, 'margin', 3 * IN); D.setDesignParam(t, 'aim', 24 * IN); }
  for (const t of living.boxes) {
    const lay = d.layout(t);
    for (const [k, r] of lay.rects.entries()) {
      if (!r.full) continue;
      const row = lay.boxes.filter(b => b.rect === k && b.row === 0);
      const span = r.x1 - r.x0 - 6 * IN;
      assert.equal(row.length, Math.max(1, Math.round((span + 3 * IN) / (27 * IN))), 'n = round((w + gap) / (aim + gap))');
      for (const b of row) near(b.x1 - b.x0, (span - 3 * IN * (row.length - 1)) / row.length, 'equal boxes fill the stretch');
      for (let i = 1; i < row.length; i++) near(row[i].x0 - row[i - 1].x1, 3 * IN, 'one gap');
      near(row[0].x0 - r.x0, 3 * IN, 'the margin at the stretch\'s end');
    }
  }
  // The west wall is 4 m between corners less the wall thicknesses; the long south wall is 5 m.
  const before = living.boxes.map(t => widths(t).length);
  for (const t of living.boxes) D.setDesignParam(t, 'aim', 14 * IN);
  const after = living.boxes.map(t => widths(t).length);
  assert.ok(after.every((n, i) => n > before[i]), 'a smaller aim shrinks every box until more fit: ' + before + ' -> ' + after);
  for (const t of living.boxes) for (const w of widths(t)) assert.ok(Math.abs(w - 14 * IN) < 3 * IN, 'each box near the aim, ' + (w / IN).toFixed(2) + ' in');
});

test('a wider gap narrows every box and keeps the count; one reveal sets gap and margins alike', () => {
  const h = house();
  const living = dress(h, 'living', LIVING);
  const d = D.trimDesign(h.env);
  const s = living.boxes.find(t => t.wallId === 's1');
  const row = () => d.layout(s).boxes.filter(b => b.row === 0);
  D.setDesignParam(s, 'aim', 30 * IN);
  const n = row().length, w0 = row()[0].x1 - row()[0].x0;
  D.setDesignParam(s, 'gap', 5 * IN);
  assert.equal(row().length, n, 'the count holds');
  near(row()[1].x0 - row()[0].x1, 5 * IN, 'the gap is the new gap');
  assert.ok(row()[0].x1 - row()[0].x0 < w0, 'each box gives up its share');
  D.setDesignParam(s, 'reveal', 3.5 * IN);
  const v = D.designValues(s);
  for (const k of ['gap', 'sides', 'top', 'bottom']) near(v[k], 3.5 * IN, k, 1e-4);
  D.setDesignParam(s, 'top', 5 * IN);
  const v2 = D.designValues(s);
  near(v2.top, 5 * IN, 'top margin', 1e-4); near(v2.sides, 3.5 * IN, 'sides kept', 1e-4); near(v2.bottom, 3.5 * IN, 'bottom kept', 1e-4);
  const b = row()[0];
  near(s.y + s.h - b.y1, 5 * IN, 'the boxes stop the top margin below the field\'s top', 1e-4);
  near(b.y0 - s.y, 3.5 * IN, 'and the bottom margin above its bottom', 1e-4);
  assert.equal(D.setDesignParam(living.rail[0], 'gap', .1), false, 'a rail has no gap');
});

test('raising the chair rail carries the room: the field under it stretches, the base stays down', () => {
  const h = house();
  const living = dress(h, 'living', LIVING), study = dress(h, 'study', STUDY, 0.95);
  // An upper field sits on the living room's rail on one wall.
  const railTop = 0.9 + T.trimProduct(living.rail[0]).W;
  const upper = h.add('picture-frame', 'w', h.sideOf('w', 'living'), { y: railTop, h: 1.2 });
  const d = D.trimDesign(h.env);
  const seed = living.rail[0];
  const copy = list => list.map(t => JSON.parse(JSON.stringify(t)));
  const room = d.planLine(copy(d.pool([seed.id], 'room')), seed.id, 'move', 0.1);
  near(room.dy, 0.1, 'moved the whole way');
  for (const t of living.rail) near(room.patches.get(t.id).y, 1.0, 'every rail of the room is on the new line', 1e-4);
  for (const t of living.boxes) { const p = room.patches.get(t.id); near(p.y, t.y, 'field bottom stays'); near(p.h, t.h + 0.1, 'field top follows the rail', 1e-4); }
  near(room.patches.get(upper.id).y, upper.y + 0.1, 'the field standing on the rail rises', 1e-4);
  near(room.patches.get(upper.id).h, upper.h - 0.1, 'and keeps its top', 1e-4);
  for (const t of living.base) assert.ok(!room.patches.has(t.id), 'the baseboard stays on the floor');
  for (const t of study.rail) assert.ok(!room.patches.has(t.id), 'the next room is not in the room scope');
  // The group is the ring of rails alone.
  const group = d.planLine(copy(d.pool([seed.id], 'group')), seed.id, 'move', 0.1);
  assert.equal(group.moved, 4, 'four rails and nothing else');
  // Moved as before, without a reach: the study's rails, 2 in higher, move the same distance.
  const all = d.planLine(copy(d.pool([seed.id], 'project')), seed.id, 'move', 0.1);
  for (const t of study.rail) near(all.patches.get(t.id).y, 1.05, 'the study rail rises the same distance', 1e-4);
  for (const t of study.boxes) near(all.patches.get(t.id).h, t.h + 0.1, 'and its field follows', 1e-4);
  // At the project's reach every rail comes onto the line in hand: the study's too, and the
  // study's fields stretch by their own rail's distance.
  const one = d.planLine(copy(d.pool([seed.id], 'project')), seed.id, 'move', 0.1, { scope: 'project' });
  near(one.dy, 0.1, 'the line moved the whole way');
  for (const t of [...living.rail, ...study.rail]) near(one.patches.get(t.id).y, 1.0, 'every rail of the project is on one line', 1e-4);
  for (const t of study.boxes) near(t.y + one.patches.get(t.id).h, 1.0, 'each study field reaches the one line', 1e-4);
  for (const t of living.boxes) near(t.y + one.patches.get(t.id).h, 1.0, 'and each living field', 1e-4);
  // A wainscot cap in the study, 1 in off the line, is the same line across the project.
  const cap = h.add('wainscot-cap', 'e', h.sideOf('e', 'study'), { y: 0.925 });
  const d2 = D.trimDesign(h.env);
  const fam = d2.planLine(copy(d2.pool([seed.id], 'project')), seed.id, 'move', 0.1, { scope: 'project' });
  near(fam.patches.get(cap.id).y, 1.0, 'the study\'s cap comes onto the rail line', 1e-4);
  assert.ok(!d2.planLine(copy(d2.pool([seed.id], 'room')), seed.id, 'move', 0.1, { scope: 'room' }).patches.has(cap.id), 'a room reach leaves the next room alone');
  // A moulding picked for the rail at the project's reach goes to the study's cap on that line too.
  const reachIds = d2.mouldingReach([seed.id], 'project', 'chair-rail').map(t => t.id);
  for (const t of [...living.rail, ...study.rail, cap]) assert.ok(reachIds.includes(t.id), t.style + ' ' + t.id + ' takes the moulding');
  for (const t of [...living.base, ...living.boxes]) assert.ok(!reachIds.includes(t.id), 'base and fields keep their own');
  assert.ok(!d2.mouldingReach([seed.id], 'room', 'chair-rail').some(t => t.id === cap.id), 'a room reach keeps to the room');
  // Not moved at all, the drag already shows where everything goes: a grab is a snap.
  const snap = d.planLine(copy(d.pool([seed.id], 'project')), seed.id, 'move', 0, { scope: 'project' });
  for (const t of study.rail) near(snap.patches.get(t.id).y, 0.9, 'a grab brings the study rail to the living line', 1e-4);
  // A field is never crushed: lowering stops while the boxes still have a field.
  const down = d.planLine(copy(d.pool([seed.id], 'room')), seed.id, 'move', -2);
  const least = Math.min(...living.boxes.map(t => down.patches.get(t.id).h));
  near(least, 0.08, 'the lowest field keeps its least height', 1e-4);
  assert.ok(down.dy > -2 && down.dy < 0, 'the move is held to what every section allows');
});

test('one edge of a field moves the line it is on; several picked sections move as one', () => {
  const h = house();
  const living = dress(h, 'living', LIVING);
  const d = D.trimDesign(h.env);
  const copy = list => list.map(t => JSON.parse(JSON.stringify(t)));
  const seed = living.boxes[0];
  const up = d.planLine(copy(d.pool([seed.id], 'room')), seed.id, 'top', 0.05);
  for (const t of living.boxes) near(up.patches.get(t.id).h, t.h + 0.05, 'every field top', 1e-4);
  for (const t of living.rail) near(up.patches.get(t.id).y, 0.95, 'the rails on that line ride up', 1e-4);
  const one = d.planLine(copy(d.pool([seed.id], 'selected')), seed.id, 'top', 0.05);
  assert.equal(one.moved, 1, 'selected only: the one field');
  const pair = [living.base[0], living.rail[1]];
  const both = d.planLine(copy(pair), pair[1].id, 'move', 0.05, { all: true });
  near(both.patches.get(pair[0].id).y, 0.05, 'a picked baseboard moves with the rest', 1e-4);
  assert.deepEqual(d.lineStops(living.rail[0]), [0.8], 'the room\'s window stool is a height to stop on');
});

test('one more or fewer box in the stretch under the pointer, on that section only', () => {
  const h = house();
  const living = dress(h, 'living', LIVING);
  const d = D.trimDesign(h.env);
  const s = living.boxes.find(t => t.wallId === 's1');
  const count = () => d.layout(s).boxes.filter(b => b.row === 0).length;
  const n = count();
  assert.equal(d.stepCols(s, 2.5, +1).count, n + 1);
  assert.equal(count(), n + 1);
  assert.equal(d.stepCols(s, 2.5, -1).count, n);
  assert.ok(D.designValues(s).pinned, 'the count is set, not fitted');
  D.setDesignParam(s, 'fit');
  assert.ok(!D.designValues(s).pinned && count() === n, 'FIT puts it back');
  // The shared wall has a door: two stretches, and only the one under the pointer changes.
  const m = living.boxes.find(t => t.wallId === 'mid');
  const per = () => { const lay = d.layout(m); return lay.rects.map((r, k) => r.full ? lay.boxes.filter(b => b.rect === k && b.row === 0).length : null).filter(v => v != null); };
  const was = per();
  assert.equal(was.length, 2, 'a stretch each side of the door');
  const first = d.layout(m).rects.find(r => r.full);
  d.stepCols(m, (first.x0 + first.x1) / 2, +1);
  assert.deepEqual(per(), [was[0] + 1, was[1]]);
  for (let i = 0; i < 5; i++) d.stepCols(m, (first.x0 + first.x1) / 2, -1);
  assert.deepEqual(per(), [0, was[1]], 'a stretch can be left with no box');
});

test('a stretch too narrow for a box worth making is left plain, and the notes say what is unusual', () => {
  const h = house();
  const side = h.sideOf('n2', 'study');
  // A door 9 in from the corner leaves a sliver.
  h.prop.openings.push({ id: 'd2', wallId: 'n2', type: 'door', t: 0.26, width: 0.8, height: 2.03 });
  const t = h.add('picture-frame', 'n2', side, { y: 0.14, h: 0.7 });
  const d = D.trimDesign(h.env);
  const stretches = () => { const lay = d.layout(t); return lay.rects.map((r, k) => r.full ? lay.boxes.filter(b => b.rect === k).length : null).filter(v => v != null); };
  D.setDesignParam(t, 'reveal', 3 * IN);
  assert.equal(stretches().length, 2);
  assert.ok(stretches()[0] >= 1, 'the sliver has a box until a least width is set');
  const fmt = m => (m / IN).toFixed(1) + ' in';
  assert.ok(d.notes([t], fmt).some(n => /narrowest box/.test(n)), 'the note points at the narrow box');
  D.setDesignParam(t, 'minBox', 8 * IN);
  assert.equal(stretches()[0], 0, 'left plain');
  assert.ok(stretches()[1] >= 1, 'the rest of the wall keeps its boxes');
  assert.equal(d.summary([t]).empty, 1);
  assert.ok(!d.notes([t], fmt).some(n => /narrowest box/.test(n)));
  D.setDesignParam(t, 'gap', 8 * IN);
  assert.ok(d.notes([t], fmt).some(n => /usually/.test(n) && /Gaps/.test(n)));
  assert.ok(d.notes([t], fmt).some(n => /ONE REVEAL/.test(n)));
});

test('battens and framed panels follow an aim too; planks do not', () => {
  const h = house();
  const side = h.sideOf('s1', 'living');
  const bb = h.add('board-batten', 's1', side), sh = h.add('shaker', 'w', h.sideOf('w', 'living')), bead = h.add('beadboard', 'n1', h.sideOf('n1', 'living'));
  const d = D.trimDesign(h.env);
  const bays = t => d.layout(t).boxes.filter(b => b.row === 0).length;
  const n0 = bays(bb), s0 = bays(sh);
  assert.ok(D.setDesignParam(bb, 'aim', 10 * IN) && bays(bb) > n0, 'closer battens, more bays');
  assert.ok(D.setDesignParam(sh, 'aim', 14 * IN) && bays(sh) > s0, 'narrower panels, more of them');
  const row = d.layout(sh).boxes.filter(b => b.row === 0);
  assert.ok(Math.abs(row[0].x1 - row[0].x0 - 14 * IN) < 2.5 * IN, 'panels near the aim');
  assert.equal(D.setDesignParam(bead, 'aim', .3), false);
  assert.deepEqual(d.notes([bb], m => String(m)), [], 'closely spaced battens draw no note about narrow boxes');
  assert.equal(D.designValues(h.add('crown', 's1', side)), null);
});

test('a dragged value holds its step until the pointer is clearly past it', () => {
  const step = 0.25;
  assert.equal(D.stickySnap(1.1, null, step), 1);
  assert.equal(D.stickySnap(1.13, 1, step), 1, 'just past halfway: stays');
  assert.equal(D.stickySnap(1.2, 1, step), 1.25, 'three quarters past: goes');
  assert.equal(D.stickySnap(1.12, 1.25, step), 1.25, 'and does not fall back at once');
});

test('records with the new numbers are made safe from a file', () => {
  const t = T.normaliseTrim({ style: 'picture-frame', wallId: 'w', target: 'x', insetTop: -1, insetBottom: .05, minBox: 9, colsAt: [2, 'a', 0, 99], gap: .08 }, null);
  assert.equal(t.target, null); assert.equal(t.insetTop, 0); assert.equal(t.insetBottom, .05); assert.equal(t.minBox, 2);
  assert.deepEqual(t.colsAt, [2, null, 0, null]);
  const u = T.normaliseTrim({ style: 'picture-frame', wallId: 'w', target: .6, colsAt: [null, null] }, null);
  assert.equal(u.target, .6); assert.equal(u.colsAt, null);
});
