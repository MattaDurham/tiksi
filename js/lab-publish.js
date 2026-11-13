// SEND TO THE LAB: a view-only copy of one property for its client page on thedurham.nyc
// (client-view.js), sent through the Mac (server/lab_publish.py).
//
// The copy holds the house as drawn (walls, openings, rooms, trim, fixtures), the models that
// are not a scan capture, the materials they use with their texture pictures, the saved views
// and the projects chosen to send, under the short names given for
// their buttons. It leaves out products, prices, project scope and notes, photos and their
// pins, notes, measurements, documents, the scan capture, a piece of any project not sent, and
// every large inline picture. The send settings are kept on the property (prop.lab).

import { ws, getFile, touch } from './store.js';
import { photoBytes } from './photos-store.js';
import { projectsWithPieces, pieceProjectId, topProjectId } from './project-pieces.js';
import { scanLayer } from './view-layers.js';
import { hints } from './texture-synth.js';

export const CLIENT_FORMAT = 'tiksi-client';
// Tags that are furniture on most properties: the built-in one, and any whose name says so.
const FURNITURE_NAME = /furniture|decor|soft goods|furnishing/i;
// Fields of a plan record that say what product or evidence it is: never in a client's copy.
const PRIVATE_FIELDS = ['product', 'proposedProduct', 'evidence', 'evidenceText', 'evidenceState', 'notes', 'note', 'source', 'uncertainty',
  'identityStatus', 'componentProducts', 'materialIdentities', 'originalFileId', 'originalName', 'sourceRevision', 'createdAt', 'updatedAt', 'measured', 'sourceFile'];
const MATERIAL_FIELDS = ['product', 'proposedProduct', 'colorBrand', 'colorCode', 'colorName', 'coverage', 'propertyIds', 'notes', 'source', 'url'];

export function slugify(name) {
  const s = String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return s || 'property';
}

// What the send dialog starts from: the last send's choices, or a fresh set.
export function labSettings(prop, projects) {
  const last = prop.lab && typeof prop.lab === 'object' ? prop.lab : {};
  const withPieces = projectsWithPieces(prop, projects);
  const sent = new Map((Array.isArray(last.projects) ? last.projects : []).map(p => [p.id, p]));
  return {
    slug: typeof last.slug === 'string' && last.slug ? last.slug : slugify(prop.name),
    projects: withPieces.map(p => ({ id: p.id, label: sent.has(p.id) ? sent.get(p.id).label : shortName(p.name), on: sent.has(p.id) || !last.slug, name: p.name })),
    furnitureTags: Array.isArray(last.furnitureTags) ? last.furnitureTags.filter(id => (prop.tags || []).some(t => t.id === id))
      : (prop.tags || []).filter(t => t.id === 'tag-furniture' || FURNITURE_NAME.test(t.name || '')).map(t => t.id),
    sentAt: last.sentAt || '', version: last.version || '',
  };
}
// A project's name cut to a button: before a colon or bracket, at most three words.
export function shortName(name) {
  const s = String(name || '').split(/[:(\[]/)[0].trim();
  return s.split(/\s+/).slice(0, 3).join(' ') || 'Project';
}

const isBigInline = v => typeof v === 'string' && v.length > 1024 && v.startsWith('data:');
// Large inline pictures and every record of where a measurement or finish came from
// (modelEvidence, baseboardPosEvidence and the like) are left out, at any depth.
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!isBigInline(v) && !/evidence/i.test(k)) out[k] = scrub(v);
    return out;
  }
  return value;
}
const strip = (rec, fields) => { for (const f of fields) delete rec[f]; return rec; };

