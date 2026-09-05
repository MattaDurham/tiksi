// PHOTOS view: gallery of a property's site photos, reference images and 360 panoramas.
// Photos are first-class workspace objects: they link to rooms, model elements and scope
// items (so cut sheets can pull site conditions per element), can be pinned in the 3D
// model, used as the plan underlay, as the sky for lighting, or as a photo-based material.
// Full-res bytes live in IndexedDB (photos-store.js); the JSON only carries a thumbnail.

import {
  ws, activeProperty, touch, escapeHtml, allScopeItems, elementInfo, materialById, fmtLen, fmtDate,
} from './store.js';
import { addPhotoFromFile, photoUrl, photoBytes, photoById, deletePhoto, isPanoramaAspect, revokePhotoUrls } from './photos-store.js';
import { addCustomMaterial } from './materials.js';

const PLAN_MAX_PX = 2000;   // same cap as plan2d's own underlay upload
const MATERIAL_KINDS = ['wall', 'floor', 'ceiling', 'trim', 'any'];

// Module-persistent view state (survives view switches, like the plan editor).
const filters = { kind: '', room: '', pin: '', q: '' };
let selectedId = null;

let el = null, prop = null;
let dropRoot = null;        // the shared #view element while the drop listeners are attached
let importing = null;       // running upload batch: { done, total, failed, queue: [{ file, prop }] }
let lightbox = null;        // { ids, idx } while the lightbox is open
let dragDepth = 0;
let previewToken = 0;       // guards async preview loads against stale selections

// ---------- data helpers ----------
function photos() { return prop.photos || (prop.photos = []); }

function sortedPhotos() {
  return photos().slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function visiblePhotos() {
  const q = filters.q.trim().toLowerCase();
  return sortedPhotos().filter(p => {
    if (filters.kind && p.kind !== filters.kind) return false;
    if (filters.room === '-' && p.roomId) return false;                          // "(no room)"
    if (filters.room && filters.room !== '-' && p.roomId !== filters.room) return false;
    if (filters.pin === 'pinned' && !p.pin) return false;
    if (filters.pin === 'unpinned' && p.pin) return false;
    if (q && !(String(p.name || '').toLowerCase().includes(q) || String(p.notes || '').toLowerCase().includes(q))) return false;
    return true;
  });
}

function roomName(id) {
  const r = prop.rooms.find(r => r.id === id);
  return r ? (r.name || 'Room') : '';
}

function kindLabel(p) { return p.kind === 'pano' ? '360 PANO' : 'PHOTO'; }

function fileExt(mime) { return { 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[mime] || 'jpg'; }

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode image'));
    img.src = src;
  });
}

// Average colour of a (thumbnail) image: the plan and cut sheets colour elements by material.color.
async function averageColor(src) {
  const img = await loadImage(src);
  const c = document.createElement('canvas');
  c.width = 8; c.height = 8;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, 8, 8);
  const d = ctx.getImageData(0, 0, 8, 8).data;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  const n = d.length / 4;
  const hex = v => Math.round(v / n).toString(16).padStart(2, '0');
  return '#' + hex(r) + hex(g) + hex(b);
}

// ---------- uploads ----------
// One batch runs at a time and owns its state; files added while it runs join its queue.
// Every queued file remembers the property it was added to, and the DOM is only touched
// while the view is mounted, so navigating away or switching property mid-upload neither
// aborts the batch nor throws.
async function addFiles(list) {
  const files = Array.from(list || []).filter(f => f && (f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif|bmp|heic|heif)$/i.test(f.name)));
  if (!files.length) { if (list && list.length) alert('Only image files can be added as photos.'); return; }
  const entries = files.map(file => ({ file, prop }));
  if (importing) {
    importing.queue.push(...entries);
    importing.total += entries.length;
    if (el) renderHead();
    return;
  }
  const batch = importing = { done: 0, total: entries.length, failed: [], queue: entries };
  if (el) renderHead();
  let last = null;
  while (batch.queue.length) {
    const { file, prop: target } = batch.queue.shift();
    try { last = await addPhotoFromFile(target, file); }
    catch (e) { batch.failed.push(file.name); }
    batch.done++;
    if (el) { renderHead(); renderGrid(); }
  }
  importing = null;
  if (el) {
    if (last && photoById(prop, last.id)) selectedId = last.id;
    render();
  }
  if (batch.failed.length) alert('Could not read ' + batch.failed.length + ' file(s): ' + batch.failed.join(', '));
}

