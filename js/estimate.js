// The estimate of a project: its scope items, the trim worked out from its drawn trim sections,
// and its markups. ESTIMATE shows it, DOCUMENTS prints from it, and store.js's project rules use
// it, so PROJECTS, the program, SCHEDULE and the one-pager show the same money and days.
//
// A project here is a top-level project with its subprojects (a room's trim, a punch list). The
// trim sections that belong to any of them (t.projectId) are laid out exactly as MODEL draws them
// (trim-design.js), cut into pieces, planned onto store-length boards, and given hours, supplies
// and prices by trim-estimate.js. Nothing of the trim estimate is stored: change the drawing and
// the estimate follows. What is stored is the project's estimate settings (project.estimate on the
// top-level project): the hourly rate, contingency, overhead, profit and tax, the spare boards.
//
// A scope item whose model elements are all drawn trim sections of the same project is already
// counted by the drawn trim (an older package wrote the room's boards as items): it is shown,
// marked as covered, and left out of the totals.

import {
  ws, onChange, onWorkspaceReplace, projectById, setProjectRules, itemTotals, itemsTotals,
  levelOfWall, wallsOn, roomsOn, openingsOn, wallHeightOf,
} from './store.js';
import { trimDesign } from './trim-design.js';
import { TRIM_CATALOG, TRIM_STOCK } from './trim-catalog.js';
import { trimPieces, estimateTrim } from './trim-estimate.js';

export const ESTIMATE_DEFAULTS = Object.freeze({
  laborRate: 85,          // $ an hour for the carpenter
  contingency: 0,         // fraction of the cost, for what the drawing does not show
  overhead: 0,            // fraction: the business's running costs
  profit: 0,              // fraction, on cost + contingency + overhead
  taxRate: 0,             // sales tax on materials bought (trim boards and supplies)
  sparePerMoulding: 1,    // whole-house spare boards of each moulding
  stockCapIn: 144,        // boards planned up to 12'-0"
  stockStretchIn: 156,    // or 13'-0" when that buys less
});
const LIMITS = { laborRate: [0, 1000], contingency: [0, 1], overhead: [0, 1], profit: [0, 1], taxRate: [0, 0.25], sparePerMoulding: [0, 10], stockCapIn: [48, 240], stockStretchIn: [48, 240] };

export const rootOf = p => (p && p.parentId && projectById(p.parentId)) || p || null;
export const treeOf = root => root ? [root, ...ws.data.projects.filter(x => x.parentId === root.id)] : [];
export function estimateSettings(p) {
  const root = rootOf(p), own = (root && root.estimate) || {};
  const out = { ...ESTIMATE_DEFAULTS };
  for (const k of Object.keys(ESTIMATE_DEFAULTS)) {
    const v = Number(own[k]);
    if (own[k] != null && own[k] !== '' && Number.isFinite(v)) out[k] = Math.min(LIMITS[k][1], Math.max(LIMITS[k][0], v));
  }
  return out;
}
// Set one setting on the project's top-level project; the default is not stored.
export function setEstimateSetting(p, key, value) {
  const root = rootOf(p);
  if (!root || !(key in ESTIMATE_DEFAULTS)) return false;
  const v = Number(value);
  if (!Number.isFinite(v)) return false;
  root.estimate = { ...(root.estimate || {}) };
  if (Math.abs(v - ESTIMATE_DEFAULTS[key]) < 1e-12) delete root.estimate[key];
  else root.estimate[key] = Math.min(LIMITS[key][1], Math.max(LIMITS[key][0], v));
  if (!Object.keys(root.estimate).length) delete root.estimate;
  return true;
}

// ---------- the drawn trim of a project ----------

const propOfProject = root => root && ws.data.properties.find(x => x.id === root.propertyId) || null;
function designFor(prop) {
  const memo = new Map();
  const once = (k, f) => { if (!memo.has(k)) memo.set(k, f()); return memo.get(k); };
  return trimDesign({ prop, projects: ws.data.projects || [], levelOf: w => levelOfWall(prop, w).id,
    wallsOn: l => once('w' + l, () => wallsOn(prop, l)), roomsOn: l => once('r' + l, () => roomsOn(prop, l)),
    openingsOn: l => once('o' + l, () => openingsOn(prop, l)), heightOf: w => wallHeightOf(prop, w) });
}

