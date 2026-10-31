// Three-way merge of JSON workspace records. Conflicting edits are reported;
// stale browsers never silently replace a newer revision.
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const keyed = v => Array.isArray(v) && v.every(r => object(r) && typeof r.id === 'string') && new Set(v.map(r => r.id)).size === v.length;

export function mergeShared(base, local, remote) {
  const conflicts = [];
  function merge(b, l, r, path) {
    if (equal(l, r) || equal(b, r)) return l;
    if (equal(b, l)) return r;
    if (object(l) && object(r) && (b === undefined || object(b))) {
      const out = {};
      for (const key of new Set([...Object.keys(b || {}), ...Object.keys(l), ...Object.keys(r)])) {
        const value = merge(b?.[key], l[key], r[key], [...path, key]);
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
