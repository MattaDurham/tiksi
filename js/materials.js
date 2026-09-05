// Material library (v2 records). Users can add custom materials; ids are stable strings so demo
// data and user models can reference them. The 13 original builtin ids are sacred.
//
// Record: { id, name, kind: 'wall'|'floor'|'ceiling'|'trim'|'any', color, pattern, tile: [w, h] (m),
//           roughness, metalness, normalScale, accent|null, photoId|null, custom }
// `color` is always present: the 2D plan and cut sheets use it; the 3D textures bake it as the tint.

import { ws, uid, touch, escapeHtml, fmtLen } from './store.js';
import { swatchUrl } from './textures.js';

export const KINDS = ['wall', 'floor', 'ceiling', 'trim', 'any'];
export const PATTERNS = ['flat', 'drywall', 'plaster', 'brick', 'cmu', 'stone', 'wood', 'tile', 'concrete', 'carpet', 'siding', 'board', 'marble', 'metal', 'glass', 'photo'];

export const PATTERN_LABELS = {
  flat: 'Flat paint', drywall: 'Drywall / paint', plaster: 'Plaster', brick: 'Brick', cmu: 'Concrete block', stone: 'Stone',
  wood: 'Wood plank', tile: 'Tile', concrete: 'Concrete', carpet: 'Carpet', siding: 'Lap siding', board: 'Board & batten',
  marble: 'Marble / quartz', metal: 'Metal', glass: 'Glass', photo: 'From photo',
};

// Sensible physical defaults per pattern; used to fill v1 records and freshly created ones.
const PATTERN_DEFAULTS = {
  flat:     { tile: [1, 1],       roughness: 0.8,  metalness: 0, normalScale: 0 },
  drywall:  { tile: [1, 1],       roughness: 0.92, metalness: 0, normalScale: 0.6 },
  plaster:  { tile: [1.2, 1.2],   roughness: 0.7,  metalness: 0, normalScale: 0.8 },
  brick:    { tile: [0.84, 0.6],  roughness: 0.85, metalness: 0, normalScale: 1 },
  cmu:      { tile: [0.8, 0.4],   roughness: 0.9,  metalness: 0, normalScale: 0.8 },
  stone:    { tile: [1.2, 0.9],   roughness: 0.9,  metalness: 0, normalScale: 1.2 },
  wood:     { tile: [1.8, 0.9],   roughness: 0.55, metalness: 0, normalScale: 1 },
  tile:     { tile: [0.6, 0.6],   roughness: 0.3,  metalness: 0, normalScale: 0.6 },
  concrete: { tile: [1.2, 1.2],   roughness: 0.85, metalness: 0, normalScale: 0.8 },
  carpet:   { tile: [0.6, 0.6],   roughness: 1,    metalness: 0, normalScale: 0.6 },
  siding:   { tile: [2.4, 0.6],   roughness: 0.75, metalness: 0, normalScale: 1 },
  board:    { tile: [1.2, 1.2],   roughness: 0.75, metalness: 0, normalScale: 1 },
  marble:   { tile: [1.2, 1.2],   roughness: 0.15, metalness: 0, normalScale: 0.3 },
  metal:    { tile: [1, 1],       roughness: 0.35, metalness: 1, normalScale: 0.3 },
  glass:    { tile: [1, 1],       roughness: 0.05, metalness: 0, normalScale: 0 },
  photo:    { tile: [1, 1],       roughness: 0.8,  metalness: 0, normalScale: 0.6 },
};

const M = (id, name, kind, color, pattern, tile, roughness, metalness, normalScale, accent) =>
  ({ id, name, kind, color, pattern, tile, roughness, metalness, normalScale, accent: accent || null, photoId: null, custom: false });

