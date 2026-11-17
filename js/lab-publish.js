// SEND TO THE LAB: a view-only copy of one property for its client page on thedurham.nyc
// (client-view.js), sent through the Mac (server/lab_publish.py).
//
// The copy holds the house as drawn (walls, openings, rooms, trim, fixtures), the models that
// are not a scan capture, the materials they use with their texture pictures, the saved views
// switched on, and the projects chosen to send, under the short names given for
// their buttons. Each saved view comes with a small picture of itself per project (made by the
// client page's own code, lab-pictures.js) and with the renderings of it that are switched on
// (view-renderings.js), as web-size copies under a name the client may see. It leaves out
// products, prices, project scope and notes, every other photo, photo pins, notes,
// measurements, documents, the scan capture, a piece of any project not sent, and
// every large inline picture. Each saved view keeps what it shows its own way (clientView): its
// tags, the pieces it hides, its cuts, x-ray and levels. The send settings are kept on the
// property (prop.lab).

import { ws, getFile, touch } from './store.js';
import { photoBytes, photoUrl } from './photos-store.js';
import { projectsWithPieces, pieceProjectId, topProjectId } from './project-pieces.js';
import { scanLayer } from './view-layers.js';
import { hints } from './texture-synth.js';

export const CLIENT_FORMAT = 'tiksi-client';
// Tags that are furniture on most properties: the built-in one, and any whose name says so.
const FURNITURE_NAME = /furniture|decor|soft goods|furnishing/i;
// The most renderings one send carries, and the sizes of a rendering's web copy and its thumbnail.
export const MAX_RENDERINGS = 80;
const RENDERING_EDGE = 2400, RENDERING_THUMB = 480;
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
    // Every saved view goes unless it was switched off; so does every rendering on a view.
    views: (prop.savedViews || []).map(v => ({ id: v.id, name: v.name, on: !(Array.isArray(last.viewsOff) && last.viewsOff.includes(v.id)) })),
    renderingsOff: Array.isArray(last.renderingsOff) ? last.renderingsOff.filter(x => typeof x === 'string') : [],
    renderingLabels: last.renderingLabels && typeof last.renderingLabels === 'object' ? { ...last.renderingLabels } : {},
    // The renderings the last send carried: one not among them is new to the client.
    renderingsSent: Array.isArray(last.renderingsSent) ? last.renderingsSent.filter(x => typeof x === 'string') : null,
    sentAt: last.sentAt || '', version: last.version || '',
  };
}
// The name a client sees on a rendering: plain words, at most 48 characters.
export const renderingLabel = s => String(typeof s === 'string' ? s : '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 48);
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

// A saved view as the client page gets it: its camera and everything it shows its own way (tags
// and their halves, pieces hidden one by one, section cuts with their handles put away, x-ray,
// hidden levels, which of the sent models show). Not its markers, comparison or source.
export function clientView(v, sentScans, scanTags = new Set(['tag-scan'])) {
  const tags = {};
  for (const [k, on] of Object.entries(v.tags || {})) if (typeof on === 'boolean' && !scanTags.has(k.split(':')[0])) tags[k] = on;
  const sec = v.section && typeof v.section === 'object' ? v.section : {};
  const section = { on: sec.on === true, height: typeof sec.height === 'number' ? sec.height : 1.2,
    ...(Array.isArray(sec.planes) && sec.planes.length ? { planes: sec.planes, active: sec.active } : {}), done: true };
  const out = { id: v.id, name: v.name, camera: v.camera, mode: v.mode === 'top' ? 'top' : 'orbit', tags, section, xray: v.xray === true,
    hiddenLevels: Array.isArray(v.hiddenLevels) ? v.hiddenLevels : [], hidden: Array.isArray(v.hidden) ? v.hidden.filter(k => !/^node:/.test(k) || sentScans.has(k.slice(5).split('#')[0])) : [] };
  if (v.models && typeof v.models === 'object') {
    out.models = {};
    for (const [id, on] of Object.entries(v.models)) if (sentScans.has(id) && typeof on === 'boolean') out.models[id] = on;
  }
  if (typeof v.xrayOpacity === 'number') out.xrayOpacity = v.xrayOpacity;
  return out;
}

// The copy itself: { format, schema, property, materials, projects, states, furnitureTags,
// renderings: [{ id, view, label, day, w, h, path, thumb }],
// files: { id: { path, format, mime } } } and the list of files to send.
// `choice`: { projects: [{ id, label }], furnitureTags: [tagId], views: [view id] (every view
// when left out), renderings: [{ id (the photo), viewId, label, day }] }.
// A rendering goes under a plain number (r1, r2...), never its photo's id or file name.
export function clientCopy(data, propId, choice) {
  const src = data.properties.find(p => p.id === propId);
  if (!src) throw new Error('No such property');
  const sentTop = new Set(choice.projects.map(p => p.id));
  const projects = data.projects.filter(p => p.propertyId === propId && (sentTop.has(p.id) || sentTop.has(p.parentId)));
  const keepPiece = rec => { const id = pieceProjectId(rec); return !id || sentTop.has(topProjectId(data.projects, id)); };
  const p = scrub(JSON.parse(JSON.stringify(src)));
  const viewsOn = Array.isArray(choice.views) ? new Set(choice.views) : null;
  const sentScans = new Set((p.scans || []).filter(sc => sc.kind === 'mesh' && scanLayer(sc) !== 'scan' && sc.visible !== false && keepPiece(sc)).map(sc => sc.id));
  const scanTags = new Set((p.tags || []).filter(t => t.id === 'tag-scan').map(t => t.id));
  const prop = {
    id: p.id, name: '', wallHeight: p.wallHeight, levels: p.levels || [], activeLevelId: p.activeLevelId,
    walls: [], openings: [], rooms: [], fixtures: [], trims: [], scans: [],
    // Every tag shows, both halves, but the scan capture's: what shows is each view's own
    // (clientView), not what MODEL happened to show when the copy was made.
    tags: (p.tags || []).map(t => { const { phases, ...rest } = t; return { ...rest, visible: !scanTags.has(t.id), ...(scanTags.has(t.id) ? { phases } : {}) }; }),
    tagOf: p.tagOf || {}, tagDefaults: p.tagDefaults || {}, tagUntaggedVisible: p.tagUntaggedVisible,
    hidden: {}, photos: [], notePins: [], photoPositions: [], cameraSets: [], docSets: [], markups: [], videos: [], measurements: [],
    env: { ...(p.env || {}), showPins: false, showNotes: false, showDims: false, showRoomLabels: false, showOpeningNumbers: false, showGrid: false, sky: (p.env && p.env.sky === 'pano') ? 'dynamic' : (p.env || {}).sky, panoPhotoId: null },
    savedViews: (p.savedViews || []).filter(v => !viewsOn || viewsOn.has(v.id)).map(v => clientView(v, sentScans, scanTags)),
  };
  for (const key of ['walls', 'openings', 'rooms', 'fixtures', 'trims']) prop[key] = (p[key] || []).filter(keepPiece).map(r => strip(r, PRIVATE_FIELDS));
  // Nothing is hidden for the whole page: each view hides its own pieces (clientView).
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
  const renderings = [];
  for (const r of Array.isArray(choice.renderings) ? choice.renderings : []) {
    if (!r || typeof r.id !== 'string' || !prop.savedViews.some(v => v.id === r.viewId) || renderings.length >= MAX_RENDERINGS || send.some(f => f.kind === 'rendering' && f.id === r.id)) continue;
    const id = 'r' + (renderings.length + 1);
    renderings.push({ id, view: r.viewId, label: renderingLabel(r.label), day: /^\d{4}-\d{2}-\d{2}$/.test(r.day || '') ? r.day : '', w: 0, h: 0, path: 'renderings/' + id + '.jpg', thumb: 'renderings/' + id + '-thumb.jpg' });
    send.push({ id: r.id, rendering: id, path: 'renderings/' + id + '.jpg', thumb: 'renderings/' + id + '-thumb.jpg', kind: 'rendering' });
  }
  const labels = new Map(choice.projects.map(x => [x.id, String(x.label || '').trim().slice(0, 32) || 'Project']));
  return {
    copy: {
      format: CLIENT_FORMAT, schema: data.version || 2, sentAt: new Date().toISOString(),
      property: prop, materials,
      projects: projects.map(x => ({ id: x.id, propertyId: x.propertyId, parentId: x.parentId || '', name: '', items: [] })),
      states: choice.projects.filter(x => projects.some(pr => pr.id === x.id)).map(x => ({ id: x.id, label: labels.get(x.id) })),
      furnitureTags: (choice.furnitureTags || []).filter(id => prop.tags.some(t => t.id === id)),
      renderings,
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

// The code the page runs, sent by the Mac a few files at a time. `heard({ done, total, bytes,
// totalBytes, copied })` hears each file finish. Resolves to { app, sent, copied }.
async function sendApp(slug, heard) {
  await lab('', {});
  const r = await fetch('/api/lab/app/' + slug, { method: 'POST', headers: { 'X-Tiksi-Token': service.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ stream: true }) });
  if (!r.ok || !/ndjson/.test(r.headers.get('Content-Type') || '') || !r.body) {
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || 'The lab sender refused (' + r.status + ')');
    return out;
  }
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let rest = '', last = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (value) rest += value;
    const lines = rest.split('\n'); rest = done ? '' : lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const v = JSON.parse(line);
      if (v.error) throw new Error(v.error);
      if (v.app) last = v; else heard(v);
    }
    if (done) break;
  }
  if (!last) throw new Error('The lab sender stopped before the code was all sent.');
  return last;
}

