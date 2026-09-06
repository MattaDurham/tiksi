// tiksi store: workspace state, persistence, units, shared helpers.
// All lengths are stored in meters, money in USD, dates as ISO strings.

const LS_KEY = 'tiksi.workspace.v1';   // storage slot, not the schema version (see migrate)
const SCHEMA_VERSION = 2;
const M_PER_FT = 0.3048;
const M2_PER_SF = 0.09290304;

export const ws = { data: null };

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

let saveTimer = null;
export function touch() {
  // Notify + debounced autosave.
  for (const fn of listeners) { try { fn(); } catch (e) { console.error(e); } }
  setSaveStatus('SAVING', true);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 450);
}

export function setSaveStatus(text, busy) {
  const el = document.getElementById('save-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('busy', !!busy);
}

let saveFailed = false;
let savePending = false;
export function save() {
  // Never write a copy with inline thumbnails while hydrateThumbs() is still moving them into
  // IndexedDB: a freshly imported gallery would not fit and would raise the quota alert for nothing.
  if (hydration) {
    if (!savePending) { savePending = true; hydration.then(() => { savePending = false; save(); }); }
    return;
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
  return Object.assign({}, d, {
    properties: (d.properties || []).map(p => {
      const photos = p.photos || [];
      if (!photos.some(strip)) return p;
      return Object.assign({}, p, { photos: photos.map(ph => strip(ph) ? Object.assign({}, ph, { thumb: '' }) : ph) });
    }),
  });
}

export function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) { ws.data = migrate(JSON.parse(raw)); thumbsStored.clear(); hydrateThumbs(); return true; }
  } catch (e) { console.error('load failed', e); }
  ws.data = emptyWorkspace();
  return false;
}

export function replaceWorkspace(data) {
  ws.data = migrate(data);
  // Thumbnails arrive inline (JSON/bundle); hydrateThumbs() copies them into IndexedDB and
  // save() waits for it, so the first localStorage copy is already the slim one.
  thumbsStored.clear();
  hydrateThumbs();
  touch();
}

// ---------- photo thumbnails (IndexedDB copy) ----------

const THUMB_PREFIX = 'thumb-';
const thumbsStored = new Set();   // photo ids whose thumbnail is confirmed in IndexedDB
let hydration = null;             // pending hydrateThumbs() run, if any

export function thumbKey(id) { return THUMB_PREFIX + id; }

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

// Reconcile in-memory photo records with the thumbnail store: records loaded from the slim
// localStorage copy get their thumbnail back, records that still carry one inline (older
// saves, imports) get it copied over so the next save can drop it. Bails out quietly when
// IndexedDB is unavailable: thumbnails then simply stay inline as they always did.
function hydrateThumbs() {
  const d = ws.data;
  const run = (async () => {
    const photos = [];
    for (const p of d.properties || []) for (const ph of p.photos || []) photos.push(ph);
    if (!photos.length) return;
    let stored;
    try { stored = await getAllThumbs(); } catch (e) { console.error('thumbnail store unavailable', e); return; }
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
  })();
  const p = run.catch(e => console.error('thumbnail hydration failed', e)).then(() => { if (hydration === p) hydration = null; });
  hydration = p;
  return p;
}

// ---------- schema defaults (v2) ----------

