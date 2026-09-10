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
  { id: 'prod-b', name: 'Tile', brand: '', model: '', category: 'tile', url: '', price: 1, unit: 'sf', imageUrl: '', specs: '', notes: '', itemIds: ['it-b1'] },
);

const slice = projectSlice(A.id);
check(slice.properties.length === 1 && slice.properties[0].id === A.id, 'slice holds only House A');
check(slice.projects.length === 1 && slice.projects[0].id === 'proj-a', 'slice holds only the projects of House A');
check(slice.products.length === 1 && slice.products[0].id === 'prod-a', 'slice holds only the products specified for House A');
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

console.log(failed ? failed + ' check(s) failed' : 'all checks passed');
process.exit(failed ? 1 : 0);
