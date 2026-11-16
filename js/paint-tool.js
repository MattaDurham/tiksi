// PAINT, MODEL's paint bucket (B). Choose a finish in the panel, then click the model: the click
// paints the one piece under it, as in paint by numbers.
//
// A piece is:
//   - one region of a wall face (wall-regions.js): the wall above a chair rail, the wall below
//     it, the wall inside a board and batten field, or the whole face when nothing divides it;
//   - one trim section (a baseboard, a rail, a crown, a field of panels on one wall face);
//   - one door or window: its frame, casing and sash, and a door's leaf;
//   - one room's floor, or its ceiling.
// How far one click reaches is the panel's choice, or a held key for one click:
//   ONE PIECE                  the piece under the pointer
//   THE SAME AROUND THE ROOM   (Shift) the pieces like it in the same room that wear the same
//                              finish now: the same band of every wall, all the room's trim
//   THE WHOLE WALL OR GROUP    (Cmd, or the Windows key) a wall face floor to ceiling; a trim
//                              section with the rest of its group, or of its wall face
// Alt-click picks up the finish under the pointer. PAINT THE SELECTED paints what SELECT has
// selected (wall faces, trim, doors and windows, rooms' floors). Every click is one UNDO step.
//
// viewer3d.js owns the scene and hands this module what it needs (`host`); nothing here keeps a
// reference to the scene between calls.

import { ws, touch, materialById, escapeHtml, fmtArea, polyArea, roomsOn, wallsOn, levelOfWall } from './store.js';
import { beginGeometryEdit } from './edit-history.js';
import { addCustomMaterial, materialTitle } from './materials.js';
import { swatchUrl } from './textures.js';
import { paintRegion, paintFace, regionLabel, wallPaint, trimDivides, wallPartFinish } from './wall-regions.js';
import { wallSides, pointInPoly } from './wall-solids.js';
import { trimLabel } from './trims.js';
import { clickGroupIds } from './project-pieces.js';

export const SCOPES = [
  ['piece', 'ONE PIECE', 'The piece under the pointer: the wall above a rail, one trim section, one floor'],
  ['room', 'THE SAME AROUND THE ROOM', 'Shift-click: the pieces like it in the same room that wear the same finish now'],
  ['whole', 'THE WHOLE WALL OR GROUP', 'Cmd-click: the wall face floor to ceiling, or a trim section with the rest of its group'],
];
const FILTERS = [['used', 'IN THIS PROJECT'], ['paint', 'PAINTS'], ['wall', 'WALL'], ['trim', 'TRIM'], ['floor', 'FLOOR'], ['ceiling', 'CEILING'], ['all', 'ALL']];
const AUTO = '';              // "no paint of its own": the piece goes back to its automatic finish
const SWATCH = 96;

