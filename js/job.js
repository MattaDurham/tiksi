// A job: a top-level project with its subprojects, worked out once and read by every page.
//
// What it costs: each room's drawn trim (boards, supplies and carpenter hours, worked out from the
// trim sections as MODEL draws them, by trim-estimate.js) and scope items, then the project's
// contingency, markup (overhead and profit) and sales tax on the materials bought. A room is a
// subproject (a room's trim and fixes), or a room whose drawn trim belongs to the project itself.
//
// How long: working days (Monday to Friday). One carpenter does the trim, room after room in the
// order the subprojects are listed; scope items with days run on their own unless they are set to
// start after something (another item, or a room's trim).
//
// Nothing here is stored except the project's settings (project.job on the top-level project).
// Change the drawing and the job follows. A scope item whose model elements are all drawn trim
// sections of the same job was written by an older trim package for those boards: it is counted
// by the drawing now, so it is listed as covered and left out of the money and the days.

import {
  ws, onChange, onWorkspaceReplace, projectById, itemTotals, itemsTotals, setProjectRules,
  levelOfWall, wallsOn, roomsOn, openingsOn, wallHeightOf,
} from './store.js';
import { trimDesign } from './trim-design.js';
import { trimPieces, estimateTrim } from './trim-estimate.js';
import { cpm } from './program.js';
import { boardPrices } from './job-products.js';

export const JOB_DEFAULTS = Object.freeze({
  laborRate: 85,          // $ an hour for the carpenter
  contingency: 0,         // fraction of the cost, for what the drawing cannot show
  markup: 0,              // overhead and profit, a fraction of cost + contingency
  taxRate: 0,             // sales tax on the trim boards and supplies bought
  discount: 0,            // fraction off the price before tax
  sparePerMoulding: 1,    // spare boards of each moulding for the house
});
const LIMITS = { laborRate: [0, 1000], contingency: [0, 1], markup: [0, 3], taxRate: [0, 0.25], discount: [0, 1], sparePerMoulding: [0, 10] };

export const rootOf = p => (p && p.parentId && projectById(p.parentId)) || p || null;
export const treeOf = root => root ? [root, ...ws.data.projects.filter(x => x.parentId === root.id)] : [];

export function jobSettings(p) {
  const root = rootOf(p), own = (root && root.job) || {};
  const out = { ...JOB_DEFAULTS };
  for (const k of Object.keys(JOB_DEFAULTS)) {
    const v = Number(own[k]);
    if (own[k] != null && own[k] !== '' && Number.isFinite(v)) out[k] = Math.min(LIMITS[k][1], Math.max(LIMITS[k][0], v));
  }
  // Who does the work: their hourly rate and their own times per task replace the job's rate and
  // the published times.
  out.who = (own.who && installerById(own.who)) || null;
  if (out.who && Number.isFinite(Number(out.who.rate))) out.laborRate = Math.min(LIMITS.laborRate[1], Math.max(0, Number(out.who.rate)));
  return out;
}

// ---------- who does the work ----------
// Installers are kept with the workspace (settings.installers): { id, name, trade, rate ($ an hour),
// each: { task: hours each } } where a task's time is their own; the rest are the published times.
export const installers = () => (ws.data.settings && Array.isArray(ws.data.settings.installers)) ? ws.data.settings.installers : [];
export const installerById = id => installers().find(x => x.id === id) || null;
export function addInstaller(fields = {}) {
  ws.data.settings.installers = installers().slice();
  const x = { id: fields.id || 'inst-' + Math.random().toString(36).slice(2, 10), name: String(fields.name || 'Carpenter').slice(0, 120), trade: String(fields.trade || 'Carpenter').slice(0, 60),
    rate: Number.isFinite(Number(fields.rate)) ? Number(fields.rate) : JOB_DEFAULTS.laborRate, each: { ...(fields.each || {}) } };
  ws.data.settings.installers.push(x);
  return x;
}
export function removeInstaller(id) {
  ws.data.settings.installers = installers().filter(x => x.id !== id);
  for (const p of ws.data.projects) if (p.job && p.job.who === id) { const next = { ...p.job }; delete next.who; if (Object.keys(next).length) p.job = next; else delete p.job; }
}
// One of an installer's times (hours each); null or '' goes back to the published time.
export function setInstallerTime(x, task, value) {
  const each = { ...(x.each || {}) };
  if (value == null || value === '') delete each[task];
  else { const v = Number(value); if (!Number.isFinite(v) || v < 0) return false; each[task] = v; }
  x.each = each;
  return true;
}
// The job's installer (an id; '' for the published times at the job's own rate).
export function setJobWho(p, id) {
  const root = rootOf(p);
  if (!root || (id && !installerById(id))) return false;
  const next = { ...(root.job || {}) };
  if (id) next.who = id; else delete next.who;
  if (Object.keys(next).length) root.job = next; else delete root.job;
  return true;
}