function onPaste(e) {
  const files = Array.from(e.clipboardData && e.clipboardData.files || []).filter(f => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  addFiles(files);
}

function hasFiles(e) { return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'); }
function onDragEnter(e) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  el.querySelector('.ph-drop').hidden = false;
}
function onDragOver(e) { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }
function onDragLeave(e) {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) el.querySelector('.ph-drop').hidden = true;
}
function onDrop(e) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  el.querySelector('.ph-drop').hidden = true;
  addFiles(e.dataTransfer.files);
}

// ---------- actions ----------
async function useAsUnderlay(p) {
  if (prop.plan && prop.plan.img && !confirm('Replace the current plan underlay with "' + p.name + '"?')) return;
  const url = await photoUrl(p.id);
  if (!url) { alert('The full-resolution file for this photo is not in this browser (it came from a JSON-only export). Re-upload it to use it as an underlay.'); return; }
  let img;
  try { img = await loadImage(url); } catch (e) { alert(e.message); return; }
  const scale = Math.min(1, PLAN_MAX_PX / Math.max(img.width, img.height));
  const cw = Math.round(img.width * scale), ch = Math.round(img.height * scale);
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  c.getContext('2d').drawImage(img, 0, 0, cw, ch);
  const isPng = p.mime === 'image/png';
  prop.plan = {
    img: isPng ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.85),
    imgW: cw, imgH: ch,
    mPerPx: 18 / cw,            // assume ~18 m wide until calibrated (plan2d convention)
    opacity: 0.55, offsetX: 0, offsetY: 0, calibrated: false,
  };
  touch();
  location.hash = '#/plan';
}

async function useAsSky(p) {
  if (p.kind !== 'pano') return;
  // The viewer needs the full-resolution bytes for the equirect texture; a thumbnail-only
  // record (JSON-only import) would leave the model with a dark sky and no explanation.
  if (!(await photoBytes(p.id))) { alert('The full-resolution file for this panorama is not in this browser (it came from a JSON-only export). Re-upload it to use it as the sky.'); return; }
  if (!prop) return;
  prop.env.sky = 'pano';
  prop.env.panoPhotoId = p.id;
  touch();
  location.hash = '#/model';
}

function clearSky() {
  prop.env.sky = 'dynamic';
  prop.env.panoPhotoId = null;
  touch();
  renderDetail();
}

function pinIn3d(p) { location.hash = '#/model?pin=' + encodeURIComponent(p.id); }

function unpin(p) {
  p.pin = null;
  touch();
  render();
}

