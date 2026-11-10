// tiksi store: workspace state, persistence, units, shared helpers.
// All lengths are stored in meters, money in USD, dates as ISO strings.

import { normalizeView } from './photo-match.js';
import { normalizePositions } from './positions.js';
import { normalizePin, normalizeLens, normalizeCameraSets, normalizeWallAnchor } from './pin-records.js';
import { normaliseFixtures } from './fixtures.js';
import { normalizeDocSets } from './doc-sets.js';
import { normalizeTags } from './tags.js';
import { normalizeSavedViews } from './saved-views.js';
import { isPictureRef, inlineBundlePictures } from './picture-assets.js';
import { normalizeOnePager, emptyOnePager } from './one-pager-record.js';
import { sameJson } from './workspace-merge.js';

const LS_KEY = 'tiksi.workspace.v1';   // storage slot, not the schema version (see migrate)
const SCHEMA_VERSION = 2;
const M_PER_FT = 0.3048;
const M2_PER_SF = 0.09290304;

export const ws = { data: null };

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const replaceListeners = new Set();
export function onWorkspaceReplace(fn) { replaceListeners.add(fn); return () => replaceListeners.delete(fn); }

let saveTimer = null;
let diskPersistence = null;
const memoryFiles = new Map();
let legacyFiles = true;
let legacyDeletion = null;
export function useDiskPersistence(backend) { diskPersistence = backend; }
export async function finishBrowserMigration({ clearFiles = true } = {}) {
  // Only called after an acknowledged, complete save to the Mac's project files.
  try { localStorage.removeItem(LS_KEY); localStorage.removeItem('tiksi.folder.v1'); } catch (ignored) {}
  try { sessionStorage.removeItem('tiksi.research.session.v1'); } catch (ignored) {}
  legacyFiles = false;
  if (!clearFiles) return;
  if (dbPromise) {
    const existing = await dbPromise;
    existing.close();
    dbPromise = null;
  }
  if (!legacyDeletion) {
    const deletion = legacyDeletion = { done: false, promise: null };
    deletion.promise = new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('tiksi-files');
      request.onsuccess = () => { deletion.done = true; resolve(); };
      request.onerror = () => { legacyDeletion = null; reject(request.error); };
      request.onblocked = () => reject(new Error('Close older Tiksi tabs to finish removing browser storage.'));
    });
  }
  // A blocked deletion continues in IndexedDB. Reissuing it would queue behind
  // that same blocked request and could leave the next disk save waiting forever.
  if (!legacyDeletion.done) await legacyDeletion.promise;
}
export function touch() {
  // Notify + debounced autosave.
  for (const fn of listeners) { try { fn(); } catch (e) { console.error(e); } }
  setSaveStatus('SAVING', true);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; save(); }, 450);
}

// A pending autosave must not be lost when the tab closes or reloads inside the debounce.
if (typeof window !== 'undefined') {
  const flush = () => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; save(); } };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
}

export function setSaveStatus(text, busy) {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('save-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('busy', !!busy);
}

let saveFailed = false;
let savePending = false;
export function save(skipPlanQueue = false) {
  if (diskPersistence) return; // disk-workspace observes edits and owns save acknowledgments
  // The stored workspace could not be read: writing now would replace it with an empty one.
  if (unreadable) { setSaveStatus('NOT SAVED — STORED WORKSPACE UNREADABLE', true); return; }
  // Never write a copy with inline thumbnails while hydrateThumbs() is still moving them into
  // IndexedDB: a freshly imported gallery would not fit and would raise the quota alert for nothing.
  if (hydration) {
    if (!savePending) { savePending = true; hydration.then(() => { savePending = false; save(); }); }
    return;
  }
  if (typeof localStorage === 'undefined') return;
  if (skipPlanQueue !== true) {
    queueUnstoredPlans();
    // A high-resolution underlay can exceed localStorage until its IndexedDB write
    // completes. That write invokes save again; do not report a false quota failure.
    if (planStoring) return;
  }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(persistable(ws.data)));
    saveFailed = false;
    const t = new Date();
    setSaveStatus('SAVED ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'), false);
  } catch (e) {
    console.error('save failed', e);
    setSaveStatus('SAVE FAILED', true);
    // One alert per failure streak: autosave runs after every edit, and a modal per keystroke
    // would make the recovery steps (export, delete photos or scans) impossible to carry out.
    if (!saveFailed) alert('Autosave failed: browser storage is full. Use EXPORT to save your workspace now, then delete photos or scans to free space.');
    saveFailed = true;
  }
}

// The localStorage copy of the workspace. Photo thumbnails are the only bulky per-record data
// in the JSON (20-35 KB each), and the ~5 MB localStorage limit would cap a gallery at a
// couple of hundred photos; so wherever IndexedDB is confirmed to hold a thumbnail the copy
// carries an empty `thumb` and hydrateThumbs() fills it back in on load. In-memory records
// and JSON/bundle exports always keep the thumbnail, so every consumer of `ph.thumb` and
// every export stays portable. Only the objects on the path to photo records are copied.
function persistable(d) {
  const strip = ph => !!ph.thumb && thumbsStored.has(ph.id);
  const stripPlan = (p, l) => !!(l.plan && l.plan.img) && plansStored.get(planKey(l.id, p.id)) === l.plan.img;
  return Object.assign({}, d, {
    properties: (d.properties || []).map(p => {
      const photos = p.photos || [], levels = p.levels || [];
      if (!photos.some(strip) && !levels.some(l => stripPlan(p, l))) return p;
      return Object.assign({}, p, {
        photos: photos.map(ph => strip(ph) ? Object.assign({}, ph, { thumb: '' }) : ph),
        levels: levels.map(l => stripPlan(p, l) ? Object.assign({}, l, { plan: Object.assign({}, l.plan, { img: '' }) }) : l),
      });
    }),
  });
}

// A workspace stored in this browser that could not be read: { raw, error }. While it is
// set, save() writes nothing, so the stored text stays exactly as it was found. The app
// shows what happened and lets the person keep the text before starting again (main.js).
let unreadable = null;
export function unreadableWorkspace() { return unreadable; }
// Move the unreadable text aside under its own key and start again. False when the copy
// could not be written: then nothing is cleared.
export function setAsideUnreadableWorkspace() {
  if (!unreadable) return true;
  try {
    const key = LS_KEY + '.unreadable.' + new Date().toISOString().replace(/[:.]/g, '-');
    localStorage.setItem(key, unreadable.raw);
    if (localStorage.getItem(key) !== unreadable.raw) return false;
    localStorage.removeItem(LS_KEY);
  } catch (e) { console.error(e); return false; }
  unreadable = null;
  return true;
}

export function load() {
  let raw = null;
  try {
    raw = localStorage.getItem(LS_KEY);
    if (raw) { ws.data = migrate(JSON.parse(raw)); thumbsStored.clear(); plansStored.clear(); hydrateThumbs(); return true; }
  } catch (e) {
    console.error('load failed', e);
    if (raw) unreadable = { raw, error: String(e && e.message || e) };
  }
  ws.data = emptyWorkspace();
  return false;
}

// `source: 'shared'` is another device's change, or this device's own save merged with one.
// The records it brings are put into the objects already here (see keepRecords), and what
// changed is returned: { properties: Set of ids, keys: Map id -> changed fields (null when
// more than its own fields changed), materials, other }. `prepare(next)` may adjust the
// incoming data before it is compared and shown.
export function replaceWorkspace(data, { source = 'import', prepare } = {}) {
  const before = ws.data;
  const next = migrate(data);
  if (prepare) prepare(next);
  const change = source === 'shared' && before ? keepRecords(before, next) : null;
  ws.data = next;
  for (const fn of replaceListeners) fn(before, ws.data, source);
  // Thumbnails arrive inline (JSON/bundle); hydrateThumbs() copies them into IndexedDB and
  // save() waits for it, so the first localStorage copy is already the slim one.
  thumbsStored.clear();
  plansStored.clear();
  hydrateThumbs();
  touch();
  return change;
}

// Put a record's new values into the object that already stands for it. An open page, a
// dialog or a slow action that took the record before the change then still holds the live
// one: what it writes next is saved, not lost in a copy nothing looks at any more.
export function adoptRecord(held, fresh) {
  if (held === fresh) return held;
  for (const key of Object.keys(held)) if (!(key in fresh)) delete held[key];
  return Object.assign(held, fresh);
}
// Shared data arrives as whole new records. Keep the objects of the records that are already
// here (properties, projects, products, materials), and say what changed.
function keepRecords(before, next) {
  const change = { properties: new Set(), keys: new Map(), materials: false, other: false };
  const note = (list, rec, old) => {
    if (list === 'properties') {
      change.properties.add(rec.id);
      change.keys.set(rec.id, old && old !== rec ? [...new Set([...Object.keys(old), ...Object.keys(rec)])].filter(key => !sameJson(old[key], rec[key])) : null);
    } else if (list === 'projects') { for (const r of [rec, old]) if (r) { change.properties.add(r.propertyId); change.keys.set(r.propertyId, null); } }
    else if (list === 'materials') change.materials = true;
    else change.other = true;
  };
  for (const list of ['properties', 'projects', 'products', 'materials']) {
    const held = new Map((before[list] || []).map(rec => [rec && rec.id, rec]));
    next[list] = (next[list] || []).map(rec => {
      const old = rec && held.get(rec.id);
      held.delete(rec && rec.id);
      if (old && sameJson(old, rec)) return old;
      note(list, rec, old);
      return old ? adoptRecord(old, rec) : rec;
    });
    // What is here and no longer in the shared data was removed elsewhere.
    for (const gone of held.values()) if (gone) note(list, gone, null);
  }
  const rest = d => { const o = { ...d }; for (const list of ['properties', 'projects', 'products', 'materials']) delete o[list]; return o; };
  if (!sameJson(rest(before), rest(next))) change.other = true;
  return change;
}