export const BUILTIN_MATERIALS = [
  // The original thirteen (ids referenced by demo data and user models).
  M('mat-drywall',  'Drywall, painted',          'wall',  '#d8d4cc', 'drywall',  [1, 1],        0.92, 0, 0.6),
  M('mat-plaster',  'Plaster, lime',             'wall',  '#cfc8bb', 'plaster',  [1.2, 1.2],    0.7,  0, 0.8),
  M('mat-brick',    'Brick, red',                'wall',  '#9c5a44', 'brick',    [0.84, 0.6],   0.85, 0, 1,   '#b6ada0'),
  M('mat-cmu',      'Concrete block',            'wall',  '#8f9296', 'cmu',      [0.8, 0.4],    0.9,  0, 0.8, '#7f8286'),
  M('mat-cedar',    'Cedar lap siding',          'wall',  '#a97b50', 'siding',   [2.4, 0.6],    0.8,  0, 1,   '#7d5a3c'),
  M('mat-fiber',    'Fiber cement lap siding',   'wall',  '#b9bfc3', 'siding',   [2.4, 0.6],    0.75, 0, 0.8),
  M('mat-tile-w',   'Subway tile, 3x6 gloss',    'wall',  '#e8ebe9', 'tile',     [0.305, 0.152],0.15, 0, 0.6, '#cfd0cb'),
  M('mat-oak',      'White oak flooring',        'floor', '#c9a06a', 'wood',     [1.8, 0.9],    0.55, 0, 1),
  M('mat-walnut',   'Walnut flooring',           'floor', '#6e4a33', 'wood',     [1.8, 0.9],    0.5,  0, 0.8, '#4a3325'),
  M('mat-tile-f',   'Porcelain tile, 12x24',     'floor', '#a8adb0', 'tile',     [1.22, 0.61],  0.3,  0, 0.5, '#8f9396'),
  M('mat-concrete', 'Concrete slab, broomed',    'floor', '#97999b', 'concrete', [1.2, 1.2],    0.9,  0, 0.8),
  M('mat-carpet',   'Carpet, grey loop',         'floor', '#7d8894', 'carpet',   [0.6, 0.6],    1,    0, 0.6),
  M('mat-lvp',      'Luxury vinyl plank',        'floor', '#b39067', 'wood',     [1.8, 0.9],    0.45, 0, 0.5),
  // Ceiling and trim (the 3D viewer relies on these two ids).
  M('mat-ceiling',  'Ceiling, flat white',       'ceiling', '#f2f1ec', 'drywall', [1, 1],       0.96, 0, 0.4),
  M('mat-shiplap',  'Shiplap ceiling',           'ceiling', '#ebe8e0', 'siding',  [2.4, 0.56],  0.7,  0, 0.8),
  M('mat-trim',     'Trim, painted semi-gloss',  'trim',  '#f4f2ec', 'flat',     [1, 1],        0.35, 0, 0),
  M('mat-trim-oak', 'Trim, clear oak',           'trim',  '#c8a577', 'wood',     [1.2, 0.3],    0.45, 0, 0.6),
  // Interior paints.
  M('mat-paint-white',    'Paint, warm white',   'wall',  '#f3f1eb', 'drywall',  [1, 1],        0.93, 0, 0.5),
  M('mat-paint-greige',   'Paint, greige',       'wall',  '#cbc4b5', 'drywall',  [1, 1],        0.93, 0, 0.5),
  M('mat-paint-sage',     'Paint, sage green',   'wall',  '#9ba894', 'drywall',  [1, 1],        0.93, 0, 0.5),
  M('mat-paint-navy',     'Paint, deep navy',    'wall',  '#3d4b5c', 'drywall',  [1, 1],        0.9,  0, 0.5),
  M('mat-paint-charcoal', 'Paint, charcoal',     'wall',  '#45464a', 'drywall',  [1, 1],        0.9,  0, 0.5),
  M('mat-paint-terra',    'Paint, terracotta',   'wall',  '#b8735a', 'drywall',  [1, 1],        0.93, 0, 0.5),
  // Masonry.
  M('mat-brick-white', 'Whitewashed brick',      'wall',  '#ded7cc', 'brick',    [0.84, 0.6],   0.85, 0, 0.9, '#cdc6ba'),
  M('mat-fieldstone',  'Fieldstone',             'wall',  '#8e8779', 'stone',    [1.2, 0.9],    0.9,  0, 1.2, '#a69c8c'),
  M('mat-limestone',   'Limestone ashlar',       'wall',  '#d0c6b1', 'stone',    [1.2, 0.6],    0.8,  0, 0.8, '#bfb5a2'),
  // Woods.
  M('mat-maple',   'Maple flooring',             'floor', '#dcbf93', 'wood',     [1.8, 0.9],    0.5,  0, 0.7),
  M('mat-hickory', 'Hickory flooring',           'floor', '#b6864f', 'wood',     [1.8, 0.9],    0.55, 0, 1,   '#7a5636'),
  M('mat-pine',    'Heart pine, wide plank',     'floor', '#c7935a', 'wood',     [2.4, 1.2],    0.6,  0, 1),
  M('mat-barn',    'Reclaimed barn wood',        'any',   '#8b7663', 'wood',     [2.4, 0.9],    0.85, 0, 1.3, '#5b4e42'),
  // Tile and stone floors.
  M('mat-hex',      'Hex mosaic, white',         'any',   '#eeece6', 'tile',     [0.3, 0.26],   0.2,  0, 0.6, '#b7b5ad'),
  M('mat-zellige',  'Zellige tile, sea glass',   'wall',  '#bcd6cf', 'tile',     [0.2, 0.2],    0.12, 0, 0.9, '#c9c4b6'),
  M('mat-terrazzo', 'Terrazzo',                  'floor', '#d8d3c8', 'tile',     [0.9, 0.9],    0.25, 0, 0.3, '#6f6a66'),
  M('mat-slate',    'Slate tile',                'floor', '#4d5359', 'tile',     [0.6, 0.6],    0.8,  0, 1.2, '#3a3d41'),
  M('mat-concrete-pol', 'Polished concrete',     'floor', '#a3a4a1', 'concrete', [1.5, 1.5],    0.35, 0, 0.4),
  M('mat-carpet-wool',  'Wool carpet',           'floor', '#b9ae9d', 'carpet',   [0.6, 0.6],    1,    0, 0.7, '#9c9282'),
  // Surfaces and metals (kind any: counters, hoods, roofs).
  M('mat-marble',      'Carrara marble',         'any',   '#e7e4e0', 'marble',   [1.2, 1.2],    0.15, 0, 0.3, '#8d939b'),
  M('mat-quartz',      'Quartz countertop',      'any',   '#ede9e1', 'marble',   [1.2, 1.2],    0.2,  0, 0.2, '#c9c3b8'),
  M('mat-stainless',   'Stainless steel',        'any',   '#c9cbcd', 'metal',    [1, 1],        0.35, 1, 0.3),
  M('mat-steel-black', 'Blackened steel',        'any',   '#2c2d2f', 'metal',    [1, 1],        0.5,  0.9, 0.5, '#4a3e34'),
  M('mat-roof-seam',   'Standing-seam roof',     'any',   '#4b5157', 'metal',    [1.6, 1.6],    0.5,  0.7, 1),
  M('mat-glass',       'Glass, clear',           'any',   '#d2e7ee', 'glass',    [1, 1],        0.05, 0, 0),
  // Exterior cladding.
  M('mat-batten',    'Board and batten',         'wall',  '#e6e2d9', 'board',    [1.2, 1.2],    0.75, 0, 1),
  M('mat-clapboard', 'Painted clapboard',        'wall',  '#d8d1bf', 'siding',   [2.4, 0.5],    0.6,  0, 0.9),
];

