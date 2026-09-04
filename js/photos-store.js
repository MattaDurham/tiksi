// Photo storage: full-resolution bytes live in IndexedDB (same 'files' store as scans),
// a small JPEG thumbnail lives in the workspace JSON so galleries render instantly and
// exports stay portable. All helpers are property-scoped: prop.photos is the list.
//
// Photo record shape (see also store.js migrate):
// { id, name, kind: 'photo' | 'pano', w, h, mime, thumb (dataURL <= 360px), createdAt,
//   notes, roomId, elementIds: [], itemIds: [], pin: null | { x, y, z, nx, ny, nz, size } }

import { uid, touch, putFile, getFile, deleteFile } from './store.js';

const THUMB_MAX = 360;
const FULL_MAX = 2048;
const urlCache = {};   // photoId -> object URL

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
  if (urlCache[id]) return urlCache[id];
  const rec = await getFile(id);
  if (!rec || !rec.buffer) return null;
  const url = URL.createObjectURL(new Blob([rec.buffer], { type: rec.mime || 'image/jpeg' }));
  urlCache[id] = url;
  return url;
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
  if (urlCache[id]) { URL.revokeObjectURL(urlCache[id]); delete urlCache[id]; }
  await deleteFile(id);
  touch();
}

export function revokePhotoUrls() {
  for (const id of Object.keys(urlCache)) { URL.revokeObjectURL(urlCache[id]); delete urlCache[id]; }
}
