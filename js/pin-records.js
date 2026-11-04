// Cleaning of the stored records behind pinned sheets, photo lenses and Polycam camera sets, for
// files opened from disk, other devices and older versions. Pure.

import { KF } from './polycam-cameras.js';

const num = v => (typeof v === 'number' || (typeof v === 'string' && v.trim())) ? Number(v) : NaN;
const fin = v => Number.isFinite(num(v));

export function normalizeWallAnchor(a) {
  if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !a.id) return null;
  if (!fin(a.along) || !fin(a.up)) return null;
  return { id: a.id, side: num(a.side) < 0 ? -1 : 1, along: num(a.along), up: num(a.up) };
}

// A pin: { x, y, z, nx, ny, nz, size, turn?, wall? } or null.
export function normalizePin(pin) {
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) return null;
  if (!['x', 'y', 'z'].every(k => fin(pin[k]))) return null;
  const out = { x: num(pin.x), y: num(pin.y), z: num(pin.z),
    nx: fin(pin.nx) ? num(pin.nx) : 0, ny: fin(pin.ny) ? num(pin.ny) : 1, nz: fin(pin.nz) ? num(pin.nz) : 0 };
  if (fin(pin.size) && num(pin.size) > 0) out.size = num(pin.size);
  if (fin(pin.turn)) out.turn = num(pin.turn);
  const wall = normalizeWallAnchor(pin.wall);
  if (wall) out.wall = wall;
  return out;
}

// A lens read from a photo file: { fx, fy, cx, cy, w, h, hfov, vfov, f35?, source } or null.
export function normalizeLens(l) {
  if (!l || typeof l !== 'object') return null;
  const keys = ['fx', 'fy', 'cx', 'cy', 'w', 'h', 'hfov', 'vfov'];
  if (!keys.every(k => fin(l[k])) || !(num(l.fx) > 0) || !(num(l.w) > 0) || !(num(l.h) > 0)) return null;
  const out = Object.fromEntries(keys.map(k => [k, num(l[k])]));
  if (fin(l.f35)) out.f35 = num(l.f35);
  out.source = typeof l.source === 'string' ? l.source : 'exif';
  return out;
}

// Camera sets: drop malformed keyframe rows and session matrices; keep the rest.
export function normalizeCameraSets(sets) {
  if (!Array.isArray(sets)) return [];
  const out = [];
  for (const s of sets) {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string') continue;
    const keyframes = (Array.isArray(s.keyframes) ? s.keyframes : []).filter(r => Array.isArray(r) && r.length === KF.pose + 12
      && typeof r[KF.stem] === 'string' && r.slice(KF.fx, KF.h + 1).every(Number.isFinite) && r.slice(KF.pose).every(Number.isFinite));
    const sessions = {};
    for (const [k, v] of Object.entries(s.sessions && typeof s.sessions === 'object' ? s.sessions : {})) {
      if (!v || !Array.isArray(v.matrix) || v.matrix.length !== 16 || !v.matrix.every(Number.isFinite)) continue;
      sessions[k] = { matrix: v.matrix.slice(), method: typeof v.method === 'string' ? v.method : '',
        inliers: fin(v.inliers) ? num(v.inliers) : null, fitM: fin(v.fitM) ? num(v.fitM) : null };
    }
    out.push({ id: s.id, name: typeof s.name === 'string' && s.name ? s.name : 'Polycam cameras', source: 'polycam',
      importedAt: typeof s.importedAt === 'string' ? s.importedAt : new Date(0).toISOString(), folder: typeof s.folder === 'string' ? s.folder : '',
      sessions, keyframes });
  }
  return out;
}
