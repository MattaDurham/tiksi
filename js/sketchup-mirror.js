// SketchUp mirror. With a project folder linked and the local server able to reach an
// installed SketchUp, every <name>.tiksi in the folder has a <name>.skp beside it:
//
//   Tiksi -> SketchUp   each wall is a group (its openings cut, a nested group per opening),
//                       each room a floor group, each fixture (fixtures.js) a group of
//                       prisms, each level a tag, each plan underlay an image. Groups carry a "tiksi" dictionary: their id and the values
//                       they were written from. Faces wear Tiksi's finishes as SketchUp
//                       materials named "Tiksi: <material name>", so a rewrite repaints them.
//   SketchUp -> Tiksi   when the .skp changes on disk (saved in SketchUp), its groups are
//                       read back and merged element by element against the last state
//                       both sides agreed on: moved, stretched, raised, renamed and deleted
//                       groups update Tiksi; a copied group becomes a new element.
//
// Geometry drawn in SketchUp outside the Tiksi groups is kept in the .skp across rewrites
// and is not brought into the plan. When both sides changed the same element, Tiksi keeps
// its version and the conflict is reported. The pure parts here (spec, signatures, merge)
// run under Node for tests; the rest talks to /api/model-conversion/mirror.

import { wallHeightOf, levelOfWall, levelOfRoom, levelHeight, roomsOn, wallsOn, openingsOn, uid } from './store.js';
import { openingSpans, wallSolids, baseboardDetail, wallFaceMaterialIds, wallSides, doorGlassBand, plainOpening, doorDetail, windowDetail, doorShownOpen, doorGlass, leafGlazing } from './wall-solids.js';
import { tagIdOf, tagById } from './tags.js';
import { thresholdFloors } from './threshold-floors.js';
import { fixtureShape, fixtureMirrorParams, fixtureLocalFrame, fixtureParts, fixtureLabel, fixturesOn, normaliseFixture, FIXTURE_FALLBACK } from './fixtures.js';
import { trimMeshParts } from './trim-mesh.js';
import { trimLabel, trimProduct } from './trims.js';

export const MIRROR_FORMAT = 'tiksi-sketchup-mirror';
// Signatures compare lengths to 0.1 mm, finer than any typed change, and the opening position
// to 1/100,000 of the wall. Each value is first rounded to the micrometre, as the server reports
// what it reads from the .skp (r6 in server/sketchup_mirror.py), so a value Tiksi wrote and the
// same value read back always sign alike. SIG_TAIL marks signatures of this precision. Mirrors
// saved before it hold millimetre signatures (LEGACY_SIG): those are read against the same
// millimetre signature of today's values (mergeMirror, syncMirror), so nothing is rewritten or
// lost because the signatures changed.
const micro = v => Number((Number(v) || 0).toFixed(6));
const tenth = v => Math.round(micro(v) * 1e4);
const along = v => Math.round(micro(v) * 1e5);
const SIG_TAIL = '|0.1mm';
const current = s => typeof s === 'string' && s.endsWith(SIG_TAIL);

// ---------- spec: what the .skp should contain ----------

// Opening values as the mirror sees them: cut from Tiksi's own spans, so a clamped or
// shortened opening reads back exactly as it was drawn.
function openingParams(o, s0, s1, L, H) {
  const v0 = o.type === 'window' ? Math.max(0, o.sill || 0) : 0;
  const v1 = Math.min(v0 + (o.height || 0), H);
  const p = { wallId: o.wallId, t: (s0 + s1) / 2 / L, width: s1 - s0, height: v1 - v0, sill: v0, s0, s1, v0, v1 };
  for (const key of ['profile', 'detail']) if (o[key] && typeof o[key] === 'object') p[key] = JSON.parse(JSON.stringify(o[key]));
  if (p.profile || p.detail) {
    p.configuration = Object.fromEntries(['leaves', 'glass', 'doorState', 'plain'].filter(k => o[k] !== undefined).map(k => [k, o[k]]));
  }
  if (o.floorContinuity === false) p.floorContinuity = false;
  return p;
}

function wallParams(prop, w) {
  const p = { ax: w.ax, ay: w.ay, bx: w.bx, by: w.by, thickness: w.thickness || 0.114, height: wallHeightOf(prop, w) };
  for (const key of ['profile', 'baseboardPos', 'baseboardNeg']) if (w[key] && typeof w[key] === 'object') p[key] = JSON.parse(JSON.stringify(w[key]));
  for (const key of ['materialEndA', 'materialEndB']) if (w[key]) p[key] = w[key];
  const trims = (prop.trims || []).filter(t => t.wallId === w.id).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (trims.length) p.trimState = { version: 1, records: trims.map(t => ({ source: structuredClone(t), product: structuredClone(trimProduct(t)) })) };
  return p;
}

// The viewer and native writer consume the same wall-local triangles. This signature is
// also a readback guard: a rigid wall move is safe only if its regenerated mitres still fit.
function trimMeshes(prop, wall) {
  const level = levelOfWall(prop, wall), view = { walls: wallsOn(prop, level.id), rooms: roomsOn(prop, level.id), wallHeight: levelHeight(prop, level.id) };
  const openings = openingsOn(prop, level.id);
  return (prop.trims || []).filter(t => t.wallId === wall.id).sort((a, b) => String(a.id).localeCompare(String(b.id))).map(source => {
    const { parts } = trimMeshParts(source, wall, view, openings);
    return { source, parts, meshSig: hash(JSON.stringify(stableDetail(parts.map(p => ({ role: p.role, positions: p.positions }))))) };
  });
}

