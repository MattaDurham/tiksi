// The one-pager: a one-page teaser of a property for its client, kept on the property so it
// travels in the project file. Every property has one. Its text is drafted from the project
// (rooms, floor area, scope, budget, schedule, products) and can be edited by hand; every
// saved version is a PDF among the property's documents, and the newest version is the one
// to send. Pure data only (no DOM, no three.js), so Node tests run it; one-pager-page.js lays
// the page out, one-pager-render.js makes the PDF and one-pager-dialog.js is the editor.
//
// prop.onePager = { headline, tagline, summary, highlights: [text], client, preparedBy, contact,
//   hero: '' (automatic) | 'model' | 'plan' | <photo id>,
//   show: { budget, schedule, rooms, plan, products },
//   customized (the text was edited by hand, so redrafting never overwrites it),
//   draftedAt, updatedAt (ISO), basedOn (the project's signature at the newest version),
//   versions: [{ n, date, documentId }] }
//
// settings.onePagerPrompt says when closing Tiksi asks to update it: 'changed' (the project
// changed since the newest version, or there is none), 'always' or 'never'.

import { fmtMoney, fmtArea, fmtDate, roomsFloorArea, projectTotals, itemPriced, isoToday } from './store.js';
import { normalizeOnePager, emptyOnePager, latestVersion, SHOW_KEYS, MAX_HIGHLIGHTS, MAX_TEXT, cleanLine } from './one-pager-record.js';

export { normalizeOnePager, emptyOnePager, latestVersion, SHOW_KEYS, MAX_HIGHLIGHTS };

export const PROMPT_MODES = [
  ['changed', 'When the project changed since the last version'],
  ['always', 'Every time'],
  ['never', 'Never'],
];
export const DEFAULT_PROMPT = 'changed';
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const clean = cleanLine;
const str = v => typeof v === 'string' ? v : '';

// ---------- what the project says about itself ----------

// Everything the page and the draft text read from the project, in one place.
// `data` is the workspace (its projects and products); `prop` the property.
export function onePagerFacts(prop, data) {
  const d = data || { projects: [], products: [], settings: {} };
  const rooms = (prop.rooms || []).filter(r => r && r.kind !== 'unscanned' && r.pts && r.pts.length >= 3);
  const floorArea = roomsFloorArea(prop.rooms || []);
  const levels = (prop.levels || []).length || 1;
  const own = (d.projects || []).filter(pr => pr && pr.propertyId === prop.id);
  const top = own.filter(pr => !pr.parentId);
  const projects = top.map(pr => {
    const t = projectTotals(pr);
    const items = pr.items || [];
    return { id: pr.id, name: pr.name || 'Project', status: pr.status || '', selected: pr.selected !== false, category: pr.category || '',
      items: items.length, priced: items.filter(itemPriced).length, low: t.low, likely: t.likely, high: t.high, days: makespan(items) };
  }).sort((a, b) => b.likely - a.likely || a.name.localeCompare(b.name));
  const program = projects.filter(p => p.selected);
  const budget = { low: 0, likely: 0, high: 0, priced: 0 };
  for (const p of program) { budget.low += p.low; budget.likely += p.likely; budget.high += p.high; budget.priced += p.priced; }
  const itemIds = new Set(own.flatMap(pr => (pr.items || []).map(it => it.id)));
  const products = (d.products || []).filter(pr => pr && ((pr.itemIds || []).some(id => itemIds.has(id)) || (pr.propertyIds || []).includes(prop.id)))
    .map(pr => ({ id: pr.id, name: pr.name || 'Product', brand: pr.brand || '', model: pr.model || '', category: pr.category || '', price: Number(pr.price) > 0 ? Number(pr.price) : 0 }));
  const photos = (prop.photos || []).filter(ph => ph && ph.kind === 'photo' && ph.source !== 'rendering' && ph.source !== 'polycam-keyframe');
  const renderings = (prop.photos || []).filter(ph => ph && ph.kind === 'photo' && ph.source === 'rendering');
  const scopeItems = own.reduce((n, pr) => n + (pr.items || []).length, 0);
  const days = program.reduce((n, p) => n + p.days, 0);
  const start = ISO_DATE_RE.test(str(d.settings && d.settings.programStart)) ? d.settings.programStart : '';
  return { name: prop.name || 'Property', address: str(prop.address), rooms, floorArea, levels, projects, program, scopeItems, budget, products, photos, renderings,
    scans: (prop.scans || []).length, days, start };
}

