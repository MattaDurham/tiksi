// PHOTOS view: gallery of a property's site photos, reference images and 360 panoramas.
// Photos are first-class workspace objects: they link to rooms, model elements and scope
// items (so cut sheets can pull site conditions per element), can be pinned in the 3D
// model, used as the plan underlay, as the sky for lighting, or as a photo-based material.
// With the Mac's server the gallery is the project folder: every picture in it and its
// subfolders, read where it is (photos-store.js); Tiksi keeps a record only of the photos it
// knows something about. Pictures fall in groups that can each be hidden: photos, panoramas,
// Polycam scan frames, renderings and documents. Selected marks the good ones to come back to.

import {
  ws, activeProperty, touch, escapeHtml, allScopeItems, elementInfo, materialById, fmtLen, fmtDate,
  activeLevel, levelOfRoom,
} from './store.js';
import {
  addPhotoFromFile, photoUrl, photoBytes, photoById, deletePhoto, isPanoramaAspect, revokePhotoUrls,
  keepsPhotosInFolder, folderListing, loadFolderPhotos, folderPreviewUrl, keepRecord, whenFilled,
  heldPhotos, moveHeldPhotos, releaseIfBare, missingFiles,
} from './photos-store.js';
import { diskWorkspace } from './disk-workspace.js';
import { addDocumentFromFile, documentCanvas, isPdfDocument } from './documents.js';
import { FOUND_SOURCES } from './photo-match.js';
import { ROLE_LABELS } from './positions.js';
import { addCustomMaterial } from './materials.js';
import { isVideoFile, importVideos } from './videos.js';

const PLAN_MAX_PX = 4096;   // detailed tracing without unbounded canvas memory
const MATERIAL_KINDS = ['wall', 'floor', 'ceiling', 'trim', 'any'];

// The groups a picture falls in, in the order the filter shows them; each can be hidden.
const GROUPS = [['photo', 'PHOTOS'], ['pano', '360 PANORAMAS'], ['scan', 'SCAN FRAMES'], ['rendering', 'RENDERINGS'], ['document', 'DOCUMENTS']];
const HIDDEN_KEY = 'tiksi.photos.hidden';
const PAGE = 200;               // cards drawn at a time; more are drawn as the gallery scrolls
const REFRESH_MS = 30000;       // the project folder is listed again this often while PHOTOS is open
const PREVIEW_LOADS = 4;        // gallery previews asked of the Mac at once

function savedHidden() {
  try { const v = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]'); return new Set(Array.isArray(v) ? v.filter(g => GROUPS.some(([k]) => k === g)) : []); }
  catch (e) { return new Set(); }
}
function saveHidden() { try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...filters.hidden])); } catch (e) { /* this device only */ } }

// Module-persistent view state (survives view switches, like the plan editor).
const filters = { hidden: savedHidden(), room: '', pin: '', q: '' };
let selectedId = null;
let shown = PAGE;               // how many of the visible photos have cards
let refreshTimer = 0;
const moving = new Map();       // property id -> { done, total } while held photos move into the folder
let thumbs = null;              // IntersectionObserver that loads gallery previews from the Mac
const previewQueue = [];
let previewsRunning = 0;

let el = null, prop = null;
let dropRoot = null;        // the shared #view element while the drop listeners are attached
let importing = null;       // running upload batch: { done, total, failed, queue: [{ file, prop }] }
let lightbox = null;        // { ids, idx } while the lightbox is open
let dragDepth = 0;
let previewToken = 0;       // guards async preview loads against stale selections
let pointerAt = null;       // { x, y } client position while the pointer is over the deck
let searchTimer = 0;        // the search waits for a pause in typing before it filters
let sheetOpen = false;      // the details sheet is up (small screens); a background redraw keeps it

// ---------- data helpers ----------
// Records: the photos Tiksi knows something about.
function photos() { return prop.photos || (prop.photos = []); }

// Every picture in the gallery: the records, and the project folder's pictures Tiksi has no
// record of (`listed`), which become records the first time something is kept about them.
let listedMemo = { listing: null, claimed: '', items: [], byId: new Map() };
function listedItems() {
  const listing = folderListing(prop);
  if (!listing || !keepsPhotosInFolder(prop)) return [];
  const paths = photos().filter(p => p.file).map(p => p.file.path);
  const claimed = paths.join('\n');
  if (listedMemo.listing === listing && listedMemo.claimed === claimed) return listedMemo.items;
  const taken = new Set(paths);
  const items = listing.files.filter(f => !taken.has(f.path) && !photoById(prop, f.key)).map(f => ({
    id: f.key, name: f.name, kind: 'photo', w: 0, h: 0, mime: f.mime, thumb: '', createdAt: new Date(f.mtime || 0).toISOString(),
    notes: '', roomId: '', elementIds: [], itemIds: [], pin: null, file: { path: f.path, size: f.size, mtime: f.mtime, group: f.group }, listed: true,
  }));
  listedMemo = { listing, claimed, items, byId: new Map(items.map(i => [i.id, i])) };
  return items;
}
function allItems() { return photos().concat(listedItems()); }
function itemById(id) { return photoById(prop, id) || (listedItems(), listedMemo.byId.get(id)) || null; }
// The record of a gallery item, made now if it is a listed picture with none.
function recordOf(item) { return item.listed ? keepRecord(prop, item) : item; }

function groupOf(p) {
  if (p.kind === 'document') return 'document';
  if (p.kind === 'pano') return 'pano';
  if (p.source === 'rendering') return 'rendering';
  if (p.source === 'polycam-keyframe') return 'scan';
  return p.file && p.file.group || 'photo';
}

