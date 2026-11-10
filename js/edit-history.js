// One session history per project, shared by PLAN and MODEL. Disk acknowledgments
// replace workspace objects but keep this history; opening a file starts a new one.
import { ws, onChange, onWorkspaceReplace, touch } from './store.js';
import { GeometryHistory } from './geometry-history.js';

const histories = new WeakMap(), listeners = new Set();
// Every change bumps the revision; the undo and redo buttons are worked out at most once per
// revision, however many times they are asked for.
let revision = 0;
const stateCache = new WeakMap();   // history -> {revision, prop, value}
const notify = () => { for (const fn of listeners) fn(); };
function history(prop, create = false) {
  if (!prop || !ws.data) return null;
  let map = histories.get(ws.data);
  if (!map && create) histories.set(ws.data, map = new Map());
  if (map && !map.has(prop.id) && create) map.set(prop.id, new GeometryHistory());
  return map?.get(prop.id) || null;
}
export function beginGeometryEdit(prop, label) { revision++; history(prop, true)?.begin(prop, label); }
export function cancelGeometryEdit(prop) { const h = history(prop); if (h) h.pending = null; }
export function onEditHistoryChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function editHistoryState(prop) {
  const h = history(prop);
  if (!h) return { undo: { available: false }, redo: { available: false } };
  const hit = stateCache.get(h);
  if (hit && hit.revision === revision && hit.prop === prop) return hit.value;
  const value = h.states(prop);
  stateCache.set(h, { revision, prop, value });
  return value;
}
export function restoreGeometryEdit(prop, direction) {
  revision++;
  if (!history(prop)?.restore(prop, direction)) return false;
  touch(); notify(); return true;
}
onChange(() => {
  revision++;
  const map = histories.get(ws.data);
  if (!map) return;
  for (const prop of ws.data.properties) map.get(prop.id)?.commit(prop);
  notify();
});
onWorkspaceReplace((before, after, source) => {
  revision++;
  if (source === 'shared' && histories.has(before)) histories.set(after, histories.get(before));
  else histories.delete(after);
});
