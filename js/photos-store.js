// Photo storage. With the Mac's server and a property saved to its project folder, photos are
// kept in that folder and read from it where they are (server/project_photos.py): Tiksi holds
// no copy. A photo taken or dropped in Tiksi is written into the folder's Photos folder, and
// prop.photos keeps a record only of the photos Tiksi knows something about (a pin, notes,
// links, a camera, or that it was selected), with `file` naming the photo in the folder.
// Without a project folder (no server, or a property not saved yet) the full-resolution bytes
// live in IndexedDB (same 'files' store as scans), and are moved into the folder later.
// Either way a small JPEG thumbnail lives on the record so galleries and cut sheets render at
// once (store.js keeps an IndexedDB copy of it so the localStorage JSON stays small).
// All helpers are property-scoped: prop.photos is the list.
//
// Photo record shape (see also store.js migrate):
// { id, name, kind: 'photo' | 'pano', w, h, mime, thumb (dataURL <= 360px), createdAt,
//   notes, roomId, elementIds: [], itemIds: [], pin: null | { x, y, z, nx, ny, nz, size },
//   view?: { position: [x,y,z], target: [x,y,z], fov (horizontal deg), from?, roll?, fit?, pairs? } (photo-match.js),
//   lens?: the camera's lens read from the file (photo-exif.js), takenAt?: when it was taken,
//   kind 'document' records are PDFs and sheets pinned in the model (documents.js),
//   positionId? / role?: a picture of a numbered photo position (positions.js),
//   file?: { path, size, mtime, sha256?, group }: the photo in the project folder (group is
//     'photo', 'scan' for a Polycam export's keyframe or 'rendering'), selected?: true }

import { ws, uid, touch, putFile, getFile, deleteFile, storeThumb, deleteThumb } from './store.js';
import { diskWorkspace } from './disk-workspace.js';
import { readExif, lensFromExif } from './photo-exif.js';
import { working } from './work-in-progress.js';

const THUMB_MAX = 360;
// Object URLs for full-resolution images. Each one pins a Blob copy of the IndexedDB buffer
// (the original camera file), so keep a handful in recency order and revoke the rest.
const URL_CACHE_MAX = 12;
const urlCache = new Map();   // photoId -> object URL, least recently used first

function drawTo(img, w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w); c.height = Math.max(1, h);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function loadImageEl(fileOrBlob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(fileOrBlob);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode image')); };
    img.src = url;
  });
}

async function decode(file) {
  // createImageBitmap honours EXIF orientation; fall back to <img> for odd formats.
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) { return loadImageEl(file); }
}

export function isPanoramaAspect(w, h) { return Math.abs(w / h - 2) < 0.12; }

// Add a photo (File or Blob) to a property. Returns the new record.
// (Counted as work in progress from the first byte read: see work-in-progress.js.)
export function addPhotoFromFile(prop, file, opts) { return working(addPhoto(prop, file, opts)); }
async function addPhoto(prop, file, opts) {
  opts = opts || {};
  if (keepsPhotosInFolder(prop)) {
    try { return await addToFolder(prop, file, opts); }
    catch (e) {
      // A refusal is said; a Mac out of reach keeps the photo here until it can be moved.
      if (e.status && e.status !== 404 && e.status < 500) throw e;
      console.warn('The photo is kept in Tiksi until the project folder can be reached', e);
    }
  }
  const img = await decode(file);
  const w = img.width, h = img.height;
  // Retain camera resolution, EXIF/depth metadata, transparency and original encoding.
  // Photogrammetry needs the source bytes; gallery thumbnails are the only derived copy.
  const buffer = await file.arrayBuffer();
  const mime = file.type || ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' }[String(file.name || '').split('.').pop().toLowerCase()] || 'application/octet-stream');
  const ts = Math.min(1, THUMB_MAX / Math.max(w, h));
  const thumb = drawTo(img, Math.round(w * ts), Math.round(h * ts)).toDataURL('image/jpeg', 0.8);
  if (img.close) img.close();

  const id = uid('ph');
  await putFile(id, buffer, { name: file.name || 'photo', mime, kind: 'photo', original: true });
  // The IndexedDB copy of the thumbnail keeps it out of the localStorage JSON; if that write
  // fails the record simply carries it inline, as older saves do.
  try { await storeThumb(id, thumb); } catch (e) { console.error('thumbnail store failed', e); }
  const rec = {
    id, name: file.name || 'Photo', kind: opts.kind || (isPanoramaAspect(w, h) ? 'pano' : 'photo'),
    w, h, mime, thumb, original: true, byteLength: buffer.byteLength,
    createdAt: new Date().toISOString(), notes: '', roomId: '', elementIds: [], itemIds: [], pin: null,
  };
  Object.assign(rec, cameraFacts(buffer, w, h));
  for (const k of ['source', 'positionId', 'role', 'renderedAt', 'view']) if (opts[k] !== undefined) rec[k] = opts[k];
  prop.photos = prop.photos || [];
  prop.photos.push(rec);
  touch();
  return rec;
}