const BUILTIN_BY_ID = new Map(BUILTIN_MATERIALS.map(m => [m.id, m]));
export function builtinById(id) { return BUILTIN_BY_ID.get(id) || null; }

function clone(m) { return JSON.parse(JSON.stringify(m)); }
function isHex(c) { return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c); }
function numOr(v, d) { const n = +v; return (v == null || isNaN(n)) ? d : n; }

// Guess a pattern from free text (custom v1 records only carried a name).
const PATTERN_WORDS = [
  ['glass', ['glass', 'glazing']],
  ['marble', ['marble', 'quartz', 'granite', 'soapstone', 'solid surface', 'countertop', 'counter']],
  ['metal', ['stainless', 'steel', 'metal', 'aluminum', 'aluminium', 'copper', 'brass', 'bronze', 'iron', 'zinc', 'chrome']],
  ['brick', ['brick']],
  ['cmu', ['block', 'cmu', 'cinder']],
  ['siding', ['siding', 'clapboard', 'shiplap', 'lap board', 'fiber cement', 'fibre cement', 'hardie']],
  ['board', ['batten', 'panel', 'wainscot', 'beadboard', 'bead board', 'slat']],
  ['tile', ['tile', 'porcelain', 'ceramic', 'subway', 'mosaic', 'hex', 'terrazzo', 'slate', 'zellige', 'penny']],
  ['stone', ['stone', 'ashlar', 'limestone', 'fieldstone', 'sandstone', 'bluestone', 'rubble']],
  ['wood', ['oak', 'walnut', 'maple', 'hickory', 'pine', 'plank', 'wood', 'hardwood', 'vinyl', 'lvp', 'laminate', 'bamboo', 'cork', 'ash', 'cherry', 'teak', 'fir', 'cedar', 'barn']],
  ['concrete', ['concrete', 'cement', 'slab', 'screed']],
  ['carpet', ['carpet', 'rug', 'wool', 'berber']],
  ['plaster', ['plaster', 'stucco', 'venetian', 'tadelakt', 'limewash', 'lime wash']],
  ['drywall', ['paint', 'drywall', 'gypsum', 'sheetrock']],
];
export function inferPattern(name, kind) {
  const s = String(name || '').toLowerCase();
  for (const [pattern, words] of PATTERN_WORDS) if (words.some(w => s.includes(w))) return pattern;
  return (kind === 'wall' || kind === 'ceiling') ? 'drywall' : 'flat';
}