// Worked out again only when something changed: any edit (touch), a merge, a replaced workspace.
let rev = 0;
onChange(() => { rev++; });
onWorkspaceReplace(() => { rev++; });
export function invalidateEstimates() { rev++; }
const memo = new Map();   // root id -> { key, value }
function memoKey(root, prop) { return [rev, ws.data, ws.data.projects, prop, prop && prop.trims, prop && prop.walls, prop && prop.openings, root.estimate]; }
const sameKey = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);

function catalogOf(ids) {
  const all = [...TRIM_CATALOG, ...(TRIM_STOCK || [])];
  return all.filter(c => ids.has(c.id));
}

// Rooms in the order their subprojects are listed, then any other room the trim stands in.
function roomOrder(root, prop, pieces) {
  const names = [];
  for (const s of treeOf(root)) {
    const r = s.roomId && (prop.rooms || []).find(x => x.id === s.roomId);
    if (r && pieces.some(p => p.roomId === r.id || p.room === (r.name || 'Room'))) names.push(r.name || 'Room');
  }
  for (const p of pieces) if (!names.includes(p.room)) names.push(p.room);
  return names;
}
// The trim estimate for a top-level project: null when none of its sections is drawn.
export function trimEstimateOf(p) {
  const root = rootOf(p);
  if (!root) return null;
  const prop = propOfProject(root);
  if (!prop || !(prop.trims || []).length) return null;
  const key = memoKey(root, prop), hit = memo.get(root.id);
  if (hit && sameKey(hit.key, key)) return hit.value;
  let value = null;
  const ids = new Set(treeOf(root).map(x => x.id));
  const mine = (prop.trims || []).filter(t => t.projectId && ids.has(t.projectId));
  if (mine.length) {
    try {
      const design = designFor(prop);
      const { pieces, faces } = trimPieces({ prop, projects: ws.data.projects, design, include: t => t.projectId && ids.has(t.projectId) });
      if (pieces.length) {
        const s = estimateSettings(root);
        const catalog = catalogOf(new Set(pieces.map(x => x.product)));
        const rooms = roomOrder(root, prop, pieces).map(name => ({ name }));
        const est = estimateTrim({ pieces, faces, catalog, rooms, settings: {
          laborRate: s.laborRate, contingency: 0, sparePerMoulding: s.sparePerMoulding, stockCapIn: s.stockCapIn, stockStretchIn: s.stockStretchIn } });
        value = { ...est, sectionIds: mine.map(t => t.id), sections: mine, settings: s };
      }
    } catch (e) {
      console.error('trim estimate', e);
      value = { error: String(e && e.message || e), sectionIds: mine.map(t => t.id), sections: mine };
    }
  }
  memo.set(root.id, { key, value });
  return value;
}

// ---------- the whole project ----------

// Items an older package wrote for drawn trim: every model element they list is a section of the
// project's own drawn trim.
export function coveredBy(it, trimIds) {
  const els = (it.elementIds || []).filter(Boolean);
  return els.length > 0 && trimIds && els.every(id => trimIds.has(id));
}

const sum3 = (a, b) => ({ low: a.low + b.low, likely: a.likely + b.likely, high: a.high + b.high });
const zero3 = () => ({ low: 0, likely: 0, high: 0 });
const mul3 = (a, f) => ({ low: a.low * f, likely: a.likely * f, high: a.high * f });

// Hours of a room's labor lines at the tasks' low, typical and high rates.
function hoursRange(lines, taskById) {
  const r = zero3();
  for (const l of lines || []) {
    const t = (taskById && taskById[l.task]) || {};
    const h = Number(l.rate != null ? l.rate : t.hours) || 0;
    r.likely += l.hours;
    r.low += l.qty * (t.low != null ? t.low : h);
    r.high += l.qty * (t.high != null ? t.high : h);
  }
  return r;
}

// Which project of the tree a room of the trim estimate belongs to: the one all its pieces belong to,
// else the top-level project.
function roomProject(root, est, roomName) {
  const ps = new Set((est.pieces || []).filter(p => p.room === roomName).map(p => p.project).filter(Boolean));
  return ps.size === 1 ? [...ps][0] : root.id;
}

