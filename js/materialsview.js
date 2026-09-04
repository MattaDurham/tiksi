// MATERIALS view: the library as a wall of sample chips, with an editor that previews the
// procedural PBR material live (sphere + cube + ground under a studio environment).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { ws, touch, activeProperty, escapeHtml, fmtLen, parseLen } from './store.js';
import {
  KINDS, PATTERNS, PATTERN_LABELS, builtinById, normalizeMaterial, newMaterial, duplicateMaterial,
  deleteMaterial, resetBuiltin, materialUsage,
} from './materials.js';
import { materialFor, swatchUrl, pendingTextureJobs } from './textures.js';
import { addPhotoFromFile, photoById } from './photos-store.js';

const FILTERS = ['all', 'wall', 'floor', 'ceiling', 'trim', 'any'];
const CARD_SWATCH = 160;

let el = null, gridEl = null, edEl = null, countEl = null;
let editingId = null;
let query = '', kindFilter = 'all';
let preview = null;          // live three.js preview, created on first editor open
let regenTimer = 0;
let notice = '';             // one-line message inside the editor (delete refusals etc.)
let onKey = null;

export function mount(root) {
  el = root;
  root.innerHTML = `
    <div class="mv">
      <div class="mv-head">
        <div class="mv-title-row">
          <span class="view-title">MATERIALS</span>
          <span class="view-sub" data-count></span>
        </div>
        <div class="mv-tools">
          <input type="text" class="search-input mv-search" placeholder="search materials..." value="${escapeHtml(query)}">
          <div class="mv-chips">${FILTERS.map(f => `<button type="button" class="mv-chip-btn ${f === kindFilter ? 'active' : ''}" data-filter="${f}">${f.toUpperCase()}</button>`).join('')}</div>
          <span class="sp"></span>
          <button type="button" class="btn primary" data-new>NEW MATERIAL</button>
        </div>
      </div>
      <div class="mv-body">
        <div class="mv-grid-scroll"><div class="mv-grid"></div></div>
        <aside class="mv-editor" hidden></aside>
      </div>
    </div>`;
  gridEl = root.querySelector('.mv-grid');
  edEl = root.querySelector('.mv-editor');
  countEl = root.querySelector('[data-count]');

  const search = root.querySelector('.mv-search');
  search.oninput = () => { query = search.value; renderGrid(); };
  root.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => {
    kindFilter = b.dataset.filter;
    root.querySelectorAll('[data-filter]').forEach(x => x.classList.toggle('active', x === b));
    renderGrid();
  });
  root.querySelector('[data-new]').onclick = () => {
    const m = newMaterial(kindFilter === 'all' ? 'wall' : kindFilter);
    openEditor(m.id, true);
    renderGrid();
  };
  onKey = e => { if (e.key === 'Escape' && editingId) closeEditor(); };
  window.addEventListener('keydown', onKey);

  renderGrid();
  if (editingId && ws.data.materials.some(m => m.id === editingId)) openEditor(editingId); else editingId = null;
}

export function unmount() {
  clearTimeout(regenTimer);
  if (onKey) window.removeEventListener('keydown', onKey);
  onKey = null;
  destroyPreview();
  el = null; gridEl = null; edEl = null; countEl = null;
}

// ---------- library grid ----------
function usageCounts() {
  const counts = {};
  for (const p of ws.data.properties) {
    const bump = o => { for (const k of Object.keys(o)) if (/material/i.test(k) && typeof o[k] === 'string' && o[k]) counts[o[k]] = (counts[o[k]] || 0) + 1; };
    (p.walls || []).forEach(bump);
    (p.rooms || []).forEach(bump);
    bump(p);
  }
  return counts;
}

function filtered() {
  const q = query.trim().toLowerCase();
  return ws.data.materials.filter(m => {
    if (kindFilter !== 'all' && m.kind !== kindFilter) return false;
    if (!q) return true;
    return [m.name, m.kind, m.pattern, PATTERN_LABELS[m.pattern] || '', m.custom ? 'custom' : 'built-in'].join(' ').toLowerCase().includes(q);
  });
}