function sortedPhotos() {
  const when = p => String(p.takenAt || p.createdAt || '');
  return allItems().sort((a, b) => when(b).localeCompare(when(a)));
}

function visiblePhotos() {
  const q = filters.q.trim().toLowerCase();
  return sortedPhotos().filter(p => {
    if (filters.hidden.has(groupOf(p))) return false;
    if (filters.room === '-' && p.roomId) return false;                          // "(no room)"
    if (filters.room && filters.room !== '-' && p.roomId !== filters.room) return false;
    if (filters.pin === 'pinned' && !p.pin) return false;
    if (filters.pin === 'unpinned' && p.pin) return false;
    if (filters.pin === 'selected' && !p.selected) return false;
    if (q && !(String(p.name || '').toLowerCase().includes(q) || String(p.notes || '').toLowerCase().includes(q)
      || (p.file && p.file.path.toLowerCase().includes(q)))) return false;
    return true;
  });
}

function roomName(id) {
  const r = prop.rooms.find(r => r.id === id);
  return r ? (r.name || 'Room') : '';
}
// Room selectors list every room on the property; with more than one storey the level name
// follows in parentheses so two "Bedroom"s can be told apart.
function roomLabel(r) {
  const name = r.name || 'Room';
  return prop.levels && prop.levels.length > 1 ? name + ' (' + levelOfRoom(prop, r).name + ')' : name;
}

function kindLabel(p) {
  return { pano: '360 PANO', document: 'DOCUMENT', rendering: 'RENDERING', scan: 'SCAN FRAME' }[groupOf(p)] || 'PHOTO';
}
const CAMERA_WORDS = { saved: 'lined up by eye', points: 'fitted to points', keyframe: 'from a scan frame', auto: 'placed automatically', position: 'from a numbered position' };
function cameraWords(p) {
  if (!p.view || !FOUND_SOURCES.includes(p.view.from)) return 'not found yet';
  return CAMERA_WORDS[p.view.from] + (p.view.fit && p.view.fit.n ? ' (' + p.view.fit.rmsPx.toFixed(1) + ' px over ' + p.view.fit.n + ')' : '');
}
function positionOf(p) { return p.positionId ? (prop.photoPositions || []).find(x => x.id === p.positionId) : null; }