// Environment / rendering settings per property. `time` is local solar hours (sunrise 6,
// noon 12, sunset 20); `azimuth` is the sun's compass heading the user drags; `north`
// rotates the compass rose relative to plan +x.
export function defaultEnv() {
  return {
    time: 14.5, azimuth: 200, north: 0, exposure: 1.0, quality: 'high',
    sky: 'dynamic', panoPhotoId: null,
    showCeilings: true, showGround: true, showGrid: false, nightLights: true,
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
  return {
    id: uid('prop'), name: name || 'New property', notes: '', wallHeight: 2.44,
    plan: null, walls: [], openings: [], rooms: [], scans: [], photos: [], env: defaultEnv(),
  };
}

// Ids land in element attributes and thumbnails in <img src>, and both can come from a
// hand-edited or hostile file: an id that does not look like one is regenerated (with every
// reference following it), a thumbnail that is not a plain base64 image is dropped.
const ID_RE = /^[\w.:-]{1,80}$/;
const THUMB_RE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

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
    for (const w of p.walls) fix(w, 'w');
    for (const o of p.openings) fix(o, 'o');
    for (const r of p.rooms) fix(r, 'r');
    for (const s of p.scans) fix(s, 'scan');
    for (const ph of p.photos) fix(ph, 'ph');
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

function migrate(d) {
  if (!d.version) d.version = 1;
  d.settings = Object.assign({ units: 'imperial', budgetCap: 150000, programStart: isoToday(), activePropertyId: null }, d.settings || {});
  d.properties = d.properties || [];
  d.materials = d.materials || [];   // material records are normalised by materials.js
  d.products = d.products || [];
  d.projects = d.projects || [];
  for (const p of d.properties) {
    p.wallHeight = p.wallHeight || 2.44;
    p.plan = p.plan || null;
    p.walls = p.walls || [];
    p.openings = p.openings || [];
    p.rooms = p.rooms || [];
    p.scans = p.scans || [];
    // v2: photos, environment, richer scan and room records. Merge over whatever is there
    // so partially filled objects from hand-edited or older exports keep their values.
    p.photos = p.photos || [];
    p.env = Object.assign(defaultEnv(), p.env || {});
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
      if (ph.pin === undefined) ph.pin = null;
      if (!ph.createdAt) ph.createdAt = new Date(0).toISOString();
      // '' is the slim localStorage form (thumbnail lives in IndexedDB, see persistable).
      if (typeof ph.thumb !== 'string' || (ph.thumb && !THUMB_RE.test(ph.thumb))) ph.thumb = '';
    }
  }
  for (const pr of d.projects) pr.items = pr.items || [];
  sanitiseIds(d);
  d.version = SCHEMA_VERSION;
  return d;
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

export function allScopeItems() {
  // [{project, item}] across all projects, in project order.
  const out = [];
  for (const pr of ws.data.projects) for (const it of pr.items) out.push({ project: pr, item: it });
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
    const h = w.height || p.wallHeight;
    return { kind: 'wall', id: w.id, label: 'Wall', length: len, height: h, area: len * h, material: w.material };
  }
  const r = p.rooms.find(r => r.id === elementId);
  if (r) return { kind: 'room', id: r.id, label: r.name || 'Room', area: polyArea(r.pts), material: r.material };
  return null;
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

export function fmtLen(m, opts) {
  if (m == null || isNaN(m)) return '-';
  if (units() === 'metric') return (Math.round(m * 100) / 100) + ' m';
  const totalIn = m / M_PER_FT * 12;
  let ft = Math.floor(totalIn / 12);
  let inch = Math.round(totalIn - ft * 12);
  if (inch === 12) { ft += 1; inch = 0; }
  if (ft === 0) return inch + '"';
  if (opts && opts.short && inch === 0) return ft + "'";
  return ft + "'-" + inch + '"';
}

export function fmtArea(m2) {
  if (m2 == null || isNaN(m2)) return '-';
  if (units() === 'metric') return (Math.round(m2 * 10) / 10) + ' m2';
  return Math.round(m2 / M2_PER_SF).toLocaleString() + ' sf';
}

export function parseLen(str) {
  // Accepts: 12'6", 12'-6", 12.5', 30", 3.8m, 3.8 m, plain number (ft if imperial, m if metric).
  if (typeof str === 'number') return units() === 'imperial' ? str * M_PER_FT : str;
  str = String(str).trim().toLowerCase();
  if (!str) return NaN;
  const mMatch = str.match(/^(-?\d+(?:\.\d+)?)\s*m$/);
  if (mMatch) return parseFloat(mMatch[1]);
  const ftIn = str.match(/^(-?\d+(?:\.\d+)?)\s*'\s*(?:-?\s*(\d+(?:\.\d+)?)\s*"?)?$/);
  if (ftIn) return (parseFloat(ftIn[1]) + (ftIn[2] ? parseFloat(ftIn[2]) / 12 : 0)) * M_PER_FT;
  const inOnly = str.match(/^(-?\d+(?:\.\d+)?)\s*"$/);
  if (inOnly) return parseFloat(inOnly[1]) / 12 * M_PER_FT;
  const plain = parseFloat(str);
  if (!isNaN(plain)) return units() === 'imperial' ? plain * M_PER_FT : plain;
  return NaN;
}

export function fmtMoney(n) {
  if (n == null || isNaN(n)) return '-';
  if (Math.abs(n) < 1000 && Math.round(n) !== n) {
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return '$' + Math.round(n).toLocaleString('en-US');
}

export function parseMoney(str) {
  const n = parseFloat(String(str).replace(/[$,\s]/g, ''));
  return isNaN(n) ? 0 : n;
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
  const q = it.qty || 1;
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

export function selectedTotals() {
  const t = { low: 0, likely: 0, high: 0 };
  for (const pr of ws.data.projects) {
    if (!pr.selected) continue;
    const x = projectTotals(pr);
    t.low += x.low; t.likely += x.likely; t.high += x.high;
  }
  return t;
}

// ---------- IndexedDB for large binaries (lidar scans, photos) ----------

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('tiksi-files', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('files', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
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
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('files', 'readwrite');
    tx.objectStore('files').put(Object.assign({ id, buffer }, meta || {}));
    settleWrite(tx, resolve, reject, 'write');
  });
}

export async function getFile(id) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction('files').objectStore('files').get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error('IndexedDB read failed'));
  });
}

