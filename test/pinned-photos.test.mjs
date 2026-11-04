// Pinned photos and documents: sheets that lie on (and follow) their wall, the lens a photo file
// records, the four-point camera fit, Polycam keyframe cameras and lining their sessions up with
// the model, and numbered photo positions. Synthetic data only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { wallAnchor, resolvePin, sheetAxes, sheetSize, sheetPlacement, pointsToMetres, viewForSheet, DEFAULT_PRINT } from '../js/pins.js';
import { readExif, lensFromExif, takenAtMs } from '../js/photo-exif.js';
import { lookAtPose, viewFromPose, poseFromView, project, solvePose, lensFromHfov, poseFromMatrix } from '../js/camera-solve.js';
import { keyframeRow, keyframeModelPose, nearestKeyframe, decodePng16, depthPoints, alignSession, yawMatrix, sharpKeyframes, KF } from '../js/polycam-cameras.js';
import { addPosition, picturesOf, removePosition, normalizePositions, renderingName, renderSize } from '../js/positions.js';
import { mergeShared } from '../js/workspace-merge.js';

globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
const close = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) < eps, (msg ? msg + ': ' : '') + a + ' != ' + b);

const WALL = { id: 'w-1', ax: 0, ay: 0, bx: 4, by: 0, thickness: 0.2, level: 'lvl-0' };   // normal +z (plan y)

test('a pin on a wall face keeps its place on that wall when the wall moves', () => {
  const a = wallAnchor(WALL, { x: 1.5, y: 1.4, z: 0.1 }, { x: 0, y: 0, z: 1 });
  assert.deepEqual(a, { id: 'w-1', side: 1, along: 1.5, up: 1.4 });
  assert.equal(wallAnchor(WALL, { x: 1.5, y: 1.4, z: -0.1 }, { x: 0, y: 0, z: -1 }).side, -1, 'the other face');
  assert.equal(wallAnchor(WALL, { x: 1.5, y: 0, z: 0.5 }, { x: 0, y: 1, z: 0 }), null, 'a floor is not a wall face');
  assert.equal(wallAnchor(WALL, { x: 1.5, y: 1, z: 0.6 }, { x: 0, y: 0, z: 1 }), null, 'too far off the face');
  const pin = { x: 1.5, y: 1.4, z: 0.1, nx: 0, ny: 0, nz: 1, wall: a };
  const moved = [{ ...WALL, ay: 0.5, by: 0.5 }];   // the wall moves 0.5 m along +z
  const at = resolvePin(pin, moved);
  close(at.point.z, 0.6); close(at.point.x, 1.5); close(at.point.y, 1.4); assert.equal(at.onWall, true);
  const shorter = [{ ...WALL, bx: 1 }];
  close(resolvePin(pin, shorter).point.x, 1, 1e-9, 'clamped to a shortened wall');
  const gone = resolvePin(pin, []);
  close(gone.point.z, 0.1); assert.equal(gone.onWall, false, 'without its wall it stays where it was');
});

test('sheets lie flat: upright on walls, turned on floors, sized as prints or at true size', () => {
  const w = sheetAxes({ x: 0, y: 0, z: 1 }, 0);
  assert.deepEqual([w.right.x, w.up.y], [1, 1]);
  const turned = sheetAxes({ x: 0, y: 0, z: 1 }, 1);
  close(Math.abs(turned.up.x), 1); close(turned.up.y, 0);
  const floor = sheetAxes({ x: 0, y: 1, z: 0 }, 90);
  close(floor.up.x, -1); close(floor.up.y, 0);
  const photo = { kind: 'photo', w: 4032, h: 3024, pin: {} };
  close(sheetSize(photo).w, DEFAULT_PRINT); close(sheetSize(photo).h, DEFAULT_PRINT * 3 / 4);
  const portrait = { kind: 'photo', w: 3024, h: 4032, pin: { size: 0.508 } };
  close(sheetSize(portrait).h, 0.508);
  const letter = { kind: 'document', w: 850, h: 1100, sheetW: pointsToMetres(612), sheetH: pointsToMetres(792), pin: {} };
  close(sheetSize(letter).w, 0.2159, 1e-9); close(sheetSize(letter).h, 0.2794, 1e-9);
  close(sheetSize({ ...letter, pin: { size: 2 } }).h, 0.5588, 1e-9);
  const place = sheetPlacement({ ...photo, pin: { x: 1, y: 1.5, z: 0.1, nx: 0, ny: 0, nz: 1, wall: { id: 'w-1', side: 1, along: 1, up: 1.5 } } }, [WALL]);
  assert.ok(place.centre.z > 0.1 && place.centre.z < 0.11, 'a hair proud of the face');
  const v = viewForSheet(place, 50, 16 / 9);
  assert.ok(v.position[2] > 0.4, 'the reading view stands in front of the sheet');
});

