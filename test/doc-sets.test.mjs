// Drawing sets (DOCUMENTS): records survive a project file and hostile input, scales and frames
// put the model where the sheet says, section and elevation lines look the right way, and the
// PDF writer produces a file whose cross-reference table points at its objects.
// Run: node test/doc-sets.test.mjs   (no browser; IndexedDB is stubbed out)

globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
const ds = await import('../js/doc-sets.js');

let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

// ---------- records ----------
const set = ds.newSet('Permit set');
check(set.sheets.length === 1 && set.sheets[0].number === 'A1' && set.paper === 'tabloid', 'a new set has one A1 sheet on tabloid paper');
const sheet = set.sheets[0];
const plan = ds.newViewport('plan', { x: 1, y: 1, w: 6, h: 4 }, { levelId: 'lvl-0', center: [2, 3], scale: 48 });
const sec = ds.newViewport('section', { x: 8, y: 1, w: 5, h: 3 }, { line: [0, 0, 4, 0] });
const note = ds.newViewport('text', { x: 1, y: 6, w: 3, h: 2 }, { text: 'NOTES' });
const view = ds.newViewport('view3d', { x: 8, y: 5, w: 5, h: 3 }, { camera: { position: [5, 4, 5], target: [0, 1, 0], fov: 50 } });
sheet.viewports.push(plan, sec, note, view);
ds.numberViewports(set);
check(plan.number === 1 && sec.number === 2 && note.number === 0 && view.number === 3, 'drawing numbers run across the set and skip text (' + [plan.number, sec.number, note.number, view.number] + ')');
check(view.style === 'shaded-lines', 'a 3D view starts shaded with edges');
check(ds.nextSheetNumber(set.sheets) === 'A2' && ds.nextSheetNumber([{ number: '9' }]) === '10' && ds.nextSheetNumber([]) === 'A1', 'sheet numbers count up from the last one');

// Hostile and older files: bad records are dropped or repaired, nothing throws.
const p = { docSets: [set, null, 'x', { name: 7, paper: 'napkin', sheets: [{ viewports: [{ kind: 'nope' }, { kind: 'plan', w: -4, scale: 'big', center: 'here' }, { kind: 'image', page: -3 }] }] }] };
ds.normalizeDocSets(p);
check(p.docSets.length === 2, 'non-object sets are dropped (' + p.docSets.length + ')');
const odd = p.docSets[1];
check(odd.paper === 'tabloid' && odd.name === 'Drawing set' && odd.sheets[0].viewports.length === 2, 'an unknown paper, a bad name and an unknown view kind are repaired or dropped');
const vbad = odd.sheets[0].viewports[0];
check(vbad.w === 0.5 && vbad.scale === 48 && vbad.center.join() === '0,0' && vbad.cut === 1.2, 'a plan view with a negative width, a word for a scale and no centre gets safe values');
check(odd.sheets[0].viewports[1].page === 1, 'a document page below 1 becomes page 1');
const dup = { docSets: [{ id: 'dset-a' }, { id: 'dset-a' }] };
ds.normalizeDocSets(dup);
check(dup.docSets[0].id !== dup.docSets[1].id, 'duplicate set ids are made unique');

// The sets travel in the property's project file and come back after a merge.
store.ws.data = store.emptyWorkspace();
const A = store.propertyTemplate('House A');
A.docSets = [set];
store.ws.data.properties.push(A);
const file = JSON.parse(JSON.stringify(store.projectSlice(A.id)));
check(file.properties[0].docSets.length === 1 && file.properties[0].docSets[0].sheets[0].viewports.length === 4, 'the project file carries the drawing set and its views');
store.ws.data = store.emptyWorkspace();
store.mergeWorkspace(file, { fromFile: true });
const back = store.ws.data.properties.find(x => x.id === A.id);
check(back && back.docSets[0].name === 'Permit set' && back.docSets[0].sheets[0].viewports[1].kind === 'section', 'opening the file restores the set');
check(Array.isArray(store.propertyTemplate('New').docSets), 'a new property has an empty list of drawing sets');