// Merge a project file (or any workspace-shaped JSON) into the current workspace: properties,
// projects, products and custom materials are replaced by id or added; settings stay. The
// first incoming property becomes active. Returns the ids of the properties that landed.
// A project file opened from disk (opts.fromFile, one property) also brings its schedule start,
// and every custom material it carries is kept with its property, so the next save writes them
// all back whether or not anything uses them yet.
export function mergeWorkspace(data, opts) {
  const fileStart = data && data.settings && data.settings.programStart;   // read before migrate fills in today
  const incoming = migrate(JSON.parse(JSON.stringify(data)));
  const d = ws.data;
  const projectFile = !!(opts && opts.fromFile) && incoming.properties.length === 1;
  const upsert = (list, rec) => { const i = list.findIndex(x => x.id === rec.id); if (i >= 0) list[i] = rec; else list.push(rec); };
  for (const p of incoming.properties) upsert(d.properties, p);
  const propIds = new Set(incoming.properties.map(p => p.id));
  const incomingProjectIds = new Set(incoming.projects.map(pr => pr.id));
  d.projects = d.projects.filter(pr => !propIds.has(pr.propertyId) || incomingProjectIds.has(pr.id));
  for (const pr of incoming.projects || []) upsert(d.projects, pr);
  for (const pr of incoming.products || []) upsert(d.products, pr);
  for (const m of incoming.materials || []) if (m && m.custom) {
    const owners = new Set([...materialOwners(d.materials.find(x => x.id === m.id)), ...materialOwners(m)]);
    if (projectFile) owners.add(incoming.properties[0].id);
    if (owners.size) m.propertyIds = [...owners];
    upsert(d.materials, m);
  }
  if (projectFile && typeof fileStart === 'string' && ISO_DATE_RE.test(fileStart)) d.settings.programStart = fileStart;
  if (incoming.properties.length) d.settings.activePropertyId = incoming.properties[0].id;
  ws.data = migrate(d);
  for (const fn of replaceListeners) fn(d, ws.data, 'import');
  // Incoming records carry thumbnails and underlays inline; move them into IndexedDB.
  hydrateThumbs();
  touch();
  return incoming.properties.map(p => p.id);
}

// The properties a custom material is kept with: the ones whose project file carried it, or
// that were open when it was made (materials.js). Their files carry it even while unused.
export function materialOwners(m) {
  return m && Array.isArray(m.propertyIds) ? m.propertyIds.filter(id => typeof id === 'string' && id) : [];
}

// The part of the workspace that is one property: the property, its projects, the products
// those projects specify, and the custom materials it uses or keeps. This is what a project file holds.
export function projectSlice(propId, data) {
  const d = data || ws.data;
  const p = d.properties.find(x => x.id === propId);
  if (!p) return null;
  const projects = (d.projects || []).filter(pr => pr.propertyId === propId);
  const itemIds = new Set();
  for (const pr of projects) for (const it of pr.items || []) itemIds.add(it.id);
  const matIds = new Set();
  for (const s of p.scans || []) for (const id of [...Object.values(s.materialBindings || {}),...Object.values(s.materialIdentities || {})]) matIds.add(id);
  for (const w of p.walls || []) for (const k of ['material', 'materialIn', 'materialPos', 'materialNeg']) matIds.add(w[k]);
  for (const r of p.rooms || []) { matIds.add(r.material); matIds.add(r.ceilingMaterial); }
  for (const f of p.fixtures || []) { matIds.add(f.material); matIds.add(f.bodyMaterial); }
  for (const m of d.materials || []) if (m && m.custom && materialOwners(m).includes(propId)) matIds.add(m.id);
  // A product added while this property was open (propertyIds) stays with it before it is linked to work.
  const products = (d.products || []).filter(pr => (pr.itemIds || []).some(id => itemIds.has(id)) || (pr.materialIds || []).some(id => matIds.has(id)) || (pr.propertyIds || []).includes(propId));
  const photoIds = new Set((p.photos || []).map(ph => ph.id));
  // The file's list is itself the record of what it keeps (mergeWorkspace), so the browser's
  // owner list stays out of it: other properties' ids neither leak nor mark this file unsaved.
  const materials = (d.materials || []).filter(m => m && m.custom && (matIds.has(m.id) || (m.photoId && photoIds.has(m.photoId))))
    .map(m => { if (!('propertyIds' in m)) return m; const { propertyIds, ...rest } = m; return rest; });
  // A material may have been sampled from another property's photograph. Carry only the
  // source photo records it needs, so the bundle collector includes their original pixels.
  const neededPhotos = new Set(materials.map(m => m.photoId).filter(Boolean));
  const photos = [...(p.photos || [])];
  for (const source of d.properties) for (const ph of source.photos || []) {
    if (neededPhotos.has(ph.id) && !photoIds.has(ph.id)) { photos.push(ph); photoIds.add(ph.id); }
  }
  const property = photos.length === (p.photos || []).length ? p : Object.assign({}, p, { photos });
  return {
    version: d.version,
    settings: { units: d.settings.units, budgetCap: d.settings.budgetCap, programStart: d.settings.programStart, activePropertyId: propId },
    properties: [property], materials, products, projects,
  };
}

// ---------- photo thumbnails and level underlays (IndexedDB copy) ----------

const THUMB_PREFIX = 'thumb-';
const PLAN_PREFIX = 'plan-';
const HANDLE_PREFIX = 'fh-';      // File System Access handles (see files.js); never orphans
const thumbsStored = new Set();   // photo ids whose thumbnail is confirmed in IndexedDB
const plansStored = new Map();    // scoped plan key -> exact image confirmed in IndexedDB
let hydration = null;             // pending hydrateThumbs() run, if any
let planStoring = null;           // pending queueUnstoredPlans() run, if any

export function thumbKey(id) { return THUMB_PREFIX + id; }
export function planKey(levelId, propertyId) { return PLAN_PREFIX + (propertyId ? propertyId + '|' : '') + levelId; }
export function handleKey(name) { return HANDLE_PREFIX + name; }

// Level underlays are rendered from scans (60-150 KB each, several per property) and would
// crowd photos out of localStorage; like thumbnails they live in IndexedDB and the slim copy
// carries an empty `img`. New underlays are copied over on the next autosave.
function queueUnstoredPlans() {
  if (planStoring || hydration) return;
  const todo = [];
  for (const p of ws.data.properties || []) for (const l of p.levels || []) {
    const key = planKey(l.id, p.id);
    if (l.plan && l.plan.img && plansStored.get(key) !== l.plan.img) todo.push({ key, img: l.plan.img });
  }
  if (!todo.length) return;
  const d = ws.data;
  let failed = false;
  planStoring = (async () => {
    for (const { key, img } of todo) {
      try { await putFile(key, null, { kind: 'plan', img }); if (ws.data === d) plansStored.set(key, img); }
      catch (e) { failed = true; /* stays inline in localStorage for this level */ }
    }
  })().catch(() => {}).then(() => { planStoring = null; if (ws.data === d) save(failed); });
}
export function forgetPlanImage(levelId, propertyId) {
  const key = planKey(levelId, propertyId);
  plansStored.delete(key);
  deleteFile(key).catch(() => {});
}

// Resolves once the current workspace's thumbnails are back in memory (boot waits for it
// before the first render so galleries never paint empty images).
export function whenHydrated() { return hydration || Promise.resolve(); }

export async function storeThumb(id, thumb) {
  await putFile(thumbKey(id), null, { kind: 'thumb', thumb });
  thumbsStored.add(id);
}

export async function deleteThumb(id) {
  thumbsStored.delete(id);
  await deleteFile(thumbKey(id));
}