// The estimate of a project and its subprojects. Totals are low / likely / high: scope items carry
// their own range; the trim's hours range from the labor rates' low and high figures.
export function projectEstimate(p) {
  const root = rootOf(p);
  if (!root) return null;
  const s = estimateSettings(root);
  const tree = treeOf(root);
  const trim = trimEstimateOf(root);
  const trimIds = new Set(trim && !trim.error ? trim.sectionIds : []);
  const parts = new Map(tree.map(x => [x.id, { project: x, items: zero3(), trim: zero3(), materials: 0, hours: zero3(), days: 0, covered: [], rooms: [] }]));
  for (const x of tree) {
    const part = parts.get(x.id);
    for (const it of x.items || []) {
      if (coveredBy(it, trimIds)) { part.covered.push(it); continue; }
      part.items = sum3(part.items, itemTotals(it));
    }
  }
  if (trim && !trim.error) {
    for (const r of trim.rooms || []) {
      const name = r.name;
      const part = parts.get(roomProject(root, trim, name)) || parts.get(root.id);
      const h = hoursRange(r.labor, trim.labor && trim.labor.taskById);
      const mat = (r.mat || 0) + (r.supplies || 0);
      part.trim = sum3(part.trim, { low: mat + h.low * s.laborRate, likely: mat + h.likely * s.laborRate, high: mat + h.high * s.laborRate });
      part.materials += mat;
      part.hours = sum3(part.hours, h);
      part.days += r.days || 0;
      part.rooms.push(name);
    }
  }
  // Markups on each part, so a subproject's share adds up to the whole.
  for (const part of parts.values()) {
    const sub = sum3(part.items, part.trim);
    const cont = mul3(sub, s.contingency);
    const over = mul3(sum3(sub, cont), s.overhead);
    const prof = mul3(sum3(sum3(sub, cont), over), s.profit);
    const tax = part.materials * s.taxRate;
    part.subtotal = sub; part.contingency = cont; part.overhead = over; part.profit = prof; part.tax = tax;
    part.total = sum3(sum3(sum3(sub, cont), sum3(over, prof)), { low: tax, likely: tax, high: tax });
  }
  const all = [...parts.values()];
  const add = k => all.reduce((t, x) => sum3(t, x[k]), zero3());
  return {
    root, settings: s, trim, parts, tree,
    items: add('items'), trimCost: add('trim'), subtotal: add('subtotal'), contingency: add('contingency'),
    overhead: add('overhead'), profit: add('profit'),
    tax: all.reduce((n, x) => n + x.tax, 0), materials: all.reduce((n, x) => n + x.materials, 0),
    hours: add('hours'), days: all.reduce((n, x) => n + x.days, 0),
    covered: all.flatMap(x => x.covered.map(it => ({ project: x.project, item: it }))),
    total: add('total'),
  };
}

// One project's own share (not its subprojects'): what PROJECTS, the program and the one-pager show.
export function projectCost(p) {
  const est = projectEstimate(p);
  const part = est && est.parts.get(p.id);
  return part ? part.total : itemsTotals(p);
}

// The work a project schedules: its scope items, and an install item for the trim of its rooms
// (working days, one carpenter, from the estimate's hours).
export function projectWorkWithTrim(p) {
  const items = p.items || [];
  const est = projectEstimate(p);
  const part = est && est.parts.get(p.id);
  if (!part || !part.days) return items;
  const trimIds = new Set(est.trim && !est.trim.error ? est.trim.sectionIds : []);
  const kept = items.filter(it => !coveredBy(it, trimIds));
  return [...kept, {
    id: 'estimate-trim-' + p.id, name: `Install trim (${part.rooms.join(', ')}): ${Math.round(part.hours.likely * 10) / 10} hrs from the estimate`,
    durationDays: part.days, deps: [], estimate: true,
  }];
}

// The rules every page uses (store.js). Only a project that has drawn trim or saved estimate
// settings costs anything other than its items' sum.
export function useEstimateRules() {
  setProjectRules({
    cost: p => {
      const root = rootOf(p);
      if (!root || (!root.estimate && !trimEstimateOf(root))) return null;
      return projectCost(p);
    },
    work: p => {
      const root = rootOf(p);
      if (!root || !trimEstimateOf(root)) return null;
      return projectWorkWithTrim(p);
    },
  });
}