const put = (slug, path, body, type) => lab('files/' + slug + '/' + path, { method: 'PUT', body, type });
const versionName = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-') + '-' + Math.random().toString(36).slice(2, 6);

// A rendering as the client gets it: a JPEG at most 2400 pixels on its long side and a small one
// for its card. { full, thumb, w, h } (blobs), or null when the picture cannot be read here.
async function webRendering(photoId) {
  const url = await photoUrl(photoId).catch(() => null);
  if (!url) return null;
  let bmp;
  try { bmp = await createImageBitmap(await (await fetch(url)).blob(), { imageOrientation: 'from-image' }); }
  catch (e) { return null; }
  const at = edge => {
    const k = Math.min(1, edge / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);   // a see-through PNG gets a white ground
    g.drawImage(bmp, 0, 0, c.width, c.height);
    return c;
  };
  const jpeg = (c, q) => new Promise(r => c.toBlob(r, 'image/jpeg', q));
  const big = at(RENDERING_EDGE);
  const out = { full: await jpeg(big, 0.88), thumb: await jpeg(at(RENDERING_THUMB), 0.8), w: big.width, h: big.height };
  bmp.close && bmp.close();
  return out.full && out.thumb ? out : null;
}

// The parts of a send, in order, as the send window lists them.
export const SEND_STEPS = [
  { id: 'code', name: 'The code the client page runs' },
  { id: 'files', name: 'Models and texture pictures' },
  { id: 'renderings', name: 'Renderings' },
  { id: 'pictures', name: 'Pictures of the saved views' },
  { id: 'property', name: 'The property, then the page switches to it' },
  { id: 'tidy', name: 'Tidying older copies' },
];
const mb = n => (n / 1e6).toFixed(n < 1e7 ? 1 : 0) + ' MB';