// The lens and capture time a photo file records, for a photo shown at w x h: { lens?, takenAt? }.
export function cameraFacts(buffer, w, h) {
  const out = {};
  let exif = null;
  try { exif = readExif(buffer); } catch (e) { exif = null; }
  if (!exif) return out;
  const lens = lensFromExif(exif, w, h);
  if (lens) out.lens = lens;
  if (exif.takenAt) out.takenAt = exif.takenAt;
  return out;
}

// Photos imported before Tiksi read lenses: read it now from the kept original. Returns true when
// the record changed.
export async function ensureCameraFacts(rec) {
  if (!rec || rec.kind !== 'photo' || (rec.lens && rec.takenAt) || rec.source === 'rendering') return false;
  const buf = await photoBytes(rec.id);
  if (!buf) return false;
  const facts = cameraFacts(buf, rec.w, rec.h);
  let changed = false;
  if (facts.lens && !rec.lens) { rec.lens = facts.lens; changed = true; }
  if (facts.takenAt && !rec.takenAt) { rec.takenAt = facts.takenAt; changed = true; }
  return changed;
}

// Object URL for the full-resolution image (cached; null if the bytes are gone).
export async function photoUrl(id) {
  if (urlCache.has(id)) {
    const url = urlCache.get(id);
    urlCache.delete(id); urlCache.set(id, url);   // mark as most recently used
    return url;
  }
  const ref = fileRef(id);
  if (ref) {
    let blob = null;
    try {
      // A browser shows a JPEG or a PNG as it is; a HEIC or a TIFF comes as the Mac's JPEG copy.
      blob = SHOWN.has(ref.mime) ? new Blob([(await folderApi().file(ref.prop, ref.path)).buffer], { type: ref.mime })
        : await folderApi().preview(ref.prop, ref.path, 2048);
    } catch (e) { return null; }
    if (urlCache.has(id)) return urlCache.get(id);
    return cacheUrl(id, URL.createObjectURL(blob));
  }
  const rec = await getFile(id);
  if (!rec || !rec.buffer) return null;
  if (urlCache.has(id)) return urlCache.get(id);   // a parallel call for the same photo won
  return cacheUrl(id, URL.createObjectURL(new Blob([rec.buffer], { type: rec.mime || 'image/jpeg' })));
}

function cacheUrl(id, url) {
  urlCache.set(id, url);
  while (urlCache.size > URL_CACHE_MAX) {
    const [oldestId, oldest] = urlCache.entries().next().value;
    URL.revokeObjectURL(oldest);
    urlCache.delete(oldestId);
  }
  return url;
}

function releaseUrl(id) {
  const url = urlCache.get(id);
  if (url) { URL.revokeObjectURL(url); urlCache.delete(id); }
}

// Full-resolution bytes (ArrayBuffer) or null.
export async function photoBytes(id) {
  const ref = fileRef(id);
  if (ref) {
    try { return (await folderApi().file(ref.prop, ref.path)).buffer; }
    catch (e) { return null; }
  }
  const rec = await getFile(id);
  return rec && rec.buffer ? rec.buffer : null;
}

export function photoById(prop, id) {
  return (prop && prop.photos || []).find(p => p.id === id) || null;
}

export async function deletePhoto(prop, id) {
  prop.photos = (prop.photos || []).filter(p => p.id !== id);
  releaseUrl(id);
  touch();
  // The record is gone either way; bytes a failed delete leaves behind show up under
  // EXPORT > CLEAN STORAGE.
  try { await deleteThumb(id); await deleteFile(id); }
  catch (e) { console.error('could not delete the photo file', e); }
}