function fileExt(mime) { return { 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/avif': 'avif', 'image/bmp': 'bmp', 'image/heic': 'heic', 'image/heif': 'heif',
  'image/tiff': 'tiff', 'image/svg+xml': 'svg', 'application/pdf': 'pdf' }[mime] || 'jpg'; }

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
  // Videos are tape-measure evidence: they are kept as originals and reviewed in MEASURE.
  const clips = Array.from(list || []).filter(isVideoFile);
  if (clips.length) {
    const { added, failed } = await importVideos(prop, clips);
    if (failed.length) alert('Not added:\n' + failed.join('\n'));
    if (added.length && confirm(added.length + ' video' + (added.length === 1 ? '' : 's') + ' added. Open MEASURE to review the frames?')) { location.hash = '#/measure?video=' + encodeURIComponent(added[0].id); return; }
  }
  // PDFs (shop drawings, spec sheets, schedules) become documents that can be pinned in the model.
  const pdfs = Array.from(list || []).filter(f => f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)));
  for (const f of pdfs) { try { await addDocumentFromFile(prop, f); } catch (e) { alert('Could not read ' + f.name + ': ' + e.message); } }
  if (pdfs.length && el) render();
  const files = Array.from(list || []).filter(f => f && (f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif|bmp|heic|heif)$/i.test(f.name)));
  if (!files.length) { if (list && list.length && !clips.length && !pdfs.length) alert('Only images and PDFs can be added here.'); return; }
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
    let added = null;
    try { added = last = await addPhotoFromFile(target, file); }
    catch (e) { batch.failed.push(file.name); }
    batch.done++;
    // One new card, not the whole gallery again: a few hundred photos are megabytes of thumbnails.
    if (el) { renderHead(); if (added && target === prop) addCard(added); }
  }
  importing = null;
  if (el) {
    // The last photo in is selected; its card is already in the gallery.
    if (last && photoById(prop, last.id)) {
      selectedId = last.id;
      el.querySelectorAll('.ph-card.active').forEach(c => { c.classList.remove('active'); c.setAttribute('aria-pressed', 'false'); });
      const card = el.querySelector(`.ph-card[data-id="${CSS.escape(last.id)}"]`);
      if (card) { card.classList.add('active'); card.setAttribute('aria-pressed', 'true'); }
    }
    renderHead(); renderDetail();
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
// The image becomes the tracing underlay of the level the PLAN editor is showing.
async function useAsUnderlay(p) {
  const lvl = activeLevel(prop);
  if (lvl.plan && lvl.plan.img && !confirm('Replace the plan underlay on "' + lvl.name + '" with "' + p.name + '"?')) return;
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
  lvl.plan = {
    img: isPng ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.92),
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
function matchIn3d(p) { location.hash = '#/model?match=' + encodeURIComponent(p.id); }

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
  const ask = p.file
    ? 'Remove what Tiksi keeps about "' + p.name + '" (its notes, pin, links and selection)? The photo stays in the project folder: ' + p.file.path
    : 'Delete "' + p.name + '"? This removes the file from browser storage and clears its links.';
  if (!confirm(ask)) return;
  clearReferences(p.id);
  await deletePhoto(prop, p.id);
  if (selectedId === p.id) selectedId = null;
  render();
}

// Selected: the good pictures, picked once (from hundreds of scan frames, say) and found again
// with the SELECTED filter. A folder picture gets a record when selected; one that was only
// selected is let go of again when unselected.
function toggleSelected(id) {
  const item = itemById(id);
  if (!item) return;
  const rec = recordOf(item);
  if (rec.selected) { delete rec.selected; releaseIfBare(prop, rec); }
  else rec.selected = true;
  touch();
  refreshCard(id);
  renderHead();
  if (selectedId === id) renderDetail();
  if (lightbox) renderLightboxCaption();
}

// One card drawn again in place (its chips changed), without drawing the gallery again.
function refreshCard(id) {
  const card = el && el.querySelector(`.ph-card[data-id="${CSS.escape(id)}"]`);
  const item = itemById(id);
  if (!card || !item) return;
  // The picture already shown stays; only the name, the chips and the tick are drawn again.
  const fresh = document.createElement('template');
  fresh.innerHTML = cardHtml(item);
  card.querySelector('.ph-card-body').replaceWith(fresh.content.querySelector('.ph-card-body'));
  const pick = card.querySelector('.ph-pick');
  pick.classList.toggle('on', !!item.selected);
  pick.setAttribute('aria-checked', String(!!item.selected));
  pick.title = (item.selected ? 'Unselect' : 'Select') + ' (S)';
}

async function showInFinder(p) {
  try { await diskWorkspace.openProjectPath(prop, p.file.path); }
  catch (e) { alert(e.message); }
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
  const p = itemById(id);
  if (!p) { closeLightbox(); return; }
  const img = box.querySelector('img');
  img.src = p.thumb || '';
  img.alt = p.name;
  box.classList.toggle('pano', p.kind === 'pano');
  renderLightboxCaption();
  // A PDF shows its current page; a photo its full-resolution original.
  const url = isPdfDocument(p) ? await documentCanvas(p, 2400).then(c => c && c.toDataURL('image/jpeg', 0.9)).catch(() => null) : await photoUrl(id);
  if (url && lightbox && lightbox.ids[lightbox.idx] === id) img.src = url;
}

function renderLightboxCaption() {
  const box = el && el.querySelector('.ph-lightbox');
  if (!box || !lightbox) return;
  const p = itemById(lightbox.ids[lightbox.idx]);
  if (!p) return;
  const size = p.w && p.h ? ' - ' + escapeHtml(p.w) + ' x ' + escapeHtml(p.h) : '';
  box.querySelector('.ph-lb-cap').innerHTML =
    `<b>${escapeHtml(p.name)}</b><span>${kindLabel(p)}${size}${p.roomId ? ' - ' + escapeHtml(roomName(p.roomId)) : ''} - ${lightbox.idx + 1} / ${lightbox.ids.length}</span>`
    + `<button class="btn small ${p.selected ? 'on' : ''}" data-act="lb-select" title="Select or unselect this picture (S)">${p.selected ? 'SELECTED' : 'SELECT'}</button>`;
  box.querySelector('[data-act=lb-select]').onclick = () => toggleSelected(p.id);
}

const typing = t => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
function onKeyDown(e) {
  // S selects or unselects the picture in the viewer, or the one open in the details.
  if ((e.key === 's' || e.key === 'S') && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e.target)) {
    const id = lightbox ? lightbox.ids[lightbox.idx] : selectedId;
    if (id) { e.preventDefault(); toggleSelected(id); }
    return;
  }
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
  const records = photos(), all = allItems();
  const listing = keepsPhotosInFolder(prop) ? folderListing(prop) : null;
  const panos = all.filter(p => p.kind === 'pano').length;
  const pinned = records.filter(p => p.pin).length;
  const picked = records.filter(p => p.selected).length;
  // Unpinned photos are placed one after another in the model: click where each was taken.
  // (Only photos Tiksi has a record of: a folder of scan frames is not placed one by one.)
  const unpinned = records.filter(p => !p.pin);
  const move = moving.get(prop.id);
  const canPlace = unpinned.length && !importing && (prop.walls.length || (prop.scans || []).length);
  const sub = importing ? `IMPORTING ${importing.done} / ${importing.total}`
    : move ? `MOVING ${move.done} / ${move.total} PHOTOS INTO THE PROJECT FOLDER`
    : `${all.length} photo${all.length === 1 ? '' : 's'}${listing ? ' in ' + listing.folder : ''} - ${panos} panorama${panos === 1 ? '' : 's'} - ${pinned} pinned in 3D - ${picked} selected`
      + (listing && listing.truncated ? ' - the folder has more pictures than Tiksi lists' : '');
  head.innerHTML = `
    <div class="ph-head-text">
      <span class="view-title">PHOTOS</span>
      <span class="view-sub ${importing || move ? 'busy' : ''}">${escapeHtml(sub)}</span>
    </div>
    <div class="ph-head-actions">
      <span class="ph-hint">${listing ? 'drop images anywhere - they are saved into ' + escapeHtml(listing.folder) + '/Photos' : 'drop images anywhere - or paste'}</span>
      ${canPlace ? `<button class="btn primary" data-act="place" title="Open the model and click where each unpinned photo was taken; each one links to the room and wall there">PLACE ${unpinned.length} IN 3D</button>` : ''}
      <button class="btn" data-act="reconstruct">PHOTO TO 3D</button>
      <button class="btn" data-act="camera" title="Take a photo with the phone camera">CAMERA</button>
      <button class="btn ${canPlace ? '' : 'primary'}" data-act="upload">UPLOAD</button>
      <input type="file" class="hidden-file" data-file="upload" accept="image/*,application/pdf,.pdf" multiple>
      <input type="file" class="hidden-file" data-file="camera" accept="image/*" capture="environment">
    </div>`;
  bindUploadButtons(head);
  const place = head.querySelector('[data-act=place]');
  if (place) place.onclick = () => {
    const first = photos().find(p => !p.pin);
    if (first) pinIn3d(first);
  };
}