// Every element the mirror carries, with comparable signatures: id -> { kind, sig, params }.
// `legacy`: the millimetre signatures mirrors were saved with before SIG_TAIL.
export function elementState(prop, legacy = false) {
  const out = new Map();
  const wallSig = legacy ? LEGACY_SIG.wall : wallSigNow, openingSig = legacy ? LEGACY_SIG.opening : openingSigNow;
  const roomSig = legacy ? LEGACY_SIG.room : roomSigNow, fixtureSig = legacy ? LEGACY_SIG.fixture : fixtureSigNow;
  for (const w of prop.walls || []) {
    const L = Math.hypot(w.bx - w.ax, w.by - w.ay);
    if (L < 0.01) continue;
    const p = wallParams(prop, w);
    out.set(w.id, { kind: 'wall', sig: wallSig(p), params: p });
    for (const { s0, s1, o } of openingSpans(w, prop.openings || [], L)) {
      const op = openingParams(o, s0, s1, L, p.height);
      out.set(o.id, { kind: 'opening', sig: openingSig(op), params: op });
    }
  }
  for (const r of prop.rooms || []) {
    if ((r.pts || []).length < 3) continue;
    const p = { pts: r.pts.map(q => [q[0], q[1]]), name: r.name || '' };
    if (Number.isFinite(r.ceilingHeight) && r.ceilingHeight > 0) p.ceilingHeight = r.ceilingHeight;
    out.set(r.id, { kind: 'room', sig: roomSig(p), params: p });
  }
  for (const f of prop.fixtures || []) {
    if (!fixtureShape(f)) continue;
    const p = fixtureMirrorParams(f);
    out.set(f.id, { kind: 'fixture', sig: fixtureSig(p), params: p });
  }
  return out;
}

export function wallSig(p) { return wallSigNow(p); }
function wallSigNow(p) {
  let sig = ['wall', tenth(p.ax), tenth(p.ay), tenth(p.bx), tenth(p.by), tenth(p.thickness), tenth(p.height)].join(',');
  for (const key of ['profile', 'baseboardPos', 'baseboardNeg']) if (p[key] && typeof p[key] === 'object') sig += '|' + key + ':' + JSON.stringify(stableDetail(p[key]));
  for (const key of ['materialEndA', 'materialEndB']) if (p[key]) sig += '|' + key + ':' + JSON.stringify(p[key]);
  if (p.trimState) sig += '|trims:' + JSON.stringify(stableDetail(p.trimState));
  return sig + SIG_TAIL;
}
export function openingSig(p) { return openingSigNow(p); }
// Detail is optional so old opening signatures remain unchanged. Sorting keys makes the
// signature independent of JSON field order and catches concurrent handing/profile edits.
function stableDetail(value) {
  if (Array.isArray(value)) return value.map(stableDetail);
  if (!value || typeof value !== 'object') return typeof value === 'number' ? micro(value) : value;
  return Object.fromEntries(Object.keys(value).sort().map(k => [k, stableDetail(value[k])]));
}
function openingSigNow(p) {
  const sig = ['opening', p.wallId, along(p.t), tenth(p.width), tenth(p.height), tenth(p.sill)].join(',');
  return sig + (p.detail && typeof p.detail === 'object' ? '|detail:' + JSON.stringify(stableDetail(p.detail)) : '')
    + (p.profile && typeof p.profile === 'object' ? '|profile:' + JSON.stringify(stableDetail(p.profile)) : '')
    + (p.configuration ? '|configuration:' + JSON.stringify(stableDetail(p.configuration)) : '')
    + (p.floorContinuity === false ? '|floor:false' : '') + SIG_TAIL;
}
export function roomSig(p) { return roomSigNow(p); }
function roomSigNow(p) {
  return ['room', p.name || '', ...(p.pts || []).map(q => tenth(q[0]) + ':' + tenth(q[1]))].join(',')
    + (Number.isFinite(p.ceilingHeight) && p.ceilingHeight > 0 ? '|ceiling:' + tenth(p.ceilingHeight) : '') + SIG_TAIL;
}
// Rotation to a tenth of a degree, the rest to 0.1 mm.
const decideg = v => ((Math.round(Number(v || 0) * 10) % 3600) + 3600) % 3600;
export function fixtureSig(p) { return fixtureSigNow(p); }
function fixtureSigNow(p) {
  const head = ['fixture', p.kind || '', p.subtype || '', p.shape || ''];
  if (p.shape === 'box') return head.concat([tenth(p.x), tenth(p.y), decideg(p.rot), tenth(p.w), tenth(p.d), tenth(p.y0), tenth(p.h)]).join(',') + SIG_TAIL;
  return head.concat((p.pts || []).map(q => tenth(q[0]) + ':' + tenth(q[1])), [tenth(p.depth), tenth(p.y0), tenth(p.h)]).join(',') + SIG_TAIL;
}

// The signatures mirrors were saved with before SIG_TAIL, kept exactly: lengths to the
// millimetre, an opening's position to 1/2000 of its wall.
const mmOld = v => Math.round(Number(v || 0) * 1000), permilleOld = v => Math.round(Number(v || 0) * 2000);
const LEGACY_SIG = {
  wall: p => ['wall', mmOld(p.ax), mmOld(p.ay), mmOld(p.bx), mmOld(p.by), mmOld(p.thickness), mmOld(p.height)].join(','),
  opening: p => ['opening', p.wallId, permilleOld(p.t), mmOld(p.width), mmOld(p.height), mmOld(p.sill)].join(','),
  room: p => ['room', p.name || '', ...(p.pts || []).map(q => mmOld(q[0]) + ':' + mmOld(q[1]))].join(','),
  fixture: p => {
    const head = ['fixture', p.kind || '', p.subtype || '', p.shape || ''];
    if (p.shape === 'box') return head.concat([mmOld(p.x), mmOld(p.y), decideg(p.rot), mmOld(p.w), mmOld(p.d), mmOld(p.y0), mmOld(p.h)]).join(',');
    return head.concat((p.pts || []).map(q => mmOld(q[0]) + ':' + mmOld(q[1])), [mmOld(p.depth), mmOld(p.y0), mmOld(p.h)]).join(',');
  },
};

