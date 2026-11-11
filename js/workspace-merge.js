// Three-way merge of JSON workspace records. Conflicting edits are reported;
// stale browsers never silently replace a newer revision.
// Equal as JSON (what is saved), compared in place: no serialization, shared objects
// short-circuit, and the first difference ends the walk. Key order does not matter;
// undefined fields are absent and non-finite numbers are null, as in JSON.
export function sameJson(a, b) {
  if (a === b) return true;
  const ta = typeof a, tb = typeof b;
  if (ta === 'number' && tb === 'number') return !Number.isFinite(a) && !Number.isFinite(b);
  if (ta === 'number' && !Number.isFinite(a)) return b === null;
  if (tb === 'number' && !Number.isFinite(b)) return a === null;
  if (ta !== 'object' || tb !== 'object' || a === null || b === null) return false;
  if (typeof a.toJSON === 'function' || typeof b.toJSON === 'function') return JSON.stringify(a) === JSON.stringify(b);
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameJson(slot(a[i]), slot(b[i]))) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  let count = 0;
  for (const k in a) {
    const v = a[k];
    if (v === undefined || typeof v === 'function') continue;
    count++;
    if (!sameJson(v, field(b, k))) return false;
  }
  for (const k in b) { const v = b[k]; if (v !== undefined && typeof v !== 'function') count--; }
  return count === 0;
}
const slot = v => v === undefined || typeof v === 'function' ? null : v;
const field = (o, k) => { const v = Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined; return typeof v === 'function' ? undefined : v; };
const equal = (a, b) => a === undefined || b === undefined ? a === b : sameJson(a, b);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
// Fields whose parts only mean something together: a photo's camera view (position, target and
// lens) merges whole, so two devices' views conflict instead of mixing into a third view. A pin
// (its point and its wall place) and a lens are whole for the same reason.
const WHOLE = new Set(['view', 'pin', 'lens', 'wall']);
const DRAFTED = new Set(['headline', 'tagline', 'summary', 'highlights', 'draftedAt']);
const keyed = v => Array.isArray(v) && v.every(r => object(r) && typeof r.id === 'string') && new Set(v.map(r => r.id)).size === v.length;

export function mergeShared(base, local, remote) {
  const conflicts = [];
  function merge(b, l, r, path, field) {
    if (equal(l, r) || equal(b, r)) return l;
    if (equal(b, l)) return r;
    if (object(l) && object(r) && (b === undefined || object(b)) && !WHOLE.has(field)) {
      // The drafted text of a one-pager nobody wrote by hand comes from the project, written
      // by whichever page opens it. Two different drafts are not two people's work: for the
      // drafted fields the saved one stays, unasked, and the next page to open drafts again
      // from the merged project. Everything else on the one-pager (client, prepared by,
      // contact, picture, section switches, versions) is entered by hand and merges as usual.
      const drafts = field === 'onePager' && l.customized !== true && r.customized !== true;
      const out = {};
      for (const key of new Set([...Object.keys(b || {}), ...Object.keys(l), ...Object.keys(r)])) {
        const both = drafts && DRAFTED.has(key) && !equal(l[key], r[key]) && !equal(b?.[key], r[key]) && !equal(b?.[key], l[key]);
        const value = both ? r[key] : merge(b?.[key], l[key], r[key], [...path, key], key);
        if (value !== undefined) out[key] = value;
      }
      return out;
    }
    if (keyed(l) && keyed(r) && (b === undefined || keyed(b))) {
      const bm = new Map((b || []).map(v => [v.id, v]));
      const lm = new Map(l.map(v => [v.id, v])), rm = new Map(r.map(v => [v.id, v]));
      return [...new Set([...r.map(v => v.id), ...l.map(v => v.id), ...bm.keys()])].map(id => merge(bm.get(id), lm.get(id), rm.get(id), [...path, id])).filter(v => v !== undefined);
    }
    conflicts.push(path.join('.'));
    return l;
  }
  return { value: merge(base, local, remote, []), conflicts };
}
