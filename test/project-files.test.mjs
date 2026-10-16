// Project files: the slice of a workspace that is one property, and merging it back.
// Run: node test/project-files.test.mjs   (no browser; IndexedDB is stubbed out)

globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
const { ws, projectSlice, mergeWorkspace, projectFileName, emptyWorkspace } = store;

let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };

// A workspace with two properties, projects on each, a product specified on one, a custom material.
ws.data = emptyWorkspace();
const A = store.propertyTemplate('House A'), B = store.propertyTemplate('House B');
A.walls.push({ id: 'w-a1', level: A.levels[0].id, ax: 0, ay: 0, bx: 4, by: 0, thickness: 0.114, height: null, material: 'mat-custom-1' });
A.rooms.push({ id: 'r-a1', level: A.levels[0].id, name: 'Room 1', pts: [[0, 0], [4, 0], [4, 3], [0, 3]], material: null, ceilingMaterial: null });
A.levels[0].plan = { img: 'data:image/webp;base64,AAAA', imgW: 10, imgH: 10, mPerPx: 0.1, offsetX: 0, offsetY: 0, opacity: 0.6, calibrated: true };
ws.data.properties.push(A, B);
ws.data.materials.push({ id: 'mat-custom-1', name: 'Custom plaster', kind: 'wall', color: '#ccc', custom: true }, { id: 'mat-custom-2', name: 'Unused', kind: 'wall', color: '#ccc', custom: true });
ws.data.projects.push(
  { id: 'proj-a', name: 'Kitchen A', propertyId: A.id, category: 'kitchen', status: 'idea', selected: false, startDate: '', notes: '', items: [{ id: 'it-a1', name: 'Cabinets', qty: 1, unit: 'ls', low: 0, likely: 0, high: 0, durationDays: 0, deps: [], elementIds: ['w-a1'], notes: '' }] },
  { id: 'proj-b', name: 'Bath B', propertyId: B.id, category: 'bath', status: 'idea', selected: false, startDate: '', notes: '', items: [{ id: 'it-b1', name: 'Tile', qty: 1, unit: 'ls', low: 0, likely: 0, high: 0, durationDays: 0, deps: [], elementIds: [], notes: '' }] },
);
ws.data.products.push(
  { id: 'prod-a', name: 'Range', brand: '', model: '', category: 'appliance', url: '', price: 1, unit: 'ea', imageUrl: '', specs: '', notes: '', itemIds: ['it-a1'] },
  { id: 'prod-material', name: 'Sourced plaster', price: 42, itemIds: [], materialIds: ['mat-custom-1'], research: { source: 'synthetic', url: 'https://example.com/plaster' } },
  { id: 'prod-b', name: 'Tile', brand: '', model: '', category: 'tile', url: '', price: 1, unit: 'sf', imageUrl: '', specs: '', notes: '', itemIds: ['it-b1'] },
);

const slice = projectSlice(A.id);
check(slice.properties.length === 1 && slice.properties[0].id === A.id, 'slice holds only House A');
check(slice.projects.length === 1 && slice.projects[0].id === 'proj-a', 'slice holds only the projects of House A');
check(slice.products.length === 2 && slice.products.some(p => p.id === 'prod-a') && slice.products.some(p => p.id === 'prod-material'), 'slice holds products specified by scope and by property materials');
check(slice.materials.length === 1 && slice.materials[0].id === 'mat-custom-1', 'slice holds only the custom materials House A uses');
check(slice.settings.activePropertyId === A.id && slice.settings.units === ws.data.settings.units, 'slice settings point at the property and keep units');
check(slice.properties[0].levels[0].plan.img.startsWith('data:image/webp'), 'slice carries the underlay inline');
check(projectFileName({ name: 'Elm St: "front/back"?' }) === 'Elm St front back.tiksi', 'file name is made safe (' + projectFileName({ name: 'Elm St: "front/back"?' }) + ')');