// The copy itself: { format, schema, property, materials, projects, states, furnitureTags,
// files: { id: { path, format, mime } } } and the list of files to send.
// `choice`: { projects: [{ id, label }], furnitureTags: [tagId] }.
export function clientCopy(data, propId, choice) {
  const src = data.properties.find(p => p.id === propId);
  if (!src) throw new Error('No such property');
  const sentTop = new Set(choice.projects.map(p => p.id));
  const projects = data.projects.filter(p => p.propertyId === propId && (sentTop.has(p.id) || sentTop.has(p.parentId)));
  const keepPiece = rec => { const id = pieceProjectId(rec); return !id || sentTop.has(topProjectId(data.projects, id)); };
  const p = scrub(JSON.parse(JSON.stringify(src)));
  const prop = {
    id: p.id, name: '', wallHeight: p.wallHeight, levels: p.levels || [], activeLevelId: p.activeLevelId,
    walls: [], openings: [], rooms: [], fixtures: [], trims: [], scans: [],
    tags: (p.tags || []).map(t => ({ ...t, visible: t.id === 'tag-scan' ? false : t.visible })),
    tagOf: p.tagOf || {}, tagDefaults: p.tagDefaults || {}, tagUntaggedVisible: p.tagUntaggedVisible,
    hidden: {}, photos: [], notePins: [], photoPositions: [], cameraSets: [], docSets: [], markups: [], videos: [], measurements: [],
    env: { ...(p.env || {}), showPins: false, showNotes: false, showDims: false, showRoomLabels: false, showOpeningNumbers: false, showGrid: false, sky: (p.env && p.env.sky === 'pano') ? 'dynamic' : (p.env || {}).sky, panoPhotoId: null },
    savedViews: (p.savedViews || []).map(v => ({ id: v.id, name: v.name, camera: v.camera, mode: v.mode === 'top' ? 'top' : 'orbit', tags: {}, section: { on: false, height: 1.2 }, xray: false, hiddenLevels: [] })),
  };
  for (const key of ['walls', 'openings', 'rooms', 'fixtures', 'trims']) prop[key] = (p[key] || []).filter(keepPiece).map(r => strip(r, PRIVATE_FIELDS));
  // A hidden piece in MODEL is hidden for the client too; the client page shows the rest.
  for (const [k, on] of Object.entries(p.hidden || {})) if (on === true) prop.hidden[k] = true;
  prop.scans = (p.scans || []).filter(s => s.kind === 'mesh' && scanLayer(s) !== 'scan' && s.visible !== false && keepPiece(s))
    .map(s => strip({ ...s, name: '' }, PRIVATE_FIELDS));
  // Materials: the ones these records and models use, with their texture pictures.
  const used = new Set();
  for (const w of prop.walls) for (const k of ['material', 'materialIn', 'materialPos', 'materialNeg', 'materialEndA', 'materialEndB']) used.add(w[k]);
  for (const r of prop.rooms) { used.add(r.material); used.add(r.ceilingMaterial); }
  for (const o of prop.openings) used.add(o.detail?.door?.leafMaterial ?? o.profile?.leafMaterial);
  for (const f of prop.fixtures) { used.add(f.material); used.add(f.bodyMaterial); }
  for (const t of prop.trims) used.add(t.material);
  for (const s of prop.scans) for (const id of Object.values(s.materialBindings || {})) used.add(id);
  // A material's name chooses its texture's style (texture-synth.js hints): the copy keeps only
  // the words that do that, not the paint or product it names.
  const materials = (data.materials || []).filter(m => m && used.has(m.id) && m.custom).map(m => {
    const h = hints(m);
    return { ...strip(scrub({ ...m }), MATERIAL_FIELDS), name: Object.keys(h).filter(k => h[k]).join(' ') };
  });
  const files = {}, send = [];
  for (const s of prop.scans) {
    const ext = String(s.format || 'glb').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
    files[s.id] = { path: 'files/' + s.id + '.' + ext, format: ext, mime: ext === 'glb' ? 'model/gltf-binary' : 'application/octet-stream' };
    send.push({ id: s.id, path: files[s.id].path, kind: 'model' });
  }
  for (const m of materials) if (m.photoId) {
    const ph = (src.photos || []).find(x => x.id === m.photoId);
    const mime = (ph && ph.mime) || 'image/jpeg', ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
    prop.photos.push({ id: m.photoId, name: '', mime, kind: 'texture' });
    files[m.photoId] = { path: 'files/' + m.photoId + '.' + ext, format: ext, mime };
    send.push({ id: m.photoId, path: files[m.photoId].path, kind: 'picture' });
  }
  const labels = new Map(choice.projects.map(x => [x.id, String(x.label || '').trim().slice(0, 32) || 'Project']));
  return {
    copy: {
      format: CLIENT_FORMAT, schema: data.version || 2, sentAt: new Date().toISOString(),
      property: prop, materials,
      projects: projects.map(x => ({ id: x.id, propertyId: x.propertyId, parentId: x.parentId || '', name: '', items: [] })),
      states: choice.projects.filter(x => projects.some(pr => pr.id === x.id)).map(x => ({ id: x.id, label: labels.get(x.id) })),
      furnitureTags: (choice.furnitureTags || []).filter(id => prop.tags.some(t => t.id === id)),
      files,
    },
    send,
  };
}