// Reconcile in-memory photo records with the thumbnail store, and level records with the
// underlay store: records loaded from the slim localStorage copy get their image back,
// records that still carry one inline (older saves, imports) get it copied over so the next
// save can drop it. Bails out quietly when IndexedDB is unavailable: images then simply
// stay inline as they always did.
function hydrateThumbs() {
  const d = ws.data;
  const run = (async () => {
    const photos = [], levels = [];
    for (const p of d.properties || []) {
      for (const ph of p.photos || []) photos.push(ph);
      for (const l of p.levels || []) levels.push({ p, l });
    }
    if (!photos.length && !levels.length) return;
    let stored, plans;
    try { stored = await getAllThumbs(); plans = await getAllPlans(); } catch (e) { console.error('thumbnail store unavailable', e); return; }
    for (const ph of photos) {
      if (ws.data !== d) return;   // workspace replaced meanwhile; the new one runs its own pass
      const have = stored.get(ph.id);
      if (ph.thumb) {
        if (have === ph.thumb) { thumbsStored.add(ph.id); continue; }
        try {
          await putFile(thumbKey(ph.id), null, { kind: 'thumb', thumb: ph.thumb });
          if (ws.data === d) thumbsStored.add(ph.id);
        } catch (e) { /* stays inline in localStorage for this record */ }
      } else if (have) {
        ph.thumb = have;
        thumbsStored.add(ph.id);
      }
    }
    for (const { p, l } of levels) {
      if (ws.data !== d) return;
      const key = planKey(l.id, p.id);
      // Read the legacy unscoped entry once, then move it to a property-specific key.
      const have = plans.get(key) || plans.get(planKey(l.id));
      if (l.plan && l.plan.img) {
        if (plans.get(key) === l.plan.img) { plansStored.set(key, l.plan.img); continue; }
        try {
          const img = l.plan.img;
          await putFile(key, null, { kind: 'plan', img });
          if (ws.data === d) plansStored.set(key, img);
        } catch (e) { /* stays inline */ }
      } else if (l.plan && have) {
        l.plan.img = have;
        try { await putFile(key, null, { kind: 'plan', img: have }); if (ws.data === d) plansStored.set(key, have); } catch (e) { /* keep inline */ }
      }
    }
  })();
  const p = run.catch(e => console.error('thumbnail hydration failed', e)).then(() => { if (hydration === p) hydration = null; });
  hydration = p;
  return p;
}

// ---------- schema defaults (v2) ----------

// Rendering settings are saved per property; location mode uses local clock time and an IANA zone.
export function defaultEnv() {
  return {
    time: 14.5, azimuth: 200, north: 0, exposure: 1.0, quality: 'high',
    sunMode: 'manual', latitude: null, longitude: null, date: isoToday(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', xrayOpacity: 0.35,
    sky: 'dynamic', panoPhotoId: null,
    showCeilings: true, showGround: true, showGrid: false, nightLights: true,
    showPins: true, showNotes: true,
  };
}

// Scan kind inferred from the file extension. PLY defaults to a point cloud; importers
// that detect a mesh or a 3DGS splat inside a PLY overwrite `kind` at import time.
const SCAN_KIND_BY_FORMAT = {
  ply: 'points', pcd: 'points', xyz: 'points', las: 'points', laz: 'points', e57: 'points',
  obj: 'mesh', glb: 'mesh', gltf: 'mesh', stl: 'mesh',
  splat: 'splat', spz: 'splat', ksplat: 'splat',
};
export function scanKindFor(format) {
  return SCAN_KIND_BY_FORMAT[String(format || '').toLowerCase()] || 'points';
}

export function propertyTemplate(name) {
  return normalizeTags({
    id: uid('prop'), name: name || 'New property', notes: '', wallHeight: 2.44,
    levels: [levelTemplate('lvl-0', 'Main level', 0, 2.44)], activeLevelId: 'lvl-0',
    walls: [], openings: [], rooms: [], fixtures: [], scans: [], photos: [], notePins: [], videos: [], measurements: [], env: defaultEnv(), source: null,
    photoPositions: [], positionCounter: 0, cameraSets: [], docSets: [], savedViews: [], onePager: emptyOnePager(),
  });
}

// ---------- levels (storeys) ----------
// A property is a stack of levels sorted by elevation (the floor's world Y, in meters); each
// level carries its default wall height and its own tracing underlay. Walls and rooms name
// their level by id; openings sit on a wall and so live on the wall's level. Plan x/y are one
// frame shared by every level, so a wall on the second floor traces straight over the first.
// `wallHeight` on the property is only a fallback for records that predate levels.

function levelTemplate(id, name, elevation, height) {
  return { id, name, elevation, height, plan: null };
}

function num(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }

export function sortLevels(prop) {
  prop.levels.sort((a, b) => a.elevation - b.elevation);
  return prop.levels;
}

function lowestLevel(prop) {
  let best = null;
  for (const l of prop.levels) if (!best || l.elevation < best.elevation) best = l;
  return best;
}

// Bring a property up to the level model in place. Idempotent: a property that already has
// levels only gets its references checked. Handles the pre-level shape (property.plan, no
// `level` on walls and rooms), a partially filled levels array from a hand-edited file, and
// an activeLevelId that names a level that is gone.
export function ensureLevels(p) {
  if (!Array.isArray(p.levels) || !p.levels.length) {
    p.levels = [levelTemplate('lvl-0', 'Main level', 0, num(p.wallHeight, 0) || 2.44)];
  }
  const seen = new Set();
  p.levels = p.levels.filter(l => l && typeof l === 'object');
  if (!p.levels.length) p.levels = [levelTemplate('lvl-0', 'Main level', 0, num(p.wallHeight, 0) || 2.44)];
  for (const l of p.levels) {
    if (l.id != null && typeof l.id !== 'string') l.id = String(l.id);
    if (l.id == null || l.id === '' || seen.has(l.id)) l.id = uid('lvl');
    seen.add(l.id);
    if (typeof l.name !== 'string' || !l.name) l.name = 'Level';
    l.elevation = num(l.elevation, 0);
    l.height = num(l.height, 0) || num(p.wallHeight, 0) || 2.44;
    if (l.plan === undefined || !(l.plan && typeof l.plan === 'object')) l.plan = null;
  }
  sortLevels(p);
  const low = lowestLevel(p);
  // The pre-level underlay moves onto the lowest level (unless that level already has one).
  if (p.plan && typeof p.plan === 'object' && low.plan == null) low.plan = p.plan;
  delete p.plan;
  const ids = seen;
  for (const w of p.walls || []) if (!ids.has(w.level)) w.level = low.id;
  for (const r of p.rooms || []) if (!ids.has(r.level)) r.level = low.id;
  if (!ids.has(p.activeLevelId)) p.activeLevelId = low.id;
  return p;
}

export function levelById(prop, id) {
  return (prop && prop.levels || []).find(l => l.id === id) || null;
}

// The level the PLAN editor shows. Falls back to (and repairs the pointer to) the lowest level.
export function activeLevel(prop) {
  if (!prop) return null;
  if (!Array.isArray(prop.levels) || !prop.levels.length) ensureLevels(prop);
  let l = levelById(prop, prop.activeLevelId);
  if (!l) { l = lowestLevel(prop); prop.activeLevelId = l.id; }
  return l;
}

export function setActiveLevel(prop, id) {
  const l = levelById(prop, id);
  if (!l) return activeLevel(prop);
  prop.activeLevelId = l.id;
  return l;
}

// A wall or room whose `level` is missing or stale counts as being on the lowest level, the
// same rule migration applies, so nothing ever vanishes from every view.
export function levelOfWall(prop, wall) {
  if (!Array.isArray(prop.levels) || !prop.levels.length) ensureLevels(prop);
  return levelById(prop, wall && wall.level) || lowestLevel(prop);
}
export function levelOfRoom(prop, room) { return levelOfWall(prop, room); }

export function wallsOn(prop, levelId) {
  return (prop.walls || []).filter(w => levelOfWall(prop, w).id === levelId);
}
export function roomsOn(prop, levelId) {
  return (prop.rooms || []).filter(r => levelOfRoom(prop, r).id === levelId);
}
// Openings whose wall is on the level.
export function openingsOn(prop, levelId) {
  const ids = new Set(wallsOn(prop, levelId).map(w => w.id));
  return (prop.openings || []).filter(o => ids.has(o.wallId));
}

export function levelHeight(prop, levelId) {
  const l = levelById(prop, levelId);
  return (l && l.height) || prop.wallHeight || 2.44;
}
// Floor-to-ceiling height of one wall: its own, else its level's default, else the legacy property default.
export function wallHeightOf(prop, wall) {
  return (wall && wall.height) || levelOfWall(prop, wall).height || prop.wallHeight || 2.44;
}

// World Y of the top of the highest level: what a section slider or a shadow camera spans.
export function topOfLevels(prop) {
  if (!Array.isArray(prop.levels) || !prop.levels.length) ensureLevels(prop);
  let top = -Infinity;
  for (const l of prop.levels) top = Math.max(top, l.elevation + l.height);
  return Number.isFinite(top) ? top : (prop.wallHeight || 2.44);
}

export function addLevel(prop, opts) {
  opts = opts || {};
  if (!Array.isArray(prop.levels) || !prop.levels.length) ensureLevels(prop);
  const l = levelTemplate(uid('lvl'), String(opts.name || 'Level ' + (prop.levels.length + 1)), num(opts.elevation, 0), num(opts.height, 0) || 2.44);
  prop.levels.push(l);
  sortLevels(prop);
  return l;
}

// False when the level still holds walls or rooms, or is the last one; otherwise removes it.
export function deleteLevel(prop, id) {
  const l = levelById(prop, id);
  if (!l || prop.levels.length <= 1) return false;
  if (wallsOn(prop, id).length || roomsOn(prop, id).length || (prop.fixtures || []).some(f => f.level === id)) return false;
  prop.levels = prop.levels.filter(x => x !== l);
  if (prop.activeLevelId === id) prop.activeLevelId = lowestLevel(prop).id;
  forgetPlanImage(id, prop.id);
  return true;
}

// Ids land in element attributes and thumbnails in <img src>, and both can come from a
// hand-edited or hostile file: an id that does not look like one is regenerated (with every
// reference following it), a thumbnail that is not a plain base64 image is dropped.
const ID_RE = /^[\w.:-]{1,80}$/;
const THUMB_RE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function sanitiseIds(d) {
  const renamed = new Map();
  const fix = (rec, prefix) => {
    if (!rec || typeof rec !== 'object') return;
    if (typeof rec.id === 'string' && ID_RE.test(rec.id)) return;
    const id = uid(prefix);
    if (typeof rec.id === 'string' && rec.id) renamed.set(rec.id, id);
    rec.id = id;
  };
  for (const p of d.properties) {
    fix(p, 'prop');
    for (const l of p.levels) fix(l, 'lvl');
    for (const w of p.walls) fix(w, 'w');
    for (const o of p.openings) fix(o, 'o');
    for (const r of p.rooms) fix(r, 'r');
    for (const s of p.scans) fix(s, 'scan');
    for (const ph of p.photos) fix(ph, 'ph');
    for (const n of p.notePins) fix(n, 'note');
    for (const f of p.fixtures || []) fix(f, 'fx');
    for (const v of p.videos) fix(v, 'vid');
    for (const m of p.measurements) fix(m, 'ms');
    for (const x of p.photoPositions || []) fix(x, 'pos');
    for (const x of p.cameraSets || []) fix(x, 'cams');
  }
  for (const m of d.materials) fix(m, 'mat');
  for (const pr of d.products) fix(pr, 'prod');
  for (const pr of d.projects) { fix(pr, 'proj'); for (const it of pr.items) fix(it, 'it'); }
  if (renamed.size) remapIds(d, renamed);
}

// References are plain id strings wherever they sit (wall.material, opening.wallId,
// item.elementIds, photo.roomId, settings.activePropertyId, ...), so walk everything.
function remapIds(node, renamed) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      if (typeof node[i] === 'string') { if (renamed.has(node[i])) node[i] = renamed.get(node[i]); }
      else remapIds(node[i], renamed);
    }
  } else if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === 'string') { if (k !== 'id' && renamed.has(v)) node[k] = renamed.get(v); }
      else remapIds(v, renamed);
    }
  }
}

