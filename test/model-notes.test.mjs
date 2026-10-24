// Notes pinned in the model (property.notePins) and the PHOTOS / NOTES switches, as files
// carry them in and out. Run: node test/model-notes.test.mjs   (no browser; IndexedDB stubbed)

globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
const { ws, emptyWorkspace, mergeWorkspace, projectSlice } = store;

let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };

// A new property starts with no notes and both kinds of marker shown.
const fresh = store.propertyTemplate('Fresh');
check(Array.isArray(fresh.notePins) && fresh.notePins.length === 0, 'a new property has an empty note list');
check(fresh.env.showPins === true && fresh.env.showNotes === true, 'photo pins and notes start shown');
check(fresh.notes === '', 'the property\'s own free-text notes stay a separate field');

// A file written before notes existed opens with an empty list and both switches on.
ws.data = emptyWorkspace();
const old = store.propertyTemplate('Older file');
delete old.notePins; old.env = { time: 10 };
const [oldId] = mergeWorkspace({ properties: [old], materials: [], products: [], projects: [] }, { fromFile: true });
const opened = ws.data.properties.find(p => p.id === oldId);
check(Array.isArray(opened.notePins) && opened.notePins.length === 0, 'an older file opens with no notes');
check(opened.env.showPins === true && opened.env.showNotes === true && opened.env.time === 10, 'older environments gain the switches and keep their values');

// Notes are cleaned on the way in: no position, no note; missing fields get defaults; bad ids are replaced
// and references to them follow.
ws.data = emptyWorkspace();
const P = store.propertyTemplate('With notes');
P.env.showPins = false;
P.rooms.push({ id: 'r-1', level: P.levels[0].id, name: 'Hall', pts: [[0, 0], [3, 0], [3, 3], [0, 3]], material: null, ceilingMaterial: null });
P.notePins = [
  { id: 'note-ok', text: 'Patch the plaster', x: 1, y: 0, z: 2, nx: 0, ny: 1, nz: 0, roomId: 'r-1', elementIds: ['r-1'], createdAt: '2026-10-01T00:00:00.000Z' },
  { id: 'note-bare', x: '1.5', y: 1.2, z: 0.05 },
  { id: 'note-nowhere', text: 'Lost', x: null, y: 0, z: 0 },
  { id: 'bad id with spaces', text: 'Renamed', x: 0, y: 0, z: 0 },
];
const [pid] = mergeWorkspace({ properties: [P], materials: [], products: [], projects: [] }, { fromFile: true });
const got = ws.data.properties.find(p => p.id === pid);
check(got.notePins.length === 3 && !got.notePins.some(n => n.id === 'note-nowhere'), 'a note without a position is dropped');
const bare = got.notePins.find(n => n.id === 'note-bare');
check(bare && bare.x === 1.5 && bare.text === '' && bare.ny === 1 && bare.nx === 0 && Array.isArray(bare.elementIds) && bare.roomId === '', 'a bare note gets numeric coordinates, an up normal and empty links');
const renamed = got.notePins.find(n => n.text === 'Renamed');
check(renamed && /^note-/.test(renamed.id), 'an invalid note id is replaced (' + (renamed && renamed.id) + ')');
check(got.env.showPins === false, 'a hidden-pins switch is kept');

// The project file carries the notes and the switches back out.
const slice = projectSlice(pid);
const out = slice.properties[0];
check(out.notePins.length === 3 && out.notePins[0].text === 'Patch the plaster' && out.notePins[0].roomId === 'r-1', 'the project file holds the notes with their room links');
check(out.env.showPins === false && out.env.showNotes === true, 'the project file holds both switches');

// A malformed list is refused before the workspace changes.
const unchanged = JSON.stringify(ws.data);
let refused = false;
try { mergeWorkspace({ properties: [{ id: 'bad', notePins: 'not a list' }] }); } catch (e) { refused = true; }
check(refused && JSON.stringify(ws.data) === unchanged, 'notePins that is not a list is rejected');
refused = false;
try { mergeWorkspace({ properties: [{ id: 'bad', notePins: [['x', 1]] }] }); } catch (e) { refused = true; }
check(refused && JSON.stringify(ws.data) === unchanged, 'a note that is not a record is rejected');

console.log(failed ? failed + ' check(s) failed' : 'all checks passed');
process.exit(failed ? 1 : 0);
