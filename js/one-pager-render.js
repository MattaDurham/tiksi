// Making the one-pager: the picture at the top (a rendering or site photo, a 3D view of the
// model, or the floor plan), the plan drawing, the page as a bitmap and the PDF, and saving a
// version as a document of the property. Browser only (canvas, the offscreen model renderer).

import { ws, touch, getFile, isoToday, projectSlice } from './store.js';
import { photoBytes } from './photos-store.js';
import { addDocumentFromFile } from './documents.js';
import { renderViewport, planVectorSvg, modelBounds3d } from './sheet-render.js';
import { newViewport, fitScale, pdfFromJpegs } from './doc-sets.js';
import { modelBounds } from './geometry.js';
import { normalizeOnePager, draftOnePager, latestVersion, recordVersion, versionFileName } from './one-pager.js';
import { onePagerHtml, pageSvg, versionLabel, PAGE_W, PAGE_H, HERO_W, HERO_H } from './one-pager-page.js';

const EXPORT_DPI = 200;
const HERO_PX = 1680;   // the picture's long side in the PDF
const HERO_RATIO = HERO_W / HERO_H;

// ---------- the picture at the top ----------

// What the automatic choice picks, in order: the newest rendering, a site photo (the cover
// of a Polycam capture first), the model, the plan.
export function heroCandidates(prop) {
  const photos = prop.photos || [];
  const byDate = (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  const renderings = photos.filter(p => p.kind === 'photo' && p.source === 'rendering').sort(byDate);
  const sitePhotos = photos.filter(p => p.kind === 'photo' && p.source !== 'rendering' && p.source !== 'polycam-keyframe');
  const cover = sitePhotos.filter(p => p.source === 'polycam-cover');
  const rest = sitePhotos.filter(p => p.source !== 'polycam-cover').sort(byDate);
  const out = [...renderings, ...cover, ...rest].map(p => ({ id: p.id, kind: p.source === 'rendering' ? 'rendering' : 'photo', label: p.name || 'Photo' }));
  const traced = (prop.walls || []).length || (prop.rooms || []).length;
  if ((prop.scans || []).some(s => s.kind === 'mesh' && s.visible !== false) || traced) out.push({ id: 'model', kind: 'model', label: '3D view of the model' });
  if (traced) out.push({ id: 'plan', kind: 'plan', label: 'Floor plan' });
  return out;
}

export function heroLabel(prop, choice) {
  if (!choice) { const c = heroCandidates(prop)[0]; return c ? 'Automatic: ' + c.label : 'Automatic: none yet'; }
  const c = heroCandidates(prop).find(x => x.id === choice);
  return c ? c.label : 'A photo that is no longer here';
}

async function photoDataUrl(id, rec) {
  const buf = await photoBytes(id);
  if (!buf) return typeof rec?.thumb === 'string' && rec.thumb.startsWith('data:') ? rec.thumb : '';
  const bmp = await createImageBitmap(new Blob([buf], { type: rec?.mime || 'image/jpeg' }), { imageOrientation: 'from-image' });
  const s = Math.min(1, HERO_PX / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  return c.toDataURL('image/jpeg', 0.86);
}

// Plan bounds of what is drawn: the traced plan, or the models when nothing is traced.
async function planBox(prop) {
  if ((prop.walls || []).length || (prop.rooms || []).length) return modelBounds(prop);
  const b = await modelBounds3d(prop);
  if (!isFinite(b.min.x)) return { minX: -5, minY: -5, maxX: 5, maxY: 5 };
  return { minX: b.min.x, minY: b.min.z, maxX: b.max.x, maxY: b.max.z };
}

async function modelDataUrl(prop) {
  const b = await planBox(prop);
  const saved = (prop.savedViews || [])[0];
  let camera;
  if (saved && saved.camera) camera = { position: saved.camera.position, target: saved.camera.target, fov: saved.camera.fov };
  else {
    // A dollhouse view: from above and to the side, the ceilings left off so the rooms show.
    const cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2, r = Math.max(b.maxX - b.minX, b.maxY - b.minY, 3);
    camera = { position: [cx + r * 0.85, r * 1.05, cz + r * 1.0], target: [cx, 0.6, cz], fov: 42 };
  }
  const v = newViewport('view3d', { x: 0, y: 0, w: HERO_W / 96, h: HERO_H / 96 }, { camera, style: 'shaded' });
  v.ceilings = !!saved;   // a saved view keeps its ceilings; the dollhouse view leaves them off
  const canvas = await renderViewport(prop, v, HERO_PX, Math.round(HERO_PX / HERO_RATIO));
  return canvas ? canvas.toDataURL('image/jpeg', 0.88) : '';
}

// The level's plan as an SVG drawing fitted to a box of w x h CSS pixels (rooms filled and
// named, walls cut, doors and windows), or '' when nothing is traced.
export function planSvgFor(prop, w, h) {
  const traced = (prop.walls || []).length || (prop.rooms || []).length;
  if (!traced) return '';
  const b = modelBounds(prop);
  if (!isFinite(b.minX)) return '';
  const lvl = (prop.levels || []).find(l => l.id === prop.activeLevelId) || (prop.levels || [])[0];
  const wIn = w / 96, hIn = h / 96;
  const scale = fitScale(b.maxX - b.minX + 1, b.maxY - b.minY + 1, wIn, hIn);
  const v = newViewport('plan', { x: 0, y: 0, w: wIn, h: hIn }, { levelId: lvl ? lvl.id : '', cut: 1.2, center: [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2], scale, layers: { model: false, dims: false, rooms: true } });
  const inner = planVectorSvg(prop, v);
  if (!inner) return '';
  const W = wIn * 72, H = hIn * 72;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W.toFixed(2)} ${H.toFixed(2)}" preserveAspectRatio="xMidYMid meet">${inner}</svg>`;
}

// The pictures the page needs: { hero: { href } | { plan: true } | null, planSvg }.
export async function pageAssets(prop) {
  const o = prop.onePager || normalizeOnePager(prop);
  const candidates = heroCandidates(prop);
  const pick = o.hero ? candidates.find(c => c.id === o.hero) || null : candidates[0] || null;
  let hero = null;
  if (pick) {
    try {
      if (pick.kind === 'plan') hero = { plan: true };
      else if (pick.kind === 'model') { const href = await modelDataUrl(prop); hero = href ? { href } : null; }
      else { const href = await photoDataUrl(pick.id, (prop.photos || []).find(p => p.id === pick.id)); hero = href ? { href } : null; }
    } catch (e) { console.error('one-pager picture', e); hero = null; }
  }
  const planSvg = planSvgFor(prop, hero && hero.plan ? HERO_W - 28 : 218, hero && hero.plan ? HERO_H - 28 : 220);
  return { hero, planSvg };
}

// ---------- the page ----------

export function pageMarkup(prop, assets, opts) {
  return onePagerHtml(prop, ws.data, assets, opts);
}

// The page as a bitmap at `dpi`: the markup goes into an SVG that an image element decodes.
export async function rasterizePage(xhtml, dpi = EXPORT_DPI) {
  const svg = pageSvg(xhtml);
  const img = new Image();
  img.decoding = 'async';
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const k = dpi / 96;
  const c = document.createElement('canvas');
  c.width = Math.round(PAGE_W * k); c.height = Math.round(PAGE_H * k);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

export async function onePagerPdf(prop, { version, date, assets } = {}) {
  const xhtml = pageMarkup(prop, assets || await pageAssets(prop), { version, date });
  const canvas = await rasterizePage(xhtml);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
  if (!blob) throw new Error('The page could not be encoded');
  const jpeg = new Uint8Array(await blob.arrayBuffer());
  return pdfFromJpegs([{ jpeg, px: [canvas.width, canvas.height], inches: [8.5, 11] }], { title: (prop.name || 'Property') + ' - one-pager' + (version ? ' ' + version.toLowerCase() : ''), date: new Date().toISOString() });
}

// ---------- versions ----------

let saving = null;
export function versionInProgress() { return !!saving; }

// Make the next version: lay the page out of the project as it is now (the text follows the
// project unless it was edited by hand), save the PDF among the property's documents and
// remember what it was made of. One at a time.
export async function saveOnePagerVersion(prop, { progress, assets } = {}) {
  if (saving) return saving;
  saving = (async () => {
    normalizeOnePager(prop);
    if (draftOnePager(prop, ws.data)) touch();
    const n = (latestVersion(prop)?.n || 0) + 1, date = isoToday();
    progress && progress('Laying out version ' + n + '…');
    const bytes = await onePagerPdf(prop, { version: 'Version ' + n, date, assets });
    progress && progress('Saving version ' + n + '…');
    const file = new File([bytes], versionFileName(prop, n, date), { type: 'application/pdf' });
    const doc = await addDocumentFromFile(prop, file);
    doc.notes = 'One-pager, version ' + n + ', saved ' + date + '. The newest version is the one to send.';
    const version = recordVersion(prop, projectSlice(prop.id), doc.id, date);
    touch();
    return { doc, version, bytes };
  })();
  try { return await saving; } finally { saving = null; }
}

// The newest version's PDF bytes, or null when it is not on this computer.
export async function latestVersionBytes(prop) {
  const v = latestVersion(prop);
  if (!v || !v.documentId) return null;
  const rec = await getFile(v.documentId);
  return rec && rec.buffer ? new Uint8Array(rec.buffer) : null;
}

export { versionLabel, PAGE_W, PAGE_H };