export async function deleteFiles(ids) {
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

// Ids of the files a workspace references (every scan and photo, all properties). Bytes may
// or may not be present in IndexedDB: a JSON-only export imported elsewhere has records but no bytes.
export function listAllFileIds(data) {
  const d = data || ws.data;
  const ids = [];
  for (const p of d.properties || []) {
    for (const s of p.scans || []) ids.push(s.id);
    for (const ph of p.photos || []) ids.push(ph.id);
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
  const ids = (await storedFileIds()).filter(id => !keep.has(id));
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

const IMAGE_EXT_BY_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/bmp': 'bmp' };
const MIME_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp' };
// Formats that are already compressed: store them in the zip instead of deflating.
const STORED_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'glb', 'spz', 'laz', 'ksplat']);

function fflate() { return import('three/addons/libs/fflate.module.js'); }

// Collect every file record the workspace references and that has bytes in IndexedDB.
// Returns [{ id, kind: 'scan'|'photo', name, format?, mime?, ext, buffer }].
async function collectBundleFiles() {
  const out = [];
  for (const p of ws.data.properties) {
    for (const s of p.scans || []) {
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
  }
  return out;
}

// Bundle = ZIP with workspace.json (same content as the JSON export), manifest.json
// (id -> path/name/type) and files/<id>.<ext> for every scan and photo that has bytes.
export async function exportBundle() {
  const { zip, zipSync, strToU8 } = await fflate();
  const files = await collectBundleFiles();
  const manifest = {
    format: 'tiksi-bundle', version: 1, app: 'tiksi', exportedAt: new Date().toISOString(),
    files: files.map(f => ({ id: f.id, kind: f.kind, path: 'files/' + f.id + '.' + f.ext, name: f.name, format: f.format, mime: f.mime, size: f.buffer.byteLength })),
  };
  const entries = {
    'workspace.json': [strToU8(JSON.stringify(ws.data, null, 1)), { level: 6 }],
    'manifest.json': [strToU8(JSON.stringify(manifest, null, 1)), { level: 6 }],
  };
  for (const f of files) entries['files/' + f.id + '.' + f.ext] = [new Uint8Array(f.buffer), { level: STORED_EXT.has(f.ext) ? 0 : 4 }];

  let bytes;
  try {
    // Async variant deflates in workers so a multi-hundred-MB scan does not freeze the UI.
    bytes = await new Promise((resolve, reject) => zip(entries, { level: 4 }, (err, data) => err ? reject(err) : resolve(data)));
  } catch (e) {
    bytes = zipSync(entries, { level: 4 });
  }
  downloadBlob(new Blob([bytes], { type: 'application/zip' }), 'tiksi-bundle-' + isoToday() + '.zip');
  return { fileCount: files.length, bytes: bytes.byteLength };
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

  let manifest = null;
  if (zipped['manifest.json']) {
    try { manifest = JSON.parse(strFromU8(zipped['manifest.json'])); } catch (e) { manifest = null; }
    if (manifest && !Array.isArray(manifest.files)) manifest = null;
  }
  // Without a manifest, fall back to naming: files/<id>.<ext>, image extensions are photos.
  const list = manifest ? manifest.files : Object.keys(zipped).filter(k => k.startsWith('files/') && !k.endsWith('/')).map(path => {
    const base = path.slice(6);
    const dot = base.lastIndexOf('.');
    const id = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : 'bin';
    const mime = MIME_BY_EXT[ext];
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
    const meta = m.kind === 'photo'
      ? { name: m.name || m.id, mime: m.mime || MIME_BY_EXT[m.path.split('.').pop().toLowerCase()] || 'image/jpeg', kind: 'photo' }
      : { name: m.name || m.id, format: m.format || m.path.split('.').pop().toLowerCase() };
    files.push({ id: m.id, buffer: u8Buffer(u8), meta });
  }
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
