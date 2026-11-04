// Pinned sheets: photos, documents and notes lie flat on the surface they were pinned to, like a
// print put up by hand. Pure maths, no three.js and no DOM.
//
// photo.pin = { x, y, z, nx, ny, nz, size, turn?, wall? }
//   x, y, z / nx, ny, nz  the point and outward normal in model coordinates (metres, y up). Older
//                         pins have only these, and so does a pin on a floor or a scan surface.
//   wall: { id, side, along, up }  a pin on a wall face: the wall, which face (+1 or -1 along the
//                         wall's normal, see geometry.js wallFrame), the distance along the wall
//                         from its start and the height. When the wall moves the pin moves with it.
//   size                  photos: the print's long side in metres; documents: a scale on their
//                         true size (1 = true size); notes keep their own size.
//   turn                  quarter turns (0-3) within the surface; on a floor it is the yaw in degrees.

export const PRINT_SIZES = [
  { id: '8x10', label: '8 x 10 in', long: 0.254 },
  { id: '11x14', label: '11 x 14 in', long: 0.3556 },
  { id: '16x20', label: '16 x 20 in', long: 0.508 },
  { id: '24x36', label: '24 x 36 in', long: 0.9144 },
  { id: '36x48', label: '36 x 48 in', long: 1.2192 },
];
export const DEFAULT_PRINT = 0.3556;   // 11 x 14 in
export const DOCUMENT_DEFAULT_WIDTH = 0.2159;   // an image document with no page size hangs letter-wide
export const SHEET_GAP = 0.003;   // metres proud of the surface, so it never flickers into the wall

const num = v => (typeof v === 'number' || (typeof v === 'string' && v.trim())) ? Number(v) : NaN;
const fin = v => Number.isFinite(num(v));

function frameOf(w) {
  const L = Math.hypot(w.bx - w.ax, w.by - w.ay), d = L || 1;
  const ux = (w.bx - w.ax) / d, uy = (w.by - w.ay) / d;
  return { L, ux, uy, nx: -uy, ny: ux, h: (w.thickness || 0.114) / 2 };
}

// The wall anchor for a point on (or within a few centimetres of) a wall face, or null when the
// point is not on that wall's face or the surface is not vertical.
export function wallAnchor(wall, point, normal) {
  if (!wall || !point || !normal) return null;
  if (Math.abs(num(normal.y)) > 0.5) return null;
  const f = frameOf(wall);
  if (f.L < 0.01) return null;
  const rx = point.x - wall.ax, rz = point.z - wall.ay;
  const along = rx * f.ux + rz * f.uy, off = rx * f.nx + rz * f.ny;
  if (along < -0.05 || along > f.L + 0.05) return null;
  const dot = normal.x * f.nx + normal.z * f.ny;
  if (Math.abs(dot) < 0.7) return null;   // a wall end or an opening's reveal, not a face
  const side = dot > 0 ? 1 : -1;
  if (Math.abs(off - side * f.h) > 0.06) return null;
  return { id: wall.id, side, along: round(along), up: round(point.y) };
}

// Where a pin is now: its wall face when it has one (and the wall still exists), else its point.
export function resolvePin(pin, walls) {
  if (!pin) return null;
  const a = pin.wall, w = a && (walls || []).find(x => x.id === a.id);
  if (w && fin(a.along) && fin(a.up)) {
    const f = frameOf(w);
    const s = a.side < 0 ? -1 : 1;
    const along = Math.max(0, Math.min(f.L, num(a.along)));
    return {
      point: { x: w.ax + f.ux * along + f.nx * f.h * s, y: num(a.up), z: w.ay + f.uy * along + f.ny * f.h * s },
      normal: { x: f.nx * s, y: 0, z: f.ny * s }, onWall: true,
    };
  }
  if (![pin.x, pin.y, pin.z].every(fin)) return null;
  const n = { x: fin(pin.nx) ? num(pin.nx) : 0, y: fin(pin.ny) ? num(pin.ny) : 1, z: fin(pin.nz) ? num(pin.nz) : 0 };
  const L = Math.hypot(n.x, n.y, n.z) || 1;
  return { point: { x: num(pin.x), y: num(pin.y), z: num(pin.z) }, normal: { x: n.x / L, y: n.y / L, z: n.z / L }, onWall: false };
}