// Drop every cached object URL: on workspace replacement, and when a view that browsed the
// gallery unmounts, so a long session does not keep full-resolution blobs alive.
export function revokePhotoUrls() {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

// ---------- photos kept in the project folder ----------
// Pictures a browser shows as they are; anything else (HEIC, TIFF) is shown from the Mac's JPEG copy.
const SHOWN = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/bmp']);
const RECORD_THUMB = 512;     // the Mac's copy the record's thumbnail is drawn from
const folderApi = () => diskWorkspace && diskWorkspace.projectPhotos;
const listings = new Map();   // property id -> the folder as last listed
const listedRefs = new Map(); // listed photo key -> { prop, path, mime }: photos with no record yet
const filling = new Map();    // record id -> the promise reading its size, lens and thumbnail
export const missingFiles = new Set();   // record ids whose file is not in the folder just now

const baseOf = path => String(path || '').split('/').pop();

// True when this property's photos are kept in its project folder on the Mac.
export function keepsPhotosInFolder(prop) {
  const api = folderApi();
  return !!(api && api.available(prop));
}

// Where the bytes of a photo kept in the folder are: { prop, path, mime }, or null.
function fileRef(id) {
  for (const prop of ws.data.properties || []) {
    const rec = (prop.photos || []).find(p => p.id === id);
    if (rec) return rec.file && keepsPhotosInFolder(prop) ? { prop, path: rec.file.path, mime: rec.mime } : null;
  }
  const listed = listedRefs.get(id);
  return listed && keepsPhotosInFolder(listed.prop) ? listed : null;
}

// The folder as last listed: { folder, files, truncated, byPath, signature } or null.
export function folderListing(prop) { return prop && listings.get(prop.id) || null; }

// List the project folder's photos again (every subfolder). Returns the listing, or null when
// this property's photos are not kept in a folder.
export async function loadFolderPhotos(prop) {
  if (!keepsPhotosInFolder(prop)) return null;
  const reply = await folderApi().list(prop);
  const files = Array.isArray(reply.files) ? reply.files : [];
  const listing = { folder: reply.folder || '', truncated: !!reply.truncated, files, byPath: new Map(files.map(f => [f.path, f])),
    signature: files.length + ':' + files.reduce((n, f) => (n * 31 + f.size + f.mtime + f.path.length) % 2147483647, 7) };
  listings.set(prop.id, listing);
  for (const f of files) listedRefs.set(f.key, { prop, path: f.path, mime: f.mime });
  await relinkMoved(prop, listing);
  return listing;
}

// A record whose file moved or was renamed in the folder follows it: a photo of the same size
// whose bytes match. One that cannot be found stays, marked missing, with what Tiksi knows of it.
async function relinkMoved(prop, listing) {
  const claimed = new Set((prop.photos || []).filter(p => p.file).map(p => p.file.path));
  const lost = (prop.photos || []).filter(p => p.file && !listing.byPath.has(p.file.path));
  for (const rec of (prop.photos || [])) if (rec.file && listing.byPath.has(rec.file.path)) missingFiles.delete(rec.id);
  for (const rec of lost) {
    const candidates = listing.files.filter(f => f.size === rec.file.size && !claimed.has(f.path));
    let found = null;
    if (rec.file.sha256 && candidates.length) {
      try {
        const sums = await folderApi().hashes(prop, candidates.slice(0, 64).map(f => f.path));
        found = candidates.find(f => sums[f.path] === rec.file.sha256) || null;
      } catch (e) { found = null; }
    } else if (!rec.file.sha256) found = candidates.find(f => f.name === baseOf(rec.file.path)) || null;
    if (found) {
      rec.file = { ...rec.file, path: found.path, mtime: found.mtime, group: found.group };
      claimed.add(found.path); missingFiles.delete(rec.id); touch();
    } else missingFiles.add(rec.id);
  }
}

// A small copy of a folder photo for the gallery, as an object URL the caller revokes once shown.
export async function folderPreviewUrl(prop, path, size = 256) {
  return URL.createObjectURL(await folderApi().preview(prop, path, size));
}

// The record of a listed photo, made the first time Tiksi has something to keep about it (a
// pin, notes, a selection). It is made at once; its size, lens and thumbnail follow
// (`whenFilled`). The photo itself stays in the folder.
// `item` is a gallery item ({ id, name, mime, file: { path, size, mtime, group } }) or a listed
// file ({ key, path, name, size, mtime, mime, group }).
export function keepRecord(prop, item) {
  const f = item.file || item, id = item.id || item.key;
  const have = photoById(prop, id) || (prop.photos || []).find(p => p.file && p.file.path === f.path);
  if (have) return have;
  const rec = {
    id, name: item.name || baseOf(f.path), kind: 'photo', w: item.w || 0, h: item.h || 0, mime: item.mime || 'image/jpeg', thumb: '',
    createdAt: new Date(f.mtime || Date.now()).toISOString(), notes: '', roomId: '', elementIds: [], itemIds: [], pin: null,
    file: { path: f.path, size: f.size, mtime: f.mtime, group: f.group || 'photo' },
  };
  prop.photos = prop.photos || [];
  prop.photos.push(rec);
  touch();
  fill(prop, rec);
  return rec;
}

// Settles when a record made by keepRecord has its size, lens and thumbnail.
export function whenFilled(rec) { return filling.get(rec.id) || Promise.resolve(rec); }

function fill(prop, rec) {
  const run = working((async () => {
    const info = await folderApi().info(prop, rec.file.path);
    if (info.w && info.h) { rec.w = info.w; rec.h = info.h; }
    rec.file = { ...rec.file, size: info.size, mtime: info.mtime, sha256: info.sha256 };
    if (isPanoramaAspect(rec.w, rec.h) && rec.kind === 'photo') rec.kind = 'pano';
    try { rec.thumb = await thumbFrom(await folderApi().preview(prop, rec.file.path, RECORD_THUMB)); await storeThumb(rec.id, rec.thumb); }
    catch (e) { console.error('thumbnail failed', e); }
    try { Object.assign(rec, cameraFacts((await folderApi().file(prop, rec.file.path)).buffer, rec.w, rec.h)); }
    catch (e) { /* no lens or time in the file */ }
    touch();
    return rec;
  })()).catch(e => { console.error('Could not read ' + rec.file.path + ' from the project folder', e); return rec; })
    .finally(() => filling.delete(rec.id));
  filling.set(rec.id, run);
  return run;
}

async function thumbFrom(blob) {
  const img = await decode(blob);
  const ts = Math.min(1, THUMB_MAX / Math.max(img.width, img.height));
  const thumb = drawTo(img, Math.round(img.width * ts), Math.round(img.height * ts)).toDataURL('image/jpeg', 0.8);
  if (img.close) img.close();
  return thumb;
}

// A photo taken or dropped in Tiksi: written into the project folder's Photos folder (renderings
// into Photos/Renderings), and recorded with what Tiksi knows of it. A photo whose exact bytes are
// already in the folder is not written again; its record, if it has one, is the one returned.
async function addToFolder(prop, file, opts) {
  const folder = subfolderFor(opts.source);
  const info = await folderApi().add(prop, file, file.name || 'Photo', folder);
  const known = (prop.photos || []).find(p => p.file && p.file.path === info.path);
  if (known) { for (const k of ['source', 'positionId', 'role', 'renderedAt', 'view']) if (opts[k] !== undefined) known[k] = opts[k]; touch(); return known; }
  let w = info.w || 0, h = info.h || 0, thumb = '';
  try {
    const img = await decode(file);
    w = w || img.width; h = h || img.height;
    const ts = Math.min(1, THUMB_MAX / Math.max(img.width, img.height));
    thumb = drawTo(img, Math.round(img.width * ts), Math.round(img.height * ts)).toDataURL('image/jpeg', 0.8);
    if (img.close) img.close();
  } catch (e) {
    try { thumb = await thumbFrom(await folderApi().preview(prop, info.path, RECORD_THUMB)); } catch (ignored) { /* no thumbnail */ }
  }
  const id = uid('ph');
  if (thumb) try { await storeThumb(id, thumb); } catch (e) { console.error('thumbnail store failed', e); }
  const rec = {
    id, name: file.name || info.name || 'Photo', kind: opts.kind || (isPanoramaAspect(w, h) ? 'pano' : 'photo'),
    w, h, mime: info.mime || file.type || 'image/jpeg', thumb,
    createdAt: new Date().toISOString(), notes: '', roomId: '', elementIds: [], itemIds: [], pin: null,
    file: { path: info.path, size: info.size, mtime: info.mtime, sha256: info.sha256, group: info.group || 'photo' },
  };
  try { Object.assign(rec, cameraFacts(await file.arrayBuffer(), w, h)); } catch (e) { /* no lens or time */ }
  for (const k of ['source', 'positionId', 'role', 'renderedAt', 'view']) if (opts[k] !== undefined) rec[k] = opts[k];
  listedRefs.set(info.key, { prop, path: info.path, mime: rec.mime });
  prop.photos = prop.photos || [];
  prop.photos.push(rec);
  touch();
  return rec;
}

// Photos whose original Tiksi still holds (added before photos were kept in the folder, or on a
// device that could not reach the Mac) and that the Mac has received: those are moved. One still
// on its way from this device waits for the save that sends it, so the move never races it.
export function heldPhotos(prop) {
  const api = folderApi();
  return (prop && prop.photos || []).filter(p => !p.file && p.kind !== 'document' && p.original !== false && api && api.onTheMac(p.id));
}

// Move every held original into the project folder's Photos folder (a rendering Tiksi made
// into Photos/Renderings) and let go of Tiksi's copy: the record keeps its notes, pin and links
// and names the file in the folder. A photo whose bytes are already in the folder is linked to
// that file instead of written twice. Tiksi's copy goes only after the Mac wrote the file (or
// found it) with the same bytes. Returns { moved, linked, notFound, failed: [names] }.
export async function moveHeldPhotos(prop, progress = () => {}) {
  const out = { moved: 0, linked: 0, notFound: 0, failed: [] };
  if (!keepsPhotosInFolder(prop)) return out;
  const held = heldPhotos(prop);
  let done = 0;
  for (const rec of held) {
    progress(done, held.length);
    try {
      const name = /\.[a-z0-9]{2,5}$/i.test(rec.name || '') ? rec.name : (rec.name || 'Photo') + '.' + extensionOf(rec.mime);
      const info = await folderApi().keep(prop, rec.id, name, rec.mime, subfolderFor(rec.source));
      if (!info) { out.notFound++; continue; }
      if (!photoById(prop, rec.id)) continue;   // deleted meanwhile
      rec.file = { path: info.path, size: info.size, mtime: info.mtime, sha256: info.sha256, group: info.group || 'photo' };
      delete rec.original; delete rec.byteLength;
      listedRefs.set(info.key, { prop, path: info.path, mime: rec.mime });
      releaseUrl(rec.id);
      touch();
      try { await deleteFile(rec.id); } catch (e) { console.error('could not let go of the moved original', e); }
      if (info.written) out.moved++; else out.linked++;
    } catch (e) {
      console.error('Could not move ' + rec.name + ' into the project folder', e);
      out.failed.push(rec.name || rec.id);
    } finally { done++; }
  }
  progress(done, held.length);
  return out;
}

// Where in the project folder a photo added in Tiksi goes: its renderings and the frames it took
// from a scan have folders of their own inside Photos.
function subfolderFor(source) {
  return source === 'rendering' ? 'Photos/Renderings' : source === 'polycam-keyframe' ? 'Photos/Scan frames' : 'Photos';
}

function extensionOf(mime) {
  return { 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/bmp': 'bmp',
    'image/heic': 'heic', 'image/heif': 'heif', 'image/tiff': 'tiff' }[mime] || 'jpg';
}

// A record of a folder photo that no longer says anything Tiksi needs (it was only selected,
// and is not any more) is let go of; the photo stays listed from the folder. Returns true then.
export function releaseIfBare(prop, rec) {
  if (!rec || !rec.file || rec.selected || rec.pin || rec.notes || rec.roomId || (rec.elementIds || []).length || (rec.itemIds || []).length
    || rec.view || rec.positionId || rec.role || rec.source || rec.kind !== 'photo' || rec.name !== baseOf(rec.file.path)) return false;
  if (prop.env && prop.env.panoPhotoId === rec.id) return false;
  if ((ws.data.materials || []).some(m => m.photoId === rec.id)) return false;
  if ((prop.levels || []).some(l => l.plan && l.plan.photoId === rec.id)) return false;
  prop.photos = prop.photos.filter(p => p !== rec);
  releaseUrl(rec.id);
  missingFiles.delete(rec.id);
  touch();
  deleteThumb(rec.id).catch(e => console.error('could not drop the thumbnail', e));
  return true;
}