function renderGrid() {
  if (!gridEl) return;
  const counts = usageCounts();
  const list = filtered();
  const inUse = ws.data.materials.filter(m => counts[m.id]).length;
  countEl.textContent = `${ws.data.materials.length} materials · ${inUse} in use · procedural PBR, nothing leaves this browser`;
  if (!list.length) {
    gridEl.innerHTML = `<div class="mv-empty">
      <div class="kicker">NO MATCHES</div>
      <p>${ws.data.materials.length ? 'Nothing matches ' + (query ? '"' + escapeHtml(query) + '"' : 'that filter') + '.' : 'The library is empty.'}
      Try another filter, or create one with NEW MATERIAL.</p></div>`;
    return;
  }
  gridEl.innerHTML = list.map(m => cardHtml(m, counts[m.id] || 0)).join('');
  gridEl.querySelectorAll('.mv-card').forEach(card => {
    card.onclick = () => openEditor(card.dataset.id);
    const m = ws.data.materials.find(x => x.id === card.dataset.id);
    loadSwatch(card, m);
  });
}

function cardHtml(m, uses) {
  const label = PATTERN_LABELS[m.pattern] || m.pattern;
  return `<div class="mv-card ${m.id === editingId ? 'active' : ''}" data-id="${escapeHtml(m.id)}" title="${escapeHtml(m.name)}">
    <div class="mv-chip" style="background:${escapeHtml(m.color)}"><img alt="" hidden><i class="mv-hole"></i></div>
    <div class="mv-card-body">
      <div class="mv-name">${escapeHtml(m.name)}</div>
      <div class="mv-meta">
        <span class="mv-kind">${escapeHtml(m.kind)}</span>
        <span class="mv-pat">${escapeHtml(label)}</span>
        ${uses ? `<span class="mv-use" title="referenced by ${uses} element${uses === 1 ? '' : 's'}">${uses} in use</span>` : ''}
        ${m.custom ? '<span class="mv-custom">custom</span>' : ''}
      </div>
    </div>
  </div>`;
}

function loadSwatch(card, m) {
  if (!m) return;
  const img = card.querySelector('img');
  const show = url => { if (url && img && img.isConnected) { img.src = url; img.hidden = false; } };
  show(swatchUrl(m, CARD_SWATCH, show));
}

function refreshCard(m) {
  if (!gridEl) return;
  const card = gridEl.querySelector(`.mv-card[data-id="${CSS.escape(m.id)}"]`);
  if (!card) { renderGrid(); return; }
  const counts = usageCounts();
  card.outerHTML = cardHtml(m, counts[m.id] || 0);
  const fresh = gridEl.querySelector(`.mv-card[data-id="${CSS.escape(m.id)}"]`);
  fresh.onclick = () => openEditor(m.id);
  loadSwatch(fresh, m);
}

// ---------- editor ----------
function current() { return ws.data.materials.find(m => m.id === editingId) || null; }

function openEditor(id, focusName) {
  editingId = id;
  notice = '';
  const m = current();
  if (!m) { closeEditor(); return; }
  normalizeMaterial(m);
  gridEl.querySelectorAll('.mv-card').forEach(c => c.classList.toggle('active', c.dataset.id === id));
  edEl.hidden = false;
  renderEditor();
  ensurePreview();
  setPreviewMaterial(m);
  if (focusName) { const n = edEl.querySelector('[data-f=name]'); if (n) { n.focus(); n.select(); } }
}

function closeEditor() {
  editingId = null;
  if (edEl) { edEl.hidden = true; edEl.innerHTML = ''; }
  if (preview) { preview.parked = true; cancelAnimationFrame(preview.raf); preview.raf = 0; }
  if (gridEl) gridEl.querySelectorAll('.mv-card.active').forEach(c => c.classList.remove('active'));
}

function fieldRange(label, key, m, max) {
  return `<div class="field mv-range">
    <label>${label} <span class="mv-val" data-val="${key}">${(+m[key]).toFixed(2)}</span></label>
    <input type="range" min="0" max="${max || 1}" step="0.01" value="${m[key]}" data-r="${key}">
  </div>`;
}

