// Geometry transactions contain no image copies. Three-way restoration keeps
// unrelated shared edits and refuses to overwrite a changed field.
import { mergeShared } from './workspace-merge.js';

const clone = value => JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function geometrySnapshot(prop) {
  return {
    data: clone({ id: prop.id, walls: prop.walls, openings: prop.openings, rooms: prop.rooms, fixtures: prop.fixtures || [], trims: prop.trims || [],
      levels: prop.levels.map(level => ({ ...level, plan: null })), activeLevelId: prop.activeLevelId }),
    plans: Object.fromEntries(prop.levels.map(level => [level.id, level.plan || null])),
  };
}

export class GeometryHistory {
  constructor(limit = 80) { this.limit = limit; this.undo = []; this.redo = []; this.pending = null; }
  // A held edit (a drag in progress) is not closed by the change events that arrive while it
  // runs; only its owner ends the hold, or a new edit or an undo/redo closes it.
  begin(prop, label = 'geometry edit', { hold = false } = {}) {
    this.commit(prop, true);
    this.pending = { before: geometrySnapshot(prop), label, hold };
  }
  release() { if (this.pending) this.pending.hold = false; }
  commit(prop, force = false) {
    if (!this.pending || (this.pending.hold && !force)) return;
    const { before, label } = this.pending; this.pending = null;
    const after = geometrySnapshot(prop);
    if (before.data.id !== after.data.id || equal(before.data, after.data)) return;
    this.undo.push({ before, after, label });
    if (this.undo.length > this.limit) this.undo.shift();
    this.redo.length = 0;
  }
  // `current` lets one copy of the property's geometry serve both directions.
  candidate(prop, direction, current = null) {
    const entry = this[direction].at(-1);
    if (!entry || entry.before.data.id !== prop.id) return null;
    const [base, target] = direction === 'undo' ? [entry.after, entry.before] : [entry.before, entry.after];
    current = current || geometrySnapshot(prop).data;
    const result = mergeShared(base.data, target.data, current);
    const walls = new Set(result.value.walls.map(w => w.id)), levels = new Set(result.value.levels.map(l => l.id));
    for (const opening of result.value.openings) if (!walls.has(opening.wallId) && current.walls.some(w => w.id === opening.wallId)) result.conflicts.push('openings.' + opening.id);
    for (const record of [...result.value.walls, ...result.value.rooms, ...(result.value.fixtures || [])]) if (record.level && !levels.has(record.level) && current.levels.some(l => l.id === record.level)) result.conflicts.push('levels.' + record.level);
    return { entry, target, ...result };
  }
  state(prop, direction, current = null) {
    const result = this.candidate(prop, direction, current);
    return { available: !!result && !result.conflicts.length, label: result?.entry.label || '',
      blocked: !!result?.conflicts.length };
  }
  // Both buttons from a single copy of the geometry (none when both lists are empty).
  states(prop) {
    const current = this.undo.length || this.redo.length ? geometrySnapshot(prop).data : null;
    return { undo: this.state(prop, 'undo', current), redo: this.state(prop, 'redo', current) };
  }
  // Put the geometry back as it was when the pending edit began and drop the edit: a drag the
  // browser cancelled leaves nothing behind. Underlays stay as they are now (no image copies).
  revert(prop) {
    const pending = this.pending;
    this.pending = null;
    if (!pending || pending.before.data.id !== prop.id) return false;
    const data = clone(pending.before.data);
    const plans = Object.fromEntries(prop.levels.map(level => [level.id, level.plan || null]));
    for (const level of data.levels) level.plan = (level.id in plans ? plans[level.id] : pending.before.plans[level.id]) || null;
    for (const key of ['walls', 'openings', 'rooms', 'fixtures', 'trims', 'levels', 'activeLevelId']) prop[key] = key === 'fixtures' || key === 'trims' ? data[key] || [] : data[key];
    return true;
  }
  restore(prop, direction) {
    this.commit(prop, true);
    const result = this.candidate(prop, direction);
    if (!result || result.conflicts.length) return false;
    const plans = Object.fromEntries(prop.levels.map(level => [level.id, level.plan || null]));
    const data = clone(result.value);
    for (const level of data.levels) level.plan = (level.id in plans ? plans[level.id] : result.target.plans[level.id]) || null;
    for (const key of ['walls', 'openings', 'rooms', 'fixtures', 'trims', 'levels', 'activeLevelId']) prop[key] = key === 'fixtures' || key === 'trims' ? data[key] || [] : data[key];
    this[direction].pop(); this[direction === 'undo' ? 'redo' : 'undo'].push(result.entry);
    return true;
  }
}