function validateWorkspace(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('not a tiksi workspace');
  for (const key of ['properties', 'materials', 'products', 'projects']) {
    if (d[key] != null && !Array.isArray(d[key])) throw new Error(key + ' must be a list');
    for (const rec of d[key] || []) if (!rec || typeof rec !== 'object' || Array.isArray(rec)) throw new Error(key + ' contains an invalid record');
  }
  for (const p of d.properties || []) for (const key of ['levels','walls','openings','rooms','fixtures','scans','photos','notePins','videos','measurements','photoPositions','cameraSets']) {
    if (p[key] != null && !Array.isArray(p[key])) throw new Error('property ' + key + ' must be a list');
    for (const rec of p[key] || []) if (!rec || typeof rec !== 'object' || Array.isArray(rec)) throw new Error('property ' + key + ' contains an invalid record');
  }
  for (const p of d.projects || []) {
    if (p.items != null && !Array.isArray(p.items)) throw new Error('project items must be a list');
    for (const it of p.items || []) {
      if (!it || typeof it !== 'object' || Array.isArray(it)) throw new Error('project contains an invalid item');
      for (const key of ['deps', 'elementIds']) if (it[key] != null && !Array.isArray(it[key])) throw new Error('item ' + key + ' must be a list');
    }
  }
}

function migrate(d) {
  validateWorkspace(d);
  if (!d.version) d.version = 1;
  d.settings = Object.assign({ units: 'imperial', budgetCap: 150000, programStart: isoToday(), activePropertyId: null, onePagerPrompt: 'changed' }, d.settings || {});
  if (!['changed', 'always', 'never'].includes(d.settings.onePagerPrompt)) d.settings.onePagerPrompt = 'changed';
  d.properties = d.properties || [];
  d.materials = d.materials || [];   // material records are normalised by materials.js
  d.products = d.products || [];
  d.projects = d.projects || [];
  for (const p of d.properties) {
    p.wallHeight = p.wallHeight || 2.44;   // legacy fallback only; levels carry the real heights
    p.walls = p.walls || [];
    p.openings = p.openings || [];
    p.rooms = p.rooms || [];
    p.scans = p.scans || [];
    // Levels: the pre-level shape (property.plan, no `level` on walls and rooms) becomes one
    // "Main level" at elevation 0; anything already shaped that way is only checked.
    ensureLevels(p);
    // Fixtures (fixtures.js): counter runs, cabinets, appliances, furniture on a level.
    p.fixtures = normaliseFixtures(p.fixtures, p);
    // v2: photos, environment, richer scan and room records. Merge over whatever is there
    // so partially filled objects from hand-edited or older exports keep their values.
    p.photos = p.photos || [];
    p.env = Object.assign(defaultEnv(), p.env || {});
    // Where the property came from (a Polycam share link, say); null for a hand-made one.
    if (p.source === undefined) p.source = null;
    for (const s of p.scans) {
      if (!s.kind) s.kind = scanKindFor(s.format);
      if (!Array.isArray(s.pos)) s.pos = [0, 0, 0];
      if (!Array.isArray(s.rot)) s.rot = [0, 0, 0];
      if (s.rotY == null) s.rotY = 0;
      if (s.scale == null) s.scale = 1;
      if (s.visible == null) s.visible = true;
      if (s.pointSize == null) s.pointSize = 0.012;
      if (!s.pointColor) s.pointColor = 'rgb';
      if (!s.budget) s.budget = 2000000;
      if (s.flip == null) s.flip = s.kind === 'splat';   // 3DGS captures are y-down; the viewer flips them
    }
    for (const r of p.rooms) {
      if (r.ceilingMaterial === undefined) r.ceilingMaterial = null;   // viewer falls back to 'mat-ceiling'
      r.pts = r.pts || [];
    }
    for (const ph of p.photos) {
      if (!ph.kind) ph.kind = 'photo';
      if (ph.notes == null) ph.notes = '';
      if (ph.roomId == null) ph.roomId = '';
      if (!Array.isArray(ph.elementIds)) ph.elementIds = [];
      if (!Array.isArray(ph.itemIds)) ph.itemIds = [];
      if (!['photo', 'pano', 'document'].includes(ph.kind)) ph.kind = 'photo';
      // Where it hangs (pins.js): a point, or a place on a wall face that follows the wall.
      ph.pin = normalizePin(ph.pin);
      // The camera a photo was taken from (MATCH PHOTO). Optional: older photos have none.
      if (ph.view !== undefined) { const v = normalizeView(ph.view); if (v) ph.view = v; else delete ph.view; }
      // The lens read from the photo file (photo-exif.js), and when it was taken.
      if (ph.lens !== undefined) { const l = normalizeLens(ph.lens); if (l) ph.lens = l; else delete ph.lens; }
      if (ph.takenAt !== undefined && (typeof ph.takenAt !== 'string' || !ph.takenAt)) delete ph.takenAt;
      if (!ph.createdAt) ph.createdAt = new Date(0).toISOString();
      // '' is the slim localStorage form (thumbnail lives in IndexedDB, see persistable). A
      // picture reference whose file could not be read is kept, never erased (picture-assets.js).
      if (typeof ph.thumb !== 'string' || (ph.thumb && !THUMB_RE.test(ph.thumb) && !isPictureRef(ph.thumb))) ph.thumb = '';
    }
    // Walk-through videos and the tape readings taken from their frames (MEASURE). Values are
    // metres or null; element is { kind: 'opening'|'wall', id, dim } or null (unassigned / note).
    p.videos = p.videos || [];
    for (const v of p.videos) {
      if (typeof v.name !== 'string') v.name = 'Video';
      if (typeof v.notes !== 'string') v.notes = '';
      if (!v.createdAt) v.createdAt = new Date(0).toISOString();
      if (typeof v.thumb !== 'string' || (v.thumb && !THUMB_RE.test(v.thumb) && !isPictureRef(v.thumb))) v.thumb = '';
      if (v.analysis !== null && (typeof v.analysis !== 'object' || Array.isArray(v.analysis))) v.analysis = null;
      if (v.analysis && !Array.isArray(v.analysis.candidates)) v.analysis.candidates = [];
    }
    p.measurements = p.measurements || [];
    for (const m of p.measurements) {
      if (!Number.isFinite(m.seconds)) m.seconds = 0;
      if (m.value != null && !Number.isFinite(m.value)) m.value = null;
      for (const k of ['text', 'input', 'note']) if (typeof m[k] !== 'string') m[k] = '';
      if (!['width', 'height', 'depth', ''].includes(m.direction)) m.direction = '';
      if (!['clear', 'probable', 'unreadable'].includes(m.confidence)) m.confidence = 'probable';
      if (!m.element || typeof m.element !== 'object' || !['opening', 'wall'].includes(m.element.kind) || typeof m.element.id !== 'string') m.element = null;
      if (!['unassigned', 'assigned', 'applied'].includes(m.status)) m.status = m.element ? 'assigned' : 'unassigned';
      if (typeof m.frameAssetId !== 'string') m.frameAssetId = null;
      if (!m.crop || !Array.isArray(m.crop) || m.crop.length !== 4 || !m.crop.every(Number.isFinite)) m.crop = null;
      if (!m.createdAt) m.createdAt = new Date(0).toISOString();
    }
    // Numbered photo positions (positions.js) and Polycam camera sets (polycam-cameras.js).
    normalizePositions(p);
    p.cameraSets = normalizeCameraSets(p.cameraSets);
    // Drawing sets for DOCUMENTS (doc-sets.js): sheets of live plan, section, 3D and schedule views.
    normalizeDocSets(p);
    // Tags (tags.js): the list, the plan's default tags and each object's assignment.
    normalizeTags(p);
    // Saved views (saved-views.js): MODEL's tabs, each a camera with its tags.
    normalizeSavedViews(p);
    // The one-pager (one-pager.js): the client teaser's text, picture choice and saved versions.
    normalizeOnePager(p);
    // Notes pinned to a point in the model (MODEL, right-click). `notes` on the property is
    // its own free text; these are separate.
    const num = v => typeof v === 'number' || (typeof v === 'string' && v.trim()) ? Number(v) : NaN;
    p.notePins = (p.notePins || []).filter(n => ['x', 'y', 'z'].every(k => Number.isFinite(num(n[k]))));
    for (const n of p.notePins) {
      for (const k of ['x', 'y', 'z']) n[k] = num(n[k]);
      for (const k of ['nx', 'ny', 'nz']) n[k] = Number.isFinite(num(n[k])) ? num(n[k]) : (k === 'ny' ? 1 : 0);
      if (typeof n.text !== 'string') n.text = '';
      if (typeof n.roomId !== 'string') n.roomId = '';
      if (!Array.isArray(n.elementIds)) n.elementIds = [];
      if (!n.createdAt) n.createdAt = new Date(0).toISOString();
      if (n.wall !== undefined) { const w = normalizeWallAnchor(n.wall); if (w) n.wall = w; else delete n.wall; }
    }
  }
  for (const pr of d.projects) {
    pr.items = pr.items || [];
    // Subprojects (see subprojectsOf): '' means none for each of these.
    if (typeof pr.parentId !== 'string') pr.parentId = '';
    if (!PRIORITIES.includes(pr.priority)) pr.priority = '';
    if (typeof pr.roomId !== 'string') pr.roomId = '';
    if (typeof pr.source !== 'string') pr.source = '';
    // Scope items track their own progress; an older file's items start as 'todo'.
    for (const it of pr.items) {
      if (!ITEM_STATUSES.includes(it.status)) it.status = 'todo';
      if (typeof it.doneAt !== 'string') it.doneAt = '';
    }
  }
  sanitiseIds(d);
  fixParents(d);
  d.version = SCHEMA_VERSION;
  return d;
}

