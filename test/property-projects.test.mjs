// Projects belong to a property: the lists, scope items and program totals follow the active
// property, lookups by id still reach every property, and a project whose property is missing
// stays visible.
// Run: node test/property-projects.test.mjs   (no browser; IndexedDB is stubbed out)

globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
const { ws, emptyWorkspace, propertyProjects, allScopeItems, selectedTotals, itemById } = store;

let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };
const item = (id, likely) => ({ id, name: id, qty: 1, unit: 'ls', low: likely, likely, high: likely, durationDays: 1, deps: [], elementIds: [], notes: '' });
const project = (id, propertyId, extra) => Object.assign({ id, name: id, propertyId, category: 'other', status: 'idea', selected: true, startDate: '', notes: '', items: [] }, extra);
const ids = list => list.map(p => p.id).join();

ws.data = emptyWorkspace();
const A = store.propertyTemplate('House A'), B = store.propertyTemplate('House B');
ws.data.properties.push(A, B);
ws.data.projects.push(
  project('proj-a', A.id, { items: [item('it-a', 1000)] }),
  project('proj-a-sub', A.id, { parentId: 'proj-a', items: [item('it-a-sub', 200)] }),
  project('proj-b', B.id, { items: [item('it-b', 5000)] }),
  project('proj-b-parked', B.id, { selected: false, items: [item('it-b-parked', 70)] }),
);

ws.data.settings.activePropertyId = A.id;
check(ids(propertyProjects()) === 'proj-a,proj-a-sub', 'House A shows its project and subproject only (' + ids(propertyProjects()) + ')');
check(allScopeItems().map(x => x.item.id).join() === 'it-a,it-a-sub', 'scope items come from House A only');
check(selectedTotals().likely === 1200, 'House A program total counts House A only (' + selectedTotals().likely + ')');

ws.data.settings.activePropertyId = B.id;
check(ids(propertyProjects()) === 'proj-b,proj-b-parked', 'switching to House B shows House B projects');
check(selectedTotals().likely === 5000, 'House B program total leaves out its parked project and House A (' + selectedTotals().likely + ')');
check(itemById('it-a') && itemById('it-a').project.id === 'proj-a', 'an item of House A can still be found by id while House B is open');

ws.data.projects.push(project('proj-orphan', 'prop-deleted'), project('proj-none', null));
check(ids(propertyProjects()) === 'proj-b,proj-b-parked,proj-orphan,proj-none', 'projects whose property is missing stay visible');

ws.data.settings.activePropertyId = 'prop-gone';
check(ids(propertyProjects()).startsWith('proj-a,proj-a-sub'), 'an unknown active property falls back to the first property');

ws.data = emptyWorkspace();
ws.data.projects.push(project('proj-loose', null));
check(ids(propertyProjects()) === 'proj-loose', 'with no property at all, every project is shown');

if (failed) { console.error(failed + ' check(s) failed'); process.exit(1); }
