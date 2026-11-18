// Wall trim designed a room at a time: one change to a height, a box width, a gap or a margin
// goes to every section it belongs to, and each wall refits its own boxes.
//
// A trim record (trims.js) is one section on one wall face. This module is the layer above the
// records: which sections change together (the scope), and how one change becomes a change to
// each of them. Pure functions, no three.js and no workspace state: MODEL (viewer3d.js) and its
// panel (trim-panel.js) call them, and tests do.
//
// The rules, each from finish-carpentry practice:
//   shared height lines   Rails and field edges round a room sit on a few lines, as a story pole
//                         carries them. Moving one line moves everything on it: the same kind of
//                         trim near the same height moves by the same amount, and whatever
//                         touches a moving piece follows it (the field under a chair rail
//                         stretches, the cap on top rides along). Trim standing on the floor
//                         stays on the floor; crown stays at the ceiling.
//   one gap, own widths   The gap between boxes and the margins round them are the same on
//                         every wall; the box width is not. Each stretch of wall (between doors,
//                         windows and corners) takes the whole number of equal boxes that comes
//                         closest to the width aimed for: n = round((w + gap) / (aim + gap)).
//                         So a smaller aim shrinks every box until another one fits, and a wider
//                         gap narrows every box by its share.
//   leave slivers plain   A stretch too narrow for a box worth making is left as wall.
//
// Scopes, narrowest first: the sections selected; their group (a subproject's group of pieces,
// or else the same trim at the same height round the room); the whole room; the whole project
// (the project the sections belong to, or every section that belongs to none).

import { wallEnds } from './wall-joins.js';
import { roomFaces } from './room-faces.js';
import { trimLayout, trimStyle, trimProduct } from './trims.js';
import { groupOf, topProjectId } from './project-pieces.js';

export const TRIM_SCOPES = ['selected', 'group', 'room', 'project'];
export const SCOPE_LABELS = { selected: 'SELECTED', group: 'GROUP', room: 'ROOM', project: 'PROJECT' };