// A room's typed quantities and times (field 'qty' or 'each'), kept on the top-level project by the
// room's key (its subproject's id, or 'room:<name>'), beside its days; null or '' goes back to the
// count or the rate.
export function setRoomLabor(p, roomKey, field, task, value) {
  const root = rootOf(p);
  if (!root || !['qty', 'each'].includes(field) || !task) return false;
  let v = null;
  if (value != null && value !== '') { v = Number(value); if (!Number.isFinite(v) || v < 0) return false; }
  return editRoom(root, roomKey, room => { room[field] = { ...(room[field] || {}) }; if (v == null) delete room[field][task]; else room[field][task] = v; });
}
// A room's days (whole working days, at least 1), which scale its tasks to fit; null goes back to the
// days its hours count.
export function setRoomDays(p, roomKey, value) {
  const root = rootOf(p);
  if (!root || !roomKey) return false;
  let v = null;
  if (value != null && value !== '') { v = Math.round(Number(value)); if (!Number.isFinite(v) || v < 1) return false; }
  return editRoom(root, roomKey, room => { if (v == null) delete room.days; else room.days = v; });
}
function editRoom(root, roomKey, change) {
  const labor = { ...((root.job && root.job.labor) || {}) };
  const room = { ...(labor[roomKey] || {}) };
  change(room);
  for (const f of ['qty', 'each']) if (room[f] && !Object.keys(room[f]).length) delete room[f];
  if (Object.keys(room).length) labor[roomKey] = room; else delete labor[roomKey];
  const next = { ...(root.job || {}) };
  if (Object.keys(labor).length) next.labor = labor; else delete next.labor;
  if (Object.keys(next).length) root.job = next; else delete root.job;
  return true;
}
// One setting on the top-level project; a default is not stored. False for an unknown key or a non-number.
export function setJobSetting(p, key, value) {
  const root = rootOf(p), v = Number(value);
  if (!root || !(key in JOB_DEFAULTS) || value === '' || !Number.isFinite(v)) return false;
  const next = { ...(root.job || {}) };
  if (Math.abs(v - JOB_DEFAULTS[key]) < 1e-12) delete next[key];
  else next[key] = Math.min(LIMITS[key][1], Math.max(LIMITS[key][0], v));
  if (Object.keys(next).length) root.job = next; else delete root.job;
  return true;
}

// ---------- the drawn trim of a job ----------

const propOf = root => (root && ws.data.properties.find(x => x.id === root.propertyId)) || null;
function designFor(prop) {
  const memo = new Map();
  const once = (k, f) => { if (!memo.has(k)) memo.set(k, f()); return memo.get(k); };
  return trimDesign({ prop, projects: ws.data.projects || [], levelOf: w => levelOfWall(prop, w).id,
    wallsOn: l => once('w' + l, () => wallsOn(prop, l)), roomsOn: l => once('r' + l, () => roomsOn(prop, l)),
    openingsOn: l => once('o' + l, () => openingsOn(prop, l)), heightOf: w => wallHeightOf(prop, w) });
}