function bindUploadButtons(root) {
  const reconstruct = root.querySelector('[data-act=reconstruct]');
  if (reconstruct) reconstruct.onclick = () => { location.hash = '#/reconstruct'; };
  const up = root.querySelector('[data-file=upload]'), cam = root.querySelector('[data-file=camera]');
  const upBtn = root.querySelector('[data-act=upload]'), camBtn = root.querySelector('[data-act=camera]');
  if (upBtn) upBtn.onclick = () => up.click();
  if (camBtn) camBtn.onclick = () => cam.click();
  for (const inp of [up, cam]) if (inp) inp.onchange = () => { addFiles(inp.files); inp.value = ''; };
}

function renderFilters() {
  const bar = el.querySelector('.ph-filters');
  if (!bar) return;
  const rooms = prop.rooms.map(r => `<option value="${escapeHtml(r.id)}" ${filters.room === r.id ? 'selected' : ''}>${escapeHtml(roomLabel(r))}</option>`).join('');
  const counts = {};
  for (const p of allItems()) { const g = groupOf(p); counts[g] = (counts[g] || 0) + 1; }
  // A group with nothing in it is not offered, unless it is hidden (so it can be shown again).
  const groups = GROUPS.filter(([g]) => counts[g] || filters.hidden.has(g)).map(([g, label]) =>
    `<button type="button" class="btn small ph-group ${filters.hidden.has(g) ? '' : 'on'}" data-group="${g}" aria-pressed="${!filters.hidden.has(g)}"
      title="${filters.hidden.has(g) ? 'Show' : 'Hide'} ${label.toLowerCase()}">${label} <span class="mono">${counts[g] || 0}</span></button>`).join('');
  bar.innerHTML = `
    <span class="ph-groups" role="group" aria-label="Show or hide each kind of picture">${groups}</span>
    <select data-filter="room" aria-label="Filter by room">
      <option value="">ALL ROOMS</option>
      <option value="-" ${filters.room === '-' ? 'selected' : ''}>(no room)</option>${rooms}
    </select>
    <select data-filter="pin" aria-label="Filter by pinned, unpinned or selected">
      <option value="">ALL PHOTOS</option>
      <option value="pinned" ${filters.pin === 'pinned' ? 'selected' : ''}>PINNED IN 3D</option>
      <option value="unpinned" ${filters.pin === 'unpinned' ? 'selected' : ''}>NOT PINNED</option>
      <option value="selected" ${filters.pin === 'selected' ? 'selected' : ''}>SELECTED</option>
    </select>
    <input type="search" class="search-input" data-filter="q" value="${escapeHtml(filters.q)}" placeholder="search name or notes" aria-label="Search photos">
    <span class="sp"></span>
    <span class="ph-count mono"></span>`;
  bar.querySelectorAll('select[data-filter]').forEach(s => s.onchange = () => { filters[s.dataset.filter] = s.value; shown = PAGE; renderGrid(); });
  bar.querySelectorAll('[data-group]').forEach(b => b.onclick = () => {
    const g = b.dataset.group;
    if (filters.hidden.has(g)) filters.hidden.delete(g); else filters.hidden.add(g);
    saveHidden(); shown = PAGE; renderFilters(); renderGrid();
  });
  bar.querySelector('[data-filter=q]').oninput = e => { filters.q = e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(() => { if (el) { shown = PAGE; renderGrid(); } }, 200); };
}

function cardHtml(p) {
  const chips = [
    `<span class="chip ${p.kind === 'pano' ? 'cyan' : ''}">${kindLabel(p)}</span>`,
    positionOf(p) ? `<span class="chip accent">POSITION ${positionOf(p).number} · ${(ROLE_LABELS[p.role] || '').toUpperCase()}</span>` : '',
    p.kind === 'photo' && p.view && FOUND_SOURCES.includes(p.view.from) ? '<span class="chip green">CAMERA</span>' : '',
    p.roomId ? `<span class="chip">${escapeHtml(roomName(p.roomId))}</span>` : '',
    p.selected ? `<span class="chip green">SELECTED</span>` : '',
    p.pin ? `<span class="chip accent">PINNED</span>` : '',
    missingFiles.has(p.id) ? `<span class="chip red">NOT IN FOLDER</span>` : '',
    (p.itemIds || []).length ? `<span class="chip green">${p.itemIds.length} ITEM${p.itemIds.length === 1 ? '' : 'S'}</span>` : '',
    (p.elementIds || []).length ? `<span class="chip">${p.elementIds.length} ELEMENT${p.elementIds.length === 1 ? '' : 'S'}</span>` : '',
    prop.env && prop.env.panoPhotoId === p.id ? `<span class="chip accent">SKY</span>` : '',
  ].filter(Boolean).join('');
  return `<button class="ph-card ${p.kind === 'pano' ? 'pano' : ''} ${p.id === selectedId ? 'active' : ''}" data-id="${escapeHtml(p.id)}"
      aria-pressed="${p.id === selectedId}" title="${escapeHtml(p.file ? p.file.path : p.name)} (double-click to zoom, S to select)">
    <div class="ph-thumb"><img ${p.thumb ? `src="${escapeHtml(p.thumb)}"` : p.file ? `data-preview="${escapeHtml(p.file.path)}"` : ''} alt="" loading="lazy" draggable="false">
      <span class="ph-pick ${p.selected ? 'on' : ''}" role="checkbox" aria-checked="${!!p.selected}" aria-label="Selected" title="${p.selected ? 'Unselect' : 'Select'} (S)">&#x2713;</span></div>
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
      <input type="file" class="hidden-file" data-file="upload" accept="image/*,application/pdf,.pdf" multiple>
      <input type="file" class="hidden-file" data-file="camera" accept="image/*" capture="environment">
    </div>
    <p class="ph-empty-foot">${keepsPhotosInFolder(prop) ? 'Pictures put anywhere in the project folder ' + escapeHtml((folderListing(prop) || {}).folder || '') + ' show here. Photos dropped or pasted here are saved into its Photos folder.'
      : 'Drop image files anywhere on this view, or paste an image from the clipboard. Nothing leaves your browser.'}</p>
  </div>`;
}