// Fill any missing v2 field in place (v1 records, hand-edited JSON, half-built customs).
export function normalizeMaterial(m) {
  if (!m || typeof m !== 'object') return m;
  if (!KINDS.includes(m.kind)) m.kind = 'any';
  if (!isHex(m.color)) m.color = '#c9c2b6';
  if (!PATTERNS.includes(m.pattern)) m.pattern = inferPattern(m.name, m.kind);
  const d = PATTERN_DEFAULTS[m.pattern];
  if (!Array.isArray(m.tile) || m.tile.length !== 2 || !(numOr(m.tile[0], 0) > 0) || !(numOr(m.tile[1], 0) > 0)) m.tile = d.tile.slice();
  else m.tile = [+m.tile[0], +m.tile[1]];
  m.roughness = Math.min(1, Math.max(0, numOr(m.roughness, d.roughness)));
  m.metalness = Math.min(1, Math.max(0, numOr(m.metalness, d.metalness)));
  m.normalScale = Math.min(2, Math.max(0, numOr(m.normalScale, d.normalScale)));
  if (!isHex(m.accent)) m.accent = null;
  if (typeof m.photoId !== 'string' || !m.photoId) m.photoId = null;
  if (m.custom !== true) m.custom = !BUILTIN_BY_ID.has(m.id);
  if (typeof m.name !== 'string' || !m.name.trim()) m.name = 'Material';
  return m;
}

// Ids land in attribute templates (option values, data-* hooks) and in cache keys, so a hostile or
// malformed id from an imported file is replaced before any view renders, and every wall, room and
// property field that pointed at it follows. Same rule as store.js migrate() uses for record ids.
const ID_OK = /^[\w.:-]{1,80}$/;

function remapMaterialId(from, to) {
  for (const p of ws.data.properties) {
    const swap = o => { for (const k of Object.keys(o)) if (/material/i.test(k) && o[k] === from) o[k] = to; };
    (p.walls || []).forEach(swap);
    (p.rooms || []).forEach(swap);
    swap(p);
  }
}

