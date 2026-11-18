// Undo and redo for a property's projects: their scope items, prices, subprojects and estimate
// settings, bids and terms, whichever page changed them (PROJECTS, ESTIMATE, DOCUMENTS, the model's
// ADD TO menu). MODEL and MEASURE keep their own geometry history (edit-history.js).
//
// After each change made on this device the property's projects are compared with how they were;
// a difference is one step (changes within a second, such as typing, make one step). Undo puts the
// projects back as they were before that step, but only while they are still exactly as the step
// left them: a change from another device in between blocks it rather than being overwritten.

import { ws, onChange, onWorkspaceReplace, touch, activeProperty } from './store.js';

const STEP_MS = 1000, MAX = 100;
const books = new Map();   // property id -> { base, undo: [], redo: [], at }
let restoring = false, listeners = new Set();
const notify = () => { for (const fn of listeners) { try { fn(); } catch (e) { console.error(e); } } };

const mine = prop => (ws.data.projects || []).filter(p => p.propertyId === prop.id);
const snap = prop => JSON.stringify(mine(prop));
function book(prop) {
  if (!prop) return null;
  let b = books.get(prop.id);
  if (!b) books.set(prop.id, b = { base: snap(prop), undo: [], redo: [], at: 0 });
  return b;
}

function record() {
  if (restoring || !ws.data) return;
  for (const prop of ws.data.properties || []) {
    const b = books.get(prop.id);
    if (!b) { book(prop); continue; }
    const now = snap(prop);
    if (now === b.base) continue;
    const t = Date.now(), last = b.undo[b.undo.length - 1];
    if (last && t - b.at < STEP_MS && last.after === b.base) last.after = now;
    else { b.undo.push({ before: b.base, after: now }); if (b.undo.length > MAX) b.undo.shift(); }
    b.redo = []; b.base = now; b.at = t;
  }
  notify();
}
onChange(record);
// A file opened or a workspace replaced starts afresh; another device's change becomes the new
// starting point (undo then refuses to cross it).
onWorkspaceReplace((before, after, source) => {
  if (source !== 'shared') books.clear();
  else for (const prop of (after && after.properties) || []) { const b = books.get(prop.id); if (b) b.base = JSON.stringify((after.projects || []).filter(p => p.propertyId === prop.id)); }
  notify();
});

export function onProjectHistoryChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function projectHistoryState(prop = activeProperty()) {
  const b = book(prop);   // a property's history starts the first time a page asks for it
  const now = b && (b.undo.length || b.redo.length) ? snap(prop) : '';
  const side = (list, key) => {
    const e = list[list.length - 1];
    if (!e) return { available: false };
    const blocked = now !== e[key];
    return { available: !blocked, blocked, label: 'the last change to the projects' };
  };
  return b ? { undo: side(b.undo, 'after'), redo: side(b.redo, 'before') } : { undo: { available: false }, redo: { available: false } };
}

function put(prop, json) {
  const list = JSON.parse(json);
  const all = ws.data.projects;
  const at = all.findIndex(p => p.propertyId === prop.id);
  const rest = all.filter(p => p.propertyId !== prop.id);
  rest.splice(at < 0 ? rest.length : Math.min(at, rest.length), 0, ...list);
  ws.data.projects = rest;
}
// Undo or redo one step on the open property. False when there is none, or when the projects
// changed elsewhere since (nothing is touched then).
export function restoreProjectEdit(direction, prop = activeProperty()) {
  const b = prop && books.get(prop.id);
  if (!b) return false;
  const from = direction === 'undo' ? b.undo : b.redo, to = direction === 'undo' ? b.redo : b.undo;
  const e = from[from.length - 1];
  if (!e || snap(prop) !== (direction === 'undo' ? e.after : e.before)) return false;
  from.pop(); to.push(e);
  const target = direction === 'undo' ? e.before : e.after;
  restoring = true;
  try { put(prop, target); b.base = target; b.at = 0; touch(); }
  finally { restoring = false; }
  notify();
  return true;
}