function renderGrid() {
  const grid = el.querySelector('.ph-grid');
  if (!grid) return;
  const all = allItems();
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
    grid.querySelector('[data-act=clear]').onclick = () => { filters.room = filters.pin = filters.q = ''; filters.hidden.clear(); saveHidden(); renderFilters(); renderGrid(); };
    return;
  }
  // A large folder is drawn a page at a time; the next page comes as the gallery scrolls to it.
  const open = selectedId ? list.findIndex(p => p.id === selectedId) : -1;
  if (open >= shown) shown = Math.ceil((open + 1) / PAGE) * PAGE;
  grid.innerHTML = list.slice(0, shown).map(cardHtml).join('') + moreHtml(list.length - shown);
  grid.querySelectorAll('.ph-card').forEach(bindCard);
  watchPreviews(grid);
  bindMore(grid, list);
  let frame = 0;
  grid.onpointermove = e => {
    if (e.pointerType === 'touch') return;
    pointerAt = { x: e.clientX, y: e.clientY };
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (pointerAt) liftCardAt(grid, pointerAt.x, pointerAt.y); });
  };
  grid.onpointerleave = () => { if (frame) cancelAnimationFrame(frame); frame = 0; pointerAt = null; liftCardAt(grid, null); };
  // A re-render under a still pointer keeps the same card lifted.
  if (pointerAt) liftCardAt(grid, pointerAt.x, pointerAt.y);
}

function bindCard(card) {
  const grid = card.parentElement;
  card.onclick = () => {
    // Tapping the open photo again brings its details back (on a phone they are a sheet).
    if (selectedId === card.dataset.id) { setSheet(true); return; }
    const prev = grid.querySelector('.ph-card.active');
    if (prev) { prev.classList.remove('active'); prev.setAttribute('aria-pressed', 'false'); }
    selectedId = card.dataset.id;
    card.classList.add('active');
    card.setAttribute('aria-pressed', 'true');
    renderDetail();
    setSheet(true);
  };
  card.ondblclick = () => openLightbox(card.dataset.id);
  const pick = card.querySelector('.ph-pick');
  if (pick) {
    pick.onclick = e => { e.stopPropagation(); toggleSelected(card.dataset.id); };
    pick.ondblclick = e => e.stopPropagation();
  }
}

function moreHtml(left) {
  return left > 0 ? `<div class="ph-more"><button class="btn small" data-act="more">SHOW ${Math.min(left, PAGE)} MORE OF ${left}</button></div>` : '';
}
function bindMore(grid, list) {
  const more = grid.querySelector('.ph-more');
  if (!more) return;
  const next = () => {
    if (!more.isConnected) return;
    const from = shown; shown += PAGE;
    more.insertAdjacentHTML('beforebegin', list.slice(from, shown).map(cardHtml).join(''));
    const cards = Array.from(grid.querySelectorAll('.ph-card')).slice(from);
    cards.forEach(card => { bindCard(card); watchPreview(card); });
    const left = list.length - shown;
    if (left > 0) more.querySelector('button').textContent = `SHOW ${Math.min(left, PAGE)} MORE OF ${left}`;
    else { observer.disconnect(); more.remove(); }
  };
  more.querySelector('button').onclick = next;
  const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) next(); }, { root: grid, rootMargin: '600px' });
  observer.observe(more);
}

// Gallery previews of folder pictures come from the Mac as their cards near the screen.
function watchPreviews(grid) {
  if (thumbs) thumbs.disconnect();
  thumbs = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) { thumbs.unobserve(e.target); queuePreview(e.target); }
  }, { root: grid, rootMargin: '400px' });
  grid.querySelectorAll('img[data-preview]').forEach(img => thumbs.observe(img));
}
function watchPreview(card) {
  const img = card.querySelector('img[data-preview]');
  if (img && thumbs) thumbs.observe(img);
}
function queuePreview(img) {
  previewQueue.push({ img, prop });
  pumpPreviews();
}
function pumpPreviews() {
  while (previewsRunning < PREVIEW_LOADS && previewQueue.length) {
    const { img, prop: owner } = previewQueue.shift();
    if (!img.isConnected || !img.dataset.preview || owner !== prop) continue;
    previewsRunning++;
    folderPreviewUrl(owner, img.dataset.preview, 256).then(url => {
      // Shown, the picture no longer needs its URL; the browser keeps the copy for next time.
      img.onload = img.onerror = () => URL.revokeObjectURL(url);
      img.src = url;
      delete img.dataset.preview;
    }).catch(() => { img.closest('.ph-thumb')?.classList.add('no-preview'); })
      .finally(() => { previewsRunning--; pumpPreviews(); });
  }
}

// A photo just imported: its card goes in front (the gallery is newest first), or the gallery
// is drawn once when this is its first card or the filters hide it.
function addCard(rec) {
  const grid = el && el.querySelector('.ph-grid');
  if (!grid) return;
  // A photo already in the folder came back as its own record: its card is there.
  if (grid.querySelector(`.ph-card[data-id="${CSS.escape(rec.id)}"]`)) return;
  if (grid.classList.contains('is-empty') || !grid.querySelector('.ph-card') || !visiblePhotos().some(p => p.id === rec.id)) { renderGrid(); return; }
  grid.insertAdjacentHTML('afterbegin', cardHtml(rec));
  bindCard(grid.firstElementChild);
  watchPreview(grid.firstElementChild);
  const count = el.querySelector('.ph-count'), all = allItems(), n = visiblePhotos().length;
  if (count) count.textContent = n !== all.length ? `${n} OF ${all.length}` : '';
}