// Open the file into another workspace that already has an older copy of House A and its own House C.
const fileJson = JSON.parse(JSON.stringify(slice));
ws.data = emptyWorkspace();
const oldA = JSON.parse(JSON.stringify(A)); oldA.name = 'House A (old)'; oldA.walls = [];
const C = store.propertyTemplate('House C');
ws.data.properties.push(oldA, C);
ws.data.projects.push({ id: 'proj-a', name: 'Kitchen A (old)', propertyId: A.id, category: 'kitchen', status: 'idea', selected: false, startDate: '', notes: '', items: [] });
ws.data.settings.units = 'metric';
const ids = mergeWorkspace(fileJson);
check(ids.length === 1 && ids[0] === A.id, 'merge reports the property that landed');
check(ws.data.properties.length === 2, 'merge replaced the old copy instead of adding a third property (' + ws.data.properties.length + ')');
const merged = ws.data.properties.find(p => p.id === A.id);
check(merged.name === 'House A' && merged.walls.length === 1, 'merge took the file\'s version of House A');
check(ws.data.projects.find(p => p.id === 'proj-a').name === 'Kitchen A', 'merge replaced the project by id');
check(ws.data.products.some(p => p.id === 'prod-a'), 'merge added the product');
check(ws.data.materials.some(m => m.id === 'mat-custom-1'), 'merge added the custom material');
check(ws.data.settings.units === 'metric', 'merge left the workspace settings alone');
check(ws.data.settings.activePropertyId === A.id, 'merge made the opened property active');
check(ws.data.properties.some(p => p.id === C.id), 'merge kept the other property');

// A project file is a full snapshot: deleted scope projects must not reappear on reopen.
ws.data.projects.push({ id: 'stale-project', name: 'Removed scope', propertyId: A.id, items: [] });
mergeWorkspace(fileJson);
check(!ws.data.projects.some(p => p.id === 'stale-project'), 'merge removes projects deleted from the opened property snapshot');
check(store.itemTotals({ qty: 0, low: 50, likely: 100, high: 200 }).likely === 0, 'zero quantity has zero cost');
check(store.itemTotals({ likely: 100 }).likely === 100, 'missing quantity still defaults to one');
// A project file keeps every custom material it was opened with, used or not, and its schedule start.
ws.data = emptyWorkspace();
const D = store.propertyTemplate('House D'), E = store.propertyTemplate('House E');
D.walls.push({ id: 'w-d1', level: D.levels[0].id, ax: 0, ay: 0, bx: 4, by: 0, thickness: 0.114, height: null, material: 'mat-d-used' });
ws.data.properties.push(D, E);
ws.data.settings.programStart = '2026-11-01';
ws.data.materials.push(
  { id: 'mat-d-used', name: 'Used stucco', kind: 'wall', color: '#ddd', custom: true, propertyIds: [D.id] },
  { id: 'mat-d-roof', name: 'Shingles, unassigned', kind: 'any', color: '#333', custom: true, propertyIds: [D.id, E.id] },
  { id: 'mat-e-only', name: 'Kept by House E', kind: 'any', color: '#444', custom: true, propertyIds: [E.id] },
  { id: 'mat-loose', name: 'Kept by nobody', kind: 'any', color: '#555', custom: true },
);
ws.data.products.push({ id: 'prod-roof', name: 'Shingle quote', price: 3, itemIds: [], materialIds: ['mat-d-roof'] });
const dSlice = JSON.parse(JSON.stringify(projectSlice(D.id)));
check(dSlice.materials.map(m => m.id).sort().join() === 'mat-d-roof,mat-d-used', 'slice keeps the custom materials its property keeps, used or not (' + dSlice.materials.map(m => m.id).join() + ')');
check(dSlice.materials.every(m => !('propertyIds' in m)), 'slice leaves the browser\'s owner list out of the file');
check(dSlice.products.some(p => p.id === 'prod-roof'), 'slice keeps products sourced for a kept material');
check(dSlice.settings.programStart === '2026-11-01', 'slice writes the schedule start');
// A file written before owner lists existed: one material used, two used by nothing.
dSlice.materials.push({ id: 'mat-d-cabinet', name: 'Cabinets, unassigned', kind: 'any', color: '#222', custom: true });

