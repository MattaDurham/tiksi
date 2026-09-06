// Photo storage: full-resolution bytes live in IndexedDB (same 'files' store as scans),
// a small JPEG thumbnail lives on the workspace record so galleries render instantly and
// exports stay portable (store.js keeps an IndexedDB copy of it so the localStorage JSON
// stays small). All helpers are property-scoped: prop.photos is the list.
//
// Photo record shape (see also store.js migrate):
// { id, name, kind: 'photo' | 'pano', w, h, mime, thumb (dataURL <= 360px), createdAt,
//   notes, roomId, elementIds: [], itemIds: [], pin: null | { x, y, z, nx, ny, nz, size } }

import { uid, touch, putFile, getFile, deleteFile, storeThumb, deleteThumb } from './store.js';

const THUMB_MAX = 360;
const FULL_MAX = 2048;
// Object URLs for full-resolution images. Each one pins a Blob copy of the IndexedDB buffer
// (up to a couple of MB), so keep a handful in recency order and revoke the rest.
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
export async function addPhotoFromFile(prop, file, opts) {
  opts = opts || {};
  const img = await decode(file);
  const w = img.width, h = img.height;
  const fs = Math.min(1, FULL_MAX / Math.max(w, h));
  const full = drawTo(img, Math.round(w * fs), Math.round(h * fs));
  const isPng = file.type === 'image/png';
  const blob = await new Promise(r => full.toBlob(r, isPng ? 'image/png' : 'image/jpeg', 0.9));
  const buffer = await blob.arrayBuffer();
  const ts = Math.min(1, THUMB_MAX / Math.max(w, h));
  const thumb = drawTo(img, Math.round(w * ts), Math.round(h * ts)).toDataURL('image/jpeg', 0.8);
  if (img.close) img.close();

  const id = uid('ph');
  await putFile(id, buffer, { name: file.name || 'photo', mime: blob.type, kind: 'photo' });
  // The IndexedDB copy of the thumbnail keeps it out of the localStorage JSON; if that write
  // fails the record simply carries it inline, as older saves do.
  try { await storeThumb(id, thumb); } catch (e) { console.error('thumbnail store failed', e); }
  const rec = {
    id, name: file.name || 'Photo', kind: opts.kind || (isPanoramaAspect(w, h) ? 'pano' : 'photo'),
    w: full.width, h: full.height, mime: blob.type, thumb,
    createdAt: new Date().toISOString(), notes: '', roomId: '', elementIds: [], itemIds: [], pin: null,
  };
  prop.photos = prop.photos || [];
  prop.photos.push(rec);
  touch();
  return rec;
}

// Object URL for the full-resolution image (cached; null if the bytes are gone).
export async function photoUrl(id) {
  if (urlCache.has(id)) {
    const url = urlCache.get(id);
    urlCache.delete(id); urlCache.set(id, url);   // mark as most recently used
    return url;
  }
  const rec = await getFile(id);
  if (!rec || !rec.buffer) return null;
  if (urlCache.has(id)) return urlCache.get(id);   // a parallel call for the same photo won
  const url = URL.createObjectURL(new Blob([rec.buffer], { type: rec.mime || 'image/jpeg' }));
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