function sanitizeMaterialIds(list) {
  const seen = new Set();
  for (const m of list) {
    const ok = typeof m.id === 'string' && ID_OK.test(m.id);
    if (ok && !seen.has(m.id)) { seen.add(m.id); continue; }
    const old = m.id;
    m.id = uid('mat');
    seen.add(m.id);
    // A duplicate keeps pointing at the first record; only an invalid id drags its references along.
    if (!ok && typeof old === 'string' && old) remapMaterialId(old, m.id);
  }
}

export function ensureBuiltinMaterials() {
  const list = ws.data.materials;
  sanitizeMaterialIds(list);
  for (const m of list) {
    const b = BUILTIN_BY_ID.get(m.id);
    if (b && m.pattern == null) {
      // v1 builtin: adopt the full v2 definition (v1 had no UI to edit builtins, so nothing is lost).
      const color = isHex(m.color) ? m.color : b.color;
      Object.assign(m, clone(b), { color });
    }
    normalizeMaterial(m);
  }
  const have = new Set(list.map(m => m.id));
  for (const b of BUILTIN_MATERIALS) if (!have.has(b.id)) list.push(clone(b));
}

export function materialsFor(kind) {
  return ws.data.materials.filter(m => !kind || m.kind === kind || m.kind === 'any');
}

export function addCustomMaterial(name, color, kind) {
  const m = normalizeMaterial({ id: uid('mat'), name, color, kind: kind || 'any', custom: true });
  ws.data.materials.push(m);
  touch();
  return m;
}

// Blank record for the editor: pattern follows the kind so the first preview already looks right.
export function newMaterial(kind) {
  kind = KINDS.includes(kind) ? kind : 'any';
  const pattern = kind === 'floor' ? 'wood' : kind === 'trim' ? 'flat' : 'drywall';
  const color = { wall: '#d6d0c4', floor: '#b8945f', ceiling: '#f0eee8', trim: '#f2f0ea', any: '#b9b2a6' }[kind];
  const m = normalizeMaterial({ id: uid('mat'), name: 'New material', color, kind, pattern, custom: true });
  ws.data.materials.push(m);
  touch();
  return m;
}

export function duplicateMaterial(id) {
  const src = ws.data.materials.find(m => m.id === id);
  if (!src) return null;
  const m = Object.assign(clone(src), { id: uid('mat'), name: src.name + ' copy', custom: true });
  const i = ws.data.materials.indexOf(src);
  ws.data.materials.splice(i + 1, 0, m);
  touch();
  return m;
}

// Everything in the workspace that references a material id: walls, rooms and any future
// `...Material` field on properties (ceiling/trim), so deletion can refuse with a list.
export function materialUsage(id) {
  const out = [];
  for (const p of ws.data.properties) {
    for (const w of p.walls || []) {
      for (const k of Object.keys(w)) if (/material/i.test(k) && w[k] === id) {
        out.push({ propertyId: p.id, property: p.name, kind: 'wall', id: w.id, label: 'Wall ' + fmtLen(Math.hypot(w.bx - w.ax, w.by - w.ay), { short: true }) });
      }
    }
    for (const r of p.rooms || []) {
      for (const k of Object.keys(r)) if (/material/i.test(k) && r[k] === id) {
        out.push({ propertyId: p.id, property: p.name, kind: 'room', id: r.id, label: (r.name || 'Room') + (k === 'material' ? ' floor' : ' ' + k.replace(/material/i, '').toLowerCase()) });
      }
    }
    for (const k of Object.keys(p)) if (/material/i.test(k) && p[k] === id) {
      out.push({ propertyId: p.id, property: p.name, kind: 'property', id: p.id, label: 'Property ' + k.replace(/material/i, '').toLowerCase() });
    }
  }
  return out;
}