// Open it in another browser: a different schedule start, and a House F that keeps the roof material too.
ws.data = emptyWorkspace();
const F = store.propertyTemplate('House F');
ws.data.properties.push(F);
ws.data.settings.programStart = '2026-10-30';
ws.data.settings.units = 'metric';
ws.data.materials.push({ id: 'mat-d-roof', name: 'Shingles, old copy', kind: 'any', color: '#333', custom: true, propertyIds: [F.id] });
mergeWorkspace(dSlice, { fromFile: true });
check(ws.data.settings.programStart === '2026-11-01', 'opening a project file brings its schedule start (' + ws.data.settings.programStart + ')');
check(ws.data.settings.units === 'metric', 'opening a project file leaves the other settings alone');
const owners = id => (ws.data.materials.find(m => m.id === id) || {}).propertyIds || [];
check(['mat-d-used', 'mat-d-roof', 'mat-d-cabinet'].every(id => owners(id).includes(D.id)), 'every custom material in the file is kept with its property');
check(owners('mat-d-roof').includes(F.id) && ws.data.materials.find(m => m.id === 'mat-d-roof').name === 'Shingles, unassigned', 'the file\'s copy replaces the record and other properties keep it too');
const resaved = projectSlice(D.id);
check(resaved.materials.map(m => m.id).sort().join() === 'mat-d-cabinet,mat-d-roof,mat-d-used', 'saving the opened file writes back every custom material it carried (' + resaved.materials.map(m => m.id).join() + ')');
check(resaved.settings.programStart === '2026-11-01', 'saving the opened file writes back its schedule start');
check(projectSlice(F.id).materials.map(m => m.id).join() === 'mat-d-roof', 'another property\'s file keeps only what it keeps');

// Only an opened project file moves the schedule start: not a demo merge, not a file without a start.
ws.data.settings.programStart = '2026-10-30';
mergeWorkspace(Object.assign({}, dSlice, { settings: Object.assign({}, dSlice.settings, { programStart: '2027-01-15' }) }));
check(ws.data.settings.programStart === '2026-10-30', 'a merge that is not an opened file keeps the schedule start');
mergeWorkspace(Object.assign({}, dSlice, { settings: { units: 'imperial' } }), { fromFile: true });
check(ws.data.settings.programStart === '2026-10-30', 'a file without a schedule start keeps the browser\'s');
mergeWorkspace(Object.assign({}, dSlice, { settings: { programStart: 'Nov 1' } }), { fromFile: true });
check(ws.data.settings.programStart === '2026-10-30', 'a malformed schedule start is ignored');
// A workspace bundle names no single owner, so its untagged materials stay untagged.
ws.data = emptyWorkspace();
const G = store.propertyTemplate('House G'), H = store.propertyTemplate('House H');
mergeWorkspace({ settings: { programStart: '2027-02-01' }, properties: [G, H], materials: [{ id: 'mat-shared', name: 'Shared', kind: 'any', color: '#666', custom: true }], products: [], projects: [] }, { fromFile: true });
check(!owners('mat-shared').length && ws.data.settings.programStart !== '2027-02-01', 'a multi-property workspace file assigns no owners and keeps the schedule start');

const unchanged = JSON.stringify(ws.data);
let malformed = false;
try { mergeWorkspace({ properties: [{ id: 'bad', walls: 'not a list' }] }); } catch (e) { malformed = true; }
check(malformed && JSON.stringify(ws.data) === unchanged, 'malformed project rejected before workspace mutation');

console.log(failed ? failed + ' check(s) failed' : 'all checks passed');
process.exit(failed ? 1 : 0);