// ---------- scales and frames ----------
check(ds.fitScale(10, 5, 6, 4) === 96, '10 x 5 m in a 6 x 4 in viewport fits at 1/8" = 1\'-0" (' + ds.fitScale(10, 5, 6, 4) + ')');
check(ds.fitScale(1, 1, 6, 4) === 12, 'a small model fits at the largest scale, 1" = 1\'-0"');
check(near(ds.worldSpan(1, 48), 1.2192), 'one paper inch at 1/4" = 1\'-0" is 4 feet of model');
check(ds.nextScale(48, 1) === 64 && ds.nextScale(48, -1) === 32 && ds.nextScale(12, -1) === 12, 'stepping the scale moves one notch and stops at the ends');
const pf = ds.orthoFrame(plan);
check(near(pf.w, 6 * 0.0254 * 48) && pf.center.join() === '2,0,3' && pf.dir.join() === '0,-1,0' && pf.up.join() === '0,0,-1', 'a plan looks straight down at its centre, plan y down the sheet');

// A line running +x looks toward +y; flipped, toward -y; its plane keeps the side it looks at.
const f = ds.lineFrame(sec);
check(near(f.nx, 0) && near(f.ny, 1) && near(f.mx, 2) && near(f.L, 4), 'a section line along +x looks toward +y from its middle');
const sp = ds.sectionPlane(sec);
const keep = (x, z) => sp.normal[0] * x + sp.normal[2] * z + sp.constant;
check(keep(1, 2) > 0 && keep(1, -2) < 0, 'the section keeps what is in front of the cut and drops what is behind it');
const flipped = ds.lineFrame({ ...sec, flip: true });
check(near(flipped.ny, -1), 'LOOK THE OTHER WAY turns the view around');
const sf = ds.orthoFrame({ ...sec, center: [1, 1.5] });
check(near(sf.center[0], 3) && near(sf.center[1], 1.5) && near(sf.center[2], 0), 'a section centre is measured along its line and up from 0');

// Elevations sit outside the model and look into it from each side.
const box = { minX: 0, minY: 0, maxX: 6, maxY: 4 };
for (const side of Object.keys(ds.ELEVATION_SIDES)) {
  const line = ds.elevationLine(box, side);
  const g = ds.lineFrame({ line, flip: false });
  const toCentre = [3 - g.mx, 2 - g.my];
  check(g.nx * toCentre[0] + g.ny * toCentre[1] > 0, 'the elevation from the ' + side + ' looks toward the model');
}
const across = ds.lineThrough(box, 'y');
check(across[0] === 3 && across[2] === 3 && across[1] < 0 && across[3] > 4, 'a cut top to bottom runs through the middle and past both edges');

// ---------- PDF ----------
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const bytes = ds.pdfFromJpegs([{ jpeg, px: [10, 8], inches: [17, 11] }, { jpeg, px: [10, 8], inches: [17, 11] }], { title: 'Test (set)', date: '2026-11-04T10:00:00Z' });
const text = new TextDecoder('latin1').decode(bytes);
check(text.startsWith('%PDF-1.4') && text.trimEnd().endsWith('%%EOF'), 'the PDF has a header and an end marker');
check((text.match(/\/Type \/Page /g) || []).length === 2 && /\/Count 2/.test(text), 'two sheets make two pages');
check(/\/MediaBox \[0 0 1224\.00 792\.00\]/.test(text), 'a tabloid sheet is 17 x 11 inches (1224 x 792 points)');
const startxref = Number(/startxref\n(\d+)/.exec(text)[1]);
check(text.slice(startxref, startxref + 4) === 'xref', 'startxref points at the cross-reference table');
const offsets = text.slice(startxref).split('\n').slice(3).filter(l => / n $/.test(l)).map(l => Number(l.slice(0, 10)));
check(offsets.length === 9 && offsets.every((o, i) => text.slice(o).startsWith((i + 1) + ' 0 obj')), 'every object offset in the table points at that object');
check(/\/Title \(Test \\\(set\\\)\)/.test(text), 'the title is escaped');

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