async function download(p) {
  const buf = await photoBytes(p.id);
  const blob = buf ? new Blob([buf], { type: p.mime || 'image/jpeg' }) : await (await fetch(p.thumb)).blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const base = String(p.name || 'photo').replace(/\.[a-z0-9]+$/i, '');
  a.download = base + (buf ? '.' + fileExt(p.mime) : '-thumb.jpg');
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function materialFromPhoto(p) {
  const kindSel = el.querySelector('[data-mat-kind]');
  const kind = kindSel ? kindSel.value : 'any';
  let color = '#a8a29a';
  try { color = await averageColor(p.thumb); } catch (e) { /* keep the neutral default */ }
  const m = addCustomMaterial(String(p.name || 'Photo material').replace(/\.[a-z0-9]+$/i, ''), color, kind);
  // Photo-based PBR record (see the material contract): albedo comes from this photo.
  Object.assign(m, { pattern: 'photo', photoId: p.id, tile: [1, 1], roughness: 0.85, metalness: 0, normalScale: 0.5, accent: null });
  touch();
  location.hash = '#/materials';
}

// Stop lighting the model with this photo (it is no longer a panorama, or is being deleted).
function clearSkyReference(id) {
  if (prop.env && prop.env.panoPhotoId === id) {
    prop.env.panoPhotoId = null;
    if (prop.env.sky === 'pano') prop.env.sky = 'dynamic';
  }
}

// Delete cascade: the sky plus every photo-based material built from it.
function clearReferences(id) {
  clearSkyReference(id);
  for (const m of ws.data.materials) {
    if (m.photoId === id) { m.photoId = null; if (m.pattern === 'photo') m.pattern = 'flat'; }
  }
}

async function remove(p) {
  if (!confirm('Delete "' + p.name + '"? This removes the file from browser storage and clears its links.')) return;
  clearReferences(p.id);
  await deletePhoto(prop, p.id);
  if (selectedId === p.id) selectedId = null;
  render();
}

// ---------- lightbox ----------
function openLightbox(id) {
  const ids = visiblePhotos().map(p => p.id);
  const idx = Math.max(0, ids.indexOf(id));
  lightbox = { ids: ids.length ? ids : [id], idx };
  let box = el.querySelector('.ph-lightbox');
  if (!box) {
    box = document.createElement('div');
    box.className = 'ph-lightbox';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Photo viewer');
    box.innerHTML = `
      <button class="ph-lb-btn ph-lb-close" aria-label="Close (Esc)" title="Close (Esc)">&#x2715;</button>
      <button class="ph-lb-btn ph-lb-prev" aria-label="Previous (left arrow)" title="Previous">&#x2039;</button>
      <figure class="ph-lb-fig"><img alt=""><figcaption class="ph-lb-cap"></figcaption></figure>
      <button class="ph-lb-btn ph-lb-next" aria-label="Next (right arrow)" title="Next">&#x203A;</button>`;
    box.querySelector('.ph-lb-close').onclick = closeLightbox;
    box.querySelector('.ph-lb-prev').onclick = () => stepLightbox(-1);
    box.querySelector('.ph-lb-next').onclick = () => stepLightbox(1);
    box.onclick = e => { if (e.target === box) closeLightbox(); };
    el.appendChild(box);
  }
  renderLightbox();
  box.querySelector('.ph-lb-close').focus();
}

function closeLightbox() {
  lightbox = null;
  const box = el && el.querySelector('.ph-lightbox');
  if (box) box.remove();
  const card = el && selectedId && el.querySelector(`.ph-card[data-id="${selectedId}"]`);
  if (card) card.focus();
}

function stepLightbox(d) {
  if (!lightbox) return;
  lightbox.idx = (lightbox.idx + d + lightbox.ids.length) % lightbox.ids.length;
  renderLightbox();
}

async function renderLightbox() {
  const box = el.querySelector('.ph-lightbox');
  if (!box || !lightbox) return;
  const id = lightbox.ids[lightbox.idx];
  const p = photoById(prop, id);
  if (!p) { closeLightbox(); return; }
  const img = box.querySelector('img');
  img.src = p.thumb;
  img.alt = p.name;
  box.classList.toggle('pano', p.kind === 'pano');
  box.querySelector('.ph-lb-cap').innerHTML =
    `<b>${escapeHtml(p.name)}</b><span>${kindLabel(p)} - ${escapeHtml(p.w)} x ${escapeHtml(p.h)}${p.roomId ? ' - ' + escapeHtml(roomName(p.roomId)) : ''} - ${lightbox.idx + 1} / ${lightbox.ids.length}</span>`;
  const url = await photoUrl(id);
  if (url && lightbox && lightbox.ids[lightbox.idx] === id) img.src = url;
}

function onKeyDown(e) {
  if (!lightbox) return;
  if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); stepLightbox(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); stepLightbox(1); }
}