// Finishes as SketchUp should paint them: { id, name, color } from the workspace materials,
// with the 3D view's fallback colour when an id is unset or unknown (unknown ones warn).
// Two materials sharing a name both take their id in brackets, so neither repaints the other.
const FALLBACK = {
  wall: { name: 'Default wall', color: '#d8d4cc' }, floor: { name: 'Default floor', color: '#97999b' },
  ceiling: { name: 'Default ceiling', color: '#f1efe9' },
  door: { name: 'Default trim', color: '#f3f1ec' }, window: { name: 'Default glass', color: '#d2e7ee' },
  'fx-top': { name: 'Default counter', color: FIXTURE_FALLBACK.top }, 'fx-body': { name: 'Default cabinet', color: FIXTURE_FALLBACK.body },
  'fx-kick': { name: 'Default toe kick', color: FIXTURE_FALLBACK.kick }, 'fx-appliance': { name: 'Default appliance', color: FIXTURE_FALLBACK.appliance },
  'fx-fabric': { name: 'Default upholstery', color: FIXTURE_FALLBACK.fabric }, 'fx-wood': { name: 'Default wood', color: FIXTURE_FALLBACK.wood },
  'fx-bath': { name: 'Default porcelain', color: FIXTURE_FALLBACK.bath },
};
const OPENING_MATERIAL = { door: 'mat-trim', window: 'mat-glass' };
const HEX = /^#[0-9a-f]{6}$/i;

function materialResolver(materials, warnings) {
  const byId = new Map((materials || []).filter(m => m && m.id).map(m => [m.id, m]));
  const named = new Map();
  for (const m of byId.values()) named.set(String(m.name || m.id), (named.get(String(m.name || m.id)) || 0) + 1);
  const warned = new Set();
  return (id, role, owner) => {
    const m = id ? byId.get(id) : null;
    if (!m) {
      if (id && !warned.has(id)) { warned.add(id); warnings.push('material ' + id + ' on ' + owner + ' is not in the material library; painted ' + FALLBACK[role].name); }
      return { id: id || null, name: FALLBACK[role].name, color: FALLBACK[role].color };
    }
    const name = String(m.name || m.id);
    return { id: m.id, name: named.get(name) > 1 ? name + ' (' + m.id + ')' : name, color: HEX.test(m.color) ? m.color.toLowerCase() : FALLBACK[role].color };
  };
}