// ---------- sending ----------
let service = null;
async function lab(path, opts = {}) {
  if (!service || opts.fresh) {
    const r = await fetch('/api/lab/capabilities', { headers: { 'X-Tiksi-Lab': '1' } });
    if (!r.ok) throw new Error(r.status === 404 ? 'This Tiksi server cannot send to the lab yet; it needs a restart onto the new code.' : 'The lab sender did not answer (' + r.status + ')');
    service = await r.json();
  }
  if (!path) return service;
  const r = await fetch('/api/lab/' + path, { method: opts.method || 'POST', headers: { 'X-Tiksi-Token': service.token, ...(opts.type ? { 'Content-Type': opts.type } : {}) }, body: opts.body });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || 'The lab sender refused (' + r.status + ')');
  return out;
}
export async function labStatus() { return lab('', { fresh: true }); }

const put = (slug, path, body, type) => lab('files/' + slug + '/' + path, { method: 'PUT', body, type });
const versionName = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-') + '-' + Math.random().toString(36).slice(2, 6);

// Send the property. `progress(text, fraction)` hears how far it is. Returns { slug, version, uploaded, url }.
export async function sendToLab(propId, choice, { progress = () => {} } = {}) {
  const prop = ws.data.properties.find(p => p.id === propId);
  if (!prop) throw new Error('No such property');
  const slug = choice.slug;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug)) throw new Error('The page name may use only lowercase letters, digits and dashes.');
  const status = await lab('', { fresh: true });
  progress('Sending the Tiksi code the page runs (only when it changed)…', 0.02);
  const { app } = await lab('app/' + slug, { body: '{}', type: 'application/json' });
  const version = versionName();
  const { copy, send } = clientCopy(ws.data, propId, choice);
  const base = 'v/' + version + '/';
  let done = 0;
  const total = send.length + 2;
  for (const f of send) {
    progress('Sending ' + (f.kind === 'model' ? 'a model' : 'a texture picture') + ' (' + (done + 1) + ' of ' + total + ')…', 0.05 + 0.85 * done / total);
    // A texture picture may be a file in the project's folder (photos-store.js reads both).
    const buffer = f.kind === 'picture' ? await photoBytes(f.id).catch(() => null) : ((await getFile(f.id).catch(() => null)) || {}).buffer;
    if (!buffer) {
      // A texture picture this Mac does not hold leaves its material in its plain colour.
      if (f.kind === 'picture') {
        delete copy.files[f.id];
        copy.property.photos = copy.property.photos.filter(ph => ph.id !== f.id);
        for (const m of copy.materials) if (m.photoId === f.id) { m.photoId = null; if (m.pattern === 'photo') m.pattern = 'flat'; }
        done++; continue;
      }
      throw new Error('A model of this property is missing on this Mac, so nothing was switched over: ' + f.id);
    }
    await put(slug, base + f.path, buffer, copy.files[f.id].mime);
    done++;
  }
  progress('Sending the property…', 0.92);
  await put(slug, base + 'property.json', new Blob([JSON.stringify(copy)], { type: 'application/json' }), 'application/json');
  // Last: the page switches to the new copy in one step.
  await put(slug, 'current.json', new Blob([JSON.stringify({ format: CLIENT_FORMAT, version, app, sentAt: copy.sentAt })], { type: 'application/json' }), 'application/json');
  progress('Tidying older copies…', 0.97);
  try { await lab('prune/' + slug, { body: JSON.stringify({ keep: [version, prop.lab && prop.lab.version].filter(Boolean) }), type: 'application/json' }); } catch (e) { console.warn('Older lab copies stay for now:', e); }
  prop.lab = { slug, projects: choice.projects.map(p => ({ id: p.id, label: p.label })), furnitureTags: copy.furnitureTags, sentAt: copy.sentAt, version };
  touch();
  progress('Sent.', 1);
  return { slug, version, uploaded: !!status.upload, url: status.site + slug + '/', preview: status.preview + slug + '/' };
}
