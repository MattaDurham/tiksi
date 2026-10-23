// SketchUp mirror. With a project folder linked and the local server able to reach an
// installed SketchUp, every <name>.tiksi in the folder has a <name>.skp beside it:
//
//   Tiksi -> SketchUp   each wall is a group (its openings cut, a nested group per opening),
//                       each room a floor group, each level a tag, each plan underlay an
//                       image. Groups carry a "tiksi" dictionary: their id and the values
//                       they were written from.
//   SketchUp -> Tiksi   when the .skp changes on disk (saved in SketchUp), its groups are
//                       read back and merged element by element against the last state
//                       both sides agreed on: moved, stretched, raised, renamed and deleted
//                       groups update Tiksi; a copied group becomes a new element.
//
// Geometry drawn in SketchUp outside the Tiksi groups is kept in the .skp across rewrites
// and is not brought into the plan. When both sides changed the same element, Tiksi keeps
// its version and the conflict is reported. The pure parts here (spec, signatures, merge)
// run under Node for tests; the rest talks to /api/model-conversion/mirror.

import { wallHeightOf, levelOfWall, levelOfRoom, levelHeight, uid } from './store.js';
import { openingSpans } from './wall-solids.js';

export const MIRROR_FORMAT = 'tiksi-sketchup-mirror';
const mm = v => Math.round(Number(v || 0) * 1000);           // signatures compare to the millimetre
const permille = v => Math.round(Number(v || 0) * 2000);     // opening position, to 1/2000 of the wall

// ---------- spec: what the .skp should contain ----------

// Opening values as the mirror sees them: cut from Tiksi's own spans, so a clamped or
// shortened opening reads back exactly as it was drawn.
function openingParams(o, s0, s1, L, H) {
  const v0 = o.type === 'window' ? Math.max(0, o.sill || 0) : 0;
  const v1 = Math.min(v0 + (o.height || 0), H);
  return { wallId: o.wallId, t: (s0 + s1) / 2 / L, width: s1 - s0, height: v1 - v0, sill: v0, s0, s1, v0, v1 };
}

function wallParams(prop, w) {
  return { ax: w.ax, ay: w.ay, bx: w.bx, by: w.by, thickness: w.thickness || 0.114, height: wallHeightOf(prop, w) };
}

// Every element the mirror carries, with comparable signatures: id -> { kind, sig, params }.
export function elementState(prop) {
  const out = new Map();
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
    out.set(r.id, { kind: 'room', sig: roomSig(p), params: p });
  }
  return out;
}

export function wallSig(p) { return ['wall', mm(p.ax), mm(p.ay), mm(p.bx), mm(p.by), mm(p.thickness), mm(p.height)].join(','); }
export function openingSig(p) { return ['opening', p.wallId, permille(p.t), mm(p.width), mm(p.height), mm(p.sill)].join(','); }
export function roomSig(p) { return ['room', p.name || '', ...(p.pts || []).map(q => mm(q[0]) + ':' + mm(q[1]))].join(','); }

export function mirrorSpec(prop) {
  const state = elementState(prop);
  const walls = [];
  for (const w of prop.walls || []) {
    const st = state.get(w.id);
    if (!st) continue;
    const lvl = levelOfWall(prop, w);
    const holes = (prop.openings || []).filter(o => o.wallId === w.id && state.has(o.id)).map(o => {
      const p = state.get(o.id).params;
      return { id: o.id, type: o.type, t: p.t, width: p.width, height: p.height, sill: p.sill, s0: p.s0, s1: p.s1, v0: p.v0, v1: p.v1 };
    });
    walls.push(Object.assign({ id: w.id, level: lvl.id, elevation: lvl.elevation, name: 'Wall ' + w.id, holes }, st.params));
  }
  const rooms = (prop.rooms || []).filter(r => state.has(r.id)).map(r => {
    const lvl = levelOfRoom(prop, r);
    return { id: r.id, level: lvl.id, elevation: lvl.elevation, name: r.name || '', pts: state.get(r.id).params.pts };
  });
  const elements = {};
  for (const [id, st] of state) elements[id] = { kind: st.kind, sig: st.sig };
  return {
    format: MIRROR_FORMAT, version: 1,
    property: { id: prop.id, name: prop.name || '' },
    levels: (prop.levels || []).map(l => ({ id: l.id, name: l.name, elevation: l.elevation, height: l.height })),
    walls, rooms, elements,
    underlays: (prop.levels || []).map(l => underlayOf(l)).filter(Boolean),
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

export function specSignature(spec) {
  return hash(JSON.stringify(Object.assign({}, spec, { underlays: spec.underlays.map(u => u.sig) })));
}

// ---------- merge: SketchUp's version into the property ----------

const readSig = {
  wall: p => wallSig(p),
  opening: p => openingSig(p),
  room: p => roomSig(p),
};

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
  const report = { applied: [], added: [], deleted: [], conflicts: [], warnings: (read.warnings || []).slice(), untagged: read.untagged || null, seen: {} };
  const before = elementState(prop);
  const seen = new Set();
  const decide = (id, kind, now, base) => {
    const nowSig = readSig[kind](now), fileBase = readSig[kind](base || {}), cur = before.get(id);
    report.seen[id] = nowSig;
    const agreed = synced[id] || (written[id] && written[id].sig) || fileBase;
    const skpChanged = nowSig !== fileBase && nowSig !== synced[id] && nowSig !== seenBefore[id];
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
        const fresh = Object.assign({}, existing || { type: ro.type === 'window' ? 'window' : 'door' }, { id: oaction === 'copy' ? uid('o') : oid });
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

  // Elements this .skp was written with and no longer holds: deleted in SketchUp. (An
  // element Tiksi added after the file was opened in SketchUp is not in its record.)
  for (const [id, cur] of before) {
    if (seen.has(id) || !written[id]) continue;
    const agreed = synced[id] || written[id].sig;
    if (cur.sig !== agreed) { report.conflicts.push({ id, kind: cur.kind, reason: 'deleted in SketchUp, changed in Tiksi; kept' }); continue; }
    if (cur.kind === 'wall') {
      prop.walls = prop.walls.filter(w => w.id !== id);
      prop.openings = prop.openings.filter(o => o.wallId !== id);
    } else if (cur.kind === 'opening') prop.openings = prop.openings.filter(o => o.id !== id);
    else prop.rooms = prop.rooms.filter(r => r.id !== id);
    report.deleted.push(id);
  }
  return report;
}

function applyWall(prop, w, now) {
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
}

function applyRoom(r, now) {
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
// `mirror` field keeps { file, mtime, size, sig, underlays, synced, report, at }.
export async function syncMirror(folder, prop, entry, write) {
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
  }
  const spec = mirrorSpec(prop), sig = specSignature(spec);
  const underlayChanged = spec.underlays.some(u => (ms.underlays || {})[u.level] !== u.sig);
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
    const handle = got ? got.handle : await folder.getFileHandle(name, { create: true });
    await write(handle, new Blob([bytes]));
    const f = await handle.getFile();
    Object.assign(ms, { file: name, mtime: f.lastModified, size: f.size, sig, at: Date.now() });
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