// ---------- rendering ----------
function render() {
  if (!el) return;
  renderHead();
  renderFilters();
  renderGrid();
  renderDetail();
}

function renderHead() {
  const head = el.querySelector('.ph-head');
  if (!head) return;
  const all = photos();
  const panos = all.filter(p => p.kind === 'pano').length;
  const pinned = all.filter(p => p.pin).length;
  const sub = importing
    ? `IMPORTING ${importing.done} / ${importing.total}`
    : `${all.length} photo${all.length === 1 ? '' : 's'} - ${panos} panorama${panos === 1 ? '' : 's'} - ${pinned} pinned in 3D`;
  head.innerHTML = `
    <div class="ph-head-text">
      <span class="view-title">PHOTOS</span>
      <span class="view-sub ${importing ? 'busy' : ''}">${escapeHtml(sub)}</span>
    </div>
    <div class="ph-head-actions">
      <span class="ph-hint">drop images anywhere - or paste</span>
      <button class="btn" data-act="camera" title="Take a photo with the phone camera">CAMERA</button>
      <button class="btn primary" data-act="upload">UPLOAD</button>
      <input type="file" class="hidden-file" data-file="upload" accept="image/*" multiple>
      <input type="file" class="hidden-file" data-file="camera" accept="image/*" capture="environment">
    </div>`;
  bindUploadButtons(head);
}

function bindUploadButtons(root) {
  const up = root.querySelector('[data-file=upload]'), cam = root.querySelector('[data-file=camera]');
  const upBtn = root.querySelector('[data-act=upload]'), camBtn = root.querySelector('[data-act=camera]');
  if (upBtn) upBtn.onclick = () => up.click();
  if (camBtn) camBtn.onclick = () => cam.click();
  for (const inp of [up, cam]) if (inp) inp.onchange = () => { addFiles(inp.files); inp.value = ''; };
}

function renderFilters() {
  const bar = el.querySelector('.ph-filters');
  if (!bar) return;
  const rooms = prop.rooms.map(r => `<option value="${escapeHtml(r.id)}" ${filters.room === r.id ? 'selected' : ''}>${escapeHtml(r.name || 'Room')}</option>`).join('');
  bar.innerHTML = `
    <select data-filter="kind" aria-label="Filter by kind">
      <option value="">ALL KINDS</option>
      <option value="photo" ${filters.kind === 'photo' ? 'selected' : ''}>PHOTOS</option>
      <option value="pano" ${filters.kind === 'pano' ? 'selected' : ''}>360 PANORAMAS</option>
    </select>
    <select data-filter="room" aria-label="Filter by room">
      <option value="">ALL ROOMS</option>
      <option value="-" ${filters.room === '-' ? 'selected' : ''}>(no room)</option>${rooms}
    </select>
    <select data-filter="pin" aria-label="Filter by pin state">
      <option value="">PINNED + UNPINNED</option>
      <option value="pinned" ${filters.pin === 'pinned' ? 'selected' : ''}>PINNED IN 3D</option>
      <option value="unpinned" ${filters.pin === 'unpinned' ? 'selected' : ''}>NOT PINNED</option>
    </select>
    <input type="search" class="search-input" data-filter="q" value="${escapeHtml(filters.q)}" placeholder="search name or notes" aria-label="Search photos">
    <span class="sp"></span>
    <span class="ph-count mono"></span>`;
  bar.querySelectorAll('select[data-filter]').forEach(s => s.onchange = () => { filters[s.dataset.filter] = s.value; renderGrid(); });
  bar.querySelector('[data-filter=q]').oninput = e => { filters.q = e.target.value; renderGrid(); };
}

