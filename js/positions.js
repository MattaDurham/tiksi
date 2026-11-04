// Numbered photo positions: a camera fixed in the model, numbered the way drawings number their
// sections, collecting the before photo, renderings of the design from exactly that camera, and
// later the after photo. Pure: no DOM, no three.js.
//
// prop.photoPositions = [{ id, number, name, roomId, view (photo-match.js), createdAt, notes }]
// prop.positionCounter = the highest number ever given, so a number is never reused.
// Pictures are ordinary photo records carrying positionId and role ('before' | 'rendering' | 'after');
// a rendering also carries renderedAt.

import { normalizeView } from './photo-match.js';

export const ROLES = ['before', 'rendering', 'after'];
export const ROLE_LABELS = { before: 'Before', rendering: 'Rendering', after: 'After' };

export function normalizePositions(p) {
  const list = Array.isArray(p.photoPositions) ? p.photoPositions : [];
  const seen = new Set();
  p.photoPositions = [];
  for (const pos of list) {
    if (!pos || typeof pos !== 'object' || typeof pos.id !== 'string') continue;
    const view = normalizeView(pos.view);
    const number = Number.isInteger(Number(pos.number)) && Number(pos.number) > 0 ? Number(pos.number) : null;
    if (!view || !number || seen.has(number)) continue;
    seen.add(number);
    p.photoPositions.push({ id: pos.id, number, name: typeof pos.name === 'string' ? pos.name : '', roomId: typeof pos.roomId === 'string' ? pos.roomId : '',
      view, createdAt: typeof pos.createdAt === 'string' && pos.createdAt ? pos.createdAt : new Date(0).toISOString(), notes: typeof pos.notes === 'string' ? pos.notes : '' });
  }
  p.photoPositions.sort((a, b) => a.number - b.number);
  const top = p.photoPositions.reduce((m, x) => Math.max(m, x.number), 0);
  p.positionCounter = Math.max(top, Number.isInteger(Number(p.positionCounter)) ? Number(p.positionCounter) : 0);
  for (const ph of p.photos || []) {
    if (ph.positionId !== undefined && (typeof ph.positionId !== 'string' || !ph.positionId)) delete ph.positionId;
    if (ph.role !== undefined && !ROLES.includes(ph.role)) delete ph.role;
    if (ph.positionId && !ph.role) ph.role = 'before';
  }
  return p;
}

// Add a numbered position at `view`. Returns the new record.
export function addPosition(p, { id, view, name = '', roomId = '', fromPhoto = null, now = new Date() }) {
  const v = normalizeView(view);
  if (!v) throw new Error('A numbered position needs a camera view.');
  normalizePositions(p);
  const number = p.positionCounter + 1;
  p.positionCounter = number;
  const pos = { id, number, name, roomId, view: v, createdAt: now.toISOString(), notes: '' };
  p.photoPositions.push(pos);
  if (fromPhoto) { fromPhoto.positionId = id; fromPhoto.role = 'before'; }
  return pos;
}

// Remove a position; its pictures stay in the photo library without it.
export function removePosition(p, id) {
  p.photoPositions = (p.photoPositions || []).filter(x => x.id !== id);
  for (const ph of p.photos || []) if (ph.positionId === id) { delete ph.positionId; delete ph.role; }
}

// The pictures of a position by role, oldest first: { before: [], rendering: [], after: [] }.
export function picturesOf(p, posId) {
  const out = { before: [], rendering: [], after: [] };
  for (const ph of p.photos || []) if (ph.positionId === posId && out[ph.role]) out[ph.role].push(ph);
  const when = ph => Date.parse(ph.renderedAt || ph.takenAt || ph.createdAt) || 0;
  for (const k of ROLES) out[k].sort((a, b) => when(a) - when(b));
  return out;
}

export function positionLabel(pos) { return String(pos.number) + (pos.name ? ' · ' + pos.name : ''); }

// File name for a rendering made at a position on a date: "Position 3 · Kitchen · rendering 2026-11-03".
export function renderingName(pos, date) {
  const d = date instanceof Date ? date : new Date(date);
  const day = Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : '';
  return 'Position ' + pos.number + (pos.name ? ' · ' + pos.name : '') + ' · rendering ' + day;
}

// The size to render a position at: the before photo's aspect, `longEdge` pixels on the long side.
export function renderSize(p, pos, longEdge = 2400) {
  const before = picturesOf(p, pos.id).before[0];
  const aspect = before && before.w > 0 && before.h > 0 ? before.w / before.h : 4 / 3;
  return aspect >= 1 ? { width: longEdge, height: Math.round(longEdge / aspect) } : { width: Math.round(longEdge * aspect), height: longEdge };
}