// The details slide over the gallery on a small screen (css/photos.css); this says whether.
function setSheet(on) {
  sheetOpen = !!on && !!selectedId;
  const layout = el && el.querySelector('.ph-layout');
  if (layout) layout.classList.toggle('sheet-open', sheetOpen);
}

// The cards overlap, so whichever card is on top is not the one being pointed at: a card's own
// strip is the part of it left showing, from its top down to where a later row covers it. Pick
// the card whose top is lowest above the pointer (later rows paint over earlier ones), using
// layout offsets so a lifted card's transform does not move its strip.
function liftCardAt(grid, clientX, clientY) {
  let pick = null;
  if (clientX != null) {
    const r = grid.getBoundingClientRect();
    const x = clientX - r.left - grid.clientLeft + grid.scrollLeft;
    const y = clientY - r.top - grid.clientTop + grid.scrollTop;
    for (const card of grid.children) {
      if (!card.classList.contains('ph-card')) continue;
      const l = card.offsetLeft, t = card.offsetTop;
      if (x < l || x > l + card.offsetWidth || y < t || y > t + card.offsetHeight) continue;
      if (!pick || t > pick.offsetTop) pick = card;
    }
  }
  const prev = grid.querySelector('.ph-card.lift');
  if (prev === pick) return;
  if (prev) prev.classList.remove('lift');
  if (pick) pick.classList.add('lift');
}

// Scope items of this property's projects (and unassigned ones); an item already linked from
// elsewhere stays listed so it can be unlinked.
function scopeOptionsHtml(p) {
  const have = new Set(p.itemIds || []);
  const groups = {};
  for (const { project, item } of allScopeItems()) {
    if (project.propertyId && project.propertyId !== prop.id && !have.has(item.id)) continue;
    (groups[project.name] = groups[project.name] || []).push(item);
  }
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
    `<option value="${escapeHtml(r.id)}" ${have.has(r.id) ? 'selected' : ''}>${escapeHtml(roomLabel(r))}</option>`).join('');
  return (rooms ? `<optgroup label="Rooms / floors">${rooms}</optgroup>` : '') + (walls ? `<optgroup label="Walls">${walls}</optgroup>` : '');
}

