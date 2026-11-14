// The browser half of test/test_scene_sync.py: a synthetic property with the standard views and
// one view of its own, written into SketchUp sync files and merged back as syncMirror does it
// (js/sketchup-mirror.js). Its state lives in a JSON file between calls:
//   node test/scene-sync-driver.mjs init STATE
//   node test/scene-sync-driver.mjs spec STATE MIRROR.json     (then: written, as after a write)
//   node test/scene-sync-driver.mjs merge STATE READ.json      (prints what changed)
//   node test/scene-sync-driver.mjs tiksi-move STATE VIEW-NAME (Tiksi moves that view's camera)
import { readFileSync, writeFileSync } from 'node:fs';

globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
const tags = await import('../js/tags.js');
const mirror = await import('../js/sketchup-mirror.js');
const { refreshStandardViews } = await import('../js/standard-views.js');
const { addSavedView } = await import('../js/saved-views.js');

const [op, file, arg] = process.argv.slice(2);
const load = () => JSON.parse(readFileSync(file, 'utf8'));
const save = s => writeFileSync(file, JSON.stringify(s));
const summary = (s, r) => ({
  applied: r ? r.applied.map(id => s.prop.savedViews.find(v => v.id === id)?.name || id) : [],
  added: r ? r.added.map(id => s.prop.savedViews.find(v => v.id === id)?.name || id) : [],
  deleted: r ? r.deleted.length : 0, conflicts: r ? r.conflicts.map(c => c.reason) : [],
  views: s.prop.savedViews.map(v => ({ id: v.id, name: v.name, camera: v.camera, tags: v.tags, hiddenLevels: v.hiddenLevels, section: v.section, standard: !!v.standard, source: v.source || null })),
});

if (op === 'init') {
  const p = store.propertyTemplate('Scene sync');
  p.id = 'prop-scenes';
  const L = p.levels[0].id;
  const wall = (id, ax, ay, bx, by) => ({ id, level: L, ax, ay, bx, by, thickness: 0.1, height: null, material: 'mat-drywall' });
  p.walls.push(wall('w-s', 0, 0, 4, 0), wall('w-e', 4, 0, 4, 3), wall('w-n', 4, 3, 0, 3), wall('w-w', 0, 3, 0, 0));
  p.rooms.push({ id: 'r-1', level: L, name: 'Studio', pts: [[0, 0], [4, 0], [4, 3], [0, 3]], material: 'mat-oak' });
  const furniture = tags.addTag(p, 'Furniture');
  refreshStandardViews(p);
  // A view of the owner's own: perspective, Furniture hidden.
  furniture.visible = false;
  addSavedView(p, 'Corner look', { camera: { position: [3.5, 1.6, 2.5], target: [0.5, 1.2, 0.5], fov: 55 }, mode: 'orbit', section: { on: false, height: 1.2 }, xray: false, hiddenLevels: [] });
  furniture.visible = true;
  // A view made from an imported model's scene belongs to that model, not to the sync file.
  p.scans = [{ id: 'scan-a', name: 'Cellar.skp', pos: [0, 0, 0] }];
  p.savedViews.push({ ...p.savedViews[0], id: 'view-imported', name: 'Imported scene', source: { app: 'sketchup', scan: 'scan-a', scene: 'A1' }, standard: undefined });
  delete p.savedViews.at(-1).standard;
  save({ prop: p, synced: {}, seen: {} });
  console.log(JSON.stringify(summary(load(), null)));
} else if (op === 'spec') {
  const s = load();
  writeFileSync(arg, JSON.stringify(mirror.mirrorSpec(s.prop, [])));
  s.synced = mirror.syncedState(s.prop);
  save(s);
} else if (op === 'merge') {
  const s = load();
  const r = mirror.mergeMirror(s.prop, JSON.parse(readFileSync(arg, 'utf8')), s.synced, s.seen);
  s.seen = r.seen; s.synced = mirror.syncedState(s.prop);
  save(s);
  console.log(JSON.stringify(summary(s, r)));
} else if (op === 'tiksi-move') {
  const s = load();
  const v = s.prop.savedViews.find(x => x.name === arg);
  v.camera.target = [v.camera.target[0] + 0.5, v.camera.target[1], v.camera.target[2]];
  v.camera.position = [v.camera.position[0] + 0.5, v.camera.position[1], v.camera.position[2]];
  save(s);
} else throw new Error('unknown operation ' + op);