// A subproject's parent must be a top-level project on the same property. A link to a missing
// project, to itself, across properties or to another subproject makes it a top-level project,
// so nesting is never deeper than one level and never loops.
function fixParents(d) {
  const byId = new Map(d.projects.map(pr => [pr.id, pr]));
  for (const pr of d.projects) {
    const parent = pr.parentId ? byId.get(pr.parentId) : null;
    if (!parent || parent === pr || parent.parentId || parent.propertyId !== pr.propertyId) pr.parentId = '';
  }
}

export function emptyWorkspace() {
  return migrate({
    version: SCHEMA_VERSION,
    settings: { units: 'imperial', budgetCap: 150000, programStart: isoToday(), activePropertyId: null },
    properties: [],
    materials: [],
    products: [],
    projects: [],
  });
}

// ---------- ids / lookups ----------

export function uid(prefix) {
  return (prefix || 'id') + '-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

export function activeProperty() {
  const d = ws.data;
  let p = d.properties.find(p => p.id === d.settings.activePropertyId);
  if (!p && d.properties.length) { p = d.properties[0]; d.settings.activePropertyId = p.id; }
  return p || null;
}

export function materialById(id) {
  return ws.data.materials.find(m => m.id === id) || null;
}

export function projectById(id) { return ws.data.projects.find(p => p.id === id) || null; }

// The projects of the active property, in list order: what PROJECTS, BUDGET, SCHEDULE and the
// scope pickers show. A project whose property is gone (or that never had one) counts as the
// active property's, so nothing drops out of sight.
export function propertyProjects() {
  const d = ws.data, p = activeProperty();
  const known = new Set(d.properties.map(x => x.id));
  return d.projects.filter(pr => (p && pr.propertyId === p.id) || !known.has(pr.propertyId));
}

// Subprojects: small pieces of work inside a project (a punch list, a room's fixes). Each is an
// ordinary project with its own status, scope and budget, plus a parentId naming a top-level
// project on the same property, a priority, an optional room and where it came from (source).
export const PRIORITIES = ['high', 'medium', 'low'];
// A scope item's own progress, separate from its project's status: a punch list closes item by item.
export const ITEM_STATUSES = ['todo', 'ordered', 'in-progress', 'done'];
export function subprojectsOf(pr) { return pr ? ws.data.projects.filter(x => x.parentId === pr.id) : []; }
// "Parent / Child" for a subproject, the plain name otherwise.
export function projectLabel(pr) {
  const parent = pr.parentId ? projectById(pr.parentId) : null;
  return parent ? parent.name + ' / ' + pr.name : pr.name;
}

export function allScopeItems() {
  // [{project, item}] across the active property's projects, in project order.
  const out = [];
  for (const pr of propertyProjects()) for (const it of pr.items) out.push({ project: pr, item: it });
  return out;
}

export function itemById(itemId) {
  for (const pr of ws.data.projects) {
    const it = pr.items.find(i => i.id === itemId);
    if (it) return { project: pr, item: it };
  }
  return null;
}

export function elementInfo(propertyId, elementId) {
  // Resolve a linked model element (wall or room) to display data.
  const p = ws.data.properties.find(x => x.id === propertyId) || activeProperty();
  if (!p) return null;
  const w = p.walls.find(w => w.id === elementId);
  if (w) {
    const len = Math.hypot(w.bx - w.ax, w.by - w.ay);
    const h = wallHeightOf(p, w);
    return { kind: 'wall', id: w.id, label: 'Wall', length: len, height: h, area: len * h, material: w.material, level: levelOfWall(p, w).name };
  }
  const r = p.rooms.find(r => r.id === elementId);
  if (r) return { kind: 'room', id: r.id, label: r.name || 'Room', area: polyArea(r.pts), material: r.material, level: levelOfRoom(p, r).name, unscanned: !countsAsFloor(r) };
  return null;
}

// An unscanned area (a common stair the scan never entered, closed off by the envelope) is
// drawn for the record but nobody measured its floor: it never counts toward floor area.
export const countsAsFloor = r => !r || r.kind !== 'unscanned';
export function roomsFloorArea(rooms) {
  return (rooms || []).reduce((n, r) => n + (countsAsFloor(r) ? polyArea(r.pts) : 0), 0);
}

export function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

// ---------- units ----------

export function units() { return ws.data.settings.units; }

// Lengths are shown as a tape reads them: feet, inches and sixteenths (2'-9 1/2"), or metres
// to the millimetre (0.851 m). Stored values are metres and never rounded here.
const M_PER_IN = M_PER_FT / 12;
function sixteenthsText(n, afterFeet) {
  const whole = Math.floor(n / 16);
  let num = n % 16, den = 16;
  while (num && num % 2 === 0) { num /= 2; den /= 2; }
  if (!num) return String(whole);
  return (whole || afterFeet ? whole + ' ' : '') + num + '/' + den;
}
export function fmtLen(m, opts) {
  if (m == null || isNaN(m)) return '-';
  if (units() === 'metric') return (Math.round(m * 1000) / 1000 || 0) + ' m';
  // Below the datum (a basement floor) the sign covers feet and inches alike: -7'-7", not -8'-5".
  let sixteenths = Math.round(Math.abs(m) / M_PER_IN * 16);
  const ft = Math.floor(sixteenths / 192);
  sixteenths -= ft * 192;
  const sign = m < 0 && (ft || sixteenths) ? '-' : '';
  const inch = sixteenthsText(sixteenths, ft > 0);
  if (ft === 0) return sign + inch + '"';
  if (opts && opts.short && sixteenths === 0) return sign + ft + "'";
  return sign + ft + "'-" + inch + '"';
}

export function fmtArea(m2) {
  if (m2 == null || isNaN(m2)) return '-';
  if (units() === 'metric') return (Math.round(m2 * 10) / 10) + ' m2';
  return Math.round(m2 / M2_PER_SF).toLocaleString() + ' sf';
}

// Tape readings carry fractions: 33 1/2", 33-1/2", 2'-9 1/2", 9½", 1/4".
const UNICODE_FRACTIONS = { '¼': ' 1/4', '½': ' 1/2', '¾': ' 3/4', '⅛': ' 1/8', '⅜': ' 3/8', '⅝': ' 5/8', '⅞': ' 7/8', '⅓': ' 1/3', '⅔': ' 2/3', '⅙': ' 1/6', '⅚': ' 5/6', '⅕': ' 1/5' };
const NUM = String.raw`(?:\d+(?:\.\d+)?|\.\d+)`;
const AMOUNT = String.raw`(?:\d+(?:\s+|\s*-\s*)\d+\s*/\s*\d+|\d+\s*/\s*\d+|${NUM})`;
const FEET_INCHES = new RegExp(String.raw`^(?:(${AMOUNT})\s*')?\s*(?:-\s*)?(?:(${AMOUNT})\s*("?))?$`);
function amount(s) {
  s = s.trim();
  if (new RegExp('^' + NUM + '$').test(s)) return parseFloat(s);
  const m = s.match(/^(?:(\d+)(?:\s+|\s*-\s*))?(\d+)\s*\/\s*(\d+)$/);
  return m && +m[3] ? (m[1] ? +m[1] : 0) + m[2] / m[3] : NaN;
}

// A number typed on its own (no mark or unit) is metres in metric. In feet and inches each
// field says what it means, and keeps what that field has always meant: 'feet' for PLAN,
// MODEL, DOCUMENTS, fixture and material fields, 'inches' for MEASURE's tape readings.
const BARE_UNITS = ['inches', 'feet'];
function bareUnit(bare) {
  if (!BARE_UNITS.includes(bare)) throw new Error('A length field must say whether a bare number is inches or feet, not ' + JSON.stringify(bare));
  return bare;
}
export function bareLengthUnit(bare = 'inches') { return units() === 'metric' ? 'metres' : bareUnit(bare); }

// Reads a typed length. Returns { value } in metres, or { value: NaN, error } saying why it
// cannot be read: nothing is guessed from part of the entry ("10x12", "2,5 m", "6 ft tall").
// Accepts 12'-6", 12' 6", 12'6, 12.5', 6 ft 2 in, 6ft2in, 6 feet 2 inches, 30", 30 in,
// 33 1/2", 33-1/2", 2'-9 1/2", 9½", 1/4", 3.8 m, 85 cm, 850 mm, a minus sign in front
// (below the datum), and a bare number in the unit bareLengthUnit(bare) names.
export function readLength(text, bare = 'inches') {
  bareUnit(bare);
  // Same arithmetic as a typed bare number, so a number argument stores the same metres.
  const bareMetres = n => units() === 'metric' ? n : bare === 'feet' ? n * M_PER_FT : n / 12 * M_PER_FT;
  if (typeof text === 'number') return Number.isFinite(text) ? { value: bareMetres(text) } : { value: NaN, error: 'Type a length.' };
  const raw = String(text ?? '');
  const refuse = why => ({ value: NaN, error: why });
  const example = units() === 'metric' ? '3.2 m, 850 mm or 85 cm' : '12\'-6", 33 1/2", 6 ft 2 in or 3.2 m';
  const cannot = () => refuse('"' + raw.trim() + '" is not a length. Type it like ' + example + '; a number on its own is ' + bareLengthUnit(bare) + '.');
  let s = raw.trim().toLowerCase()
    .replace(/[¼½¾⅛⅜⅝⅞⅓⅔⅙⅚⅕]/g, c => UNICODE_FRACTIONS[c])
    .replace(/[″”“]/g, '"').replace(/[′’‘]/g, "'").replace(/''/g, '"').trim();
  if (!s) return refuse('Type a length.');
  if (/\d,\d/.test(s)) return refuse('"' + raw.trim() + '" has a comma in it. Use a point for decimals (2.5 m) and no thousands separator.');
  let sign = 1;
  if (s.startsWith('-')) { sign = -1; s = s.slice(1).trim(); }
  if (!s || /^-/.test(s)) return cannot();
  const metric = s.match(new RegExp('^(' + NUM + ')\\s*(m|cm|mm|metres?|meters?|centimetres?|centimeters?|millimetres?|millimeters?)\\.?$'));
  if (metric) {
    const u = metric[2], div = u.startsWith('mm') || u.startsWith('milli') ? 1000 : u.startsWith('c') ? 100 : 1;
    return { value: sign * parseFloat(metric[1]) / div };
  }
  // Words for feet and inches become the marks: 6 ft 2 in -> 6' 2".
  s = s.replace(/\s*(?<![a-z])(?:feet|foot|ft)(?![a-z])\.?/g, "'").replace(/\s*(?<![a-z])(?:inches|inch|in)(?![a-z])\.?/g, '"').trim();
  const m = s.match(FEET_INCHES);
  if (!m || (!m[1] && !m[2])) return cannot();
  const ft = m[1] ? amount(m[1]) : 0, inch = m[2] ? amount(m[2]) : 0;
  if (!Number.isFinite(ft) || !Number.isFinite(inch)) return cannot();
  // A number on its own (no mark at all), in the unit this field reads it in.
  if (!m[1] && !m[3]) return { value: sign * bareMetres(inch) };
  return { value: sign * (ft + inch / 12) * M_PER_FT };
}

// The value of readLength, NaN when the entry cannot be read. Its bare number is feet, as it
// always was for parseLen's callers; pass 'inches' for a field that reads tape inches.
export function parseLen(str, bare = 'feet') { return readLength(str, bare).value; }

export function fmtMoney(n) {
  if (n == null || isNaN(n)) return '-';
  if (Math.abs(n) < 1000 && Math.round(n) !== n) {
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return '$' + Math.round(n).toLocaleString('en-US');
}

// Reads a typed amount of money. Returns { value } in dollars (blank is 0), or
// { value: NaN, error } when the entry cannot be read. Accepts 250000, 250,000, 250 000,
// $250,000.50, 1200$, +500, 5., 250k, $1.2m, 1.2 million and one minus sign; refuses
// "10x12", "2,5", "1500 2000", "--5" and "about 300" rather than reading part of them.
const MONEY = /^([+-])?\s*(\$)?\s*([+-])?\s*(\d{1,3}(?:,\d{3})+(?:\.\d*)?|\d{1,3}(?: \d{3})+(?:\.\d*)?|\d+(?:\.\d*)?|\.\d+)\s*(k|thousand|mm|m|million)?\s*(\$)?$/;
export function readMoney(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { value: 0 };
  const m = raw.toLowerCase().replace(/\s+/g, ' ').match(MONEY);
  // One sign at most, and one dollar sign, before or after the amount.
  if (!m || (m[1] && m[3]) || (m[2] && m[6])) return { value: NaN, error: '"' + raw + '" is not an amount. Type it like 250000, $250,000, 250k or 1.2m.' };
  const mult = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6 };
  const sign = (m[1] || m[3]) === '-' ? -1 : 1;
  return { value: sign * parseFloat(m[4].replace(/[, ]/g, '')) * (m[5] ? mult[m[5]] : 1) };
}

// The value of readMoney, and 0 when the entry cannot be read (fields that do not show
// readMoney's message keep this older contract).
export function parseMoney(str) {
  const v = readMoney(str).value;
  return Number.isNaN(v) ? 0 : v;
}

export function fmtBytes(n) {
  if (n == null || isNaN(n)) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

export function isoToday() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function fmtDate(iso) {
  if (!iso) return '-';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}

export function dayDiff(isoA, isoB) {
  const [y1, m1, d1] = isoA.split('-').map(Number);
  const [y2, m2, d2] = isoB.split('-').map(Number);
  return Math.round((new Date(y2, m2 - 1, d2) - new Date(y1, m1 - 1, d1)) / 86400000);
}

// ---------- project money rollups ----------

export function itemTotals(it) {
  const q = it.qty ?? 1;
  return { low: (it.low || 0) * q, likely: (it.likely || 0) * q, high: (it.high || 0) * q };
}

export function projectTotals(pr) {
  const t = { low: 0, likely: 0, high: 0 };
  for (const it of pr.items) {
    const x = itemTotals(it);
    t.low += x.low; t.likely += x.likely; t.high += x.high;
  }
  return t;
}

// How far a project's scope has got: items with any price, and items marked done. A $0
// total means nothing when no item is priced, so the views say "no prices" instead.
export function itemPriced(it) { return [it.low, it.likely, it.high].some(v => Number(v) > 0); }
export function projectProgress(pr) {
  const items = pr.items || [];
  return { items: items.length, priced: items.filter(itemPriced).length, done: items.filter(it => it.status === 'done').length };
}

export function selectedTotals() {
  const t = { low: 0, likely: 0, high: 0 };
  for (const pr of propertyProjects()) {
    if (!pr.selected) continue;
    const x = projectTotals(pr);
    t.low += x.low; t.likely += x.likely; t.high += x.high;
  }
  return t;
}

// ---------- IndexedDB for large binaries (lidar scans, photos) ----------

let dbPromise = null;
let fileBackend = null;
// Server-backed originals remain lazy: opening a project on a phone need not copy
// its entire scan/photo library into that browser before rendering the first view.
export function setFileBackend(backend) { fileBackend = backend; }
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('tiksi-files', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('files', { keyPath: 'id' });
      req.onsuccess = () => {
        const database = req.result;
        // Migration deletes this legacy store after saving its complete recovery
        // copy. Retained tabs/documents must not hold that deletion open.
        database.onversionchange = () => { database.close(); dbPromise = null; };
        resolve(database);
      };
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

// Settle a write transaction on every path with a real Error. A request failure (quota,
// constraint) reaches tx.onerror before tx.error is set, and Chromium reports a quota overrun
// with an abort event only; callers show e.message, so null must never escape here.
function settleWrite(tx, resolve, reject, what) {
  tx.oncomplete = () => resolve();
  tx.onerror = e => reject(ioError((e.target && e.target.error) || tx.error, 'IndexedDB ' + what + ' failed'));
  tx.onabort = () => reject(ioError(tx.error, 'IndexedDB ' + what + ' aborted'));
}

// Chromium's QuotaExceededError (and some other DOMExceptions) come with an empty message,
// which would leave a toast reading "Import failed: ". Give those a message worth showing.
function ioError(err, fallback) {
  if (err && err.message) return err;
  const name = err && err.name;
  const msg = name === 'QuotaExceededError'
    ? 'browser storage is full; delete scans or photos (or clear leftovers with EXPORT > CLEAN STORAGE) and try again'
    : fallback + (name ? ' (' + name + ')' : '');
  return Object.assign(new Error(msg), { name: name || 'Error', cause: err });
}

export async function putFile(id, buffer, meta) {
  // Callers retain ownership of their input, just as with IndexedDB writes.
  const owned = diskPersistence && buffer ? buffer.slice(0) : buffer;
  await cacheFile(id, owned, { ...(meta || {}), id, buffer: owned });
  if (buffer && fileBackend) fileBackend.changed(id);
}

export async function cacheFile(id, buffer, meta) {
  if (diskPersistence) { memoryFiles.set(id, Object.assign({ id, buffer }, meta || {})); return; }
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('files', 'readwrite');
    tx.objectStore('files').put(Object.assign({ id, buffer }, meta || {}));
    settleWrite(tx, resolve, reject, 'write');
  });
}

export async function getFile(id) {
  const local = await getCachedFile(id);
  if (!fileBackend) return local;
  const file = await fileBackend.read(id, local);
  // IndexedDB used to return an owned copy. Preserve that contract: renderers
  // may mutate bytes or transfer them to a worker, detaching the supplied buffer.
  // A file the backend did not keep (`owned`: too large to hold in page memory) is the
  // caller's already: it is handed over as it is, not copied a second time.
  if (file?.owned) { const { owned, ...mine } = file; return mine; }
  return file?.buffer ? { ...file, buffer: file.buffer.slice(0) } : file;
}

export async function getCachedFile(id) {
  if (diskPersistence) {
    if (memoryFiles.has(id)) return memoryFiles.get(id);
    if (!legacyFiles) return null;
  }
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction('files').objectStore('files').get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error('IndexedDB read failed'));
  });
}

