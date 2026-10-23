// Subprojects: a project's parent link, priority, room and source survive a project file and
// a hand-edited or hostile one cannot nest deeper than one level, loop, or cross properties.
// Run: node test/subprojects.test.mjs   (no browser; IndexedDB is stubbed out)

globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
const { ws, projectSlice, mergeWorkspace, emptyWorkspace, subprojectsOf, projectLabel, projectById } = store;

let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };
const project = (id, propertyId, extra) => Object.assign({ id, name: id, propertyId, category: 'other', status: 'idea', selected: false, startDate: '', notes: '', items: [] }, extra);

ws.data = emptyWorkspace();
const A = store.propertyTemplate('House A'), B = store.propertyTemplate('House B');
A.rooms.push({ id: 'r-a-bath', level: A.levels[0].id, name: 'Bath', pts: [[0, 0], [2, 0], [2, 2], [0, 2]], material: null, ceilingMaterial: null });
ws.data.properties.push(A, B);
ws.data.projects.push(
  project('proj-list', A.id, { name: 'House list', priority: 'medium' }),
  project('proj-door', A.id, { name: 'Door sticks', parentId: 'proj-list', priority: 'high', roomId: 'r-a-bath', source: 'Note "House list", line 2' }),
  project('proj-shelf', A.id, { name: 'Shelf', parentId: 'proj-list', priority: 'low', status: 'done' }),
  project('proj-b', B.id, { name: 'House B work' }),
);

// A project file carries the parent and every subproject with their fields.
const fileJson = JSON.parse(JSON.stringify(projectSlice(A.id)));
check(fileJson.projects.map(p => p.id).join() === 'proj-list,proj-door,proj-shelf', 'the project file holds the project and both subprojects (' + fileJson.projects.map(p => p.id).join() + ')');
ws.data = emptyWorkspace();
ws.data.properties.push(B);
ws.data.projects.push(project('proj-b', B.id, { name: 'House B work' }));
mergeWorkspace(fileJson, { fromFile: true });
const door = projectById('proj-door');
check(door && door.parentId === 'proj-list' && door.priority === 'high' && door.roomId === 'r-a-bath' && door.source === 'Note "House list", line 2',
  'opening the file keeps the parent, priority, room and source');
check(subprojectsOf(projectById('proj-list')).map(p => p.id).join() === 'proj-door,proj-shelf', 'subprojectsOf lists the children in order');
check(projectLabel(door) === 'House list / Door sticks' && projectLabel(projectById('proj-list')) === 'House list', 'labels name the parent of a subproject only');
check(projectById('proj-b').parentId === '' && projectById('proj-b').priority === '' && projectById('proj-b').roomId === '' && projectById('proj-b').source === '',
  'an older project gains empty subproject fields');

// Bad links from a hand-edited file: each one becomes a project of its own.
ws.data = emptyWorkspace();
mergeWorkspace({
  properties: [A, B],
  projects: [
    project('p-top', A.id),
    project('p-ok', A.id, { parentId: 'p-top' }),
    project('p-grandchild', A.id, { parentId: 'p-ok' }),
    project('p-self', A.id, { parentId: 'p-self' }),
    project('p-missing', A.id, { parentId: 'p-nowhere' }),
    project('p-cross', B.id, { parentId: 'p-top' }),
    project('p-loop-1', A.id, { parentId: 'p-loop-2' }),
    project('p-loop-2', A.id, { parentId: 'p-loop-1' }),
    project('p-odd', A.id, { parentId: 7, priority: 'urgent', roomId: null, source: { x: 1 } }),
  ],
});
const parentOf = id => projectById(id).parentId;
check(parentOf('p-ok') === 'p-top', 'a valid parent link is kept');
check(parentOf('p-grandchild') === '', 'a subproject of a subproject becomes a project of its own');
check(parentOf('p-self') === '' && parentOf('p-missing') === '' && parentOf('p-cross') === '', 'links to itself, to a missing project or across properties are dropped');
const loop = [parentOf('p-loop-1'), parentOf('p-loop-2')];
check(loop.filter(Boolean).length <= 1, 'a two-project loop is broken (' + loop.join() + ')');
check(ws.data.projects.every(p => !p.parentId || !projectById(p.parentId).parentId), 'no parent is itself a subproject');
const odd = projectById('p-odd');
check(odd.parentId === '' && odd.priority === '' && odd.roomId === '' && odd.source === '', 'wrong-typed fields fall back to empty');

// An id that is not an id is regenerated; the subprojects follow it to the new id.
ws.data = emptyWorkspace();
mergeWorkspace({ properties: [A], projects: [project('bad id <x>', A.id, { name: 'Renamed parent' }), project('p-child', A.id, { parentId: 'bad id <x>' })] });
const renamed = ws.data.projects.find(p => p.name === 'Renamed parent');
check(renamed.id !== 'bad id <x>' && projectById('p-child').parentId === renamed.id, 'a regenerated parent id is followed by its subproject');

if (failed) { console.error(failed + ' check(s) failed'); process.exit(1); }