// A minimal JPEG: SOI, an APP1 Exif block with the tags a phone writes, EOI.
function syntheticJpeg({ f35 = 14, focal = [222, 100], orientation = 6, when = '2026:10:30 11:39:27', offset = '-04:00', subsec = '187', le = true } = {}) {
  const entries0 = [[0x010f, 2, 'Apple'], [0x0112, 3, orientation], [0x8769, 4, 0]];
  const entriesE = [[0x920a, 5, focal], [0xa405, 3, f35], [0x9003, 2, when], [0x9011, 2, offset], [0x9291, 2, subsec], [0xa002, 4, 5712], [0xa003, 4, 4284], [0xa434, 2, 'iPhone back camera 2.22mm f/2.2']];
  const buf = new Uint8Array(1024), dv = new DataView(buf.buffer);
  const w16 = (o, v) => dv.setUint16(o, v, le), w32 = (o, v) => dv.setUint32(o, v, le);
  buf.set(le ? [0x49, 0x49] : [0x4d, 0x4d]); w16(2, 42); w32(4, 8);
  let extra = 400;
  const writeIfd = (at, entries) => {
    w16(at, entries.length);
    entries.forEach(([tag, type, val], i) => {
      const e = at + 2 + i * 12; w16(e, tag); w16(e + 2, type);
      if (type === 2) { const bytes = [...new TextEncoder().encode(val), 0]; w32(e + 4, bytes.length); if (bytes.length <= 4) buf.set(bytes, e + 8); else { w32(e + 8, extra); buf.set(bytes, extra); extra += bytes.length + 1; } }
      else if (type === 3) { w32(e + 4, 1); w16(e + 8, val); }
      else if (type === 4) { w32(e + 4, 1); w32(e + 8, val); }
      else if (type === 5) { w32(e + 4, 1); w32(e + 8, extra); w32(extra, val[0]); w32(extra + 4, val[1]); extra += 8; }
    });
    w32(at + 2 + entries.length * 12, 0);
  };
  const exifAt = 8 + 2 + entries0.length * 12 + 4;
  entries0[2][2] = exifAt;
  writeIfd(8, entries0); writeIfd(exifAt, entriesE);
  const tiff = buf.slice(0, extra);
  const app1 = new Uint8Array(4 + 6 + tiff.length);
  app1.set([0xff, 0xe1, (app1.length - 2) >> 8, (app1.length - 2) & 255]); app1.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4); app1.set(tiff, 10);
  return new Uint8Array([0xff, 0xd8, ...app1, 0xff, 0xd9]);
}

test('the lens and time come out of the photo file; a 14 mm-equivalent iPhone photo is about 102 degrees wide', () => {
  for (const le of [true, false]) {
    const e = readExif(syntheticJpeg({ le }));
    assert.equal(e.make, 'Apple'); assert.equal(e.orientation, 6); assert.equal(e.focal35, 14);
    close(e.focalLength, 2.22); assert.equal(e.pixelW, 5712); assert.equal(e.lensModel, 'iPhone back camera 2.22mm f/2.2');
    assert.equal(e.takenAt, '2026-10-30T11:39:27.187-04:00');
    close(takenAtMs(e.takenAt), Date.parse('2026-10-30T15:39:27.187Z'));
  }
  const lens = lensFromExif({ focal35: 14 }, 5712, 4284);
  close(lens.hfov, 102.1, 0.2); close(lens.cx, 2856);
  const main = lensFromExif({ focal35: 24 }, 4032, 3024);
  close(main.hfov, 71.6, 0.2, 'the main camera');
  const portrait = lensFromExif({ focal35: 24 }, 3024, 4032);
  close(portrait.vfov, main.hfov, 1e-9, 'held upright, the long side is vertical');
  assert.equal(readExif(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), null);
  assert.equal(lensFromExif({ focalLength: 5.1 }, 100, 100), null, 'no 35 mm equivalent, no lens');
});