// The sheet's right and up directions on a surface with this normal. On a wall "up" is world up;
// on a floor or ceiling the sheet's top points along the yaw `turnDeg` (0 = toward -z).
export function sheetAxes(normal, turn) {
  const n = norm(normal);
  let up, right;
  if (Math.abs(n.y) < 0.9) {
    up = norm(sub({ x: 0, y: 1, z: 0 }, scale(n, n.y)));
    right = cross(up, n);
    const q = ((Math.round(num(turn)) || 0) % 4 + 4) % 4;
    for (let i = 0; i < q; i++) { const r = right; right = scale(up, -1); up = r; }
  } else {
    const a = (num(turn) || 0) * Math.PI / 180;
    up = norm({ x: -Math.sin(a), y: 0, z: -Math.cos(a) });
    right = cross(up, n);
  }
  return { right: norm(right), up: norm(up), normal: n };
}

// Width and height in metres of a pinned record's sheet.
export function sheetSize(rec) {
  const pin = rec && rec.pin || {};
  const aspect = rec && rec.w > 0 && rec.h > 0 ? rec.w / rec.h : 4 / 3;
  if (rec && rec.kind === 'document') {
    const k = fin(pin.size) && num(pin.size) > 0 ? num(pin.size) : 1;
    const w = fin(rec.sheetW) && rec.sheetW > 0 ? num(rec.sheetW) : DOCUMENT_DEFAULT_WIDTH;
    const h = fin(rec.sheetH) && rec.sheetH > 0 ? num(rec.sheetH) : w / aspect;
    return { w: w * k, h: h * k };
  }
  const long = fin(pin.size) && num(pin.size) > 0 ? num(pin.size) : DEFAULT_PRINT;
  return aspect >= 1 ? { w: long, h: long / aspect } : { w: long * aspect, h: long };
}

// A sheet laid on the surface: its centre (a hair proud of the surface), axes and size. The pin
// point is the sheet's centre.
export function sheetPlacement(rec, walls) {
  const at = resolvePin(rec && rec.pin, walls);
  if (!at) return null;
  const turn = rec.pin.turn;
  const ax = sheetAxes(at.normal, turn);
  let { w, h } = sheetSize(rec);
  if (Math.abs(at.normal.y) < 0.9 && ((Math.round(num(turn)) || 0) % 2)) [w, h] = [h, w];
  return { centre: add(at.point, scale(ax.normal, SHEET_GAP)), ...ax, w, h, onWall: at.onWall };
}

// PDF page size in points (1/72 in) to metres.
export function pointsToMetres(pt) { return num(pt) * 0.0254 / 72; }

// A readable camera for a sheet: straight in front of it, far enough that it fills about
// `fill` of a view with vertical field `vfovDeg` and aspect `aspect`.
export function viewForSheet(place, vfovDeg = 50, aspect = 16 / 9, fill = 0.8) {
  if (!place) return null;
  const t = Math.tan(vfovDeg * Math.PI / 360);
  const dist = Math.max(place.h / (2 * t * fill), place.w / (2 * t * aspect * fill), 0.35);
  const eye = add(place.centre, scale(place.normal, dist));
  return { position: [eye.x, eye.y, eye.z], target: [place.centre.x, place.centre.y, place.centre.z] };
}

function round(v) { return Math.round(v * 1e5) / 1e5; }
function add(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function scale(a, k) { return { x: a.x * k, y: a.y * k, z: a.z * k }; }
function cross(a, b) { return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }; }
function norm(a) { const L = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / L, y: a.y / L, z: a.z / L }; }