// Returns null on success, or a message describing where the material is still used.
export function deleteMaterial(id) {
  const m = ws.data.materials.find(x => x.id === id);
  if (!m) return 'Material not found.';
  if (!m.custom) return 'Built-in materials cannot be deleted. Use RESET TO DEFAULT to undo edits.';
  const uses = materialUsage(id);
  if (uses.length) {
    const where = uses.slice(0, 8).map(u => u.label + ' (' + u.property + ')').join(', ');
    return 'Still in use by ' + uses.length + ' element' + (uses.length === 1 ? '' : 's') + ': ' + where + (uses.length > 8 ? ', ...' : '') + '. Reassign those first.';
  }
  ws.data.materials = ws.data.materials.filter(x => x.id !== id);
  touch();
  return null;
}

export function resetBuiltin(id) {
  const m = ws.data.materials.find(x => x.id === id);
  const b = BUILTIN_BY_ID.get(id);
  if (!m || !b) return false;
  for (const k of Object.keys(m)) if (!(k in b)) delete m[k];
  Object.assign(m, clone(b));
  touch();
  return true;
}

// ---------- pickers ----------
// Everything of the kind (or 'any'), plus whatever is assigned right now even when its kind no
// longer matches: the editor can re-kind a material that walls or rooms still use, and imported
// data can assign anything. Dropping it would show "(none)" for a surface that still has a
// material and let the first change silently discard it.
function pickerList(kind, selectedId) {
  const list = materialsFor(kind);
  if (selectedId && !list.some(m => m.id === selectedId)) {
    const cur = ws.data.materials.find(m => m.id === selectedId);
    if (cur) list.unshift(cur);
  }
  return list;
}
function optionLabel(m, kind) {
  const off = kind && m.kind !== kind && m.kind !== 'any';
  return escapeHtml(m.name) + (off ? ' (' + escapeHtml(m.kind) + ')' : '');
}

export function materialSelectHtml(kind, selectedId, attrs) {
  const opts = pickerList(kind, selectedId).map(m =>
    `<option value="${escapeHtml(m.id)}" ${m.id === selectedId ? 'selected' : ''}>${optionLabel(m, kind)}</option>`
  ).join('');
  return `<select ${attrs || ''}><option value="">(none)</option>${opts}</select>`;
}

// Select + a strip of rendered swatches. Bind with bindMaterialPicker(root, onChange) so either
// control updates the other; swatches render lazily (flat colour first, lit chip when ready).
export function materialPickerHtml(kind, selectedId, attrs) {
  const chips = pickerList(kind, selectedId).map(m =>
    `<button type="button" class="mat-pick ${m.id === selectedId ? 'active' : ''}" data-mat-pick="${escapeHtml(m.id)}" title="${escapeHtml(m.name)}" style="background:${escapeHtml(m.color)}"><img alt="" hidden></button>`
  ).join('');
  return `<div class="mat-picker" data-kind="${escapeHtml(kind || '')}">${materialSelectHtml(kind, selectedId, attrs)}<div class="mat-picker-strip">${chips}</div></div>`;
}

export function bindMaterialPicker(rootEl, onChange) {
  if (!rootEl) return;
  const pickers = rootEl.matches && rootEl.matches('.mat-picker') ? [rootEl] : Array.from(rootEl.querySelectorAll('.mat-picker'));
  for (const pk of pickers) {
    const sel = pk.querySelector('select');
    const chips = Array.from(pk.querySelectorAll('[data-mat-pick]'));
    const sync = () => chips.forEach(c => c.classList.toggle('active', c.dataset.matPick === sel.value));
    sel.addEventListener('change', () => { sync(); if (onChange) onChange(sel.value || null); });
    for (const c of chips) {
      c.onclick = () => {
        sel.value = c.dataset.matPick;
        sync();
        if (onChange) onChange(sel.value || null);
      };
      const m = ws.data.materials.find(x => x.id === c.dataset.matPick);
      if (!m) continue;
      const img = c.querySelector('img');
      const show = url => { if (url && img) { img.src = url; img.hidden = false; } };
      show(swatchUrl(m, 48, show));
    }
  }
}