// `materials` is the workspace material library (ws.data.materials).
// `legacy` builds the spec as mirrors saved before SIG_TAIL were written (millimetre element
// signatures, piece outlines rounded to the micrometre), only to recognise their signature.
export function mirrorSpec(prop, materials, legacy = false) {
  const state = elementState(prop, legacy), warnings = [];
  const finish = materialResolver(materials, warnings);
  // Each group goes on its Tiksi tag as a SketchUp tag of the same name ('' = the level's tag).
  const tag = key => { const t = tagById(prop, tagIdOf(prop, key)); return t ? t.name : ''; };
  const walls = [];
  for (const w of prop.walls || []) {
    const st = state.get(w.id);
    if (!st) continue;
    const lvl = levelOfWall(prop, w);
    const holes = (prop.openings || []).filter(o => o.wallId === w.id && state.has(o.id)).map(o => {
      const p = state.get(o.id).params;
      const role = o.type === 'window' ? 'window' : 'door';
      const hole = { id: o.id, type: o.type, t: p.t, width: p.width, height: p.height, sill: p.sill, s0: p.s0, s1: p.s1, v0: p.v0, v1: p.v1,
        material: finish(OPENING_MATERIAL[role], role, 'opening ' + o.id), tag: tag('opening:' + o.id) };
      // A glass door (o.glass): the heights between which its pane is glass, and that finish.
      // Only glass doors carry the key, so every other mirror keeps the signature it has.
      // A doorway its owner set to no door (leaves: 0, or a plain opening): its pane, which stays
      // as the handle SketchUp moves and Tiksi reads back, is see-through instead of a white panel.
      const open = role === 'door' && (o.leaves === 0 || plainOpening(o));
      if (open) hole.material = { id: null, name: 'Opening, no door', color: '#ffffff', opacity: 0.06 };
      const band = open ? null : doorGlassBand(o, p.v0, p.v1);
      if (band) hole.glass = { v0: band[0], v1: band[1], material: finish(OPENING_MATERIAL.window, 'window', 'opening ' + o.id) };
      if (p.floorContinuity === false) hole.floorContinuity = false;
      if (p.profile || p.detail) {
        for (const key of ['profile', 'detail']) if (p[key]) hole[key] = JSON.parse(JSON.stringify(p[key]));
        hole.configuration = JSON.parse(JSON.stringify(p.configuration));
        const observedSides = wallSides(w, roomsOn(prop, lvl.id));
        hole.sides = { pos: !!observedSides.pos, neg: !!observedSides.neg };
        const interior = hole.sides.pos && hole.sides.neg;
        hole.resolved = role === 'door' ? doorDetail(o, p.width, p.height, interior, hole.sides) : windowDetail(o, p.width, p.height);
        hole.trimMaterial = finish('mat-trim', 'door', 'opening ' + o.id);
        const glassFinish = finish('mat-glass', 'window', 'opening ' + o.id);
        // Keep a distinct native material from older opaque opening-marker panes.
        hole.glassMaterial = { ...glassFinish, name: glassFinish.name + ' (transparent)', opacity: 0.22 };
        const hardware = hole.resolved.hardwareFinish || 'chrome';
        hole.metalMaterial = { id: null, name: 'Door hardware, ' + (hardware === 'glass' ? 'chrome' : hardware), color: hardware === 'brass' ? '#b99b54' : hardware === 'dark' ? '#35332e' : '#b9bcc0' };
        hole.knobMaterial = hardware === 'glass' ? hole.glassMaterial : hole.metalMaterial;
        hole.leafMaterial = finish(hole.resolved.leafMaterial || 'mat-trim', 'door', 'opening ' + o.id);
        if (role === 'door') {
          hole.leaves = open ? 0 : hole.resolved.leaves;
          hole.shownOpen = doorShownOpen(o, interior);
          hole.leafGlazing = leafGlazing(doorGlass(o), hole.resolved.leafWidth, hole.resolved.leafHeight);
          hole.plain = plainOpening(o);
        }
      }
      return hole;
    });
    // pos: the long face on the side the plan normal (-uy, ux) of a -> b points to (in the
    // .skp, local y = -thickness/2); neg: the opposite face; other: ends, top and reveals.
    // Optional endA/endB override only the physical vertical ends at local x=0 / x=L.
    const ids = wallFaceMaterialIds(w, roomsOn(prop, lvl.id));
    const faces = Object.fromEntries(Object.entries(ids).map(([face, id]) => [face, finish(id, 'wall', 'wall ' + w.id)]));
    const wall = Object.assign({ id: w.id, level: lvl.id, elevation: lvl.elevation, name: 'Wall ' + w.id, holes, materials: faces, tag: tag('wall:' + w.id) }, st.params);
    if (wall.trimState) wall.trims = trimMeshes(prop, w).map(({ source, parts, meshSig }) => ({
      id: source.id, name: trimLabel(source), tag: tag('trim:' + source.id), source: structuredClone(source), product: structuredClone(trimProduct(source)), meshSig,
      parts: parts.map(part => ({ role: part.role, positions: part.positions,
        material: part.role === 'backer' ? { id: null, name: 'Trim backer', color: '#2b2825' } : finish(source.material || 'mat-trim', 'door', 'trim ' + source.id) })),
    }));
    const sides = wallSides(w, roomsOn(prop, lvl.id));
    for (const [side, key, sign] of [['pos', 'baseboardPos', 1], ['neg', 'baseboardNeg', -1]]) {
      const specified = w[key] && typeof w[key] === 'object' || Number.isFinite(w.profile?.baseboardHeight) || Number.isFinite(w.profile?.baseboardDepth);
      if (!specified || !sides[side]) continue;
      const detail = baseboardDetail(w, sign);
      if (!(detail.height > 0) || !(detail.depth > 0)) continue;
      for (const s of wallSolids(w, prop.openings || [], st.params.height).solids) {
        if (s.v0 >= .001) continue;
        const height = Math.min(detail.height, s.v1);
        (wall.baseboards ||= []).push({ s0: s.s0, s1: s.s1, side, ...detail, height, radius: Math.min(detail.radius, height), material: finish('mat-trim', 'door', 'wall ' + w.id) });
      }
    }
    walls.push(wall);
  }
  const rooms = (prop.rooms || []).filter(r => state.has(r.id)).map(r => {
    const lvl = levelOfRoom(prop, r);
    const room = { id: r.id, level: lvl.id, elevation: lvl.elevation, name: r.name || '', pts: state.get(r.id).params.pts, material: finish(r.material, 'floor', 'room ' + r.id), tag: tag('room:' + r.id) };
    if (Number.isFinite(r.ceilingHeight) && r.ceilingHeight > 0) {
      room.ceilingHeight = r.ceilingHeight;
      room.ceilingMaterial = finish(r.ceilingMaterial || 'mat-ceiling', 'ceiling', 'room ' + r.id);
    }
    return room;
  });
  for (const patch of thresholdFloors(prop)) {
    const room = rooms.find(r => r.id === patch.roomId);
    if (!room) continue;
    (room.thresholds ||= []).push({ pts: patch.pts, material: finish(patch.material, 'floor', 'threshold ' + patch.openingId) });
  }
  // Fixtures: one group per fixture, framed at its origin (a box's centre, a run's first
  // back-line point) along its own direction; parts are prisms in that frame, (u, v) metres.
  const fixtures = [];
  for (const lvl of prop.levels || []) for (const f of fixturesOn(prop, lvl.id)) {
    const st = state.get(f.id);
    if (!st) continue;
    const { origin, angle, toLocal } = fixtureLocalFrame(f);
    // Written unrounded, as walls are: the server measures the piece back from these points, and
    // a point rounded here could read back a micrometre off and change its signature.
    const plain = legacy ? v => Math.round(v * 1e6) / 1e6 || 0 : v => v || 0;   // -0 and a missing value as 0, nothing rounded
    const parts = fixtureParts(f).filter(q => q.pts.length >= 3 && q.y1 - q.y0 > 1e-4).map(q => ({
      pts: q.pts.map(pt => toLocal(pt).map(plain)), z0: plain(q.y0), z1: plain(q.y1),
      material: finish(q.material, FALLBACK['fx-' + q.role] ? 'fx-' + q.role : 'fx-body', 'fixture ' + f.id),
    }));
    fixtures.push({ id: f.id, level: lvl.id, elevation: lvl.elevation, name: fixtureLabel(f), kind: f.kind, subtype: f.subtype || null, shape: fixtureShape(f),
      origin: origin.map(plain), angle: plain(angle), parts, base: st.params, tag: tag('fixture:' + f.id), local: st.params.shape === 'run' ? { pts: f.pts.map(pt => toLocal(pt).map(plain)) } : null });
  }
  const elements = {};
  for (const [id, st] of state) elements[id] = { kind: st.kind, sig: st.sig };
  return {
    format: MIRROR_FORMAT, version: 1,
    property: { id: prop.id, name: prop.name || '' },
    levels: (prop.levels || []).map(l => ({ id: l.id, name: l.name, elevation: l.elevation, height: l.height })),
    tags: (prop.tags || []).map(t => ({ name: t.name, visible: t.visible !== false })),
    walls, rooms, fixtures, elements,
    underlays: (prop.levels || []).map(l => underlayOf(l)).filter(Boolean),
    warnings,
  };
}

// A level's tracing underlay, placed where the plan editor draws it.
function underlayOf(level) {
  const pl = level.plan;
  if (!pl || typeof pl.img !== 'string' || !pl.img.startsWith('data:image/') || !(pl.imgW > 0) || !(pl.imgH > 0) || !(pl.mPerPx > 0)) return null;
  const img = pl.img;
  const sig = hash(img.length + ':' + img.slice(0, 4096) + img.slice(-4096)) + ':' + [pl.imgW, pl.imgH, pl.mPerPx, pl.offsetX, pl.offsetY].map(v => Math.round((v || 0) * 1e6)).join('/');
  return { level: level.id, levelName: level.name, elevation: level.elevation, sig, x: pl.offsetX || 0, y: pl.offsetY || 0, widthM: pl.imgW * pl.mPerPx, heightM: pl.imgH * pl.mPerPx };
}