function cardHtml(p) {
  const chips = [
    `<span class="chip ${p.kind === 'pano' ? 'cyan' : ''}">${kindLabel(p)}</span>`,
    p.roomId ? `<span class="chip">${escapeHtml(roomName(p.roomId))}</span>` : '',
    p.pin ? `<span class="chip accent">PINNED</span>` : '',
    (p.itemIds || []).length ? `<span class="chip green">${p.itemIds.length} ITEM${p.itemIds.length === 1 ? '' : 'S'}</span>` : '',
    (p.elementIds || []).length ? `<span class="chip">${p.elementIds.length} ELEMENT${p.elementIds.length === 1 ? '' : 'S'}</span>` : '',
    prop.env && prop.env.panoPhotoId === p.id ? `<span class="chip accent">SKY</span>` : '',
  ].filter(Boolean).join('');
  return `<button class="ph-card ${p.kind === 'pano' ? 'pano' : ''} ${p.id === selectedId ? 'active' : ''}" data-id="${escapeHtml(p.id)}"
      aria-pressed="${p.id === selectedId}" title="${escapeHtml(p.name)} (double-click to zoom)">
    <div class="ph-thumb"><img src="${escapeHtml(p.thumb || '')}" alt="" loading="lazy" draggable="false"></div>
    <div class="ph-card-body">
      <div class="ph-name">${escapeHtml(p.name)}</div>
      <div class="ph-chips">${chips}</div>
    </div>
  </button>`;
}

function emptyStateHtml() {
  return `<div class="ph-empty">
    <div class="ph-empty-mark" aria-hidden="true">
      <svg viewBox="0 0 64 48" width="72" height="54"><rect x="2" y="8" width="60" height="38" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M2 40l18-16 12 11 8-7 22 18" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="46" cy="19" r="5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M22 8V4h20v4" fill="none" stroke="currentColor" stroke-width="2"/></svg>
    </div>
    <div class="ph-empty-title">NO PHOTOS YET</div>
    <p class="ph-empty-lead">Photos are part of the model. Add them once and use them everywhere:</p>
    <div class="ph-empty-grid">
      <div class="ph-empty-tile"><b>SITE CONDITIONS</b><span>Document what is there today. Link a photo to a wall, a room or a scope item and it prints on that item's cut sheet.</span></div>
      <div class="ph-empty-tile"><b>REFERENCE IMAGES</b><span>Inspiration and product shots. Pin any photo in the 3D model where it belongs.</span></div>
      <div class="ph-empty-tile"><b>360 PANORAMAS</b><span>An equirectangular pano (2:1) becomes the sky: real light and reflections from your own site.</span></div>
      <div class="ph-empty-tile"><b>TEXTURES</b><span>A close-up of brick, tile or wood becomes a photo-based material, or a floorplan photo becomes the plan underlay.</span></div>
    </div>
    <div class="ph-empty-actions">
      <button class="btn primary" data-act="upload">UPLOAD PHOTOS</button>
      <button class="btn" data-act="camera">USE CAMERA</button>
      <input type="file" class="hidden-file" data-file="upload" accept="image/*" multiple>
      <input type="file" class="hidden-file" data-file="camera" accept="image/*" capture="environment">
    </div>
    <p class="ph-empty-foot">Drop image files anywhere on this view, or paste an image from the clipboard. Nothing leaves your browser.</p>
  </div>`;
}

