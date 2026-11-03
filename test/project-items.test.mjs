// Scope item status: an older file's items open as "to do", a known status survives a project
// file, an unknown one is reset, and the priced and done counts come from the items.
// Run: node test/project-items.test.mjs   (no browser; IndexedDB is stubbed out)

globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
const { ws, projectSlice, mergeWorkspace, emptyWorkspace, projectById, projectProgress, itemPriced, ITEM_STATUSES } = store;

let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };
const item = (id, extra) => Object.assign({ id, name: id, qty: 1, unit: 'ea', low: 0, likely: 0, high: 0, durationDays: 0, deps: [], elementIds: [], notes: '' }, extra);

const A = store.propertyTemplate('House A');
ws.data = emptyWorkspace();
// An older file: no item has a status or doneAt; one carries a status from somewhere else.
mergeWorkspace({
  properties: [A],
  projects: [{ id: 'proj-old', name: 'Old', propertyId: A.id, category: 'bath', status: 'idea', selected: false, startDate: '', notes: '',
    items: [item('it-a', { likely: 120 }), item('it-b'), item('it-c', { status: 'finished', doneAt: 5 })] }],
});
const old = projectById('proj-old');
check(old.items.every(it => it.status === 'todo'), 'items without a known status open as todo (' + old.items.map(it => it.status).join() + ')');
check(old.items.every(it => it.doneAt === ''), 'doneAt is an empty string when missing or not text');
check(ITEM_STATUSES.join() === 'todo,ordered,in-progress,done', 'the four item statuses are todo, ordered, in-progress, done');

// Priced means any of low, likely or high above zero; done counts status done only.
old.items[1].high = 40;
old.items[1].status = 'done'; old.items[1].doneAt = '2026-11-03';
old.items[2].status = 'ordered';
const g = projectProgress(old);
check(g.items === 3 && g.priced === 2 && g.done === 1, `progress counts 3 items, 2 priced, 1 done (${g.items}, ${g.priced}, ${g.done})`);
check(itemPriced({ low: 0, likely: '0', high: undefined }) === false && itemPriced({ low: 5 }) === true, 'zero and missing prices do not count as priced');
check(projectProgress({ items: [] }).items === 0, 'an empty project has no items, priced or done');

// The statuses and the done date travel in a project file.
const fileJson = JSON.parse(JSON.stringify(projectSlice(A.id)));
ws.data = emptyWorkspace();
mergeWorkspace(fileJson, { fromFile: true });
const back = projectById('proj-old');
check(back.items.map(it => it.status).join() === 'todo,done,ordered', 'opening the file keeps each item status (' + back.items.map(it => it.status).join() + ')');
check(back.items[1].doneAt === '2026-11-03', 'the done date survives the file');

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('project item status: all passed');