function renderEditor() {
  const m = current();
  if (!m || !edEl) return;
  const builtin = builtinById(m.id);
  const uses = materialUsage(m.id);
  const prop = activeProperty();
  const photos = prop ? (prop.photos || []) : [];
  const photo = m.photoId && prop ? photoById(prop, m.photoId) : null;
  const dirty = isDirty(m);
  edEl.innerHTML = `
    <div class="mv-ed-head">
      <input type="text" class="mv-ed-name" data-f="name" value="${escapeHtml(m.name)}" spellcheck="false">
      <div class="mv-ed-badges">
        <span class="chip ${m.custom ? 'accent' : ''}">${m.custom ? 'custom' : 'built-in' + (dirty ? ' · edited' : '')}</span>
        <button type="button" class="mv-close" data-close title="Close (Esc)">&times;</button>
      </div>
    </div>
    <div class="mv-preview"><canvas></canvas><div class="mv-preview-hint">LIVE PREVIEW · drag to orbit · scroll to zoom</div></div>
    ${notice ? `<div class="mv-notice">${escapeHtml(notice)}</div>` : ''}
    <div class="mv-fields">
      <div class="field-row">
        <div class="field"><label>Kind</label>
          <select data-f="kind">${KINDS.map(k => `<option value="${k}" ${k === m.kind ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
        <div class="field"><label>Pattern</label>
          <select data-f="pattern">${PATTERNS.map(p => `<option value="${p}" ${p === m.pattern ? 'selected' : ''}>${escapeHtml(PATTERN_LABELS[p] || p)}</option>`).join('')}</select></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Colour</label>
          <div class="mv-color"><input type="color" data-c="color" value="${escapeHtml(m.color)}"><input type="text" data-hex="color" value="${escapeHtml(m.color)}" maxlength="7" spellcheck="false"></div></div>
        <div class="field"><label>Accent <span class="faint">(mortar / grout / veins)</span></label>
          <div class="mv-color"><input type="color" data-c="accent" value="${escapeHtml(m.accent || autoAccent(m.color))}"><input type="text" data-hex="accent" value="${escapeHtml(m.accent || '')}" placeholder="auto" maxlength="7" spellcheck="false"></div></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Tile width <span class="faint">(one repeat)</span></label><input type="text" data-tile="0" value="${escapeHtml(fmtLen(m.tile[0]))}"></div>
        <div class="field"><label>Tile height</label><input type="text" data-tile="1" value="${escapeHtml(fmtLen(m.tile[1]))}"></div>
      </div>
      <div class="mv-hint">${tileHint(m)}</div>
      ${fieldRange('Roughness', 'roughness', m)}
      ${fieldRange('Metalness', 'metalness', m)}
      ${fieldRange('Normal strength', 'normalScale', m, 2)}

      <div class="mv-section">
        <div class="kicker">FROM PHOTO</div>
        ${prop ? `
          <div class="mv-photos">
            ${photos.map(p => `<button type="button" class="mv-photo ${p.id === m.photoId ? 'active' : ''}" data-photo="${escapeHtml(p.id)}" title="${escapeHtml(p.name)}"><img src="${escapeHtml(p.thumb || '')}" alt=""></button>`).join('')}
            <button type="button" class="mv-photo mv-photo-add" data-upload title="Upload an image from this device">+<span>UPLOAD</span></button>
            <input type="file" accept="image/*" class="hidden-file">
          </div>
          <div class="mv-hint">${photo
            ? `Albedo from <b>${escapeHtml(photo.name)}</b>; normals and roughness are derived from its luminance. Mirrored repeat hides the seams.`
            : (photos.length ? 'Pick a photo of the real surface to use it as the albedo, or upload one.' : 'No photos on ' + escapeHtml(prop.name) + ' yet. Upload one, or add photos in the PHOTOS view.')}</div>`
          : `<div class="mv-hint">Create a property first: photo materials are stored with the property's photos.</div>`}
      </div>

      <div class="mv-section">
        <div class="kicker">USED BY</div>
        ${uses.length ? `<div class="mv-uses">${uses.slice(0, 12).map(u => `<span class="chip cyan" title="${escapeHtml(u.property)}">${escapeHtml(u.label)}</span>`).join('')}${uses.length > 12 ? `<span class="chip">+${uses.length - 12} more</span>` : ''}</div>`
          : '<div class="mv-hint">Not assigned to any wall, floor or ceiling yet.</div>'}
      </div>
    </div>
    <div class="mv-actions">
      <button type="button" class="btn" data-dup>DUPLICATE</button>
      ${m.custom
        ? '<button type="button" class="btn danger" data-del>DELETE</button>'
        : `<button type="button" class="btn" data-reset ${dirty ? '' : 'disabled'}>RESET TO DEFAULT</button>`}
      <span class="sp"></span>
      <button type="button" class="btn primary" data-close>DONE</button>
    </div>`;
  bindEditor(m);
}

function isDirty(m) {
  const b = builtinById(m.id);
  return !!b && JSON.stringify(stripped(m)) !== JSON.stringify(stripped(b));
}

// Cheap refresh of the "edited" badge and RESET button without rebuilding the panel.
function refreshDirty(m) {
  if (!edEl) return;
  const dirty = isDirty(m);
  const reset = edEl.querySelector('[data-reset]');
  if (reset) reset.disabled = !dirty;
  const badge = edEl.querySelector('.mv-ed-badges .chip');
  if (badge && !m.custom) badge.textContent = 'built-in' + (dirty ? ' · edited' : '');
}

function stripped(m) {
  const { id, name, kind, color, pattern, tile, roughness, metalness, normalScale, accent, photoId } = m;
  return { id, name, kind, color, pattern, tile, roughness, metalness, normalScale, accent: accent || null, photoId: photoId || null };
}

function autoAccent(hex) {
  // Same idea as the synthesiser's fallback: a greyed, lighter version of the base.
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const l = 0.3 * r + 0.59 * g + 0.11 * b;
  r = Math.min(255, Math.round((r + (l - r) * 0.5) * 1.15)); g = Math.min(255, Math.round((g + (l - g) * 0.5) * 1.15)); b = Math.min(255, Math.round((b + (l - b) * 0.5) * 1.15));
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function tileHint(m) {
  const [w, h] = m.tile;
  const per = (n, d) => Math.max(1, Math.round(n / d));
  switch (m.pattern) {
    case 'brick': return `${per(w, 0.21)} bricks × ${per(h, 0.075)} courses per repeat (bricks 0.2 × 0.065 m nominal).`;
    case 'cmu': return `${per(w, 0.4)} × ${per(h, 0.2)} blocks per repeat (0.4 × 0.2 m blocks).`;
    case 'wood': return `${per(h, /wide/i.test(m.name) ? 0.2 : /vinyl|lvp|laminate/i.test(m.name) ? 0.18 : 0.13)} planks across the repeat height, staggered end joints along the width.`;
    case 'tile': return /hex|mosaic|penny/i.test(m.name) ? `Hex mosaic, ${per(w, 0.05)} across per repeat.` : /terrazzo/i.test(m.name) ? 'Poured field, no joints.' : `2 × 2 tiles per repeat, each ${fmtLen(w / 2)} × ${fmtLen(h / 2)}${Math.abs(w / h - 1) > 0.15 ? ', running bond' : ', stacked'}.`;
    case 'siding': return `${per(h, /shiplap/i.test(m.name) ? 0.14 : 0.15)} boards per repeat, exposure ${fmtLen(h / per(h, /shiplap/i.test(m.name) ? 0.14 : 0.15))}.`;
    case 'board': return `${per(w, /panel|wainscot|slat/i.test(m.name) ? 0.1 : 0.3)} boards per repeat width.`;
    case 'stone': return /ashlar|limestone|sandstone/i.test(m.name) ? `Coursed 0.6 × 0.3 m blocks.` : `About ${per(w, 0.3)} × ${per(h, 0.24)} stones per repeat.`;
    case 'metal': return /seam|roof/i.test(m.name) ? `Seams every ${fmtLen(w / per(w, 0.4))}.` : 'Brushed along the width.';
    case 'photo': return 'The photo is stretched over one repeat; set the tile to the real-world size it covers.';
    case 'flat': case 'glass': return 'No texture maps; tile size is unused.';
    default: return `One repeat covers ${fmtLen(w)} × ${fmtLen(h)} of surface.`;
  }
}

function bindEditor(m) {
  const q = s => edEl.querySelector(s);
  const changed = (rebuild) => {
    normalizeMaterial(m);
    touch();
    refreshCard(m);
    schedulePreview(m);
    if (rebuild) renderEditor(); else refreshDirty(m);
  };
  q('[data-f=name]').onchange = e => { m.name = e.target.value.trim() || 'Material'; changed(false); };
  q('[data-f=name]').oninput = e => {
    const card = gridEl.querySelector(`.mv-card[data-id="${CSS.escape(m.id)}"] .mv-name`);
    if (card) card.textContent = e.target.value;
  };
  q('[data-f=kind]').onchange = e => { m.kind = e.target.value; changed(true); };
  q('[data-f=pattern]').onchange = e => {
    m.pattern = e.target.value;
    if (m.pattern !== 'photo') m.photoId = m.photoId || null;
    changed(true);
  };
  for (const key of ['color', 'accent']) {
    const picker = q(`[data-c=${key}]`), hex = q(`[data-hex=${key}]`);
    picker.oninput = () => { m[key] = picker.value; hex.value = picker.value; changed(false); };
    hex.onchange = () => {
      let v = hex.value.trim();
      if (!v && key === 'accent') { m.accent = null; picker.value = autoAccent(m.color); changed(false); return; }
      if (/^[0-9a-f]{6}$/i.test(v)) v = '#' + v;
      if (/^#[0-9a-f]{6}$/i.test(v)) { m[key] = v.toLowerCase(); picker.value = m[key]; hex.value = m[key]; changed(false); }
      else hex.value = m[key] || '';
    };
  }
  edEl.querySelectorAll('[data-tile]').forEach(inp => inp.onchange = () => {
    const v = parseLen(inp.value);
    const i = +inp.dataset.tile;
    if (!isNaN(v) && v >= 0.02 && v <= 50) m.tile[i] = Math.round(v * 10000) / 10000;
    inp.value = fmtLen(m.tile[i]);
    changed(false);
    q('.mv-hint').innerHTML = tileHint(m);
  });
  edEl.querySelectorAll('[data-r]').forEach(r => r.oninput = () => {
    m[r.dataset.r] = +r.value;
    q(`[data-val=${r.dataset.r}]`).textContent = (+r.value).toFixed(2);
    changed(false);
  });
  edEl.querySelectorAll('[data-photo]').forEach(b => b.onclick = () => {
    m.photoId = b.dataset.photo;
    m.pattern = 'photo';
    changed(true);
  });
  const up = q('[data-upload]'), file = q('input[type=file]');
  if (up && file) {
    up.onclick = () => file.click();
    file.onchange = async () => {
      const f = file.files[0];
      file.value = '';
      const prop = activeProperty();
      if (!f || !prop) return;
      up.disabled = true;
      try {
        const rec = await addPhotoFromFile(prop, f);
        m.photoId = rec.id;
        m.pattern = 'photo';
        notice = '';
        changed(true);
      } catch (e) {
        notice = 'Could not read that image: ' + e.message;
        renderEditor();
      }
    };
  }
  q('[data-dup]').onclick = () => { const d = duplicateMaterial(m.id); if (d) { renderGrid(); openEditor(d.id, true); } };
  const del = q('[data-del]');
  if (del) del.onclick = () => {
    const err = deleteMaterial(m.id);
    if (err) { notice = err; renderEditor(); return; }
    closeEditor();
    renderGrid();
  };
  const reset = q('[data-reset]');
  if (reset) reset.onclick = () => {
    if (!confirm('Reset "' + m.name + '" to its built-in definition?')) return;
    resetBuiltin(m.id);
    notice = '';
    renderEditor();
    refreshCard(current());
    schedulePreview(current());
  };
  edEl.querySelectorAll('[data-close]').forEach(b => b.onclick = closeEditor);
  // Re-parent the live preview canvas into the freshly rendered panel.
  if (preview) attachPreviewCanvas();
}

// ---------- live preview ----------
function metreUVs(geo, sx, sy) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * sx, uv.getY(i) * sy);
  uv.needsUpdate = true;
  return geo;
}

function ensurePreview() {
  if (preview) { preview.parked = false; attachPreviewCanvas(); if (!preview.raf) loop(); return; }
  const canvas = edEl.querySelector('.mv-preview canvas');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (e) {
    edEl.querySelector('.mv-preview').innerHTML = '<div class="mv-hint">WebGL is not available; swatches fall back to flat colour.</div>';
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#10151a');
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environment = env;
  scene.environmentIntensity = 0.6;

  const camera = new THREE.PerspectiveCamera(34, 4 / 3, 0.05, 40);
  camera.position.set(1.9, 1.25, 2.3);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0.32, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 1.2;
  controls.maxDistance = 6;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.7;

  const key = new THREE.DirectionalLight(0xfff1e0, 2.2);
  key.position.set(-2.5, 3.2, 2.2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -2.2; key.shadow.camera.right = 2.2; key.shadow.camera.top = 2.2; key.shadow.camera.bottom = -2.2;
  key.shadow.camera.near = 0.5; key.shadow.camera.far = 12;
  key.shadow.radius = 4; key.shadow.bias = -0.0005; key.shadow.normalBias = 0.02;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xc6d6ea, 0.5);
  rim.position.set(2.5, 1.5, -2.5);
  scene.add(rim);

  const sphere = new THREE.Mesh(metreUVs(new THREE.SphereGeometry(0.42, 96, 64), 2.64, 1.32));
  sphere.position.set(-0.55, 0.42, 0.1);
  sphere.castShadow = sphere.receiveShadow = true;
  const cube = new THREE.Mesh(metreUVs(new RoundedBoxGeometry(0.72, 0.72, 0.72, 4, 0.02), 0.72, 0.72));
  cube.position.set(0.55, 0.36, -0.15);
  cube.rotation.y = 0.5;
  cube.castShadow = cube.receiveShadow = true;
  const ground = new THREE.Mesh(metreUVs(new THREE.PlaneGeometry(4, 4), 4, 4));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(sphere, cube, ground);

  // A backdrop wall so the ground plane does not float in the void (uses a neutral material).
  const back = new THREE.Mesh(new THREE.PlaneGeometry(4, 2.4), new THREE.MeshStandardMaterial({ color: 0x1b232b, roughness: 0.95 }));
  back.position.set(0, 1.2, -2);
  back.receiveShadow = true;
  scene.add(back);

  preview = { renderer, scene, camera, controls, meshes: [sphere, cube, ground], raf: 0, ro: null, parked: false, env, back };
  attachPreviewCanvas();
  loop();
}

function attachPreviewCanvas() {
  if (!preview || !edEl) return;
  const host = edEl.querySelector('.mv-preview');
  if (!host) return;
  const canvas = preview.renderer.domElement;
  const stale = host.querySelector('canvas');
  if (stale && stale !== canvas) stale.replaceWith(canvas);
  else if (!stale) host.prepend(canvas);
  if (preview.ro) preview.ro.disconnect();
  preview.ro = new ResizeObserver(() => resizePreview());
  preview.ro.observe(host);
  resizePreview();
}

function resizePreview() {
  if (!preview || !edEl) return;
  const host = edEl.querySelector('.mv-preview');
  if (!host) return;
  const w = host.clientWidth, h = Math.round(w * 0.72);
  if (!w) return;
  host.style.height = h + 'px';
  preview.renderer.setSize(w, h, false);
  preview.camera.aspect = w / h;
  preview.camera.updateProjectionMatrix();
}

function loop() {
  if (!preview || preview.parked || !el) { if (preview) preview.raf = 0; return; }
  preview.raf = requestAnimationFrame(loop);
  // While maps are still synthesising, render every fourth frame so the CPU can finish them sooner.
  preview.frame = (preview.frame || 0) + 1;
  if (pendingTextureJobs() && preview.frame % 4) return;
  preview.controls.update();
  preview.renderer.render(preview.scene, preview.camera);
}

function setPreviewMaterial(m) {
  if (!preview) return;
  const mat = materialFor(m);
  for (const mesh of preview.meshes) mesh.material = mat;
  // Glass on the ground plane hides the scene; keep the floor neutral for transmissive materials.
  if (m.pattern === 'glass') preview.meshes[2].material = preview.back.material;
}

function schedulePreview(m) {
  clearTimeout(regenTimer);
  regenTimer = setTimeout(() => { const cur = current(); if (cur && cur === m) setPreviewMaterial(m); }, 220);
}

function destroyPreview() {
  if (!preview) return;
  cancelAnimationFrame(preview.raf);
  if (preview.ro) preview.ro.disconnect();
  preview.controls.dispose();
  for (const mesh of preview.meshes) mesh.geometry.dispose();
  preview.back.geometry.dispose(); preview.back.material.dispose();
  preview.env.dispose();
  preview.renderer.dispose();
  preview = null;
}