export function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

// Finishes are part of the spec, so a material change rewrites the .skp. Element records
// compare geometry and explicit endpoint IDs; repainting ordinary native faces is not
// interpreted as a geometry edit.
export function specSignature(spec) {
  return hash(JSON.stringify(Object.assign({}, spec, { underlays: spec.underlays.map(u => u.sig) })));
}

// ---------- merge: SketchUp's version into the property ----------

const readSig = {
  wall: p => wallSig(p),
  opening: p => openingSig(p),
  room: p => roomSig(p),
  fixture: p => fixtureSig(p),
};

// Catalog trim is generated against neighbouring walls. A rigid native move can therefore
// alter a mitre when reconstructed. Check the complete proposed wall layout before mutating
// any records, and preserve the native file whenever that layout is not exactly representable.
function trimReadbackIssue(prop, read) {
  const trimWalls = new Set((prop.trims || []).map(t => t.wallId));
  const rows = read.walls || [], counts = new Map();
  for (const row of rows) counts.set(row.id, (counts.get(row.id) || 0) + 1);
  for (const row of rows) if (row.base?.trimState || row.now?.trimState || trimWalls.has(row.id)) {
    if (!row.id || counts.get(row.id) > 1 || !(prop.walls || []).some(w => w.id === row.id)) {
      return { id: row.id || 'trim', reason: 'Copying or importing a native wall with catalog trim needs review; the SketchUp copy was preserved.' };
    }
  }
  if (trimWalls.size && rows.some(row => !row.id || counts.get(row.id) > 1 || !(prop.walls || []).some(w => w.id === row.id))) {
    return { id: 'trim', reason: 'Native wall copies or additions can change editable trim joints; review them before syncing. The SketchUp copy was preserved.' };
  }
  const fields = ['ax', 'ay', 'bx', 'by', 'thickness', 'height'];
  const changed = rows.filter(row => fields.some(k => Number.isFinite(row.now?.[k]) && Number.isFinite(row.base?.[k]) && Math.abs(row.now[k] - row.base[k]) > 1e-5));
  const deleted = new Set((prop.walls || []).filter(w => read.model?.elements?.[w.id]?.kind === 'wall' && !counts.has(w.id)).map(w => w.id));
  if ((!changed.length && !deleted.size) || !trimWalls.size) return null;
  const byId = new Map(changed.map(row => [row.id, row]));
  const candidate = { ...prop, walls: (prop.walls || []).filter(w => !deleted.has(w.id)).map(w => {
    const row = byId.get(w.id);
    return row ? { ...w, ...Object.fromEntries(fields.map(k => [k, row.now[k]])) } : w;
  }) };
  const geometry = (p, w) => trimMeshes(p, w).map(t => ({ id: t.source.id, meshSig: t.meshSig }));
  const same = (a, b) => JSON.stringify(stableDetail(a)) === JSON.stringify(stableDetail(b));
  for (const wall of prop.walls || []) {
    if (!trimWalls.has(wall.id) || deleted.has(wall.id)) continue;
    const row = byId.get(wall.id), proposed = candidate.walls.find(w => w.id === wall.id);
    const after = geometry(candidate, proposed);
    if (row && (!row.base?.trimState || !same(wallParams(prop, wall).trimState, row.base.trimState) || !same(after, row.base.trimGeometry))) {
      return { id: wall.id, reason: 'This native wall move changes or predates its editable trim geometry; the SketchUp copy was preserved.' };
    }
    if (!same(geometry(prop, wall), after)) {
      return { id: wall.id, reason: 'This native wall move changes a trim mitre against another wall; the SketchUp copy was preserved.' };
    }
  }
  return null;
}

