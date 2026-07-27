// tiksi store: workspace state, persistence, units, shared helpers.
// All lengths are stored in meters, money in USD, dates as ISO strings.

const LS_KEY = 'tiksi.workspace.v1';
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

function setSaveStatus(text, busy) {
  const el = document.getElementById('save-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('busy', !!busy);
}

export function save() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(ws.data));
    const t = new Date();
    setSaveStatus('SAVED ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'), false);
  } catch (e) {
    console.error('save failed', e);
    setSaveStatus('SAVE FAILED', true);
    alert('Autosave failed (storage quota?). Export your workspace now to avoid losing work.');
  }
}

export function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) { ws.data = migrate(JSON.parse(raw)); return true; }
  } catch (e) { console.error('load failed', e); }
  ws.data = emptyWorkspace();
  return false;
}

export function replaceWorkspace(data) {
  ws.data = migrate(data);
  save();
  touch();
}

function migrate(d) {
  if (!d.version) d.version = 1;
  d.settings = Object.assign({ units: 'imperial', budgetCap: 150000, programStart: isoToday(), activePropertyId: null }, d.settings || {});
  d.properties = d.properties || [];
  d.materials = d.materials || [];
  d.products = d.products || [];
  d.projects = d.projects || [];
  for (const p of d.properties) {
    p.wallHeight = p.wallHeight || 2.44;
    p.plan = p.plan || null;
    p.walls = p.walls || [];
    p.openings = p.openings || [];
    p.rooms = p.rooms || [];
    p.scans = p.scans || [];
  }
  for (const pr of d.projects) pr.items = pr.items || [];
  return d;
}

export function emptyWorkspace() {
  return migrate({
    version: 1,
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

// ---------- IndexedDB for large binaries (lidar scans) ----------

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

export async function putFile(id, buffer, meta) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('files', 'readwrite');
    tx.objectStore('files').put(Object.assign({ id, buffer }, meta || {}));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function getFile(id) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction('files').objectStore('files').get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteFile(id) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('files', 'readwrite');
    tx.objectStore('files').delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- export / import ----------

export function exportWorkspace() {
  const blob = new Blob([JSON.stringify(ws.data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'tiksi-workspace-' + isoToday() + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
  const scanCount = ws.data.properties.reduce((n, p) => n + (p.scans ? p.scans.length : 0), 0);
  if (scanCount) alert('Note: ' + scanCount + ' scan file(s) live in browser storage and are not embedded in the export. Re-upload scans after importing on another machine.');
}

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