export function createPaintTool(host) {
  // material: a library id, AUTO, or null while nothing is chosen yet.
  const state = { material: null, scope: 'piece', sampling: false, filter: null, under: null };

  // ---------- the model's pieces ----------
  const prop = () => host.prop();
  const level = id => (host.levels() || []).find(l => l.id === id) || null;
  const faceOf = u => { const l = level(u.levelId); return l ? (l.group.userData.faces || []).find(f => f.id === u.faceId) || null : null; };
  const resultOf = u => { const l = level(u.levelId); return (l && l.group.userData.regions && l.group.userData.regions.get(u.faceId)) || null; };
  const regionOf = u => { const res = resultOf(u); return res ? res.regions.find(r => r.key === u.key) || null : null; };
  const wallById = id => prop().walls.find(w => w.id === id) || null;
  const trimById = id => (prop().trims || []).find(t => t.id === id) || null;
  const roomById = id => prop().rooms.find(r => r.id === id) || null;
  const openingById = id => (prop().openings || []).find(o => o.id === id) || null;
  const levelTrims = levelId => { const ids = new Set(wallsOn(prop(), levelId).map(w => w.id)); return (prop().trims || []).filter(t => ids.has(t.wallId)); };
  // The finish a wall side wears where no region of it is painted.
  const sideFinish = (u, part) => part ? wallPartFinish(part, prop().walls, roomsOn(prop(), u.levelId)) || '' : '';
  const same = (a, b) => a.type === b.type && a.id === b.id && a.faceId === b.faceId && a.key === b.key;

  // The finish a piece wears now, as drawn.
  function finishOf(u) {
    if (u.type === 'region') { const r = regionOf(u); return r ? r.finish || sideFinish(u, faceOf(u)?.parts[r.cells[0].part]) : ''; }
    if (u.type === 'face') return sideFinish(u, faceOf(u)?.parts[0]);
    if (u.type === 'trim') { const t = trimById(u.id); return t ? t.material || 'mat-trim' : ''; }
    if (u.type === 'opening') { const o = openingById(u.id); return o ? o.trimMaterial || 'mat-trim' : ''; }
    const room = roomById(u.id);
    if (!room) return '';
    return u.type === 'floor' ? room.material || '' : room.ceilingMaterial || 'mat-ceiling';
  }
  function areaOf(u) {
    if (u.type === 'region') { const r = regionOf(u); return r ? r.area : 0; }
    if (u.type === 'face') { const res = resultOf(u); return res ? res.regions.reduce((n, r) => n + r.area, 0) : 0; }
    if (u.type === 'floor' || u.type === 'ceiling') { const room = roomById(u.id); return room ? polyArea(room.pts) : 0; }
    return 0;
  }
  function nameOf(u) {
    if (u.type === 'region' || u.type === 'face') {
      const f = faceOf(u);
      if (!f) return 'Wall';
      if (u.type === 'face') return f.label + ', floor to ceiling';
      const res = resultOf(u), r = regionOf(u);
      const part = r ? regionLabel(r, levelTrims(u.levelId), res.regions.length) : '';
      return f.label + (part ? ', ' + part : '');
    }
    if (u.type === 'trim') return trimLabel(trimById(u.id));
    if (u.type === 'opening') { const o = openingById(u.id); return o && o.type === 'window' ? 'Window, its frame and casing' : 'Door, with its frame and casing'; }
    const room = roomById(u.id);
    return ((room && room.name) || 'Room') + (u.type === 'floor' ? ', floor' : ', ceiling');
  }
  function meshesOf(u) {
    const out = [], root = host.root();
    if (!root) return out;
    const want = u.type === 'region' ? d => d.faceId === u.faceId && d.region === u.key
      : u.type === 'face' ? d => d.faceId === u.faceId
      : u.type === 'trim' ? d => d.kind === 'trim' && d.id === u.id
      : u.type === 'opening' ? d => d.kind === 'opening' && d.id === u.id && !d.glass
      : u.type === 'floor' ? d => d.kind === 'room' && d.id === u.id
      : d => d.kind === 'ceiling' && d.id === u.id;
    root.traverse(o => {
      if (!o.isMesh) return;
      // A floor or ceiling mesh may carry its room on a parent group.
      for (let p = o; p && p !== root; p = p.parent) if (p.userData && p.userData.kind) { if (want(p.userData)) out.push(o); break; }
    });
    return out;
  }
  function paintUnit(u, id) {
    if (u.type === 'region') {
      const res = resultOf(u), r = regionOf(u);
      if (res && r) paintRegion(res, r, wallsOn(prop(), u.levelId), id);
    } else if (u.type === 'face') {
      const f = faceOf(u);
      if (f) paintFace(f, wallsOn(prop(), u.levelId), id);
    } else if (u.type === 'trim') {
      const t = trimById(u.id);
      if (t) t.material = id || null;
    } else if (u.type === 'opening') {
      const o = openingById(u.id);
      if (o && id) o.trimMaterial = id; else if (o) delete o.trimMaterial;
    } else {
      const room = roomById(u.id);
      if (!room) return;
      if (u.type === 'ceiling') room.ceilingMaterial = id || null;
      else if (id) room.material = id;         // a floor always has a finish
    }
  }

  // The piece under a hit of the viewer's pick(), or null where PAINT does not reach.
  function unitForHit(hit) {
    if (!hit || hit.cap) return null;
    if (hit.faceId) {
      const levelId = (host.levels() || []).find(l => (l.group.userData.faces || []).some(f => f.id === hit.faceId))?.id;
      if (levelId === undefined) return null;
      const key = hit.mesh && hit.mesh.userData.region;
      return key ? { type: 'region', levelId, faceId: hit.faceId, key } : { type: 'face', levelId, faceId: hit.faceId };
    }
    if (hit.kind === 'trim') return { type: 'trim', id: hit.id };
    // A plain opening has no frame to paint: its returns are the wall's.
    if (hit.kind === 'opening') { const o = openingById(hit.id); return o && !(o.type !== 'window' && o.plain === true) ? { type: 'opening', id: hit.id } : null; }
    if (hit.kind === 'room') return { type: 'floor', id: hit.id };
    if (hit.kind === 'ceiling') return { type: 'ceiling', id: hit.id };
    return null;
  }
  // The room a trim section looks into: the one in front of its own stretch of the wall (a long
  // wall may run past two rooms).
  function trimRoom(t) {
    const w = t && wallById(t.wallId);
    if (!w) return null;
    const L = Math.hypot(w.bx - w.ax, w.by - w.ay) || 1, ux = (w.bx - w.ax) / L, uy = (w.by - w.ay) / L;
    const side = t.side === -1 ? -1 : 1, s = (t.f0 + t.f1) / 2 * L, off = side * ((w.thickness || 0.114) / 2 + 0.08);
    const x = w.ax + ux * s - uy * off, y = w.ay + uy * s + ux * off;
    return roomsOn(prop(), levelOfWall(prop(), w).id).find(r => r.pts && r.pts.length > 2 && pointInPoly(x, y, r.pts)) || null;
  }
  // THE SAME AROUND THE ROOM.
  function matching(u) {
    const now = finishOf(u);
    if (u.type === 'region' || u.type === 'face') {
      const l = level(u.levelId), f = faceOf(u), r = u.type === 'region' ? regionOf(u) : null;
      if (!l || !f) return [u];
      const faces = (l.group.userData.faces || []).filter(x => f.roomId ? x.roomId === f.roomId : x.kind === f.kind && !x.roomId);
      if (!r) return faces.map(x => ({ type: 'face', levelId: u.levelId, faceId: x.id }));
      const out = [];
      for (const x of faces) {
        const res = l.group.userData.regions.get(x.id);
        for (const q of (res && res.regions) || []) {
          const v = { type: 'region', levelId: u.levelId, faceId: x.id, key: q.key };
          // The same band of the wall: most of the lower of the two lies at the same height.
          const lap = Math.min(r.y1, q.y1) - Math.max(r.y0, q.y0), least = Math.min(r.y1 - r.y0, q.y1 - q.y0);
          if (!!q.field === !!r.field && lap >= least * 0.5 && finishOf(v) === now) out.push(v);
        }
      }
      return out.length ? out : [u];
    }
    if (u.type === 'trim') {
      const room = trimRoom(trimById(u.id));
      if (!room) return [u];
      return (prop().trims || []).filter(t => { const tr = trimRoom(t); return tr && tr.id === room.id && (t.material || 'mat-trim') === now; }).map(t => ({ type: 'trim', id: t.id }));
    }
    if (u.type === 'opening') {
      // The doors and windows of the walls round the same rooms as this one.
      const o = openingById(u.id), w = o && wallById(o.wallId);
      if (!w) return [u];
      const rooms = roomsOn(prop(), levelOfWall(prop(), w).id), near = x => { const s = wallSides(x, rooms); return [s.pos, s.neg].filter(Boolean).map(r => r.id); };
      const mine = near(w);
      return (prop().openings || []).filter(x => { const xw = wallById(x.wallId); return xw && (x.trimMaterial || 'mat-trim') === now && !(x.type !== 'window' && x.plain === true) && near(xw).some(id => mine.includes(id)); }).map(x => ({ type: 'opening', id: x.id }));
    }
    return [u];
  }
  // THE WHOLE WALL OR GROUP.
  function whole(u) {
    if (u.type === 'region') return [{ type: 'face', levelId: u.levelId, faceId: u.faceId }];
    if (u.type !== 'trim') return [u];
    const t = trimById(u.id);
    if (!t) return [u];
    let ids = clickGroupIds(prop(), ws.data.projects, 'trim', u.id);
    if (ids.length < 2) {
      // No group: the trim of the same wall face.
      const w = wallById(t.wallId), lvl = w && level(levelOfWall(prop(), w).id);
      const face = lvl && (lvl.group.userData.faces || []).find(f => f.parts.some(p => p.wallId === t.wallId && p.side === t.side));
      const on = face ? face.parts : [{ wallId: t.wallId, side: t.side }];
      ids = (prop().trims || []).filter(x => on.some(p => p.wallId === x.wallId && p.side === x.side)).map(x => x.id);
    }
    const out = ids.map(id => ({ type: 'trim', id }));
    // A framed field takes the wall inside it along.
    for (const id of ids) {
      const x = trimById(id), w = x && wallById(x.wallId);
      if (!w || trimDivides(x) !== 'inside') continue;
      const lvl = level(levelOfWall(prop(), w).id);
      for (const [faceId, res] of (lvl && lvl.group.userData.regions) || []) for (const r of res.regions) if (r.field === id) out.push({ type: 'region', levelId: lvl.id, faceId, key: r.key });
    }
    return out;
  }
  const scopeFor = e => e && e.shiftKey ? 'room' : e && e.metaKey ? 'whole' : state.scope;
  function targetFor(hit, e) {
    const base = unitForHit(hit);
    if (!base) return null;
    const scope = scopeFor(e);
    const units = scope === 'room' ? matching(base) : scope === 'whole' ? whole(base) : [base];
    return { base, scope, units };
  }
  // What SELECT has selected, as pieces PAINT can paint.
  function selectedUnits() {
    const out = [];
    for (const t of host.picked() || []) {
      const s = t.sel;
      if (!s) continue;
      if (s.kind === 'face') { const l = (host.levels() || []).find(x => (x.group.userData.faces || []).some(f => f.id === s.id)); if (l) out.push({ type: 'face', levelId: l.id, faceId: s.id }); }
      else if (s.kind === 'trim') out.push({ type: 'trim', id: s.id });
      else if (s.kind === 'opening' && unitForHit({ kind: 'opening', id: s.id })) out.push({ type: 'opening', id: s.id });
      else if (s.kind === 'room') out.push({ type: 'floor', id: s.id });
    }
    return out;
  }

  // ---------- painting ----------
  function paint(units, label) {
    const id = state.material;
    if (id == null) { host.toast('Choose a finish in the PAINT panel first, or Alt-click a surface to pick up its finish.', 'warn'); return false; }
    // A floor always has a finish; a whole face is repainted even when its side already wears
    // this one, because its regions may not.
    const todo = units.filter(u => id === AUTO ? u.type !== 'floor' : u.type === 'face' || finishOf(u) !== id);
    if (!todo.length) return false;
    beginGeometryEdit(prop(), label);
    for (const u of todo) paintUnit(u, id);
    touch();
    host.rebuild();
    return true;
  }
  function describe(target) {
    const { base, units } = target;
    const area = units.reduce((n, u) => n + areaOf(u), 0);
    const now = materialById(finishOf(base));
    const more = units.length - 1;
    return { name: nameOf(base), more, area, now: now ? now.name : '' };
  }
  function showUnder(target) {
    state.under = target ? describe(target) : null;
    const el = host.panel() && host.panel().querySelector('[data-pt-under]');
    if (el) el.innerHTML = underHtml();
  }
  function underHtml() {
    const u = state.under;
    if (!u) return '<span class="pt-none">Point at a wall, trim, a door, a window, a floor or a ceiling.</span>';
    return `<b>${escapeHtml(u.name)}</b>${u.more > 0 ? `<span>and ${u.more} more like it</span>` : ''}
      ${u.area > 0 ? `<span>${escapeHtml(fmtArea(u.area))}${u.more > 0 ? ' in all' : ''}</span>` : ''}
      ${u.now ? `<span>Now: ${escapeHtml(u.now)}</span>` : ''}`;
  }

  function move(e) {
    const target = targetFor(host.pick(e), e);
    host.setHover(target ? target.units.flatMap(meshesOf) : []);
    showUnder(target);
    return !!target;
  }
  function click(e) {
    const target = targetFor(host.pick(e), e);
    if (!target) return;
    if (state.sampling || e.altKey) {
      state.material = finishOf(target.base) || AUTO;
      state.sampling = false;
      host.repaintPanel();
      return;
    }
    const n = target.units.length;
    if (paint(target.units, n > 1 ? 'paint ' + n + ' pieces' : 'paint ' + nameOf(target.base))) move(e);
  }
  function leave() { host.setHover([]); showUnder(null); }

  // ---------- the panel ----------
  function usedIds() {
    const p = prop(), ids = new Set(['mat-trim']);
    for (const w of p.walls || []) {
      for (const k of ['material', 'materialIn', 'materialPos', 'materialNeg', 'materialEndA', 'materialEndB']) if (w[k]) ids.add(w[k]);
      for (const m of wallPaint(w)) ids.add(m.material);
    }
    for (const r of p.rooms || []) { if (r.material) ids.add(r.material); if (r.ceilingMaterial) ids.add(r.ceilingMaterial); }
    for (const t of p.trims || []) if (t.material) ids.add(t.material);
    return ids;
  }
  function listFor(filter) {
    const all = ws.data.materials;
    if (filter === 'all') return all;
    if (filter === 'paint') return all.filter(m => m.category === 'paint');
    if (filter === 'used') { const ids = usedIds(); return all.filter(m => ids.has(m.id)); }
    return all.filter(m => m.kind === filter || m.kind === 'any');
  }
  function currentHtml() {
    if (state.material == null) return '<div class="pt-current pt-empty"><span class="pt-chip"></span><div><b>No finish chosen</b><span>Choose one below, or Alt-click a surface to pick up its finish.</span></div></div>';
    if (state.material === AUTO) return '<div class="pt-current"><span class="pt-chip pt-auto"></span><div><b>No paint of its own</b><span>A click takes the paint off: the piece goes back to its wall\'s, or the trim paint.</span></div></div>';
    const m = materialById(state.material);
    if (!m) return '<div class="pt-current pt-empty"><span class="pt-chip"></span><div><b>That finish is gone</b><span>Choose another below.</span></div></div>';
    return `<div class="pt-current" title="${escapeHtml(materialTitle(m))}"><span class="pt-chip" data-pt-chip="${escapeHtml(m.id)}" style="background:${escapeHtml(m.color)}"><img alt="" hidden></span>
      <div><b>${escapeHtml(m.name)}</b><span>${escapeHtml(materialTitle(m).split(' · ').slice(1).join(' · ') || m.color)}</span></div></div>`;
  }
  function renderPanel() {
    const el = host.panel();
    if (!el) return;
    if (!state.filter) state.filter = listFor('used').length > 1 ? 'used' : 'paint';
    const list = listFor(state.filter), sel = selectedUnits();
    el.innerHTML = `<h3>PAINT</h3>
      ${currentHtml()}
      <div class="pt-under" data-pt-under>${underHtml()}</div>
      ${sel.length ? `<button class="btn primary" data-pt-selected title="Paint what SELECT has selected">PAINT THE ${sel.length} SELECTED</button>` : ''}
      <div class="field"><label>One click paints</label>
        <div class="pt-scopes" role="radiogroup" aria-label="How much one click paints">${SCOPES.map(([id, label, title]) => `<button type="button" class="btn ${state.scope === id ? 'active' : ''}" role="radio" aria-checked="${state.scope === id}" data-pt-scope="${id}" title="${escapeHtml(title)}">${label}</button>`).join('')}</div></div>
      <button class="btn ${state.sampling ? 'active' : ''}" data-pt-sample aria-pressed="${state.sampling}" title="Then click a surface: its finish becomes the one you paint with (or Alt-click any time)">PICK UP A FINISH FROM THE MODEL</button>
      <h3>FINISHES</h3>
      <div class="pt-filters">${FILTERS.map(([id, label]) => `<button type="button" class="v-pill ${state.filter === id ? 'active' : ''}" data-pt-filter="${id}">${label}</button>`).join('')}</div>
      <div class="pt-grid">
        <button type="button" class="pt-swatch ${state.material === AUTO ? 'active' : ''}" data-pt-mat="" title="Take the paint off: the piece goes back to its automatic finish"><span class="pt-chip pt-auto"></span><em>No paint of its own</em></button>
        ${list.map(m => `<button type="button" class="pt-swatch ${state.material === m.id ? 'active' : ''}" data-pt-mat="${escapeHtml(m.id)}" title="${escapeHtml(materialTitle(m))}"><span class="pt-chip" style="background:${escapeHtml(m.color)}"><img alt="" hidden></span><em>${escapeHtml(m.name)}</em></button>`).join('')}
      </div>
      ${list.length ? '' : '<p class="empty">Nothing here yet. ALL shows every finish in the library.</p>'}
      <h3>NEW PAINT COLOUR</h3>
      <div class="pt-new">
        <input type="color" data-pt-new-color value="#dcd6c8" aria-label="Colour">
        <input type="text" data-pt-new-name placeholder="Name, e.g. White Dove" aria-label="Name">
      </div>
      <div class="pt-new">
        <input type="text" data-pt-new-brand placeholder="Maker, e.g. Benjamin Moore" aria-label="Maker">
        <input type="text" data-pt-new-code placeholder="Code, e.g. OC-17" aria-label="Colour code">
      </div>
      <button class="btn" data-pt-new-add>ADD AND PAINT WITH IT</button>
      <p class="empty">Click paints one piece: the wall above a rail, one trim section, a door with its casing, a floor. Shift-click paints the same piece all round the room; Cmd-click the whole wall or group; Alt-click picks up a finish. Esc ends. Sheen, texture and the product are on the MATERIALS page.</p>`;
    const swatch = (holder, id) => {
      const m = materialById(id), img = holder.querySelector('img');
      if (!m || !img) return;
      const show = url => { if (url && img.isConnected) { img.src = url; img.hidden = false; } };
      show(swatchUrl(m, SWATCH, show));
    };
    el.querySelectorAll('[data-pt-mat]').forEach(b => {
      if (b.dataset.ptMat) swatch(b, b.dataset.ptMat);
      b.onclick = () => { state.material = b.dataset.ptMat; state.sampling = false; renderPanel(); };
    });
    const chip = el.querySelector('[data-pt-chip]');
    if (chip) swatch(chip, chip.dataset.ptChip);
    el.querySelectorAll('[data-pt-scope]').forEach(b => b.onclick = () => { state.scope = b.dataset.ptScope; renderPanel(); });
    el.querySelectorAll('[data-pt-filter]').forEach(b => b.onclick = () => { state.filter = b.dataset.ptFilter; renderPanel(); });
    el.querySelector('[data-pt-sample]').onclick = () => { state.sampling = !state.sampling; renderPanel(); };
    const selected = el.querySelector('[data-pt-selected]');
    if (selected) selected.onclick = () => { if (paint(sel, 'paint ' + sel.length + ' selected')) renderPanel(); };
    el.querySelector('[data-pt-new-add]').onclick = () => {
      const q = k => el.querySelector('[data-pt-new-' + k + ']').value.trim();
      const name = q('name');
      if (!name) { host.toast('Give the colour a name first.', 'warn'); return; }
      const m = addCustomMaterial(name, q('color'), 'any');
      Object.assign(m, { category: 'paint', pattern: 'flat', colorName: name, colorBrand: q('brand'), colorCode: q('code') });
      touch();
      state.material = m.id; state.filter = 'paint';
      renderPanel();
    };
  }

  return {
    state, click, move, leave, renderPanel,
    hint: () => state.sampling ? 'PAINT: click a surface to pick up its finish.' : 'PAINT: click a wall, trim, a door, a window, a floor or a ceiling to paint that one piece. Shift-click: the same all round the room. Cmd-click: the whole wall or group. Alt-click picks up a finish. Esc ends.',
    task: () => state.sampling ? 'Tap a surface to pick up its finish.' : state.material == null ? 'Choose a finish, then tap what to paint.' : 'Tap a wall, trim, a door, a floor or a ceiling to paint it.',
    // For tests and the phone panel: what is chosen, and what a click at this hit would paint.
    setMaterial(id) { state.material = id; },
    setScope(id) { if (SCOPES.some(s => s[0] === id)) state.scope = id; },
    describeHit(hit, e) { const t = targetFor(hit, e); return t ? { ...describe(t), units: t.units } : null; },
  };
}