// `read` is the server's reading of the .skp. `synced` maps id -> signature at the last
// moment Tiksi and the .skp agreed; `seenBefore` maps id -> the value the .skp reported last
// time it was read. Both are empty for a mirror written on another machine.
//
// The .skp may have been open in SketchUp while Tiksi rewrote it, so a save can carry stale
// values. SketchUp changed an element only when its value differs from what this very file
// was written from (the group's own record), from the last agreed state, and from what the
// file reported before. Tiksi changed it when it differs from the last agreed state.
// Mutates `prop`; the returned report's `seen` is the next `seenBefore`.
export function mergeMirror(prop, read, synced, seenBefore) {
  synced = synced || {};
  seenBefore = seenBefore || {};
  const written = (read.model && read.model.elements && typeof read.model.elements === 'object') ? read.model.elements : {};
  const report = { ...(read.unsupportedGeometry?.length ? { blockWrite: true } : {}), applied: [], added: [], deleted: [], conflicts: [], warnings: (read.warnings || []).slice(), untagged: read.untagged || null, seen: {} };
  const trimIssue = trimReadbackIssue(prop, read);
  if (trimIssue) {
    report.blockWrite = true;
    report.conflicts.push({ ...trimIssue, kind: 'wall' });
    report.warnings.push(trimIssue.reason);
    return report;
  }
  const before = elementState(prop);
  // A millimetre signature saved before SIG_TAIL stands for `sigNow` (the value's signature
  // today) when it is the millimetre signature of that same value; otherwise it differs from it.
  const upgrade = (stored, kind, params, sigNow) => !stored || current(stored) || !params ? stored
    : stored === LEGACY_SIG[kind](params) ? sigNow : stored;
  const agreedOf = (id, kind) => { const cur = before.get(id);
    return upgrade(synced[id], kind, cur && cur.params, cur && cur.sig) || upgrade(written[id] && written[id].sig, kind, cur && cur.params, cur && cur.sig); };
  const seen = new Set();
  const decide = (id, kind, now, base) => {
    if (['wall', 'room'].includes(kind) && Number.isFinite(now.elevation) && Number.isFinite(base?.elevation) && Math.abs(now.elevation-base.elevation) > .0001) {
      report.conflicts.push({ id, kind, reason: 'Vertical move is unsupported by the limited bridge; SketchUp copy preserved.' });
      report.blockWrite = true; return 'keep';
    }
    const nowSig = readSig[kind](now), fileBase = readSig[kind](base || {}), cur = before.get(id);
    report.seen[id] = nowSig;
    const agreed = agreedOf(id, kind) || fileBase;
    const syncedSig = cur ? upgrade(synced[id], kind, cur.params, cur.sig) : synced[id];
    const skpChanged = nowSig !== fileBase && nowSig !== syncedSig && nowSig !== upgrade(seenBefore[id], kind, now, nowSig);
    if (!cur) {
      if (synced[id] || written[id]) {   // Tiksi deleted it after the last sync
        if (skpChanged) report.conflicts.push({ id, kind, reason: 'deleted in Tiksi, changed in SketchUp; kept deleted' });
        return 'skip';
      }
      return 'add';
    }
    if (!skpChanged || cur.sig === nowSig) return 'keep';
    if (cur.sig !== agreed) { report.conflicts.push({ id, kind, reason: 'changed in both; kept the Tiksi version' }); return 'keep'; }
    return 'apply';
  };

  const wallById = new Map((prop.walls || []).map(w => [w.id, w]));
  for (const rw of read.walls || []) {
    let id = rw.id, action;
    let template = wallById.get(id);
    if (!id || seen.has(id)) { action = 'copy'; }
    else { seen.add(id); action = decide(id, 'wall', rw.now, rw.base); }
    if (action === 'apply') { applyWall(prop, template, rw.now); report.applied.push(id); }
    else if (action === 'copy' || action === 'add') {
      const fresh = Object.assign({}, template || { level: rw.level, material: 'mat-drywall' }, { id: action === 'copy' ? uid('w') : id, height: null });
      if (!(prop.levels || []).some(l => l.id === fresh.level)) fresh.level = (prop.levels[0] || {}).id;
      prop.walls.push(fresh);
      applyWall(prop, fresh, rw.now);
      wallById.set(fresh.id, fresh);
      report.added.push(fresh.id);
      template = fresh;
    }
    for (const ro of rw.openings || []) {
      let oid = ro.id, oaction;
      const parentId = template ? template.id : rw.id;
      if (action === 'copy' || !oid || seen.has(oid)) oaction = 'copy';
      else { seen.add(oid); oaction = decide(oid, 'opening', ro.now, ro.base); }
      const existing = (prop.openings || []).find(o => o.id === oid);
      if (oaction === 'apply') { applyOpening(existing, ro.now, parentId); report.applied.push(oid); }
      else if (oaction === 'copy' || oaction === 'add') {
        const fresh = Object.assign(JSON.parse(JSON.stringify(existing || { type: ro.type === 'window' ? 'window' : 'door' })), { id: oaction === 'copy' ? uid('o') : oid });
        applyOpening(fresh, ro.now, parentId);
        prop.openings.push(fresh);
        report.added.push(fresh.id);
      }
    }
  }
  const roomById = new Map((prop.rooms || []).map(r => [r.id, r]));
  for (const rr of read.rooms || []) {
    let id = rr.id, action;
    if (!id || seen.has(id)) action = 'copy';
    else { seen.add(id); action = decide(id, 'room', rr.now, rr.base); }
    const template = roomById.get(id);
    if (action === 'apply') { applyRoom(template, rr.now); report.applied.push(id); }
    else if (action === 'copy' || action === 'add') {
      const fresh = Object.assign({ material: 'mat-oak', ceilingMaterial: null }, template || { level: rr.level }, { id: action === 'copy' ? uid('r') : id });
      if (!(prop.levels || []).some(l => l.id === fresh.level)) fresh.level = (prop.levels[0] || {}).id;
      applyRoom(fresh, rr.now);
      prop.rooms.push(fresh);
      report.added.push(fresh.id);
    }
  }

  const fixtureById = new Map((prop.fixtures || []).map(f => [f.id, f]));
  for (const rf of read.fixtures || []) {
    let id = rf.id, action;
    if (!id || seen.has(id)) action = 'copy';
    else { seen.add(id); action = decide(id, 'fixture', rf.now, rf.base); }
    const template = fixtureById.get(id);
    if (action === 'apply') { applyFixture(template, rf.now); report.applied.push(id); }
    else if ((action === 'copy' || action === 'add') && (template || (rf.now && rf.now.kind))) {
      const fresh = JSON.parse(JSON.stringify(template || { kind: rf.now.kind, subtype: rf.now.subtype, level: rf.level, provenance: { source: 'user' } }));
      fresh.id = action === 'copy' ? uid('fx') : id;
      if (!(prop.levels || []).some(l => l.id === fresh.level)) fresh.level = (prop.levels[0] || {}).id;
      applyFixture(fresh, rf.now);
      if (!normaliseFixture(fresh)) continue;
      (prop.fixtures = prop.fixtures || []).push(fresh);
      report.added.push(fresh.id);
    }
  }

  // Elements this .skp was written with and no longer holds: deleted in SketchUp. (An
  // element Tiksi added after the file was opened in SketchUp is not in its record.)
  for (const [id, cur] of before) {
    if (seen.has(id) || !written[id]) continue;
    const agreed = agreedOf(id, cur.kind);
    if (cur.sig !== agreed) { report.conflicts.push({ id, kind: cur.kind, reason: 'deleted in SketchUp, changed in Tiksi; kept' }); continue; }
    if (cur.kind === 'wall') {
      prop.walls = prop.walls.filter(w => w.id !== id);
      prop.openings = prop.openings.filter(o => o.wallId !== id);
      if (prop.trims) prop.trims = prop.trims.filter(t => t.wallId !== id);
    } else if (cur.kind === 'opening') prop.openings = prop.openings.filter(o => o.id !== id);
    else if (cur.kind === 'fixture') prop.fixtures = prop.fixtures.filter(f => f.id !== id);
    else prop.rooms = prop.rooms.filter(r => r.id !== id);
    report.deleted.push(id);
  }
  return report;
}