function renderGrid() {
  const grid = el.querySelector('.ph-grid');
  if (!grid) return;
  const all = photos();
  const list = visiblePhotos();
  const count = el.querySelector('.ph-count');
  if (count) count.textContent = all.length && list.length !== all.length ? `${list.length} OF ${all.length}` : '';
  if (!all.length && !importing) {
    grid.className = 'ph-grid is-empty';
    grid.innerHTML = emptyStateHtml();
    bindUploadButtons(grid);
    return;
  }
  grid.className = 'ph-grid';
  if (!list.length) {
    if (importing) { grid.innerHTML = `<div class="ph-none"><span>Importing ${importing.done} of ${importing.total}...</span></div>`; return; }
    grid.innerHTML = `<div class="ph-none"><span>No photos match these filters.</span><button class="btn small" data-act="clear">CLEAR FILTERS</button></div>`;
    grid.querySelector('[data-act=clear]').onclick = () => { filters.kind = filters.room = filters.pin = filters.q = ''; renderFilters(); renderGrid(); };
    return;
  }
  grid.innerHTML = list.map(cardHtml).join('');
  grid.querySelectorAll('.ph-card').forEach(card => {
    card.onclick = () => {
      if (selectedId === card.dataset.id) return;
      const prev = grid.querySelector('.ph-card.active');
      if (prev) { prev.classList.remove('active'); prev.setAttribute('aria-pressed', 'false'); }
      selectedId = card.dataset.id;
      card.classList.add('active');
      card.setAttribute('aria-pressed', 'true');
      renderDetail();
    };
    card.ondblclick = () => openLightbox(card.dataset.id);
  });
}

function scopeOptionsHtml(p) {
  const have = new Set(p.itemIds || []);
  const groups = {};
  for (const { project, item } of allScopeItems()) (groups[project.name] = groups[project.name] || []).push(item);
  return Object.entries(groups).map(([name, items]) =>
    `<optgroup label="${escapeHtml(name)}">${items.map(it =>
      `<option value="${escapeHtml(it.id)}" ${have.has(it.id) ? 'selected' : ''}>${escapeHtml(it.name)}</option>`).join('')}</optgroup>`).join('');
}

