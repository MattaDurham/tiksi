// Geometry transactions contain no image copies. Three-way restoration keeps
// unrelated shared edits and refuses to overwrite a changed field.
import { mergeShared } from './workspace-merge.js';

const clone = value => JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function geometrySnapshot(prop) {
  return {
    data: clone({ id: prop.id, walls: prop.walls, openings: prop.openings, rooms: prop.rooms,
      levels: prop.levels.map(level => ({ ...level, plan: null })), activeLevelId: prop.activeLevelId }),
    plans: Object.fromEntries(prop.levels.map(level => [level.id, level.plan || null])),
  };
}

export class GeometryHistory {
  constructor(limit = 80) { this.limit = limit; this.undo = []; this.redo = []; this.pending = null; }
  begin(prop, label = 'geometry edit') {
    this.commit(prop);
    this.pending = { before: geometrySnapshot(prop), label };
  }
  commit(prop) {
    if (!this.pending) return;
    const { before, label } = this.pending; this.pending = null;
    const after = geometrySnapshot(prop);
    if (before.data.id !== after.data.id || equal(before.data, after.data)) return;
    this.undo.push({ before, after, label });
    if (this.undo.length > this.limit) this.undo.shift();
    this.redo.length = 0;
  }
  candidate(prop, direction) {
    const entry = this[direction].at(-1);
    if (!entry || entry.before.data.id !== prop.id) return null;
    const [base, target] = direction === 'undo' ? [entry.after, entry.before] : [entry.before, entry.after];
    const current = geometrySnapshot(prop).data;
    const result = mergeShared(base.data, target.data, current);
    const walls = new Set(result.value.walls.map(w => w.id)), levels = new Set(result.value.levels.map(l => l.id));
    for (const opening of result.value.openings) if (!walls.has(opening.wallId) && current.walls.some(w => w.id === opening.wallId)) result.conflicts.push('openings.' + opening.id);
    for (const record of [...result.value.walls, ...result.value.rooms]) if (record.level && !levels.has(record.level) && current.levels.some(l => l.id === record.level)) result.conflicts.push('levels.' + record.level);
    return { entry, target, ...result };
  }
  state(prop, direction) {
    const result = this.candidate(prop, direction);
    return { available: !!result && !result.conflicts.length, label: result?.entry.label || '',
      blocked: !!result?.conflicts.length };
  }
  restore(prop, direction) {
    this.commit(prop);
    const result = this.candidate(prop, direction);
    if (!result || result.conflicts.length) return false;
    const plans = Object.fromEntries(prop.levels.map(level => [level.id, level.plan || null]));
    const data = clone(result.value);
    for (const level of data.levels) level.plan = (level.id in plans ? plans[level.id] : result.target.plans[level.id]) || null;
    for (const key of ['walls', 'openings', 'rooms', 'levels', 'activeLevelId']) prop[key] = data[key];
    this[direction].pop(); this[direction === 'undo' ? 'redo' : 'undo'].push(result.entry);
    return true;
  }
}