function applyWall(prop, w, now) {
  for (const key of ['profile', 'baseboardPos', 'baseboardNeg']) {
    if (now[key] && typeof now[key] === 'object') w[key] = JSON.parse(JSON.stringify(now[key]));
    else if (Object.hasOwn(now, key) && now[key] === null) delete w[key];
  }
  for (const key of ['materialEndA', 'materialEndB']) {
    if (typeof now[key] === 'string' && now[key]) w[key] = now[key];
    else if (Object.hasOwn(now, key) && now[key] === null) delete w[key];
  }
  for (const k of ['ax', 'ay', 'bx', 'by']) w[k] = round(now[k]);
  if (now.thickness > 0.005) w.thickness = round(now.thickness);
  if (now.height > 0.05) {
    // Keep "follows the level height" when SketchUp left the height alone.
    const lvlH = levelHeight(prop, w.level);
    w.height = w.height == null && Math.abs(now.height - lvlH) < 0.002 ? null : round(now.height);
  }
}

function applyOpening(o, now, wallId) {
  o.wallId = wallId;
  o.t = Math.min(0.999, Math.max(0.001, Math.round(now.t * 1e5) / 1e5));
  if (now.width > 0.05) o.width = round(now.width);
  if (now.height > 0.05) o.height = round(now.height);
  if (o.type === 'window') o.sill = round(Math.max(0, now.sill));
  for (const key of ['profile', 'detail']) if (now[key] && typeof now[key] === 'object') o[key] = JSON.parse(JSON.stringify(now[key]));
  if (now.floorContinuity === false) o.floorContinuity = false;
  if (now.configuration && typeof now.configuration === 'object') {
    for (const key of ['leaves', 'glass', 'doorState', 'plain']) {
      if (Object.hasOwn(now.configuration, key)) o[key] = now.configuration[key];
      else delete o[key];
    }
  }
}

// A fixture moved, turned or stretched in SketchUp. Its own parameters (toe kick, seat
// height, finishes) stay; a size SketchUp reports as collapsed is ignored.
function applyFixture(f, now) {
  if (!now) return;
  if (now.shape === 'box') {
    for (const k of ['x', 'y']) if (Number.isFinite(now[k])) f[k] = round(now[k]);
    if (Number.isFinite(now.rot)) f.rot = Math.round(((now.rot % 360) + 360) % 360 * 100) / 100;
    for (const k of ['w', 'd', 'h']) if (now[k] > 0.02) f[k] = round(now[k]);
  } else if (Array.isArray(now.pts) && now.pts.length >= 2) {
    f.pts = now.pts.map(p => [round(p[0]), round(p[1])]);
    if (now.depth > 0.02) f.depth = round(now.depth);
    if (now.h > 0.02) f.h = round(now.h);
  }
  if (Number.isFinite(now.y0)) f.y0 = round(now.y0);
  if (f.provenance && f.provenance.source === 'scan') f.provenance = Object.assign({}, f.provenance, { source: 'user' });
}

function applyRoom(r, now) {
  if (Number.isFinite(now.ceilingHeight) && now.ceilingHeight > 0) r.ceilingHeight = round(now.ceilingHeight);
  if (Array.isArray(now.pts) && now.pts.length >= 3) r.pts = now.pts.map(p => [round(p[0]), round(p[1])]);
  if (now.name) r.name = String(now.name).slice(0, 120);
}

const round = v => Math.round(v * 1e4) / 1e4;

export function syncedState(prop) {
  const out = {};
  for (const [id, st] of elementState(prop)) out[id] = st.sig;
  return out;
}

// ---------- service and folder ----------

let caps = null, capsAt = 0;
export async function mirrorCapabilities(force) {
  if (!force && caps && Date.now() - capsAt < 60000) return caps;
  try {
    const r = await fetch('/api/model-conversion/capabilities');
    caps = r.ok ? await r.json() : { mirror: false };
  } catch (e) { caps = { mirror: false }; }
  capsAt = Date.now();
  return caps;
}

export class MirrorBusy extends Error {}

async function post(op, body) {
  const cap = await mirrorCapabilities();
  const r = await fetch('/api/model-conversion/mirror', {
    method: 'POST', body,
    headers: { 'X-Tiksi-Token': cap.token || '', 'X-Mirror-Op': op, 'Content-Type': 'application/octet-stream' },
  });
  if (!r.ok) {
    let msg = 'SketchUp mirror ' + op + ' failed (' + r.status + ')';
    try { msg = (await r.json()).error || msg; } catch (e) { /* not JSON */ }
    if (r.status === 403) caps = null;     // server restarted: fetch a fresh token next time
    throw r.status === 409 ? new MirrorBusy(msg) : new Error(msg);
  }
  return r.arrayBuffer();
}

// Ask the local server to open the mirror in SketchUp. The browser cannot say where the
// project folder is, so it describes the file: { name, size, mtime, folder, parent, hint };
// the server finds it (server/sketchup_open.py) and answers { path, app }.
export async function openInSketchUp(file) {
  for (let attempt = 0; ; attempt++) {
    const cap = await mirrorCapabilities(attempt > 0);
    const r = await fetch('/api/model-conversion/open-in-sketchup', {
      method: 'POST', body: JSON.stringify(file),
      headers: { 'X-Tiksi-Token': cap.token || '', 'Content-Type': 'application/json' },
    });
    if (r.ok) return r.json();
    let msg = 'Opening SketchUp failed (' + r.status + ')';
    try { msg = (await r.json()).error || msg; } catch (e) { /* not JSON */ }
    if (r.status === 403 && attempt === 0 && /reconnect/i.test(msg)) continue;   // server restarted: fresh token
    throw new Error(msg);
  }
}

export async function readMirror(buffer) {
  return JSON.parse(new TextDecoder().decode(await post('read', buffer)));
}

