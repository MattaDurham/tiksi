// Documents pinned in the model: PDFs (shop drawings, spec sheets, schedules) and images of
// sheets. They live in the property's photo list as kind 'document' records, so they travel in
// .tiksi files, project folders and sync exactly as photos do:
//   { id, name, kind: 'document', mime, w, h (page image pixels), sheetW, sheetH (true size, metres),
//     page (shown page, 1-based), pageCount, thumb, original, byteLength, createdAt, notes, roomId,
//     elementIds, itemIds, pin }
// pdf.js (vendor/pdfjs, Apache-2.0) is loaded only when a PDF is opened.

import { uid, touch, putFile, storeThumb } from './store.js';
import { photoBytes } from './photos-store.js';
import { pointsToMetres, DOCUMENT_DEFAULT_WIDTH } from './pins.js';

const THUMB_MAX = 360;
let pdfjs = null;
async function pdfLib() {
  if (!pdfjs) {
    pdfjs = await import('../vendor/pdfjs/pdf.min.js');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
  }
  return pdfjs;
}
const isPdf = (mime, name) => mime === 'application/pdf' || /\.pdf$/i.test(name || '');

const docCache = new Map();   // id -> pdf.js document promise
async function openPdf(id, buffer) {
  if (!docCache.has(id)) {
    const lib = await pdfLib();
    const data = new Uint8Array((buffer || await photoBytes(id)).slice(0));
    const base = new URL('../vendor/pdfjs/', import.meta.url).href;
    // Fonts many spec sheets use without embedding them, character maps for non-Latin text, and
    // the decoders scanned drawings need (JPEG 2000, JBIG2) ship with Tiksi.
    docCache.set(id, lib.getDocument({ data, isEvalSupported: false, enableScripting: false,
      standardFontDataUrl: base + 'standard_fonts/', cMapUrl: base + 'cmaps/', cMapPacked: true, wasmUrl: base + 'wasm/' }).promise);
    while (docCache.size > 6) { const [k, v] = docCache.entries().next().value; docCache.delete(k); v.then(d => d.destroy()).catch(() => {}); }
  }
  return docCache.get(id);
}

// A canvas of one page with its long side `longPx` pixels, and the page's size in points.
export async function renderPdfPage(id, page, longPx, buffer) {
  const doc = await openPdf(id, buffer);
  const n = Math.max(1, Math.min(doc.numPages, page || 1));
  const pg = await doc.getPage(n);
  const base = pg.getViewport({ scale: 1 });
  const scale = longPx / Math.max(base.width, base.height);
  const vp = pg.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(vp.width)); c.height = Math.max(1, Math.round(vp.height));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
  await pg.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise;
  return { canvas: c, pageCount: doc.numPages, page: n, widthPt: base.width, heightPt: base.height };
}

function thumbOf(canvasOrImg, w, h) {
  const s = Math.min(1, THUMB_MAX / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(canvasOrImg, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}

// Add a PDF or an image as a document. Returns the new record (unpinned).
export async function addDocumentFromFile(prop, file) {
  const buffer = await file.arrayBuffer();
  const name = file.name || 'Document';
  const id = uid('ph');
  let rec;
  if (isPdf(file.type, name)) {
    const r = await renderPdfPage(id, 1, 1600, buffer);
    rec = { mime: 'application/pdf', w: r.canvas.width, h: r.canvas.height, sheetW: pointsToMetres(r.widthPt), sheetH: pointsToMetres(r.heightPt),
      page: 1, pageCount: r.pageCount, thumb: thumbOf(r.canvas, r.canvas.width, r.canvas.height) };
  } else {
    const bmp = await createImageBitmap(new Blob([buffer], { type: file.type || 'image/png' }), { imageOrientation: 'from-image' });
    rec = { mime: file.type || 'image/png', w: bmp.width, h: bmp.height, sheetW: DOCUMENT_DEFAULT_WIDTH, sheetH: DOCUMENT_DEFAULT_WIDTH * bmp.height / bmp.width,
      page: 1, pageCount: 1, thumb: thumbOf(bmp, bmp.width, bmp.height) };
    bmp.close && bmp.close();
  }
  await putFile(id, buffer, { name, mime: rec.mime, kind: 'photo', original: true });
  try { await storeThumb(id, rec.thumb); } catch (e) { console.error('thumbnail store failed', e); }
  const doc = Object.assign({ id, name, kind: 'document', original: true, byteLength: buffer.byteLength, createdAt: new Date().toISOString(),
    notes: '', roomId: '', elementIds: [], itemIds: [], pin: null }, rec);
  prop.photos = prop.photos || [];
  prop.photos.push(doc);
  touch();
  return doc;
}

// The image to hang for a document: its current page at `longPx` (PDF), or the image itself.
export async function documentCanvas(rec, longPx = 2048) {
  if (isPdf(rec.mime, rec.name)) {
    const r = await renderPdfPage(rec.id, rec.page || 1, longPx);
    return r.canvas;
  }
  const buf = await photoBytes(rec.id);
  if (!buf) return null;
  const bmp = await createImageBitmap(new Blob([buf], { type: rec.mime || 'image/png' }), { imageOrientation: 'from-image' });
  const s = Math.min(1, longPx / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  return c;
}

// Show another page of a PDF document: updates its page, size and thumbnail.
export async function setDocumentPage(rec, page) {
  if (!isPdf(rec.mime, rec.name)) return false;
  const r = await renderPdfPage(rec.id, page, 1600);
  rec.page = r.page; rec.pageCount = r.pageCount;
  rec.w = r.canvas.width; rec.h = r.canvas.height;
  rec.sheetW = pointsToMetres(r.widthPt); rec.sheetH = pointsToMetres(r.heightPt);
  rec.thumb = thumbOf(r.canvas, r.canvas.width, r.canvas.height);
  try { await storeThumb(rec.id, rec.thumb); } catch (e) { /* stays inline */ }
  touch();
  return true;
}

export function isDocument(rec) { return !!rec && rec.kind === 'document'; }
export function isPdfDocument(rec) { return isDocument(rec) && isPdf(rec.mime, rec.name); }