test('four clicked point pairs recover the camera that took the photo', () => {
  const lens = lensFromHfov(70, 4000, 3000);
  const truth = lookAtPose([1.2, 1.55, 3.4], [2.6, 1.1, 0.2], 3);
  const world = [[0, 0, 0], [4, 0, 0], [4, 2.4, 0], [0, 2.4, 0], [3.2, 0.9, 0.6], [1, 0, 1.5]];
  const pairs = world.map(w => ({ img: project(truth, lens, w), world: w }));
  assert.ok(pairs.every(p => p.img), 'all in front of the camera');
  const rough = lookAtPose([1.6, 1.3, 3.9], [2.2, 1.3, 0], 0);   // lined up roughly by eye
  const fit = solvePose(pairs.slice(0, 4), lens, rough);
  assert.ok(fit.rmsPx < 0.05, 'rms ' + fit.rmsPx);
  for (let k = 0; k < 3; k++) close(fit.pose.C[k], truth.C[k], 1e-3, 'position');
  const v = viewFromPose(fit.pose, 70);
  close(v.roll, 3, 0.01, 'roll comes back');
  const again = poseFromView(v);
  for (let k = 0; k < 9; k++) close(again.R[k], truth.R[k], 1e-4, 'rotation');
  // With five pairs or more the focal length can be fitted too.
  const wrong = { ...lens, fx: lens.fx * 0.8, fy: lens.fy * 0.8 };
  const f2 = solvePose(pairs, wrong, rough, { solveFocal: true });
  close(f2.lens.fx, lens.fx, 1, 'focal'); assert.ok(f2.rmsPx < 0.05);
  // Noisy clicks still land within a few centimetres, and the error is reported per pair.
  const noisy = pairs.map((p, i) => ({ ...p, img: [p.img[0] + (i % 2 ? 2 : -2), p.img[1] + (i % 3 ? 1.5 : -1.5)] }));
  const f3 = solvePose(noisy, lens, rough);
  assert.ok(f3.rmsPx > 0.5 && f3.rmsPx < 4); assert.equal(f3.errors.length, 6);
  assert.ok(Math.hypot(...f3.pose.C.map((c, k) => c - truth.C[k])) < 0.05);
  assert.equal(solvePose(pairs.slice(0, 3), lens, rough), null, 'three pairs are not enough');
  const m = [...truth.R.slice(0, 3), truth.C[0], ...truth.R.slice(3, 6), truth.C[1], ...truth.R.slice(6, 9), truth.C[2], 0, 0, 0, 1];
  close(poseFromMatrix(m).C[2], 3.4);
});