function renderDetail() {
  const pane = el.querySelector('.ph-detail');
  if (!pane) return;
  // A folder picture with no record yet gets one on the first thing kept about it (`kept`).
  let p = selectedId ? itemById(selectedId) : null;
  const kept = () => (p = recordOf(p));
  if (!p) {
    selectedId = null;
    setSheet(false);
    pane.innerHTML = `<div class="ph-detail-body"><h3>PHOTO</h3>
      <div class="empty">Select a photo to name it, add notes, link it to rooms, walls and scope items, or send it to the plan, the model or the material library.<br><br>
      Double-click a card to open the viewer.</div></div>`;
    return;
  }
  const looksPano = isPanoramaAspect(p.w, p.h);
  const isSky = prop.env && prop.env.sky === 'pano' && prop.env.panoPhotoId === p.id;
  const token = ++previewToken;
  pane.innerHTML = `
    <button type="button" class="ph-sheet-close" data-act="sheet-close" aria-label="Close the photo details">CLOSE</button>
    <div class="ph-preview ${p.kind === 'pano' ? 'pano' : ''}">
      <img ${p.thumb ? `src="${escapeHtml(p.thumb)}"` : ''} alt="${escapeHtml(p.name)}" draggable="false">
      <button class="ph-zoom" data-act="zoom" title="Open viewer (double-click a card also works)" aria-label="Open viewer">ZOOM</button>
      <span class="ph-preview-badge" data-storage hidden>${p.file ? 'NOT IN THE FOLDER' : 'THUMBNAIL ONLY'}</span>
    </div>
    <div class="ph-detail-body">
      <h3>${kindLabel(p)}</h3>
      <div class="field"><label>Name</label><input type="text" data-f="name" value="${escapeHtml(p.name)}"></div>
      ${p.kind === 'document' ? '' : `<div class="field"><label>Kind</label>
        <div class="seg">
          <button class="seg-btn ${p.kind !== 'pano' ? 'active' : ''}" data-kind="photo" style="flex:1">PHOTO</button>
          <button class="seg-btn ${p.kind === 'pano' ? 'active' : ''}" data-kind="pano" style="flex:1">360 PANORAMA</button>
        </div>
        ${looksPano && p.kind !== 'pano' ? '<div class="ph-note">2:1 aspect: this looks like an equirectangular panorama.</div>' : ''}
      </div>`}
      <div class="field"><label>Send to</label>
        <div class="ph-send">
          <button class="btn" data-act="underlay" title="Trace walls over this image in PLAN">PLAN UNDERLAY</button>
          ${isSky
            ? '<button class="btn on" data-act="clear-sky" title="Stop lighting the model with this panorama">SKY: ON</button>'
            : `<button class="btn" data-act="sky" title="${p.kind === 'pano' ? 'Light the 3D model with this panorama' : 'Set the kind to 360 panorama first'}" ${p.kind === 'pano' ? '' : 'disabled'}>USE AS SKY</button>`}
          ${p.pin
            ? '<button class="btn on" data-act="pin" title="Show this pin in the 3D model">PINNED: SHOW</button>'
            : '<button class="btn" data-act="pin" title="Place this photo on a surface in the 3D model">PIN IN 3D</button>'}
          ${p.kind === 'pano' || p.kind === 'document' ? '' : '<button class="btn" data-act="match" title="Stand where this photo was taken, with the photo over the model, to check the model against the site">PHOTO MODE</button>'}
          ${isPdfDocument(p) ? '<button class="btn" data-act="openpdf" title="Open the PDF in a new tab">OPEN PDF</button>' : ''}
          <button class="btn ${p.selected ? 'on' : ''}" data-act="select" title="Mark the good pictures; the SELECTED filter shows them (S)">${p.selected ? 'SELECTED' : 'SELECT'}</button>
          <div class="ph-mat">
            <button class="btn" data-act="material" title="Create a photo-based material from this image">MATERIAL</button>
            <select data-mat-kind aria-label="Material kind">${MATERIAL_KINDS.map(k => `<option value="${k}">${k}</option>`).join('')}</select>
          </div>
        </div>
      </div>
      <div class="field"><label>Room</label>
        <select data-f="roomId"><option value="">(none)</option>${prop.rooms.map(r =>
          `<option value="${escapeHtml(r.id)}" ${p.roomId === r.id ? 'selected' : ''}>${escapeHtml(roomLabel(r))}</option>`).join('')}</select></div>
      <div class="field"><label>Notes</label><textarea data-f="notes" placeholder="What does this show? Conditions, measurements, ideas.">${escapeHtml(p.notes || '')}</textarea></div>
      <div class="field"><label>Scope items (cut sheets)</label>
        <select multiple size="4" data-multi="itemIds" aria-label="Linked scope items">${scopeOptionsHtml(p)}</select>
        <div class="ph-note">Ctrl/Cmd-click to link several. Linked photos print on the item's cut sheet.</div></div>
      <div class="field"><label>Model elements</label>
        <select multiple size="4" data-multi="elementIds" aria-label="Linked model elements">${elementOptionsHtml(p)}</select>
        <div class="ph-note">Photos of a wall or floor follow it onto every cut sheet that rebuilds it.</div></div>

      ${p.w && p.h ? `<div class="stat-line"><span>Size</span><b>${escapeHtml(p.w)} x ${escapeHtml(p.h)}</b></div>` : ''}
      ${p.file ? `<div class="stat-line"><span>In the folder</span><b>${escapeHtml(p.file.path)}${missingFiles.has(p.id) ? ' (not there now)' : ''}</b></div>`
        : `<div class="stat-line"><span>Added</span><b>${escapeHtml(fmtDate(String(p.createdAt || '').slice(0, 10)))}</b></div>`}
      <div class="stat-line"><span>Pinned in 3D</span><b>${p.pin ? `x ${(+p.pin.x).toFixed(2)}  y ${(+p.pin.y).toFixed(2)}  z ${(+p.pin.z).toFixed(2)}` : 'no'}</b></div>
      ${p.kind === 'document' ? `<div class="stat-line"><span>Sheet</span><b>${(p.sheetW * 39.37).toFixed(1)} x ${(p.sheetH * 39.37).toFixed(1)} in${p.pageCount > 1 ? ' · page ' + p.page + ' of ' + p.pageCount : ''}</b></div>`
        : `<div class="stat-line"><span>Camera</span><b>${escapeHtml(cameraWords(p))}</b></div>
      ${p.lens ? `<div class="stat-line"><span>Lens</span><b>${p.lens.f35 ? p.lens.f35 + ' mm equiv. · ' : ''}${Math.round(p.lens.hfov)}&deg; across</b></div>` : ''}
      ${p.takenAt ? `<div class="stat-line"><span>Taken</span><b>${escapeHtml(p.takenAt.replace('T', ' ').slice(0, 16))}</b></div>` : ''}
      ${positionOf(p) ? `<div class="stat-line"><span>Numbered position</span><b>${positionOf(p).number}${positionOf(p).name ? ' · ' + escapeHtml(positionOf(p).name) : ''} · ${escapeHtml(ROLE_LABELS[p.role] || '')}</b></div>` : ''}`}
      ${isSky ? '<div class="stat-line"><span>Sky</span><b class="accent">ACTIVE (lighting the model)</b></div>' : ''}

      <div class="ph-actions">
        ${p.pin ? '<button class="btn" data-act="unpin" title="Remove the 3D pin">UNPIN</button>' : ''}
        ${p.file ? '<button class="btn" data-act="finder" title="Show this photo in Finder on the Mac">SHOW IN FINDER</button>' : ''}
        <button class="btn" data-act="download" title="Save the original file">DOWNLOAD</button>
        ${p.listed ? '' : p.file ? '<button class="btn danger" data-act="delete" title="The photo stays in the project folder">REMOVE FROM TIKSI</button>' : '<button class="btn danger" data-act="delete">DELETE</button>'}
      </div>
    </div>`;

  // Swap the thumbnail for the full-resolution object URL once it is available.
  const img = pane.querySelector('.ph-preview img');
  (isPdfDocument(p) ? Promise.resolve(p.thumb) : photoUrl(p.id)).then(url => {
    if (token !== previewToken || !el) return;
    if (url) img.src = url;
    else pane.querySelector('[data-storage]').hidden = false;
  });

  pane.querySelector('[data-f=name]').onchange = e => {
    const name = e.target.value.trim() || p.name;
    if (name !== p.name) { kept().name = name; touch(); }
    e.target.value = p.name;
    const card = el.querySelector(`.ph-card[data-id="${CSS.escape(p.id)}"] .ph-name`);
    if (card) card.textContent = p.name;
  };
  pane.querySelector('[data-f=notes]').onchange = e => { kept().notes = e.target.value; touch(); };
  pane.querySelector('[data-f=roomId]').onchange = e => { kept().roomId = e.target.value; touch(); renderGrid(); };
  pane.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => {
    if (p.kind === b.dataset.kind) return;
    kept().kind = b.dataset.kind;
    // Only the sky depends on the kind; a material built from the image keeps working.
    if (p.kind !== 'pano') clearSkyReference(p.id);
    touch(); render();
  });
  pane.querySelectorAll('[data-multi]').forEach(sel => sel.onchange = () => {
    kept()[sel.dataset.multi] = Array.from(sel.selectedOptions).map(o => o.value);
    touch(); renderGrid();
  });
  const act = (name, fn) => { const b = pane.querySelector(`[data-act=${name}]`); if (b) b.onclick = () => fn(p); };
  // These need the photo's record, with its size read from the file, before they go on.
  const actKept = (name, fn) => act(name, async () => { const r = kept(); await whenFilled(r); fn(r); });
  act('sheet-close', () => setSheet(false));
  act('zoom', () => openLightbox(p.id));
  act('select', () => toggleSelected(p.id));
  act('finder', showInFinder);
  actKept('underlay', useAsUnderlay);
  actKept('sky', useAsSky);
  act('clear-sky', clearSky);
  actKept('pin', pinIn3d);
  actKept('match', matchIn3d);
  act('unpin', unpin);
  actKept('material', materialFromPhoto);
  act('download', download);
  act('openpdf', async () => {
    const buf = await photoBytes(p.id);
    if (!buf) { alert('The PDF file is missing from this browser.'); return; }
    const url = URL.createObjectURL(new Blob([buf], { type: 'application/pdf' }));
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  });
  act('delete', remove);
}