// Worked out again only after a change (any edit, a merge, another workspace).
let rev = 0;
onChange(() => { rev++; });
onWorkspaceReplace(() => { rev++; });
const trimMemo = new Map(), jobMemo = new Map();

// The trim estimate of a job's drawn sections, or null when it has none.
export function trimOf(p) {
  const root = rootOf(p), prop = propOf(root);
  if (!root || !prop || !(prop.trims || []).length) return null;
  const s = jobSettings(root);
  const key = [rev, ws.data, s.laborRate, s.sparePerMoulding, JSON.stringify(root.job || {})].join('|');
  const hit = trimMemo.get(root.id);
  if (hit && hit.key === key && hit.data === ws.data) return hit.value;
  const ids = new Set(treeOf(root).map(x => x.id));
  const sections = (prop.trims || []).filter(t => t.projectId && ids.has(t.projectId));
  let value = null;
  if (sections.length) {
    try {
      const { pieces, faces } = trimPieces({ prop, projects: ws.data.projects, design: designFor(prop), include: t => t.projectId && ids.has(t.projectId) });
      if (pieces.length) {
        // Rooms in the order their subprojects are listed, then any other room the trim is in.
        const names = [];
        for (const x of treeOf(root)) {
          const r = x.roomId && (prop.rooms || []).find(y => y.id === x.roomId);
          if (r && pieces.some(q => q.roomId === r.id)) names.push(r.name || 'Room');
        }
        for (const q of pieces) if (!names.includes(q.room)) names.push(q.room);
        // Each room's typed quantities and times, by the room's key (as jobOf finds the room).
        const typed = (root.job && root.job.labor) || {}, rooms = {};
        for (const name of names) {
          const owners = new Set(pieces.filter(q => q.room === name).map(q => q.project).filter(Boolean));
          const owner = owners.size === 1 && [...owners][0] !== root.id ? [...owners][0] : 'room:' + name;
          if (typed[owner]) rooms[name] = typed[owner];
        }
        const inputs = { pieces, faces, rooms: names.map(name => ({ name })) };
        const stock = boardPrices();
        value = estimateTrim({ ...inputs, settings: { laborRate: s.laborRate, contingency: 0, sparePerMoulding: s.sparePerMoulding,
          labor: { each: (s.who && s.who.each) || {}, rooms }, stock: stock.stock, priceOverrides: stock.priceOverrides } });
        value.labor.who = s.who;
        value.inputs = inputs;
        value.sectionIds = sections.map(t => t.id);
        value.sections = sections;
      }
    } catch (e) {
      console.error('trim estimate', e);
      value = { error: String(e && e.message || e), sectionIds: sections.map(t => t.id), sections };
    }
  }
  trimMemo.set(root.id, { key, data: ws.data, value });
  return value;
}

// The trim estimate as the trim package prints it: the job's contingency included, so the book's
// total is ESTIMATE's cost of the trim plus contingency (overhead, profit and tax are the client's
// price, on the proposal).
export function trimForBook(p) {
  const t = trimOf(p), s = jobSettings(p);
  if (!t || t.error) return null;
  return estimateTrim({ ...t.inputs, settings: { ...t.settings, laborRate: s.laborRate, contingency: s.contingency, sparePerMoulding: s.sparePerMoulding } });
}

export function coveredBy(it, trimIds) {
  const els = (it.elementIds || []).filter(Boolean);
  return els.length > 0 && !!trimIds && els.every(id => trimIds.has(id));
}

// ---------- money ----------

const add3 = (a, b) => ({ low: a.low + b.low, likely: a.likely + b.likely, high: a.high + b.high });
const zero3 = () => ({ low: 0, likely: 0, high: 0 });
const one3 = v => ({ low: v, likely: v, high: v });
const mul3 = (a, f) => ({ low: a.low * f, likely: a.likely * f, high: a.high * f });