function pngGrey16(w, h, value) {
  const raw = Buffer.alloc(h * (1 + w * 2));
  for (let y = 0; y < h; y++) { raw[y * (1 + w * 2)] = y % 2 ? 2 : 0; for (let x = 0; x < w; x++) { const v = value(x, y); const o = y * (1 + w * 2) + 1 + x * 2; raw.writeUInt16BE(v, o); } }
  // Undo the "Up" filter on odd rows by storing differences.
  for (let y = h - 1; y >= 1; y--) if (y % 2) for (let i = 1; i <= w * 2; i++) raw[y * (1 + w * 2) + i] = (raw[y * (1 + w * 2) + i] - raw[(y - 1) * (1 + w * 2) + i]) & 255;
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 16; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const camJson = (pose, extra) => Object.assign({ fx: 400, fy: 400, cx: 160, cy: 120, width: 320, height: 240, tracking_segment: 0, blur_score: 0.4,
  exif: { DateTimeOriginal: '2026:10:30 11:32:37', SubsecTimeOriginal: '187', OffsetTimeOriginal: '-04:00' } },
  Object.fromEntries([0, 1, 2].flatMap(i => [0, 1, 2, 3].map(j => ['t_' + i + j, pose[i * 4 + j]]))), extra);

test('Polycam keyframes keep their camera and time; depth maps decode to points on the surface', async () => {
  const pose = [1, 0, 0, 0.5, 0, 1, 0, 1.2, 0, 0, 1, 2];   // at (0.5, 1.2, 2), looking down -z
  const row = keyframeRow(camJson(pose), 'kf-1');
  assert.equal(row[KF.stem], 'kf-1'); assert.equal(row[KF.t], Date.parse('2026-10-30T15:32:37.187Z'));
  assert.equal(keyframeRow({ fx: 1 }, 'x'), null);
  const png = pngGrey16(16, 12, () => 2000);   // everything 2 m away: the plane z = 0
  const depth = await decodePng16(png);
  assert.equal(depth.w, 16); assert.equal(depth.data[5 * 16 + 7], 2000);
  const pts = depthPoints(row, depth, null, 1);
  assert.equal(pts.length, 16 * 12);
  for (const p of pts) close(p[2], 0, 1e-9);
  const set = { keyframes: [row], sessions: { 0: { matrix: yawMatrix(90, [1, 0, 0]) } } };
  const cam = keyframeModelPose(set, row);
  close(cam.C[0], 1 + 2, 1e-9); close(cam.C[2], -0.5, 1e-9);   // yaw 90 takes (0.5, -, 2) to (2, -, -0.5)
  assert.equal(nearestKeyframe(set, Date.parse('2026-10-30T15:39:27Z')).row, row);
  assert.equal(nearestKeyframe(set, Date.parse('2026-10-31T15:39:27Z')), null, 'a day apart is too far');
  assert.equal(sharpKeyframes({ keyframes: [row, keyframeRow(camJson(pose, { blur_score: 0.9 }), 'kf-2')] }, 10)[0][KF.stem], 'kf-2', 'the higher blur score is the sharper frame');
});

test('a scan session is lined up with the model even when it starts metres away and turned', () => {
  // The model: an L-shaped room (two long walls, a short wall and the floor), sampled densely.
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const model = [];   // scattered samples, as a scan's surface is, not a regular lattice
  for (let i = 0; i < 12000; i++) { const x = rnd() * 6, y = rnd() * 2.4; model.push([x, y, 0], [x, y, 3]); }
  for (let i = 0; i < 6000; i++) model.push([0, rnd() * 2.4, rnd() * 3]);
  for (let i = 0; i < 8000; i++) model.push([2 + rnd() * 4, 0, 1 + rnd() * 2]);
  // The session saw part of it, in its own frame: the inverse of yaw 140 and a 7.7 m shift.
  const truth = yawMatrix(140, [7.7, 0.3, -2.1]);
  const inv = yawMatrix(-140, [0, 0, 0]);
  const seen = model.filter((p, i) => i % 3 === 0 && p[0] < 4.5).map(p => p.map(v => v + (rnd() - 0.5) * 0.01)).map(p => {
    const q = [p[0] - truth[3], p[1] - truth[7], p[2] - truth[11]];
    return [inv[0] * q[0] + inv[2] * q[2], q[1], inv[8] * q[0] + inv[10] * q[2]];
  });
  const r = alignSession(seen, model, null, { step: 0.4 });
  assert.ok(r.inliers > 0.9, 'inliers ' + r.inliers);
  assert.ok(r.fitM < 0.02, 'fit ' + r.fitM);
  for (const k of [0, 2, 8, 10, 3, 7, 11]) close(r.matrix[k], truth[k], 0.02, 'matrix ' + k);
});

test('numbered positions: numbers are never reused, pictures group by role and date', () => {
  const p = { photos: [] };
  const view = { position: [1, 1.5, 4], target: [1, 1.2, 0], fov: 70 };
  const before = { id: 'ph-a', w: 4032, h: 3024, createdAt: '2026-10-30T15:00:00Z' };
  p.photos.push(before);
  const one = addPosition(p, { id: 'pos-1', view, name: 'Kitchen', fromPhoto: before, now: new Date('2026-11-03T12:00:00Z') });
  const two = addPosition(p, { id: 'pos-2', view });
  assert.deepEqual([one.number, two.number], [1, 2]);
  assert.equal(before.role, 'before'); assert.equal(before.positionId, 'pos-1');
  removePosition(p, 'pos-2');
  assert.equal(addPosition(p, { id: 'pos-3', view }).number, 3, 'number 2 is not given again');
  p.photos.push({ id: 'r1', positionId: 'pos-1', role: 'rendering', renderedAt: '2026-11-04T10:00:00Z' }, { id: 'r0', positionId: 'pos-1', role: 'rendering', renderedAt: '2026-11-03T10:00:00Z' });
  const pics = picturesOf(p, 'pos-1');
  assert.deepEqual(pics.rendering.map(x => x.id), ['r0', 'r1']); assert.equal(pics.before[0].id, 'ph-a');
  assert.equal(renderingName(one, new Date('2026-11-03T12:00:00Z')), 'Position 1 · Kitchen · rendering 2026-11-03');
  assert.deepEqual(renderSize(p, one, 2400), { width: 2400, height: 1800 });
  const dup = { photoPositions: [{ id: 'a', number: 4, view }, { id: 'b', number: 4, view }, { id: 'c', number: 'x', view }], positionCounter: 2, photos: [] };
  normalizePositions(dup);
  assert.deepEqual(dup.photoPositions.map(x => x.id), ['a']); assert.equal(dup.positionCounter, 4);
});

test('documents, wall places, lenses, positions and camera sets survive the file and a reopen', () => {
  const p = store.propertyTemplate('Synthetic pins');
  assert.deepEqual([p.photoPositions, p.positionCounter, p.cameraSets], [[], 0, []]);
  const pin = { x: 1, y: 1.4, z: 0.1, nx: 0, ny: 0, nz: 1, size: 0.5, wall: { id: 'w-1', side: 1, along: 1, up: 1.4 } };
  p.photos.push({ id: 'ph-doc', name: 'Range spec sheet.pdf', kind: 'document', mime: 'application/pdf', w: 850, h: 1100, sheetW: 0.2159, sheetH: 0.2794, page: 1, pageCount: 4, thumb: '', createdAt: '2026-11-03T00:00:00Z', pin },
    { id: 'ph-photo', name: 'IMG_1.jpeg', kind: 'photo', w: 5712, h: 4284, thumb: '', takenAt: '2026-10-30T11:39:27.187-04:00',
      lens: lensFromExif({ focal35: 14 }, 5712, 4284), view: { position: [1, 1.5, 4], target: [1, 1.2, 0], fov: 102, from: 'points', roll: 2.5, fit: { rmsPx: 3.2, n: 5 }, pairs: [{ img: [1, 2], world: [0, 0, 0] }] }, pin: { ...pin, wall: { id: 'w-1', along: 'x' } } });
  p.photoPositions.push({ id: 'pos-x', number: 3, name: 'Kitchen', view: { position: [1, 1.5, 4], target: [1, 1.2, 0], fov: 70 } });
  p.cameraSets.push({ id: 'cams-x', name: 'Polycam', keyframes: [keyframeRow(camJson([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]), 'kf'), ['bad']], sessions: { 0: { matrix: yawMatrix(0, [0, 0, 0]), method: 'search', inliers: 0.95, fitM: 0.012 }, 1: { matrix: [1] } } });
  store.ws.data = store.emptyWorkspace();
  const ids = store.mergeWorkspace(JSON.parse(JSON.stringify({ properties: [p], materials: [], products: [], projects: [] })), { fromFile: true });
  const got = store.ws.data.properties.find(x => x.id === ids[0]);
  const doc = got.photos.find(x => x.id === 'ph-doc'), ph = got.photos.find(x => x.id === 'ph-photo');
  assert.equal(doc.kind, 'document'); assert.deepEqual(doc.pin.wall, pin.wall);
  assert.ok(!('wall' in ph.pin), 'a broken wall place is dropped, the pin kept');
  assert.equal(ph.view.from, 'points'); assert.equal(ph.view.roll, 2.5); assert.equal(ph.view.pairs.length, 1); close(ph.lens.hfov, 102.1, 0.2);
  assert.equal(got.photoPositions[0].number, 3); assert.equal(got.positionCounter, 3);
  assert.equal(got.cameraSets[0].keyframes.length, 1, 'malformed keyframe rows are dropped');
  assert.deepEqual(Object.keys(got.cameraSets[0].sessions), ['0']);
  assert.ok(store.listAllFileIds().includes('ph-doc'), 'the document file travels with the project');
  const slice = JSON.parse(JSON.stringify(store.projectSlice(got.id)));
  assert.equal(slice.properties[0].photoPositions[0].id, 'pos-x');
});

test('a pin merges whole: its point and its wall place never mix between two devices', () => {
  const pin = (along, x) => ({ x, y: 1, z: 0.1, nx: 0, ny: 0, nz: 1, wall: { id: 'w-1', side: 1, along, up: 1 } });
  const base = { properties: [{ id: 'p', photos: [{ id: 'a', pin: pin(1, 1) }] }] };
  const local = JSON.parse(JSON.stringify(base)), remote = JSON.parse(JSON.stringify(base));
  local.properties[0].photos[0].pin = pin(2, 2);
  remote.properties[0].photos[0].pin = { ...pin(1, 1), wall: { id: 'w-1', side: 1, along: 3, up: 1 } };
  const m = mergeShared(base, local, remote);
  assert.deepEqual(m.conflicts, ['properties.p.photos.a.pin']);
});
