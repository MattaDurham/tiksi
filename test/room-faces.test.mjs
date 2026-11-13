// Room faces (js/room-faces.js): each room's wall surfaces, inside corner to inside corner, with
// their square feet and lengths. Synthetic plans only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { roomFaces, faceTotals } from '../js/room-faces.js';

const T = 0.15, H = 2.5;
const wall = (id, ax, ay, bx, by, extra = {}) => ({ id, ax, ay, bx, by, thickness: T, ...extra });
const near = (a, b, msg, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${msg}: ${a} is not ${b}`);

// An 8 x 4 m box (x east, y south) split by a partition at x = 3 into a kitchen and a living
// room. The north wall is drawn as two walls in a straight line; the partition holds a door and
// the living room's north wall a window.
function house() {
  return {
    walls: [wall('n1', 0, 0, 5, 0), wall('n2', 5, 0, 8, 0), wall('e', 8, 0, 8, 4), wall('s', 8, 4, 0, 4), wall('w', 0, 4, 0, 0), wall('mid', 3, 0, 3, 4)],
    rooms: [{ id: 'k', name: 'Kitchen', pts: [[0, 0], [3, 0], [3, 4], [0, 4]] }, { id: 'l', name: 'Living', pts: [[3, 0], [8, 0], [8, 4], [3, 4]] }],
    openings: [{ id: 'door', wallId: 'mid', type: 'door', t: 0.5, width: 0.9, height: 2.03 },
      { id: 'win', wallId: 'n2', type: 'window', t: 0.5, width: 1.2, height: 1.2, sill: 0.9 }],
    heightOf: () => H,
  };
}
const byLabel = faces => Object.fromEntries(faces.map(f => [f.label, f]));

test('each room wall runs inside corner to inside corner', () => {
  const f = byLabel(roomFaces(house()));
  near(f['Kitchen, west wall'].length, 4 - T, 'between the north and south walls\' faces');
  near(f['Kitchen, north wall'].length, 3 - T, 'from the west wall\'s face to the partition\'s');
  near(f['Kitchen, east wall'].length, 4 - T, 'the partition stops at the faces it butts into');
  near(f['Living, south wall'].length, 5 - T, 'the long south wall is split where the partition meets it');
  assert.equal(Object.keys(f).filter(k => k.startsWith('Kitchen')).length, 4);
  assert.equal(Object.keys(f).filter(k => k.startsWith('Living')).length, 4);
});

test('a straight run drawn as two walls is one face', () => {
  const north = byLabel(roomFaces(house()))['Living, north wall'];
  assert.deepEqual(north.parts.map(p => p.wallId).sort(), ['n1', 'n2']);
  near(north.length, 5 - T, 'partition face to the east wall\'s face');
});

test('the outside of the house is one face per flat run, corner to outside corner', () => {
  const f = byLabel(roomFaces(house()));
  near(f['Outside, north face'].length, 8 + T, 'past both outside corners');
  near(f['Outside, west face'].length, 4 + T, 'past both outside corners');
  assert.equal(f['Outside, north face'].kind, 'outside');
  assert.equal(f['Outside, north face'].roomId, null);
  assert.equal(roomFaces(house()).filter(x => x.kind === 'none').length, 0, 'no sliver is left without a room or the outside');
});

test('areas are gross and net of the openings in the face; baseboard skips doors only', () => {
  const f = byLabel(roomFaces(house()));
  const k = f['Kitchen, east wall'], l = f['Living, west wall'], n = f['Living, north wall'];
  near(k.gross, (4 - T) * H, 'gross is length times height');
  near(k.net, (4 - T) * H - 0.9 * 2.03, 'the door comes off both faces of the partition');
  near(l.net, k.net, 'and the other side alike');
  near(k.baseboard, 4 - T - 0.9, 'baseboard stops at the door');
  near(n.net, n.gross - 1.2 * 1.2, 'the window comes off');
  near(n.baseboard, n.length, 'a window leaves the baseboard whole');
  assert.deepEqual(n.openings.map(o => o.id), ['win']);
});

test('totals add the faces and count each opening once per face', () => {
  const faces = roomFaces(house()).filter(f => f.roomId === 'l');
  const t = faceTotals(faces);
  assert.equal(t.count, 4);
  near(t.length, 2 * (5 - T) + 2 * (4 - T), 'perimeter inside the room');
  near(t.gross, t.length * H, 'gross');
  near(t.net, t.gross - 0.9 * 2.03 - 1.2 * 1.2, 'net');
  assert.equal(t.openings, 2);
});

test('a wall between two rooms with no partition between them splits where the room changes', () => {
  const p = house();
  p.walls = p.walls.filter(w => w.id !== 'mid');
  p.openings = [];
  const north = roomFaces(p).filter(f => f.label.endsWith('north wall'));
  assert.deepEqual(north.map(f => f.roomId).sort(), ['k', 'l']);
  near(north.find(f => f.roomId === 'k').length, 3 - T / 2, 'kitchen part: wall face to the room line', 0.002);
  near(north.find(f => f.roomId === 'l').length, 5 - T / 2, 'living part: room line to wall face', 0.002);
});

test('a face id stays the same across a rebuild and changes with its room', () => {
  const a = roomFaces(house()).map(f => f.id).sort(), b = roomFaces(house()).map(f => f.id).sort();
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length, 'ids are unique');
});

test('a face is as tall as its walls; walls of different heights in line stay separate', () => {
  const p = house();
  p.heightOf = w => (w.id === 'n2' ? 3 : H);
  const north = roomFaces(p).filter(f => f.label === 'Living, north wall');
  assert.equal(north.length, 2);
  assert.deepEqual(north.map(f => f.height).sort(), [H, 3]);
});