export async function deleteFiles(ids) {
  if (diskPersistence) { for (const id of ids) memoryFiles.delete(id); return; }
  if (!ids.length) return;
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('files', 'readwrite');
    const store = tx.objectStore('files');
    for (const id of ids) store.delete(id);
    settleWrite(tx, resolve, reject, 'delete');
  });
}

export function deleteFile(id) { return deleteFiles([id]); }

// Every key in the store: scans, photos and thumbnails, referenced or not.
export async function storedFileIds() {
  if (diskPersistence) return [...memoryFiles.keys()];
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction('files').objectStore('files').getAllKeys();
    req.onsuccess = () => resolve((req.result || []).map(String));
    req.onerror = () => reject(req.error || new Error('IndexedDB read failed'));
  });
}

// photo id -> thumbnail data URL for every stored thumbnail. Keys share a prefix, so one
// ranged getAll fetches them without touching the (large) scan and photo records.
async function getAllThumbs() {
  if (diskPersistence) return new Map([...memoryFiles.values()].filter(r => r.kind === 'thumb').map(r => [String(r.id).slice(THUMB_PREFIX.length), r.thumb]));
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction('files').objectStore('files').getAll(IDBKeyRange.bound(THUMB_PREFIX, THUMB_PREFIX + '\uffff'));
    req.onsuccess = () => {
      const out = new Map();
      for (const r of req.result || []) if (r && typeof r.thumb === 'string') out.set(String(r.id).slice(THUMB_PREFIX.length), r.thumb);
      resolve(out);
    };
    req.onerror = () => reject(req.error || new Error('IndexedDB read failed'));
  });
}