// A cost and its markups: contingency on the cost, markup on cost + contingency, the discount off
// all of that, then tax on the materials as bought (the store charges it whatever the discount).
function priced(cost, materials, s) {
  const contingency = mul3(cost, s.contingency);
  const markup = mul3(add3(cost, contingency), s.markup);
  const discount = mul3(add3(add3(cost, contingency), markup), s.discount);
  const tax = materials * s.taxRate;
  return { cost, contingency, markup, discount, tax, price: add3(add3(add3(cost, contingency), markup), add3(mul3(discount, -1), one3(tax))) };
}
// Hours are quoted to a tenth, and labor is those hours times the rate, so a printed room checks.
const tenth3 = h => ({ low: Math.round(h.low * 10) / 10, likely: Math.round(h.likely * 10) / 10, high: Math.round(h.high * 10) / 10 });

// Hours of labor lines at the rates' low, typical and high figures.
function hoursOf(lines, taskById) {
  const h = zero3();
  for (const l of lines || []) {
    const t = (taskById && taskById[l.task]) || {};
    const rate = Number(l.rate != null ? l.rate : t.hours) || 0;
    h.likely += l.hours;
    h.low += l.qty * (t.low != null ? t.low : rate);
    h.high += l.qty * (t.high != null ? t.high : rate);
  }
  return h;
}

// The whole job. Rooms: [{ key, name, project, trim: [estimate rooms], items, materials, supplies,
// hours, labor, items$, cost, days, ...priced }]; other: the top-level project's own items.
export function jobOf(p) {
  const root = rootOf(p);
  if (!root) return null;
  const s = jobSettings(root);
  const trim = trimOf(root);
  const key = [rev, ws.data, JSON.stringify(root.job || {})].join('|');
  const hit = jobMemo.get(root.id);
  if (hit && hit.key === key && hit.data === ws.data && hit.trim === trim) return hit.value;

  const tree = treeOf(root);
  const okTrim = trim && !trim.error ? trim : null;
  const trimIds = new Set(okTrim ? okTrim.sectionIds : []);
  const covered = [];
  const own = x => (x.items || []).filter(it => { if (coveredBy(it, trimIds)) { covered.push({ project: x, item: it }); return false; } return true; });
  const rooms = tree.slice(1).map(x => ({ key: x.id, name: x.name || 'Subproject', project: x, trim: [], items: own(x) }));
  const otherItems = own(root);
  if (okTrim) {
    for (const r of okTrim.rooms) {
      const owners = new Set(okTrim.pieces.filter(q => q.room === r.name).map(q => q.project).filter(Boolean));
      const owner = owners.size === 1 ? [...owners][0] : root.id;
      let room = rooms.find(x => x.key === owner);
      if (!room) { room = { key: 'room:' + r.name, name: r.name, project: root, trim: [], items: [] }; rooms.push(room); }
      room.trim.push(r);
    }
  }
  const taskById = okTrim && okTrim.labor && okTrim.labor.taskById;
  for (const room of rooms) {
    // The boards bought for the room, as the buy list orders them: its own boards, and the spares
    // of each moulding on the room that buys the most of it (the engine's per-room order share).
    const names = new Set(room.trim.map(r => r.name));
    room.boards = okTrim ? Object.values(okTrim.alloc || {}).filter(a => names.has(a.room)).reduce((n, a) => n + a.qty * a.price, 0) : 0;
    room.supplies = room.trim.reduce((n, r) => n + (r.supplies || 0), 0);
    room.materials = room.boards + room.supplies;
    room.hours = tenth3(room.trim.reduce((h, r) => add3(h, hoursOf(r.labor, taskById)), zero3()));
    room.labor = mul3(room.hours, s.laborRate);
    room.itemCost = room.items.reduce((t, it) => add3(t, itemTotals(it)), zero3());
    room.days = room.trim.reduce((n, r) => n + (r.days || 0), 0);
    room.pieces = room.trim.reduce((n, r) => n + (r.pieces || 0), 0);
    room.trimLf = room.trim.reduce((n, r) => n + (r.trimLf || 0), 0);
    room.storePieces = room.trim.reduce((n, r) => n + Object.values(r.sticks || {}).reduce((a, b) => a + b, 0), 0);
    Object.assign(room, priced(add3(add3(one3(room.materials), room.labor), room.itemCost), room.materials, s));
  }
  const other = { items: otherItems, itemCost: otherItems.reduce((t, it) => add3(t, itemTotals(it)), zero3()) };
  Object.assign(other, priced(other.itemCost, 0, s));
  const parts = [...rooms, other];
  const sum = k => parts.reduce((t, x) => add3(t, x[k]), zero3());
  const job = {
    root, settings: s, trim, tree, rooms, other, covered,
    materials: rooms.reduce((n, r) => n + r.materials, 0),
    boards: rooms.reduce((n, r) => n + r.boards, 0),
    supplies: rooms.reduce((n, r) => n + r.supplies, 0),
    hours: rooms.reduce((h, r) => add3(h, r.hours), zero3()),
    labor: rooms.reduce((t, r) => add3(t, r.labor), zero3()),
    itemCost: sum('itemCost'), cost: sum('cost'), contingency: sum('contingency'), markup: sum('markup'), discount: sum('discount'),
    tax: parts.reduce((n, x) => n + x.tax, 0), price: sum('price'),
  };
  job.schedule = jobSchedule(job);
  jobMemo.set(root.id, { key, data: ws.data, trim, value: job });
  return job;
}