function elementOptionsHtml(p) {
  const have = new Set(p.elementIds || []);
  const walls = prop.walls.map(w => {
    const info = elementInfo(prop.id, w.id);
    const mat = materialById(w.material);
    const label = `Wall ${fmtLen(info ? info.length : 0)}${mat ? ' - ' + mat.name : ''}  [${w.id.slice(-6)}]`;
    return `<option value="${escapeHtml(w.id)}" ${have.has(w.id) ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
  const rooms = prop.rooms.map(r =>
    `<option value="${escapeHtml(r.id)}" ${have.has(r.id) ? 'selected' : ''}>${escapeHtml(r.name || 'Room')}</option>`).join('');
  return (rooms ? `<optgroup label="Rooms / floors">${rooms}</optgroup>` : '') + (walls ? `<optgroup label="Walls">${walls}</optgroup>` : '');
}

function renderDetail() {
  const pane = el.querySelector('.ph-detail');
  if (!pane) return;
  const p = selectedId ? photoById(prop, selectedId) : null;
  if (!p) {
    selectedId = null;
    pane.innerHTML = `<div class="ph-detail-body"><h3>PHOTO</h3>
      <div class="empty">Select a photo to name it, add notes, link it to rooms, walls and scope items, or send it to the plan, the model or the material library.<br><br>
      Double-click a card to open the viewer.</div></div>`;
    return;
  }
  const looksPano = isPanoramaAspect(p.w, p.h);
  const isSky = prop.env && prop.env.sky === 'pano' && prop.env.panoPhotoId === p.id;
  const token = ++previewToken;
  pane.innerHTML = `
    <div class="ph-preview ${p.kind === 'pano' ? 'pano' : ''}">
      <img src="${escapeHtml(p.thumb || '')}" alt="${escapeHtml(p.name)}" draggable="false">
      <button class="ph-zoom" data-act="zoom" title="Open viewer (double-click a card also works)" aria-label="Open viewer">ZOOM</button>
      <span class="ph-preview-badge" data-storage hidden>THUMBNAIL ONLY</span>
    </div>
    <div class="ph-detail-body">
      <h3>${kindLabel(p)}</h3>
      <div class="field"><label>Name</label><input type="text" data-f="name" value="${escapeHtml(p.name)}"></div>
      <div class="field"><label>Kind</label>
        <div class="seg">
          <button class="seg-btn ${p.kind !== 'pano' ? 'active' : ''}" data-kind="photo" style="flex:1">PHOTO</button>
          <button class="seg-btn ${p.kind === 'pano' ? 'active' : ''}" data-kind="pano" style="flex:1">360 PANORAMA</button>
        </div>
        ${looksPano && p.kind !== 'pano' ? '<div class="ph-note">2:1 aspect: this looks like an equirectangular panorama.</div>' : ''}
      </div>
      <div class="field"><label>Send to</label>
        <div class="ph-send">
          <button class="btn" data-act="underlay" title="Trace walls over this image in PLAN">PLAN UNDERLAY</button>
          ${isSky
            ? '<button class="btn on" data-act="clear-sky" title="Stop lighting the model with this panorama">SKY: ON</button>'
            : `<button class="btn" data-act="sky" title="${p.kind === 'pano' ? 'Light the 3D model with this panorama' : 'Set the kind to 360 panorama first'}" ${p.kind === 'pano' ? '' : 'disabled'}>USE AS SKY</button>`}
          ${p.pin
            ? '<button class="btn on" data-act="pin" title="Show this pin in the 3D model">PINNED: SHOW</button>'
            : '<button class="btn" data-act="pin" title="Place this photo on a surface in the 3D model">PIN IN 3D</button>'}
          <div class="ph-mat">
            <button class="btn" data-act="material" title="Create a photo-based material from this image">MATERIAL</button>
            <select data-mat-kind aria-label="Material kind">${MATERIAL_KINDS.map(k => `<option value="${k}">${k}</option>`).join('')}</select>
          </div>
        </div>
      </div>
      <div class="field"><label>Room</label>
        <select data-f="roomId"><option value="">(none)</option>${prop.rooms.map(r =>
          `<option value="${escapeHtml(r.id)}" ${p.roomId === r.id ? 'selected' : ''}>${escapeHtml(r.name || 'Room')}</option>`).join('')}</select></div>
      <div class="field"><label>Notes</label><textarea data-f="notes" placeholder="What does this show? Conditions, measurements, ideas.">${escapeHtml(p.notes || '')}</textarea></div>
      <div class="field"><label>Scope items (cut sheets)</label>
        <select multiple size="4" data-multi="itemIds" aria-label="Linked scope items">${scopeOptionsHtml(p)}</select>
        <div class="ph-note">Ctrl/Cmd-click to link several. Linked photos print on the item's cut sheet.</div></div>
      <div class="field"><label>Model elements</label>
        <select multiple size="4" data-multi="elementIds" aria-label="Linked model elements">${elementOptionsHtml(p)}</select>
        <div class="ph-note">Photos of a wall or floor follow it onto every cut sheet that rebuilds it.</div></div>

      <div class="stat-line"><span>Size</span><b>${escapeHtml(p.w)} x ${escapeHtml(p.h)}</b></div>
      <div class="stat-line"><span>Added</span><b>${escapeHtml(fmtDate(String(p.createdAt || '').slice(0, 10)))}</b></div>
      <div class="stat-line"><span>Pinned in 3D</span><b>${p.pin ? `x ${(+p.pin.x).toFixed(2)}  y ${(+p.pin.y).toFixed(2)}  z ${(+p.pin.z).toFixed(2)}` : 'no'}</b></div>
      ${isSky ? '<div class="stat-line"><span>Sky</span><b class="accent">ACTIVE (lighting the model)</b></div>' : ''}

      <div class="ph-actions">
        ${p.pin ? '<button class="btn" data-act="unpin" title="Remove the 3D pin">UNPIN</button>' : ''}
        <button class="btn" data-act="download" title="Save the original file">DOWNLOAD</button>
        <button class="btn danger" data-act="delete">DELETE</button>
      </div>
    </div>`;

  // Swap the thumbnail for the full-resolution object URL once it is available.
  const img = pane.querySelector('.ph-preview img');
  photoUrl(p.id).then(url => {
    if (token !== previewToken || !el) return;
    if (url) img.src = url;
    else pane.querySelector('[data-storage]').hidden = false;
  });

  pane.querySelector('[data-f=name]').onchange = e => {
    p.name = e.target.value.trim() || p.name;
    e.target.value = p.name;
    touch();
    const card = el.querySelector(`.ph-card[data-id="${p.id}"] .ph-name`);
    if (card) card.textContent = p.name;
  };
  pane.querySelector('[data-f=notes]').onchange = e => { p.notes = e.target.value; touch(); };
  pane.querySelector('[data-f=roomId]').onchange = e => { p.roomId = e.target.value; touch(); renderGrid(); };
  pane.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => {
    if (p.kind === b.dataset.kind) return;
    p.kind = b.dataset.kind;
    // Only the sky depends on the kind; a material built from the image keeps working.
    if (p.kind !== 'pano') clearSkyReference(p.id);
    touch(); render();
  });
  pane.querySelectorAll('[data-multi]').forEach(sel => sel.onchange = () => {
    p[sel.dataset.multi] = Array.from(sel.selectedOptions).map(o => o.value);
    touch(); renderGrid();
  });
  const act = (name, fn) => { const b = pane.querySelector(`[data-act=${name}]`); if (b) b.onclick = () => fn(p); };
  act('zoom', () => openLightbox(p.id));
  act('underlay', useAsUnderlay);
  act('sky', useAsSky);
  act('clear-sky', clearSky);
  act('pin', pinIn3d);
  act('unpin', unpin);
  act('material', materialFromPhoto);
  act('download', download);
  act('delete', remove);
}

// ---------- mount / unmount ----------
export function mount(root) {
  prop = activeProperty();
  el = root;
  if (!prop) {
    root.innerHTML = `<div class="view-scroll"><div class="kicker">PHOTOS</div>
      <p class="muted">No property yet. Create one from the PROPERTY selector in the top bar.</p></div>`;
    return;
  }
  if (selectedId && !photoById(prop, selectedId)) selectedId = null;
  // A room filter from another property (or a deleted room) would hide every photo while the
  // select shows ALL ROOMS.
  if (filters.room && filters.room !== '-' && !prop.rooms.some(r => r.id === filters.room)) filters.room = '';
  root.innerHTML = `
    <div class="ph-layout">
      <div class="ph-main">
        <div class="ph-head"></div>
        <div class="ph-filters toolbar"></div>
        <div class="ph-grid"></div>
      </div>
      <aside class="ph-detail inspector"></aside>
      <div class="ph-drop" hidden><div class="ph-drop-box">DROP PHOTOS TO ADD THEM TO ${escapeHtml(prop.name).toUpperCase()}</div></div>
    </div>`;
  render();

  // #view outlives the view, so these come off again in unmount().
  dropRoot = root;
  dropRoot.addEventListener('dragenter', onDragEnter);
  dropRoot.addEventListener('dragover', onDragOver);
  dropRoot.addEventListener('dragleave', onDragLeave);
  dropRoot.addEventListener('drop', onDrop);
  document.addEventListener('paste', onPaste);
  window.addEventListener('keydown', onKeyDown);
}

export function unmount() {
  if (dropRoot) {
    dropRoot.removeEventListener('dragenter', onDragEnter);
    dropRoot.removeEventListener('dragover', onDragOver);
    dropRoot.removeEventListener('dragleave', onDragLeave);
    dropRoot.removeEventListener('drop', onDrop);
    dropRoot = null;
  }
  document.removeEventListener('paste', onPaste);
  window.removeEventListener('keydown', onKeyDown);
  // A running upload batch keeps going (it owns its state); the preview and lightbox URLs go.
  revokePhotoUrls();
  lightbox = null; dragDepth = 0;
  el = null; prop = null;
}