export async function writeMirror(spec, existing, underlayFiles) {
  const { zipSync, strToU8 } = await import('three/addons/libs/fflate.module.js');
  const entries = { 'mirror.json': strToU8(JSON.stringify(spec)) };
  if (existing) entries['existing.skp'] = new Uint8Array(existing);
  for (const [name, bytes] of Object.entries(underlayFiles || {})) entries[name] = bytes;
  return post('write', zipSync(entries, { level: 1 }));
}

function dataUrlBytes(url) {
  const m = /^data:image\/(png|jpeg|webp);base64,(.*)$/.exec(url);
  if (!m) return null;
  const bin = atob(m[2]), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return { ext: m[1] === 'jpeg' ? 'jpg' : m[1], bytes: out };
}

// SketchUp reads PNG and JPEG images; underlays rendered from scans are WebP, which its SDK
// rejects (the whole write would fail). Those are re-encoded as JPEG before they are sent.
export async function sketchupImageBytes(url, encode = encodeJpeg) {
  const data = dataUrlBytes(url);
  if (!data || data.ext !== 'webp') return data;
  return { ext: 'jpg', bytes: await encode(data.bytes) };
}

async function encodeJpeg(bytes) {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }));
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    return new Uint8Array(await blob.arrayBuffer());
  } finally { bitmap.close(); }
}

export function mirrorFileName(tiksiName) { return String(tiksiName).replace(/\.tiksi$/i, '') + '.skp'; }

async function fileIn(folder, name) {
  try { const handle = await folder.getFileHandle(name); return { handle, file: await handle.getFile() }; }
  catch (e) { if (e.name === 'NotFoundError') return null; throw e; }
}

// True when the .skp in the folder is not the one Tiksi last wrote or read.
export async function mirrorChangedOnDisk(folder, entry) {
  const ms = entry && entry.mirror;
  if (!ms || !ms.file) return false;
  const got = await fileIn(folder, ms.file);
  return !!got && (got.file.lastModified !== ms.mtime || got.file.size !== ms.size);
}

// One round for one property: read a .skp saved elsewhere, merge it, then write the mirror
// if Tiksi's side is ahead. `entry` is the folder record of the property (files.js); its
// `mirror` field keeps { file, mtime, size, sig, underlays, synced, report, warnings, at }.
// `materials` is the workspace material library the finishes are painted from.
export async function syncMirror(folder, prop, entry, write, materials) {
  const ms = entry.mirror || (entry.mirror = { synced: {}, underlays: {} });
  const name = mirrorFileName(entry.file);
  let report = null, changed = false;
  if (ms.file && ms.file !== name) {           // the property was renamed: move its mirror
    const old = await fileIn(folder, ms.file);
    if (old && !(await fileIn(folder, name))) {
      await write(await folder.getFileHandle(name, { create: true }), new Blob([await old.file.arrayBuffer()]));
      try { await folder.removeEntry(ms.file); } catch (e) { /* the old copy stays */ }
    }
    ms.file = name;
  }
  let got = await fileIn(folder, name);
  if (got && (got.file.lastModified !== ms.mtime || got.file.size !== ms.size)) {
    const read = await readMirror(await got.file.arrayBuffer());
    if (read.model && read.model.propertyId && read.model.propertyId !== prop.id) throw new Error(name + ' mirrors a different Tiksi property');
    report = mergeMirror(prop, read, ms.synced, ms.seen);
    ms.seen = report.seen;
    changed = report.applied.length + report.added.length + report.deleted.length > 0;
    for (const level of Object.keys(ms.underlays || {})) {
      if (!(read.underlays || []).some(u => u.level === level && u.sig === ms.underlays[level])) delete ms.underlays[level];
    }
    ms.mtime = got.file.lastModified; ms.size = got.file.size;
    ms.synced = syncedState(prop);
    ms.report = summarise(report);
    ms.blockWrite = report.blockWrite;
  }
  if (ms.blockWrite) return { changed, report: report || ms.report };
  const spec = mirrorSpec(prop, materials), sig = specSignature(spec);
  const underlayChanged = spec.underlays.some(u => (ms.underlays || {})[u.level] !== u.sig);
  // A mirror saved before SIG_TAIL whose signature is that of today's project, built the old
  // way: the .skp is up to date. Keep the new signatures; rewrite nothing.
  if (got && ms.sig && sig !== ms.sig && !underlayChanged && ms.sig === specSignature(mirrorSpec(prop, materials, true))) {
    ms.sig = sig;
    ms.synced = syncedState(prop);
  }
  if (!got || sig !== ms.sig || underlayChanged) {
    const files = {};
    for (const u of spec.underlays) {
      if (got && ms.underlays && ms.underlays[u.level] === u.sig) continue;   // already in the .skp
      const level = prop.levels.find(l => l.id === u.level), data = level && await sketchupImageBytes(level.plan.img);
      if (!data) continue;
      u.file = 'underlay/' + u.level + '.' + data.ext;
      files[u.file] = data.bytes;
    }
    const bytes = await writeMirror(spec, got ? await got.file.arrayBuffer() : null, files);
    // Retain the entire prior SketchUp file, including edits the limited reader cannot represent.
    if (got && !folder.preservesMirrorVersions) await write(await folder.getFileHandle(name.replace(/\.skp$/i, '') + '.before-sync-' + Date.now() + '.skp', { create: true }), new Blob([await got.file.arrayBuffer()]));
    const handle = got ? got.handle : await folder.getFileHandle(name, { create: true });
    await write(handle, new Blob([bytes]));
    const f = await handle.getFile();
    Object.assign(ms, { file: name, mtime: f.lastModified, size: f.size, sig, at: Date.now(), warnings: spec.warnings.slice(0, 10) });
    ms.underlays = Object.fromEntries(spec.underlays.map(u => [u.level, u.sig]));
    ms.synced = syncedState(prop);
  }
  ms.file = name;
  return { changed, report };
}

function summarise(r) {
  return { at: Date.now(), applied: r.applied.length, added: r.added.length, deleted: r.deleted.length,
    conflicts: r.conflicts.slice(0, 20), warnings: r.warnings.slice(0, 10), untagged: r.untagged };
}