// ---------- days ----------

// The job's work in working days: each room's trim, one after another (one carpenter), and every
// scope item with days. A row: { id, name, kind: 'trim'|'item', room, project, durationDays, deps,
// crew, item? }. `include` narrows to the projects in the program.
export function jobSchedule(job, include = () => true) {
  const rows = [];
  let prev = (job.root.job && job.root.job.trimAfter) || '';
  for (const room of job.rooms) {
    if (!room.days || !include(room.project)) continue;
    const id = 'trim:' + room.key;
    rows.push({ id, name: room.name, kind: 'trim', room, project: room.project, durationDays: room.days, deps: prev ? [prev] : [], crew: 'Carpenter',
      hours: room.hours.likely });
    prev = id;
  }
  const add = (x, items) => { if (!include(x)) return; for (const it of items) if ((Number(it.durationDays) || 0) > 0) rows.push({ id: it.id, name: it.name || 'Item', kind: 'item', item: it, project: x,
    room: job.rooms.find(r => r.project === x && r.project !== job.root) || null, durationDays: Number(it.durationDays), deps: it.deps || [], crew: it.crew || '' }); };
  add(job.root, job.other.items);
  for (const room of job.rooms) if (room.project !== job.root) add(room.project, room.items);
  const { sched, end, cyclic } = cpm(rows);
  return { rows: rows.filter(r => sched[r.id]), sched, days: Math.ceil(end - 1e-9), cyclic };
}

// ---------- every page's rule ----------

// What one project of the job costs on its own (a subproject: its room; the top-level project: its
// own items and the rooms whose trim it holds directly).
export function projectShare(p) {
  const job = jobOf(p);
  if (!job) return itemsTotals(p);
  if (p.id === job.root.id) return job.rooms.filter(r => r.project === p).reduce((t, r) => add3(t, r.price), job.other.price);
  const room = job.rooms.find(r => r.project === p);
  return room ? room.price : itemsTotals(p);
}

// store.js's project rules: projectTotals is the project's share of its job; the program schedule
// lays a job out as one (projectWork of the top-level project gives all its rows).
export function useJobRules() {
  setProjectRules({
    cost: p => {
      const root = rootOf(p);
      if (!root || (!root.job && !trimOf(root))) return null;
      return projectShare(p);
    },
    work: (p, include) => {
      const root = rootOf(p);
      if (!root || root !== p) return null;
      return jobSchedule(jobOf(root), include).rows;
    },
  });
}