const IN = 0.0254;
const BAND = 0.16;         // m: the same kind of trim within this of a height is on "the same line" in another room
const TOUCH = 0.012;       // m: edges this close meet, and move together
const FLOOR = 0.003;       // m: an edge this close to the floor stands on it
const MIN_FIELD = 0.08;    // m: as trims.js, a field is never squeezed below this
export const LIMITS = {
  aim: [4 * IN, 120 * IN],        // the box width aimed for
  gap: [0.5 * IN, 18 * IN],
  margin: [0, 24 * IN],
};
// What the trade's own guides give as usual: used for the panel's notes, never enforced.
export const PRACTICE = {
  gap: [2.75 * IN, 6 * IN],       // Metrie 2 3/4 to 4 in; JLC 3 in; up to 6 in under 10 ft ceilings
  box: [12 * IN, 36 * IN],        // boxes narrower or wider than this are unusual
  split: 50 * IN,                 // a box wider than this is usually made two
  skinny: 8 * IN,                 // a box under this is usually left out
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r4 = v => Math.round(v * 10000) / 10000;

// The design numbers of a field as it is drawn, defaults filled in; null for a run or crown.
export function designValues(t) {
  const s = trimStyle(t), p = trimProduct(t);
  if (!s || s.kind !== 'field') return null;
  const frame = t.style === 'picture-frame';
  const sides = frame ? (t.inset != null ? t.inset : .09) : null;
  return {
    frame, preset: frame && !!t.frameLayout, boxes: !!s.boxes, bays: !!s.bays, planks: !!s.planks,
    aim: s.boxes ? (t.target != null ? t.target : .76) : s.bays ? (t.spacing || (t.style === 'grid' ? null : (p && p.spacing) || .45)) : null,
    aimSet: s.boxes ? t.target != null : s.bays ? t.spacing != null : false,
    gap: frame ? (t.gap != null ? t.gap : .1) : null,
    sides, top: frame ? (t.insetTop != null ? t.insetTop : sides) : null, bottom: frame ? (t.insetBottom != null ? t.insetBottom : sides) : null,
    rows: t.rows || 1, minBox: frame ? t.minBox : null,
    pinned: t.cols != null || !!t.colsAt || !!t.widths,
  };
}

// Set one design number on one record. False when it means nothing for this kind of trim.
//   aim     the box (or bay) width to aim for; the count goes back to fitting
//   gap     between boxes;  margin  all four margins;  reveal  the gap and every margin together
//   sides, top, bottom  one margin, the others kept as drawn
//   rows, minBox, fit (counts and widths back to fitting)
export function setDesignParam(t, key, v) {
  const d = designValues(t);
  if (!d) return false;
  const margin = x => r4(clamp(x, ...LIMITS.margin));
  // Top and bottom are stored only where they differ from the sides.
  const margins = (sides, top, bottom) => { t.inset = sides; t.insetTop = Math.abs(top - sides) < 1e-5 ? null : top; t.insetBottom = Math.abs(bottom - sides) < 1e-5 ? null : bottom; };
  switch (key) {
    case 'aim':
      if (!d.boxes && !d.bays) return false;
      if (v == null) { if (d.boxes) t.target = null; else t.spacing = null; }
      else if (d.boxes) t.target = r4(clamp(v, ...LIMITS.aim));
      else t.spacing = r4(clamp(v, ...LIMITS.aim));
      t.cols = null; t.colsAt = null; t.widths = null;
      return true;
    case 'gap': if (!d.frame) return false; t.gap = r4(clamp(v, ...LIMITS.gap)); return true;
    case 'margin': if (!d.frame) return false; margins(margin(v), margin(v), margin(v)); return true;
    case 'reveal': if (!d.frame) return false; t.gap = r4(clamp(v, ...LIMITS.gap)); margins(t.gap, t.gap, t.gap); return true;
    case 'sides': if (!d.frame) return false; margins(margin(v), d.top, d.bottom); return true;
    case 'top': if (!d.frame) return false; margins(d.sides, margin(v), d.bottom); return true;
    case 'bottom': if (!d.frame) return false; margins(d.sides, d.top, margin(v)); return true;
    case 'rows':
      if (!d.boxes && t.style !== 'grid') return false;
      t.rows = clamp(Math.round(v) || 1, 1, 12); t.heights = null; return true;
    case 'minBox': if (!d.frame) return false; t.minBox = v > 0 ? r4(clamp(v, 0, 2)) : null; return true;
    case 'fit':
      if (!d.boxes && !d.bays) return false;
      t.cols = null; t.colsAt = null; t.widths = null; t.heights = null; return true;
    default: return false;
  }
}

// env: { prop, projects, levelOf(wall) -> level id, wallsOn(levelId), roomsOn(levelId),
//        openingsOn(levelId), heightOf(wall) }. One context serves one gesture or one panel
// render: it remembers each level's room faces and each section's wall.
export function trimDesign(env) {
  const prop = env.prop, projects = env.projects || [];
  const walls = new Map((prop.walls || []).map(w => [w.id, w]));
  const facesBy = new Map(), infoBy = new Map();
  const facesOn = lvl => {
    if (!facesBy.has(lvl)) facesBy.set(lvl, roomFaces({ walls: env.wallsOn(lvl), rooms: env.roomsOn(lvl), openings: env.openingsOn(lvl), heightOf: env.heightOf }));
    return facesBy.get(lvl);
  };
  const byId = id => (prop.trims || []).find(t => t.id === id) || null;

  // Where a section stands: its wall, the face's own ends along it (corners shorten or lengthen
  // a face), and the room it looks into.
  function info(t) {
    if (!t) return null;
    const key = t.id + '|' + t.wallId + '|' + t.side + '|' + t.f0 + '|' + t.f1;
    if (infoBy.has(key)) return infoBy.get(key);
    const wall = walls.get(t.wallId);
    let out = null;
    if (wall) {
      const level = env.levelOf(wall), L = Math.hypot(wall.bx - wall.ax, wall.by - wall.ay), H = env.heightOf(wall);
      const e = wallEnds(wall, env.wallsOn(level), 0);
      const x0 = t.side > 0 ? e.a.pos : e.a.neg, x1 = t.side > 0 ? e.b.pos : e.b.neg;
      // The face with most of the section on it.
      const a = t.f0 * L, b = t.f1 * L;
      let face = null, best = 0;
      for (const f of facesOn(level)) for (const p of f.parts) {
        if (p.wallId !== t.wallId || p.side !== t.side) continue;
        const over = Math.min(b, p.s1) - Math.max(a, p.s0);
        if (over > best) { best = over; face = f; }
      }
      const room = face && face.roomId ? env.roomsOn(level).find(r => r.id === face.roomId) : null;
      out = { wall, level, L, H, x0, x1, face, roomId: room ? room.id : null,
        roomKey: level + '|' + (face ? face.roomId || face.kind : 'none'),
        roomName: room ? room.name || 'Room' : face && face.kind === 'outside' ? 'Outside' : 'No room' };
    }
    infoBy.set(key, out);
    return out;
  }
  // The section's layout exactly as it is drawn (trim-mesh.js gives the same face ends).
  function layout(t) {
    const i = info(t);
    if (!i) return { parts: [], rects: [], boxes: [], cols: 0, L: 0, H: 0 };
    return trimLayout(t, i.wall, env.openingsOn(i.level), { H: i.H, x0: i.x0, x1: i.x1 });
  }

  const edges = t => {
    const s = trimStyle(t), p = trimProduct(t);
    if (!s || s.kind === 'crown') return null;
    return s.kind === 'field' ? { y0: t.y, y1: t.y + t.h, rigid: false } : { y0: t.y, y1: t.y + (p ? p.W : .05), rigid: true };
  };
  function sameBand(a, b) {
    const ea = edges(a), eb = edges(b);
    if (!ea || !eb) return !ea && !eb;
    return Math.abs(ea.y0 - eb.y0) < BAND && (ea.rigid || Math.abs(ea.y1 - eb.y1) < BAND);
  }
  const roomKey = t => { const i = info(t); return i ? i.roomKey : ''; };
  const top = t => topProjectId(projects, t.projectId || '') || '';

  // Every section a change may touch at this scope, whatever its kind.
  function pool(seedIds, scope) {
    const all = prop.trims || [];
    const seeds = seedIds.map(byId).filter(Boolean);
    if (scope === 'selected' || !seeds.length) return seeds;
    const out = new Set(seeds);
    if (scope === 'room') {
      const rooms = new Set(seeds.map(roomKey));
      for (const t of all) if (rooms.has(roomKey(t))) out.add(t);
    } else if (scope === 'project') {
      const tops = new Set(seeds.map(top));
      for (const t of all) if (tops.has(top(t))) out.add(t);
    } else {
      for (const seed of seeds) {
        const g = groupOf(projects, seed);
        for (const t of all) {
          if (g ? t.projectId === g.id : t.style === seed.style && roomKey(t) === roomKey(seed) && sameBand(t, seed)) out.add(t);
        }
      }
    }
    return [...out];
  }
  // The sections a design number goes to: those in the pool of the same kind as a selected one.
  function members(seedIds, scope) {
    const styles = new Set(seedIds.map(byId).filter(Boolean).map(t => t.style));
    return pool(seedIds, scope).filter(t => styles.has(t.style));
  }
  // The sections a moulding picked for `style` goes to: that style across the reach and, at the
  // project's reach (or the sections picked), the other rails and caps on the same line, so the
  // top of the wainscoting is one moulding everywhere (a chair rail in one room, a wainscot cap
  // in the next). Base, crown and fields keep to their own kind.
  function mouldingReach(seedIds, scope, style) {
    const list = members(seedIds, scope).filter(t => t.style === style);
    const group = (trimStyle({ style }) || {}).group;
    if (!lineRule(scope).anyHeight || group !== 'Rails and caps' || !list.length) return list;
    const lines = list.map(t => t.y);
    const more = pool(seedIds, scope).filter(t => t.style !== style && (trimStyle(t) || {}).group === group && lines.some(y => Math.abs(t.y - y) < BAND));
    return [...list, ...more];
  }
  // What each scope covers for this selection, for the panel's buttons.
  function scopes(seedIds) {
    const seeds = seedIds.map(byId).filter(Boolean);
    const rooms = [...new Set(seeds.map(t => (info(t) || {}).roomName).filter(Boolean))];
    const grouped = seeds.map(t => groupOf(projects, t)).filter(Boolean);
    const tops = [...new Set(seeds.map(top))];
    const proj = tops.length === 1 && tops[0] ? projects.find(p => p.id === tops[0]) : null;
    const what = {
      selected: 'Only the sections selected.',
      group: grouped.length ? 'The group these sections are in: ' + [...new Set(grouped.map(g => g.name || 'subproject'))].join(', ') + '.'
        : 'The same trim at the same height round ' + (rooms.length === 1 ? rooms[0] : 'each room') + '.',
      room: 'All the trim in ' + (rooms.length ? rooms.join(', ') : 'the room') + ': the same kind takes the change, and whatever touches a moved height follows it.',
      project: proj ? 'All the trim in the project "' + (proj.name || 'project') + '".' : tops.every(x => !x) ? 'All the trim that belongs to no project, in every room.' : 'All the trim in these sections\' projects.',
    };
    return TRIM_SCOPES.map(id => ({ id, label: SCOPE_LABELS[id], count: members(seedIds, id).length, title: what[id] }));
  }

  // Move a height line. `records` are the sections that may move (the pool, as they were when
  // the drag began), `seedId` the one grabbed and `edge` what was grabbed: 'move' (the whole
  // section), 'top' or 'bottom' (one edge of a field). Returns the change to each record and the
  // distance actually moved once every section is kept inside its wall and no field is crushed.
  // opts.scope: the reach the move is made at (lineRule says what each one does);
  // opts.all: every record moves (several sections picked to move together);
  // opts.align: the seed's kind of trim comes onto the seed's own line, wherever it was;
  // opts.anyHeight: with align, every section of that kind in the records, not only those near it.
  function planLine(records, seedId, edge, dy, opts = {}) {
    const rule = opts.scope ? { ...lineRule(opts.scope, edge), ...opts } : opts;
    const items = [];
    for (const t of records) {
      const e = edges(t), i = info(t);
      if (!e || !i) continue;
      items.push({ t, id: t.id, style: t.style, room: i.roomKey, H: i.H, ...e, lo: false, hi: false, offLo: 0, offHi: 0 });
    }
    const seed = items.find(x => x.id === seedId);
    const none = { patches: new Map(), dy: 0, moved: 0 };
    if (!seed) return none;
    const want = seed.rigid || edge === 'move' ? ['lo', 'hi'] : edge === 'top' ? ['hi'] : ['lo'];
    const at = (it, e) => e === 'lo' ? it.y0 : it.y1;
    const queue = [];
    // Trim standing on the floor stays there unless it is the piece in hand. `off` is how far an
    // edge first moves to reach its line, before the drag's own distance.
    const mark = (it, e, force, off = 0) => {
      if (it.rigid) {
        if (it.lo || (!force && it.y0 <= FLOOR)) return;
        it.lo = it.hi = true; it.offLo = it.offHi = off; queue.push(it); return;
      }
      if (it[e] || (!force && e === 'lo' && it.y0 <= FLOOR)) return;
      it[e] = true; it[e === 'lo' ? 'offLo' : 'offHi'] = off; queue.push(it);
    };
    for (const it of items) {
      const near = want.every(e => Math.abs(at(it, e) - at(seed, e)) < BAND);
      // Across the project a line is also kept by trim of the same family near it: a chair rail
      // in one room and a wainscot cap in the next, or two styles of wainscoting.
      const family = rule.align && rule.anyHeight && near && it.rigid === seed.rigid && (trimStyle(it.t) || {}).group === (trimStyle(seed.t) || {}).group;
      const parallel = (it.style === seed.style && (near || (rule.align && rule.anyHeight))) || family;
      if (it === seed || parallel) for (const e of want) mark(it, e, it === seed, rule.align && it !== seed ? at(seed, e) - at(it, e) : 0);
      else if (rule.all) { mark(it, 'lo', true); mark(it, 'hi', true); }
    }
    // Whatever meets a moving piece in the same room moves with it, by the same amount.
    while (queue.length) {
      const m = queue.pop();
      const spans = m.rigid ? [[m.y0, m.y1, m.offLo]] : [m.lo ? [m.y0, m.y0, m.offLo] : null, m.hi ? [m.y1, m.y1, m.offHi] : null].filter(Boolean);
      for (const o of items) {
        if (o === m || o.room !== m.room) continue;
        for (const [a, b, off] of spans) {
          if (o.rigid) { if (o.y1 >= a - TOUCH && o.y0 <= b + TOUCH) mark(o, 'lo', false, off); continue; }
          if (o.y0 >= a - TOUCH && o.y0 <= b + TOUCH) mark(o, 'lo', false, off);
          if (o.y1 >= a - TOUCH && o.y1 <= b + TOUCH) mark(o, 'hi', false, off);
        }
      }
    }
    // Where each edge ends up for a move of d, and the d every section allows.
    const lo0 = it => it.y0 + (it.lo ? it.offLo : 0), hi0 = it => it.y1 + (it.hi ? it.offHi : 0);
    let lo = -Infinity, hi = Infinity;
    for (const it of items) {
      if (!it.lo && !it.hi) continue;
      if (it.lo) lo = Math.max(lo, -lo0(it));
      if (it.hi) hi = Math.min(hi, it.H - hi0(it));
      if (it.rigid) continue;
      // The field keeps its least height.
      if (it.lo && it.hi) { if (hi0(it) - lo0(it) < MIN_FIELD - 1e-9) { lo = Infinity; } }
      else if (it.hi) lo = Math.max(lo, lo0(it) + MIN_FIELD - hi0(it));
      else hi = Math.min(hi, hi0(it) - MIN_FIELD - lo0(it));
    }
    const d = lo > hi ? 0 : clamp(dy, lo, hi);
    if (lo > hi && items.some(it => (it.lo && it.offLo) || (it.hi && it.offHi))) return none;
    const patches = new Map();
    for (const it of items) {
      // An edge that does not move keeps its exact place.
      const y0 = r4(lo0(it) + d), y1 = r4(hi0(it) + d);
      if (it.lo && it.hi) patches.set(it.id, it.rigid ? { y: y0 } : { y: y0, h: (it.offLo || it.offHi) ? y1 - y0 : it.t.h });
      else if (it.hi) patches.set(it.id, { y: it.y0, h: y1 - it.y0 });
      else if (it.lo) patches.set(it.id, { y: y0, h: it.y1 - y0 });
    }
    return { patches, dy: d, moved: patches.size };
  }

  // Heights worth stopping a line on in this section's room: its window stools.
  function lineStops(t) {
    const i = info(t);
    if (!i) return [];
    const out = new Set();
    for (const f of facesOn(i.level)) {
      if ((f.roomId || f.kind) !== (i.face ? i.face.roomId || i.face.kind : 'none')) continue;
      for (const h of f.openings) {
        if (h.type !== 'window') continue;
        const o = (prop.openings || []).find(x => x.id === h.id);
        if (o && o.sill > 0) out.add(r4(o.sill));
      }
    }
    return [...out].sort((a, b) => a - b);
  }

  // One more or one fewer box in the stretch of wall under `x` (metres along the wall), on this
  // section only. The stretch's count is then set, not fitted. Returns the new count, or null.
  function stepCols(t, x, delta) {
    const d = designValues(t);
    if (!d || d.preset || (!d.boxes && !d.bays)) return null;
    const lay = layout(t);
    const full = lay.rects.filter(r => r.full);
    if (!full.length) return null;
    let fi = full.findIndex(r => x >= r.x0 && x <= r.x1);
    if (fi < 0) fi = full.reduce((m, r, k) => Math.abs((r.x0 + r.x1) / 2 - x) < Math.abs((full[m].x0 + full[m].x1) / 2 - x) ? k : m, 0);
    const ri = lay.rects.indexOf(full[fi]);
    const now = lay.boxes.filter(b => b.rect === ri && b.row === 0).length;
    const next = clamp(now + delta, d.frame ? 0 : 1, 60);
    if (next === now) return null;
    // Every stretch keeps the count it shows now; only this one changes.
    const counts = full.map(r => lay.boxes.filter(b => b.rect === lay.rects.indexOf(r) && b.row === 0).length);
    counts[fi] = next;
    t.colsAt = counts; t.cols = null; t.widths = null;
    return { count: next, was: now, stretch: fi, stretches: full.length };
  }

  // What the boxes of these sections come to: how many, and the range of their widths.
  function summary(records) {
    let boxes = 0, sections = 0, min = Infinity, max = 0, hMin = Infinity, hMax = 0, empty = 0;
    for (const t of records) {
      const d = designValues(t);
      if (!d || (!d.boxes && !d.bays)) continue;
      sections++;
      const lay = layout(t);
      const row = lay.boxes.filter(b => b.row === 0 && lay.rects[b.rect] && lay.rects[b.rect].full);
      for (const b of row) { boxes++; min = Math.min(min, b.x1 - b.x0); max = Math.max(max, b.x1 - b.x0); hMin = Math.min(hMin, b.y1 - b.y0); hMax = Math.max(hMax, b.y1 - b.y0); }
      empty += lay.rects.filter((r, k) => r.full && !lay.boxes.some(b => b.rect === k)).length;
    }
    return boxes ? { sections, boxes, min, max, hMin, hMax, empty } : { sections, boxes: 0, min: 0, max: 0, hMin: 0, hMax: 0, empty };
  }

  // Where these sections leave the trade's usual practice: short notes for the panel. `len`
  // formats a length. Advice only; nothing is changed.
  function notes(records, len) {
    const out = [];
    const frames = records.filter(t => t.style === 'picture-frame');
    // Box widths are a matter for boxes: battens are spaced as closely as the design wants.
    const sum = summary(frames);
    if (sum.boxes) {
      if (sum.min < PRACTICE.skinny - 1e-6) out.push('The narrowest box is ' + len(sum.min) + '. Under ' + len(PRACTICE.skinny) + ' a box is usually left out and the wall kept plain: set LEAVE OUT BOXES NARROWER THAN.');
      if (sum.max > PRACTICE.split + 1e-6) out.push('The widest box is ' + len(sum.max) + '. Over ' + len(PRACTICE.split) + ' a box is usually made two: lower the width to aim for.');
    }
    if (frames.length) {
      const v = frames.map(designValues);
      const gaps = v.map(x => x.gap);
      if (Math.min(...gaps) < PRACTICE.gap[0] - 1e-6 || Math.max(...gaps) > PRACTICE.gap[1] + 1e-6) out.push('Gaps between boxes are usually ' + len(PRACTICE.gap[0]) + ' to ' + len(PRACTICE.gap[1]) + ' (3 in is the commonest).');
      if (v.some(x => Math.abs(x.gap - x.sides) > .002 || Math.abs(x.gap - x.top) > .002 || Math.abs(x.gap - x.bottom) > .002)) out.push('The gap and the margins differ. One reveal all round (the gap, and the margin to the rail, base, corners and casings) is the usual practice: ONE REVEAL ALL ROUND sets them equal.');
    }
    return out;
  }

  return { info, layout, pool, members, mouldingReach, scopes, planLine, lineStops, stepCols, summary, notes, byId };
}

// How a height line moves at each reach. Every section of the grabbed kind comes onto the
// grabbed one's line, so a drag (or a typed height) leaves them all at one height. In a room or a
// group that is the sections near its height (two rails of one kind at different heights stay
// two lines); for the whole project, or the sections picked, it is every one of that kind, and
// trim of the same family near the line (chair rails with a wainscot cap, one style of
// wainscoting with another). Picked sections of other kinds move by the same distance.
export function lineRule(scope, edge) {
  return { align: true, anyHeight: scope === 'project' || scope === 'selected', all: scope === 'selected' && edge === 'move' };
}

// A drag's raw value settles on steps of `step`, and leaves a step only once the pointer is
// clearly past it (three quarters of the way to the next): a count that turns over at that
// step does not flicker while the hand rests on the boundary.
export function stickySnap(raw, last, step) {
  if (last == null || !Number.isFinite(last)) return Math.round(raw / step) * step;
  return Math.abs(raw - last) < step * .75 ? last : Math.round(raw / step) * step;
}