// Working days of one project's scope: the longest dependency chain, as SCHEDULE lays it out.
// Items with no duration are budget-only and take no time.
function makespan(items) {
  const byId = new Map((items || []).map(it => [it.id, it]));
  const ef = new Map();
  const finish = (it, stack) => {
    if (ef.has(it.id)) return ef.get(it.id);
    if (stack.has(it.id)) return 0;   // a dependency loop: schedule.js reports it; here it just ends
    stack.add(it.id);
    let es = 0;
    for (const dep of it.deps || []) { const d = byId.get(dep); if (d) es = Math.max(es, finish(d, stack)); }
    stack.delete(it.id);
    const dur = Math.max(0, Number(it.durationDays) || 0);
    ef.set(it.id, es + dur);
    return es + dur;
  };
  let total = 0;
  for (const it of items || []) total = Math.max(total, finish(it, new Set()));
  return Math.round(total);
}

const list = (names, max = 3) => {
  const shown = names.slice(0, max);
  if (names.length > max) return shown.join(', ') + ' and ' + (names.length - max) + ' more';
  if (shown.length <= 1) return shown.join('');
  return shown.slice(0, -1).join(', ') + ' and ' + shown[shown.length - 1];
};
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');

// Draft text from the facts. Returns { headline, tagline, summary, highlights }.
export function draftText(facts) {
  const f = facts;
  const headline = f.name;
  const parts = [];
  if (f.rooms.length) parts.push(plural(f.rooms.length, 'room'));
  if (f.floorArea > 0) parts.push(fmtArea(f.floorArea));
  if (f.levels > 1) parts.push(plural(f.levels, 'level'));
  const tagline = ['Renovation proposal'].concat(parts.length ? [parts.join(', ')] : []).join(' · ');
  const s = [];
  if (f.rooms.length) s.push(f.name + ' is a ' + f.rooms.length + '-room' + (f.floorArea > 0 ? ', ' + fmtArea(f.floorArea) : '') + ' property' + (f.levels > 1 ? ' on ' + plural(f.levels, 'level') : '') + (f.scans ? ', measured from a 3D scan' : '') + '.');
  else s.push('A renovation at ' + f.name + (f.scans ? ', measured from a 3D scan' : '') + '.');
  if (f.program.length) s.push('The proposed work covers ' + list(f.program.map(p => p.name)) + (f.scopeItems ? ', ' + plural(f.scopeItems, 'scope item') + ' in all' : '') + '.');
  else if (f.projects.length) s.push(plural(f.projects.length, 'project') + ' ' + (f.projects.length === 1 ? 'is' : 'are') + ' under consideration: ' + list(f.projects.map(p => p.name)) + '.');
  else s.push('Scope, budget and schedule will fill in as the design takes shape.');
  if (f.budget.priced) s.push('The likely cost is ' + fmtMoney(f.budget.likely) + (f.budget.low !== f.budget.high ? ', within a range of ' + fmtMoney(f.budget.low) + ' to ' + fmtMoney(f.budget.high) : '') + '.');
  if (f.days > 0) s.push('The work takes about ' + plural(f.days, 'working day') + (f.start ? ' from ' + fmtDate(f.start) : '') + '.');
  if (f.products.length) s.push(plural(f.products.length, 'product') + ' ' + (f.products.length === 1 ? 'is' : 'are') + ' specified, such as ' + list(f.products.slice(0, 2).map(p => [p.brand, p.name].filter(Boolean).join(' ')), 2) + '.');
  const highlights = [];
  for (const p of f.projects.slice(0, MAX_HIGHLIGHTS)) highlights.push(p.name + (p.priced ? ': ' + fmtMoney(p.likely) + ' likely' : p.items ? ': ' + plural(p.items, 'scope item') : ''));
  if (!highlights.length) for (const r of f.rooms.slice(0, MAX_HIGHLIGHTS)) {
    const a = Math.abs(polyArea(r.pts));
    highlights.push((r.name || 'Room') + (a > 0 ? ': ' + fmtArea(a) : ''));
  }
  return { headline: clean(headline, MAX_TEXT.headline), tagline: clean(tagline, MAX_TEXT.tagline), summary: s.join(' ').slice(0, MAX_TEXT.summary), highlights: highlights.map(h => clean(h, MAX_TEXT.highlight)) };
}

function polyArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]; s += x1 * y2 - x2 * y1; }
  return s / 2;
}

// Put the drafted text on the property. Hand-edited text stays unless `force`; a record with
// no text yet is always drafted. Returns true when the record changed.
export function draftOnePager(prop, data, { force = false } = {}) {
  const o = prop.onePager || normalizeOnePager(prop);
  if (o.customized && !force) return false;
  const t = draftText(onePagerFacts(prop, data));
  const same = o.headline === t.headline && o.tagline === t.tagline && o.summary === t.summary && o.highlights.join('\n') === t.highlights.join('\n');
  if (same && o.draftedAt) return false;
  Object.assign(o, t, { customized: false, draftedAt: new Date().toISOString() });
  return true;
}

// ---------- what changed ----------

// A cheap signature of a project file's content that ignores the one-pager itself and the
// bytes of pictures (only their sizes), so it reads the same wherever the file is opened.
export function projectSignature(slice) {
  const s = JSON.stringify(slice, (k, v) => {
    if (k === 'onePager') return undefined;
    if ((k === 'thumb' || k === 'img') && typeof v === 'string') return v.length;
    return v;
  });
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36) + ':' + s.length;
}

// 'none' (no version saved), 'current' (the newest version is of this project) or 'behind'.
export function onePagerState(prop, slice) {
  const o = prop && prop.onePager;
  if (!o || !o.versions.length) return 'none';
  return o.basedOn && o.basedOn === projectSignature(slice) ? 'current' : 'behind';
}

export function shouldAskOnClose(prop, slice, mode) {
  if (!prop) return false;
  const m = PROMPT_MODES.some(([k]) => k === mode) ? mode : DEFAULT_PROMPT;
  if (m === 'never') return false;
  if (m === 'always') return true;
  return onePagerState(prop, slice) !== 'current';
}

// Record a saved version: the document it became and the project it was made of.
export function recordVersion(prop, slice, documentId, date = isoToday()) {
  const o = prop.onePager || normalizeOnePager(prop);
  const n = (latestVersion(prop)?.n || 0) + 1;
  const v = { n, date, documentId: documentId || '' };
  o.versions.push(v);
  o.updatedAt = new Date().toISOString();
  o.basedOn = projectSignature(slice);
  return v;
}

const safeName = s => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Property';
export function versionFileName(prop, n, date = isoToday()) {
  return safeName(prop.name) + ' - one-pager v' + n + ' - ' + date + '.pdf';
}

// One line on where the one-pager stands, for panels and prompts.
export function onePagerStatus(prop, slice) {
  const v = latestVersion(prop);
  if (!v) return { state: 'none', text: 'No one-pager saved yet.' };
  const state = onePagerState(prop, slice);
  const when = v.date ? ' saved ' + fmtDate(v.date) : '';
  return { state, version: v, text: 'Version ' + v.n + when + (state === 'behind' ? '; the project changed since.' : '; current.') };
}