// level id -> underlay image data URL for every stored underlay.
async function getAllPlans() {
  if (diskPersistence) return new Map([...memoryFiles.values()].filter(r => r.kind === 'plan').map(r => [r.id, r.img]));
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction('files').objectStore('files').getAll(IDBKeyRange.bound(PLAN_PREFIX, PLAN_PREFIX + '\uffff'));
    req.onsuccess = () => {
      const out = new Map();
      for (const r of req.result || []) if (r && typeof r.img === 'string') out.set(String(r.id), r.img);
      resolve(out);
    };
    req.onerror = () => reject(req.error || new Error('IndexedDB read failed'));
  });
}

// Ids of the files a workspace references (every scan and photo, all properties). Bytes may
// or may not be present in IndexedDB: a JSON-only export imported elsewhere has records but no bytes.
export function listAllFileIds(data) {
  const d = data || ws.data;
  const ids = [];
  for (const p of d.properties || []) {
    for (const s of p.scans || []) { ids.push(s.id); if (s.originalFileId && s.originalFileId !== s.id) ids.push(s.originalFileId); }
    for (const ph of p.photos || []) ids.push(ph.id);
    for (const v of p.videos || []) ids.push(v.id);
    for (const m of p.measurements || []) if (m.frameAssetId) ids.push(m.frameAssetId);
  }
  return ids;
}

// Stored files nothing in the current workspace references. IMPORT and DEMO swap the
// workspace but keep the bytes, so a JSON-only export of the previous one still finds them
// on this machine; these are what CLEAN STORAGE offers to remove. Returns { ids, bytes };
// `bytes` is only computed with opts.sizes, since it reads every orphan record.
export async function orphanFiles(opts) {
  const keep = new Set();
  for (const id of listAllFileIds()) { keep.add(id); keep.add(thumbKey(id)); }
  for (const p of ws.data.properties || []) for (const l of p.levels || []) keep.add(planKey(l.id, p.id));
  const ids = (await storedFileIds()).filter(id => !keep.has(id) && !id.startsWith(HANDLE_PREFIX));
  let bytes = 0;
  if (opts && opts.sizes) {
    for (const id of ids) {
      const rec = await getFile(id);
      if (rec && rec.buffer) bytes += rec.buffer.byteLength;
      else if (rec && typeof rec.thumb === 'string') bytes += rec.thumb.length;
    }
  }
  return { ids, bytes };
}

export function readFileAsArrayBuffer(file) {
  if (file.arrayBuffer) return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsArrayBuffer(file);
  });
}

// ---------- export / import ----------

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  // Give the click a tick to start the download before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function exportWorkspace() {
  downloadBlob(new Blob([JSON.stringify(ws.data, null, 1)], { type: 'application/json' }), 'tiksi-workspace-' + isoToday() + '.json');
  const n = listAllFileIds().length;
  if (n) alert('Note: ' + n + ' scan/photo file(s) live in browser storage and are not embedded in a JSON export. Use EXPORT > BUNDLE (.zip) to carry them to another machine.');
}