// ---------- mount / unmount ----------
export function mount(root) {
  prop = activeProperty();
  el = root;
  if (!prop) {
    root.innerHTML = `<div class="view-scroll"><div class="kicker">PHOTOS</div>
      <p class="muted">No property yet. Create one with NEW PROPERTY under FILE.</p></div>`;
    return;
  }
  // Deep link from PROJECTS: #/photos?select=<photoId> selects that photo.
  const m = /[?&]select=([^&]+)/.exec(location.hash);
  let opened = false;
  if (m) {
    if (photoById(prop, decodeURIComponent(m[1]))) { selectedId = decodeURIComponent(m[1]); opened = true; Object.assign(filters, { room: '', pin: '', q: '' }); filters.hidden.clear(); saveHidden(); }
    history.replaceState(null, '', '#/photos');
  }
  if (selectedId && !itemById(selectedId)) selectedId = null;
  shown = PAGE;
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
      <aside class="ph-detail inspector" data-side-pane="photos"></aside>
      <div class="ph-drop" hidden><div class="ph-drop-box">DROP PHOTOS TO ADD THEM TO ${escapeHtml(prop.name).toUpperCase()}</div></div>
    </div>`;
  render();
  // Sent here to see one photo (a capture, a link from PROJECTS): its details open. A redraw of
  // the page (a background save brings it back) keeps them open if they were.
  if (opened || sheetOpen) setSheet(true);

  // #view outlives the view, so these come off again in unmount().
  dropRoot = root;
  dropRoot.addEventListener('dragenter', onDragEnter);
  dropRoot.addEventListener('dragover', onDragOver);
  dropRoot.addEventListener('dragleave', onDragLeave);
  dropRoot.addEventListener('drop', onDrop);
  document.addEventListener('paste', onPaste);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('focus', onFocus);
  readFolder(prop, true);
}

// The project folder is listed when PHOTOS opens, when the window comes back to the front and
// every REFRESH_MS; the gallery is drawn again only when what the folder holds changed. Photos
// Tiksi still holds are moved into the folder's Photos folder the first time.
function onFocus() { if (prop) readFolder(prop, false); }
async function readFolder(owner, first) {
  clearTimeout(refreshTimer);
  if (!keepsPhotosInFolder(owner)) return;
  const before = folderListing(owner);
  try {
    let listing = await loadFolderPhotos(owner);
    if (heldPhotos(owner).length && !moving.has(owner.id)) {
      const state = { done: 0, total: 0 };
      moving.set(owner.id, state);
      if (owner === prop) renderHead();
      const result = await moveHeldPhotos(owner, (done, total) => { Object.assign(state, { done, total }); if (owner === prop && el) renderHead(); })
        .finally(() => moving.delete(owner.id));
      listing = await loadFolderPhotos(owner);
      if (result.failed.length) alert(result.failed.length + ' photo' + (result.failed.length === 1 ? '' : 's') + ' could not be moved into the project folder and are still kept in Tiksi: ' + result.failed.join(', '));
    }
    if (owner === prop && el && (first || !before || before.signature !== listing.signature)) { renderHead(); renderFilters(); renderGrid(); renderDetail(); }
  } catch (e) {
    console.error('Could not read the project folder', e);
    if (owner === prop && el) { const sub = el.querySelector('.ph-head .view-sub'); if (sub) sub.textContent = 'The project folder could not be read: ' + e.message; }
  }
  if (owner === prop && el) refreshTimer = setTimeout(() => { if (prop === owner && el) readFolder(owner, false); }, REFRESH_MS);
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
  window.removeEventListener('focus', onFocus);
  clearTimeout(refreshTimer);
  if (thumbs) { thumbs.disconnect(); thumbs = null; }
  previewQueue.length = 0;
  // A running upload batch keeps going (it owns its state); the preview and lightbox URLs go.
  revokePhotoUrls();
  clearTimeout(searchTimer);
  lightbox = null; dragDepth = 0; pointerAt = null;
  el = null; prop = null;
}