// Send the property. `progress(text, fraction, step)` hears how far it is; `step` says which part
// of SEND_STEPS is under way and how far it has got: { id, state: 'running' | 'done' | 'none',
// text, done, total or fraction (how far that part is), picture (a Blob: the rendering being sent) }. `pictures({ copy, read,
// progress })` makes the saved views' own pictures (lab-pictures.js viewPictures; without it the
// page shows the views by name). Returns { slug, version, uploaded, url, preview, notes }:
// `notes` says what could not go.
export async function sendToLab(propId, choice, { progress = () => {}, pictures = null } = {}) {
  const prop = ws.data.properties.find(p => p.id === propId);
  if (!prop) throw new Error('No such property');
  const slug = choice.slug;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug)) throw new Error('The page name may use only lowercase letters, digits and dashes.');
  const status = await lab('', { fresh: true });
  const step = (id, state, text, extra = {}) => ({ id, state, text, ...extra });
  progress('Sending the code the client page runs…', 0.01, step('code', 'running', 'Checking whether it changed since the last send…'));
  const app = await sendApp(slug, e => {
    if (!e.total) return;
    progress('Sending the code the client page runs (' + e.done + ' of ' + e.total + ' files)…', 0.01 + 0.24 * e.done / e.total,
      step('code', 'running', e.done + ' of ' + e.total + ' files · ' + mb(e.bytes) + ' of ' + mb(e.totalBytes) + (e.copied ? ' · ' + e.copied + ' unchanged, copied online' : ''), { done: e.done, total: e.total }));
  });
  const codeFiles = (app.sent || 0) + (app.copied || 0);
  progress('The code is there.', codeFiles ? 0.25 : 0.03, step('code', 'done', !codeFiles ? 'Unchanged since the last send' : app.copied ? app.sent + ' of ' + codeFiles + ' files changed and sent; ' + app.copied + ' copied online' : codeFiles + ' files sent'));
  const version = versionName();
  const { copy, send } = clientCopy(ws.data, propId, choice);
  const base = 'v/' + version + '/';
  let done = 0;
  const total = send.length + 2, notes = [];
  const viewCount = copy.property.savedViews.length;
  // The code took the start of the bar when it went up; the files take the next part, the views'
  // pictures the part after, when there are views.
  const start = codeFiles ? 0.25 : 0.05;
  const filesEnd = pictures && viewCount ? start + (0.9 - start) * 0.6 : 0.9;
  const counts = { files: send.filter(f => f.kind !== 'rendering').length, renderings: send.filter(f => f.kind === 'rendering').length };
  const doneOf = { files: 0, renderings: 0 };
  const stepOf = f => f.kind === 'rendering' ? 'renderings' : 'files';
  for (const id of ['files', 'renderings']) if (!counts[id]) progress('', start, step(id, 'none', 'None to send'));
  let unread = 0;
  for (const f of send) {
    const id = stepOf(f);
    progress('Sending ' + (f.kind === 'model' ? 'a model' : f.kind === 'rendering' ? 'a rendering' : 'a texture picture') + ' (' + (done + 1) + ' of ' + total + ')…', start + (filesEnd - start) * done / total,
      step(id, 'running', (doneOf[id] + 1) + ' of ' + counts[id] + (id === 'files' ? ' · ' + (f.kind === 'model' ? 'a model' : 'a texture picture') : ''), { done: doneOf[id], total: counts[id] }));
    const finished = () => { done++; if (++doneOf[id] === counts[id]) progress('', start + (filesEnd - start) * done / total, step(id, 'done', counts[id] + ' sent')); };
    if (f.kind === 'rendering') {
      // A web-size copy and a small one for its card; one this Mac cannot read is left out.
      const made = await webRendering(f.id);
      const r = copy.renderings.find(x => x.id === f.rendering);
      if (!made) { copy.renderings = copy.renderings.filter(x => x !== r); unread++; finished(); continue; }
      r.w = made.w; r.h = made.h;
      progress('Sending a rendering (' + (done + 1) + ' of ' + total + ')…', start + (filesEnd - start) * done / total,
        step(id, 'running', (doneOf[id] + 1) + ' of ' + counts[id] + (r.label ? ' · ' + r.label : ''), { done: doneOf[id], total: counts[id], picture: made.thumb }));
      await put(slug, base + f.path, made.full, 'image/jpeg');
      await put(slug, base + f.thumb, made.thumb, 'image/jpeg');
      finished(); continue;
    }
    // A texture picture may be a file in the project's folder (photos-store.js reads both).
    const buffer = f.kind === 'picture' ? await photoBytes(f.id).catch(() => null) : ((await getFile(f.id).catch(() => null)) || {}).buffer;
    if (!buffer) {
      // A texture picture this Mac does not hold leaves its material in its plain colour.
      if (f.kind === 'picture') {
        delete copy.files[f.id];
        copy.property.photos = copy.property.photos.filter(ph => ph.id !== f.id);
        for (const m of copy.materials) if (m.photoId === f.id) { m.photoId = null; if (m.pattern === 'photo') m.pattern = 'flat'; }
        finished(); continue;
      }
      throw new Error('A model of this property is missing on this Mac, so nothing was switched over: ' + f.id);
    }
    await put(slug, base + f.path, buffer, copy.files[f.id].mime);
    finished();
  }
  if (unread) notes.push(unread + ' rendering' + (unread === 1 ? '' : 's') + ' could not be read on this Mac and ' + (unread === 1 ? 'was' : 'were') + ' left out.');
  // The saved views' own pictures: made by the client page's code from this very copy, so each
  // shows what a click on it gives. viewPictures = { view id: { state id: path } }; a project
  // that changes nothing in a view has no picture there, and is not offered under that view.
  if (!(pictures && viewCount)) progress('', filesEnd, step('pictures', 'none', viewCount ? 'Not taken: the page shows the views by name' : 'No saved views'));
  if (pictures && viewCount) {
    try {
      const sent = new Set(send.filter(f => copy.files[f.id]).map(f => f.id));
      const read = async id => {
        if (!sent.has(id) || !copy.files[id]) return null;
        const kind = send.find(f => f.id === id).kind;
        const buffer = kind === 'picture' ? await photoBytes(id).catch(() => null) : ((await getFile(id).catch(() => null)) || {}).buffer;
        return buffer ? { buffer, format: copy.files[id].format, mime: copy.files[id].mime } : null;
      };
      const made = await pictures({ copy, read, progress: (text, f) => progress(text, filesEnd + (0.9 - filesEnd) * Math.min(1, Math.max(0, f || 0)), step('pictures', 'running', text.replace(/…$/, ''), { fraction: f })) });
      const index = {};
      const states = ['existing', ...copy.states.map(x => x.id)];
      let n = 0;
      for (const [vi, v] of copy.property.savedViews.entries()) {
        for (const [si, stateId] of states.entries()) {
          const body = made.views[v.id] && made.views[v.id][stateId];
          if (!body) continue;
          const path = 'views/' + vi + '-' + si + '.jpg';
          progress('Sending the pictures of the views (' + (++n) + ' of ' + made.count + ')…', 0.9, step('pictures', 'running', 'Sending them: ' + n + ' of ' + made.count, { done: n - 1, total: made.count }));
          await put(slug, base + path, new Blob([body], { type: 'image/jpeg' }), 'image/jpeg');
          (index[v.id] = index[v.id] || {})[stateId] = path;
        }
      }
      copy.viewPictures = index;
      copy.viewPictureSize = made.size;
      progress('', 0.9, step('pictures', 'done', n + ' picture' + (n === 1 ? '' : 's') + ' of ' + viewCount + ' view' + (viewCount === 1 ? '' : 's')));
    } catch (e) {
      progress('', 0.9, step('pictures', 'none', 'Not made: the page shows the views by name'));
      console.warn('The pictures of the saved views were not made:', e);
      notes.push('The pictures of the saved views could not be made (' + (e && e.message || e) + '), so the page shows the views by name.');
    }
  }
  progress('Sending the property…', 0.92, step('property', 'running', 'Sending the property'));
  await put(slug, base + 'property.json', new Blob([JSON.stringify(copy)], { type: 'application/json' }), 'application/json');
  // Last: the page switches to the new copy in one step.
  await put(slug, 'current.json', new Blob([JSON.stringify({ format: CLIENT_FORMAT, version, app: app.app, sentAt: copy.sentAt })], { type: 'application/json' }), 'application/json');
  progress('Tidying older copies…', 0.97, step('property', 'done', 'The page shows this copy now'));
  progress('Tidying older copies…', 0.97, step('tidy', 'running', 'Removing copies older than the last two'));
  try {
    await lab('prune/' + slug, { body: JSON.stringify({ keep: [version, prop.lab && prop.lab.version].filter(Boolean) }), type: 'application/json' });
    progress('', 0.99, step('tidy', 'done', 'Done'));
  } catch (e) { console.warn('Older lab copies stay for now:', e); progress('', 0.99, step('tidy', 'none', 'Older copies stay for now')); }
  const keep = choice.keep && typeof choice.keep === 'object' ? choice.keep : {};
  prop.lab = { slug, projects: choice.projects.map(p => ({ id: p.id, label: p.label })), furnitureTags: copy.furnitureTags,
    viewsOff: Array.isArray(keep.viewsOff) ? keep.viewsOff : [], renderingsOff: Array.isArray(keep.renderingsOff) ? keep.renderingsOff : [],
    renderingLabels: keep.renderingLabels && typeof keep.renderingLabels === 'object' ? keep.renderingLabels : {},
    renderingsSent: send.filter(f => f.kind === 'rendering' && copy.renderings.some(r => r.id === f.rendering)).map(f => f.id),
    sentAt: copy.sentAt, version };
  touch();
  progress('Sent.', 1);
  return { slug, version, uploaded: !!status.upload, url: status.site + slug + '/', preview: status.preview + slug + '/', notes,
    views: viewCount, renderings: copy.renderings.length, pictured: copy.viewPictures ? Object.keys(copy.viewPictures).length : 0 };
}