const IMAGE_EXT_BY_MIME = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/heic': 'heic', 'image/heif': 'heif', 'image/tiff': 'tiff' };
const MIME_BY_EXT = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff' };
// Formats that are already compressed: store them in the zip instead of deflating.
const STORED_EXT = new Set(['pdf', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'glb', 'spz', 'laz', 'ksplat', 'mp4', 'mov', 'm4v']);
const VIDEO_EXT_BY_MIME = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/x-m4v': 'm4v' };
const VIDEO_MIME_BY_EXT = { mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v' };

function fflate() { return import('three/addons/libs/fflate.module.js'); }

// Collect every file record the given properties reference and that has bytes in IndexedDB.
// Returns [{ id, kind: 'scan'|'photo', name, format?, mime?, ext, buffer }].
async function collectBundleFiles(properties) {
  const out = [];
  for (const p of properties || ws.data.properties) {
    for (const s of p.scans || []) {
      if (s.originalFileId && s.originalFileId !== s.id) {
        const source = await getFile(s.originalFileId);
        if (!source?.buffer) throw new Error('Original model source is missing: ' + (s.originalName || s.name));
        const ext = source.format || 'bin';
        out.push({ id: s.originalFileId, kind: 'source', name: s.originalName || source.name, format: ext, ext, buffer: source.buffer });
      }
      const rec = await getFile(s.id);
      if (!rec || !rec.buffer) continue;
      const ext = String(s.format || rec.format || 'bin').toLowerCase();
      out.push({ id: s.id, kind: 'scan', name: s.name || rec.name || s.id, format: ext, ext, buffer: rec.buffer });
    }
    for (const ph of p.photos || []) {
      const rec = await getFile(ph.id);
      if (!rec || !rec.buffer) continue;
      const mime = ph.mime || rec.mime || 'image/jpeg';
      out.push({ id: ph.id, kind: 'photo', name: ph.name || rec.name || ph.id, mime, ext: IMAGE_EXT_BY_MIME[mime] || 'jpg', buffer: rec.buffer });
    }
    // Walk-through videos and the frames saved with tape readings (MEASURE) are originals too.
    for (const v of p.videos || []) {
      const rec = await getFile(v.id);
      if (!rec || !rec.buffer) continue;
      const mime = v.mime || rec.mime || 'video/mp4';
      out.push({ id: v.id, kind: 'video', name: v.name || rec.name || v.id, mime, ext: VIDEO_EXT_BY_MIME[mime] || 'mp4', buffer: rec.buffer });
    }
    for (const m of p.measurements || []) {
      const rec = m.frameAssetId && await getFile(m.frameAssetId);
      if (!rec || !rec.buffer) continue;
      out.push({ id: m.frameAssetId, kind: 'frame', name: rec.name || m.frameAssetId, mime: 'image/jpeg', ext: 'jpg', buffer: rec.buffer });
    }
  }
  return out;
}

// Bundle = ZIP with workspace.json (a workspace, or the slice that is one property),
// manifest.json (id -> path/name/type) and files/<id>.<ext> for every scan and photo that
// has bytes. `format` is 'tiksi-bundle' for a whole workspace, 'tiksi-project' for one property.
async function buildZip(data, format, extra) {
  const { zip, zipSync, strToU8 } = await fflate();
  const files = await collectBundleFiles(data.properties);
  const manifest = Object.assign({
    format, version: 1, app: 'tiksi', exportedAt: new Date().toISOString(),
    files: files.map(f => ({ id: f.id, kind: f.kind, path: 'files/' + f.id + '.' + f.ext, name: f.name, format: f.format, mime: f.mime, size: f.buffer.byteLength })),
  }, extra || {});
  const entries = {
    'workspace.json': [strToU8(JSON.stringify(data, null, 1)), { level: 6 }],
    'manifest.json': [strToU8(JSON.stringify(manifest, null, 1)), { level: 6 }],
  };
  for (const f of files) entries['files/' + f.id + '.' + f.ext] = [new Uint8Array(f.buffer), { level: STORED_EXT.has(f.ext) ? 0 : 4 }];
  let bytes;
  try {
    // Async variant deflates in workers so a multi-hundred-MB scan does not freeze the UI.
    bytes = await new Promise((resolve, reject) => zip(entries, { level: 4 }, (err, out) => err ? reject(err) : resolve(out)));
  } catch (e) {
    bytes = zipSync(entries, { level: 4 });
  }
  return { bytes, fileCount: files.length };
}

export async function exportBundle() {
  const { bytes, fileCount } = await buildZip(ws.data, 'tiksi-bundle');
  downloadBlob(new Blob([bytes], { type: 'application/zip' }), 'tiksi-bundle-' + isoToday() + '.zip');
  return { fileCount, bytes: bytes.byteLength };
}

// A file name for a property: its name, made safe for every file system.
export function projectFileName(prop) {
  const base = String(prop.name || 'property').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'property';
  return base + '.tiksi';
}

// One property as a project file (.tiksi, a ZIP): its slice of the workspace plus every scan
// and photo it references. Resolves { blob, name, fileCount, bytes }.
export async function exportProjectBlob(propId) {
  const current = projectSlice(propId);
  const slice = current && JSON.parse(JSON.stringify(current));
  if (!slice) throw new Error('no such property');
  const prop = slice.properties[0];
  const { bytes, fileCount } = await buildZip(slice, 'tiksi-project', { project: { id: prop.id, name: prop.name } });
  return { blob: new Blob([bytes], { type: 'application/zip' }), name: projectFileName(prop), fileCount, bytes: bytes.byteLength };
}

// Open a project file (or a whole-workspace bundle) into the current workspace: files land in
// IndexedDB first, then the records merge. Resolves the ids of the properties that landed.
export async function importProject(file) {
  const { data, files } = await readBundle(file);
  for (const f of files) await putFile(f.id, f.buffer, f.meta);
  return mergeWorkspace(data, { fromFile: true });
}

function u8Buffer(u8) {
  // fflate hands back fresh Uint8Arrays; only copy when the view does not span its buffer.
  return (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) ? u8.buffer : u8.slice().buffer;
}

// Parse and validate a bundle without touching state. Returns { data, files, manifest, missing }.
export async function readBundle(file) {
  const { unzipSync, strFromU8 } = await fflate();
  const buf = new Uint8Array(await readFileAsArrayBuffer(file));
  let zipped;
  try { zipped = unzipSync(buf); } catch (e) { throw new Error('not a valid ZIP file'); }
  if (!zipped['workspace.json']) throw new Error('bundle has no workspace.json');
  let data;
  try { data = JSON.parse(strFromU8(zipped['workspace.json'])); } catch (e) { throw new Error('workspace.json is not valid JSON'); }
  if (!data || !Array.isArray(data.properties)) throw new Error('workspace.json is not a tiksi workspace');
  validateWorkspace(data);

  let manifest = null;
  if (zipped['manifest.json']) {
    try { manifest = JSON.parse(strFromU8(zipped['manifest.json'])); } catch (e) { manifest = null; }
    if (manifest && !Array.isArray(manifest.files)) manifest = null;
  }
  // Project files saved by the Mac keep pictures as files (picture-assets.js); the opened
  // records get them back inline, byte for byte, so they work without the Mac too.
  const pictureEntries = new Map((manifest ? manifest.files : []).filter(m => m && typeof m.id === 'string' && m.id.startsWith('pic-') && typeof m.path === 'string').map(m => [m.id, m.path]));
  const missingPictures = await inlineBundlePictures(data, id => pictureEntries.has(id) && zipped[pictureEntries.get(id)] || null);
  // Without a manifest, fall back to naming: files/<id>.<ext>, image extensions are photos.
  const list = manifest ? manifest.files : Object.keys(zipped).filter(k => k.startsWith('files/') && !k.endsWith('/')).map(path => {
    const base = path.slice(6);
    const dot = base.lastIndexOf('.');
    const id = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : 'bin';
    const mime = MIME_BY_EXT[ext];
    if (VIDEO_MIME_BY_EXT[ext]) return { id, kind: 'video', path, name: base, mime: VIDEO_MIME_BY_EXT[ext] };
    return mime ? { id, kind: 'photo', path, name: base, mime } : { id, kind: 'scan', path, name: base, format: ext };
  });
  // Only files the workspace actually references get stored: anything else in the archive
  // would be an orphan from the moment it lands (and an odd id would never be a valid key).
  const referenced = new Set(listAllFileIds(data).filter(id => typeof id === 'string' && ID_RE.test(id)));
  const files = [], missing = [];
  for (const m of list) {
    if (!m || typeof m.id !== 'string' || typeof m.path !== 'string' || !referenced.has(m.id)) continue;
    const u8 = zipped[m.path];
    if (!u8) { missing.push(m.id); continue; }
    const ext = m.path.split('.').pop().toLowerCase();
    const meta = m.kind === 'photo' || m.kind === 'frame'
      ? { name: m.name || m.id, mime: m.mime || MIME_BY_EXT[ext] || 'image/jpeg', kind: m.kind }
      : m.kind === 'video' ? { name: m.name || m.id, mime: m.mime || VIDEO_MIME_BY_EXT[ext] || 'video/mp4', kind: 'video' }
      : { name: m.name || m.id, format: m.format || ext };
    files.push({ id: m.id, buffer: u8Buffer(u8), meta });
  }
  missing.push(...missingPictures);
  return { data, files, manifest, missing };
}

// Restore a bundle: writes files to IndexedDB first (so a quota failure leaves the current
// workspace intact), then replaces the workspace. Resolves true when replaced, false if cancelled.
export async function importBundle(file, opts) {
  opts = opts || {};
  const { data, files, missing } = await readBundle(file);
  const props = data.properties.length;
  const size = files.reduce((n, f) => n + f.buffer.byteLength, 0);
  if (opts.confirm !== false) {
    const msg = 'Replace the current workspace with "' + file.name + '"?\n' +
      props + ' propert' + (props === 1 ? 'y' : 'ies') + ', ' + files.length + ' file' + (files.length === 1 ? '' : 's') + ' (' + fmtBytes(size) + ').' +
      (missing.length ? '\n' + missing.length + ' file(s) listed in the manifest are missing from the archive.' : '') +
      '\nExport first if you want a backup.';
    if (!confirm(msg)) return false;
  }
  for (const f of files) await putFile(f.id, f.buffer, f.meta);
  replaceWorkspace(data);
  return true;
}

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
