// The one-pager: the record survives a project file and hostile input, the text is drafted
// from what the project knows, the signature tells a changed project from a changed one-pager,
// closing asks only when it should, versions are numbered and named, and the page lays out
// from the same facts. Run: node test/one-pager.test.mjs   (no browser; IndexedDB is stubbed out)

globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
const op = await import('../js/one-pager.js');
const page = await import('../js/one-pager-page.js');

let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };

// ---------- the record ----------
store.ws.data = store.emptyWorkspace();
const fresh = store.propertyTemplate('Fresh');
check(fresh.onePager && Array.isArray(fresh.onePager.versions) && fresh.onePager.versions.length === 0 && fresh.onePager.hero === '', 'a new property has an empty one-pager record');
const hostile = { onePager: { headline: 'x'.repeat(500), summary: 7, highlights: ['a', '', 3, 'b\u0000c', 'd', 'e', 'f', 'g', 'h'], hero: '../etc', show: { budget: 'no', plan: false, bogus: true },
  customized: 'yes', versions: [{ n: 2, date: 'yesterday', documentId: 'ph-1' }, { n: 1, date: '2026-11-01' }, { n: 2 }, null, { n: -4 }, { n: 'x' }] } };
const rec = op.normalizeOnePager(hostile);
check(rec.headline.length === 90 && rec.summary === '' && rec.highlights.join('|') === 'a|b c|d|e|f|g', 'long, non-string and control-character text is cut, dropped or cleaned (' + rec.highlights.length + ' highlights kept)');
check(rec.hero === '' && rec.show.budget === true && rec.show.plan === false && !('bogus' in rec.show) && rec.customized === false, 'a bad picture choice, a non-boolean toggle, an unknown toggle and a non-boolean flag take safe values');
check(rec.versions.map(v => v.n).join() === '1,2' && rec.versions[1].date === '' && rec.versions[1].documentId === 'ph-1' && rec.versions[0].documentId === '', 'versions are sorted, duplicates and bad numbers dropped, bad dates and ids blanked');
check(op.latestVersion(hostile).n === 2 && op.latestVersion({ onePager: op.emptyOnePager() }) === null, 'the newest version is the highest number, or none');

// ---------- a project with something to say ----------
function house() {
  const p = store.propertyTemplate('12 Elm Street');
  const lv = p.levels[0].id;
  p.walls.push({ id: 'w1', level: lv, ax: 0, ay: 0, bx: 6, by: 0, thickness: 0.12, height: null, material: null });
  p.rooms.push({ id: 'r1', level: lv, name: 'Kitchen', pts: [[0, 0], [4, 0], [4, 4], [0, 4]], material: null, ceilingMaterial: null },
    { id: 'r2', level: lv, name: 'Pantry', pts: [[4, 0], [6, 0], [6, 2], [4, 2]], material: null, ceilingMaterial: null });
  p.photos.push({ id: 'ph-cover', name: 'Cover.jpg', kind: 'photo', source: 'polycam-cover', w: 4, h: 3, mime: 'image/jpeg', thumb: 'data:image/jpeg;base64,AAAA', createdAt: '2026-11-01T00:00:00.000Z', notes: '', roomId: '', elementIds: [], itemIds: [], pin: null });
  return p;
}
store.ws.data = store.emptyWorkspace();
const A = house();
store.ws.data.properties.push(A, Object.assign(store.propertyTemplate('Another house'), { id: 'prop-other' }));
store.ws.data.settings.activePropertyId = A.id;
store.ws.data.settings.programStart = '2026-11-10';
const it = (id, name, extra) => Object.assign({ id, name, qty: 1, unit: 'ea', low: 0, likely: 0, high: 0, durationDays: 0, deps: [], elementIds: [], notes: '', status: 'todo', doneAt: '' }, extra);
store.ws.data.projects.push(
  { id: 'pr-k', name: 'Kitchen refresh', propertyId: A.id, category: 'kitchen', status: 'scoped', selected: true, parentId: '', priority: '', roomId: '', source: '', startDate: '', notes: '', items: [
    it('i1', 'Cabinets', { low: 20000, likely: 25000, high: 32000, durationDays: 10 }),
    it('i2', 'Counters', { low: 5000, likely: 7000, high: 9000, durationDays: 3, deps: ['i1'] }),
    it('i3', 'Paint', { low: 800, likely: 1000, high: 1500, durationDays: 2 }),
  ] },
  { id: 'pr-p', name: 'Pantry shelving', propertyId: A.id, category: 'interior', status: 'idea', selected: false, parentId: '', priority: '', roomId: '', source: '', startDate: '', notes: '', items: [it('i4', 'Shelves', { likely: 600 })] },
  { id: 'pr-other', name: 'Not this house', propertyId: 'prop-other', category: 'bath', status: 'idea', selected: true, parentId: '', priority: '', roomId: '', source: '', startDate: '', notes: '', items: [it('i9', 'Tile', { likely: 99999 })] },
);
store.ws.data.products.push({ id: 'prod-1', name: 'Shaker cabinets', brand: 'Acme', model: 'S-12', category: 'cabinet', price: 300, unit: 'ea', itemIds: ['i1'] },
  { id: 'prod-2', name: 'Elsewhere', brand: '', model: '', category: 'tile', price: 1, unit: 'sf', itemIds: ['i9'] });
const f = op.onePagerFacts(A, store.ws.data);
check(f.rooms.length === 2 && Math.round(f.floorArea * 100) / 100 === 20 && f.levels === 1, 'facts count the rooms and their floor area (' + f.floorArea + ' m2)');
check(f.projects.map(p => p.name).join('|') === 'Kitchen refresh|Pantry shelving' && f.program.length === 1, 'facts take this property\'s projects, biggest first, and the selected ones as the program');
check(f.budget.likely === 33000 && f.budget.low === 25800 && f.budget.high === 42500 && f.budget.priced === 3, 'the budget sums the selected program (' + f.budget.likely + ' likely)');
check(f.days === 13, 'the schedule is the longest dependency chain of the program (' + f.days + ' days: cabinets then counters)');
check(f.products.length === 1 && f.products[0].brand === 'Acme', 'only products linked to this property\'s scope are listed');
check(f.photos.length === 1 && f.renderings.length === 0, 'site photos are counted apart from renderings');

const changed = op.draftOnePager(A, store.ws.data);
const o = A.onePager;
check(changed && o.headline === '12 Elm Street' && /2 rooms/.test(o.tagline), 'the draft names the property and its rooms in the tagline (' + o.tagline + ')');
check(/Kitchen refresh/.test(o.summary) && /\$33,000/.test(o.summary) && /\$25,800 to \$42,500/.test(o.summary) && /13 calendar days, from Nov 10, 2026 to Nov 23, 2026/.test(o.summary) && /Acme Shaker cabinets/.test(o.summary), 'the summary says what the work is, what it costs and when, and names a product');
check(o.highlights[0] === 'Kitchen refresh: $33,000 likely' && o.highlights[1] === 'Pantry shelving: $600 likely', 'highlights list the projects with their likely cost (' + o.highlights.join(' / ') + ')');
check(o.customized === false && o.draftedAt, 'a drafted record is not customized and says when it was drafted');
check(op.draftOnePager(A, store.ws.data) === false, 'drafting again from the same project changes nothing');
o.summary = 'My own words.'; o.customized = true;
store.ws.data.projects[0].items[0].likely = 26000;
check(op.draftOnePager(A, store.ws.data) === false && o.summary === 'My own words.', 'hand-edited text is left alone when the project changes');
check(op.draftOnePager(A, store.ws.data, { force: true }) === true && /\$34,000/.test(o.summary) && o.customized === false, 'REDRAFT (force) writes the text again from the project as it is now');

const empty = store.propertyTemplate('Bare lot');
store.ws.data.properties.push(empty);
op.draftOnePager(empty, store.ws.data);
check(empty.onePager.headline === 'Bare lot' && /A renovation at Bare lot/.test(empty.onePager.summary) && /fill in as the design takes shape/.test(empty.onePager.summary) && empty.onePager.highlights.length === 0, 'a property with nothing in it still gets a sensible first draft');

// ---------- the one-pager prints BUDGET's totals and SCHEDULE's span ----------
{
  const program = await import('../js/program.js');
  const sched = await import('../js/schedule.js');
  const before = store.ws.data;
  store.ws.data = store.emptyWorkspace();
  const P = house();
  store.ws.data.properties.push(P);
  store.ws.data.settings.activePropertyId = P.id;
  store.ws.data.settings.programStart = '2026-11-10';
  const proj = (id, extra, items) => Object.assign({ id, name: id, propertyId: P.id, category: 'interior', status: 'scoped', parentId: '', priority: '', roomId: '', source: '', startDate: '', notes: '', items }, extra);
  store.ws.data.projects.push(
    proj('Bath', { selected: true }, [it('b1', 'Tile', { low: 9000, likely: 10000, high: 12000, durationDays: 8 })]),
    // Starts a week into the program, so it runs side by side with the bath, not after it.
    proj('Kitchen', { selected: true, startDate: '2026-11-17' }, [it('k1', 'Cabinets', { low: 18000, likely: 20000, high: 25000, durationDays: 5 })]),
    // A selected punch list inside the bath: BUDGET counts it.
    proj('Bath punch list', { selected: true, parentId: 'Bath' }, [it('s1', 'Caulk', { low: 150, likely: 200, high: 300, durationDays: 1 })]),
    // No selected flag at all: BUDGET parks it.
    proj('Porch', {}, [it('p1', 'Decking', { low: 4000, likely: 5000, high: 6000, durationDays: 20 })]),
  );
  const f = op.onePagerFacts(P, store.ws.data);
  const budgetTotals = store.selectedTotals();
  check(f.budget.likely === budgetTotals.likely && f.budget.low === budgetTotals.low && f.budget.high === budgetTotals.high && f.budget.likely === 30200,
    'the one-pager costs what BUDGET totals: selected subprojects in, unflagged projects out (' + f.budget.likely + ' likely, BUDGET ' + budgetTotals.likely + ')');
  const span = program.programSchedule(store.propertyProjects(), '2026-11-10').days;
  check(f.days === 12 && span === 12, 'the one-pager spans what SCHEDULE lays out: projects side by side in calendar days (' + f.days + ' days; adding them up would give 34)');
  check(f.finish === '2026-11-22', 'and finishes on SCHEDULE\'s finish date (' + f.finish + ')');
  check(f.program.map(p => p.name).join('|') === 'Kitchen|Bath', 'the work named on the page is the selected projects (' + f.program.map(p => p.name).join('|') + ')');
  check(sched.cpm === program.cpm, 'SCHEDULE and the one-pager share one critical-path calculation');
  store.ws.data = before;
}

// ---------- the signature, the state and closing ----------
const sig = () => op.projectSignature(store.projectSlice(A.id));
const s1 = sig();
A.onePager.summary = 'Edited again'; A.onePager.customized = true;
check(sig() === s1, 'editing the one-pager itself does not change the project\'s signature');
A.photos[0].thumb = 'data:image/jpeg;base64,BBBB';
check(sig() === s1, 'a thumbnail\'s bytes do not change the signature (only its size would)');
A.walls[0].bx = 7;
const s2 = sig();
check(s2 !== s1, 'moving a wall changes the signature');
check(op.onePagerState(A, store.projectSlice(A.id)) === 'none', 'with no version saved the state is none');
const v1 = op.recordVersion(A, store.projectSlice(A.id), 'ph-pdf-1', '2026-11-06');
check(v1.n === 1 && A.onePager.versions.length === 1 && A.onePager.basedOn === s2 && A.onePager.updatedAt, 'saving records version 1 and what it was made of');
check(op.onePagerState(A, store.projectSlice(A.id)) === 'current', 'right after saving, the one-pager is current');
check(op.shouldAskOnClose(A, store.projectSlice(A.id), 'changed') === false && op.shouldAskOnClose(A, store.projectSlice(A.id), 'always') === true && op.shouldAskOnClose(A, store.projectSlice(A.id), 'never') === false, 'closing asks when the setting says every time, never when it says never, and not while current');
A.rooms[0].name = 'Kitchen and dining';
check(op.onePagerState(A, store.projectSlice(A.id)) === 'behind' && op.shouldAskOnClose(A, store.projectSlice(A.id), 'changed') === true, 'renaming a room puts the one-pager behind, and closing asks');
check(op.shouldAskOnClose(empty, store.projectSlice(empty.id), 'changed') === true && op.shouldAskOnClose(empty, store.projectSlice(empty.id), 'never') === false, 'a property with no version yet is asked about, unless the setting says never');
check(op.shouldAskOnClose(A, store.projectSlice(A.id), 'bogus') === true, 'an unknown setting behaves like the default');
const v2 = op.recordVersion(A, store.projectSlice(A.id), 'ph-pdf-2', '2026-11-07');
check(v2.n === 2 && op.latestVersion(A).n === 2 && op.onePagerState(A, store.projectSlice(A.id)) === 'current', 'the next version is 2 and the one-pager is current again');
check(op.versionFileName({ name: 'Elm: "front/back"?' }, 3, '2026-11-07') === 'Elm front back - one-pager v3 - 2026-11-07.pdf', 'version files are named after the property, the version and the date (' + op.versionFileName({ name: 'Elm: "front/back"?' }, 3, '2026-11-07') + ')');
const st = op.onePagerStatus(A, store.projectSlice(A.id));
check(st.state === 'current' && /Version 2 saved Nov 7, 2026; current/.test(st.text), 'the status line says the version, the date and whether it is current (' + st.text + ')');

// ---------- the project file ----------
const file = JSON.parse(JSON.stringify(store.projectSlice(A.id)));
check(file.properties[0].onePager.versions.length === 2 && file.properties[0].onePager.summary === 'Edited again', 'the project file carries the one-pager and its versions');
store.ws.data = store.emptyWorkspace();
store.mergeWorkspace(file, { fromFile: true });
const back = store.ws.data.properties.find(x => x.id === A.id);
check(back.onePager.versions.length === 2 && back.onePager.basedOn === A.onePager.basedOn && back.onePager.customized === true, 'opening the file restores the one-pager, its versions and what they were made of');
check(op.onePagerState(back, store.projectSlice(back.id)) === 'current', 'the signature reads the same after a round trip through the file');
check(store.ws.data.settings.onePagerPrompt === 'changed', 'the closing prompt setting defaults to asking when the project changed');
const odd = store.emptyWorkspace(); odd.settings.onePagerPrompt = 'sometimes';
store.ws.data = odd; store.replaceWorkspace(odd);
check(store.ws.data.settings.onePagerPrompt === 'changed', 'an unknown prompt setting becomes the default');

// ---------- the page ----------
store.ws.data = store.emptyWorkspace();
const B = house();
store.ws.data.properties.push(B); store.ws.data.settings.activePropertyId = B.id; store.ws.data.settings.programStart = '2026-11-10';
store.ws.data.projects.push({ id: 'pr-k', name: 'Kitchen refresh', propertyId: B.id, category: 'kitchen', status: 'scoped', selected: true, parentId: '', priority: '', roomId: '', source: '', startDate: '', notes: '', items: [it('i1', 'Cabinets', { low: 20000, likely: 25000, high: 32000, durationDays: 10 })] });
store.ws.data.products.push({ id: 'prod-1', name: 'Shaker cabinets', brand: 'Acme', model: 'S-12', category: 'cabinet', price: 300, unit: 'ea', itemIds: ['i1'] });
op.draftOnePager(B, store.ws.data);
B.onePager.client = 'The Does <family>'; B.onePager.preparedBy = 'Studio & Co'; B.onePager.contact = 'hello@example.com';
const html = page.onePagerHtml(B, store.ws.data, { hero: { href: 'data:image/jpeg;base64,AAAA' }, planSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' }, { version: 'Version 1', date: '2026-11-06' });
check(/<div xmlns="http:\/\/www.w3.org\/1999\/xhtml" class="op-page">/.test(html) && !/&nbsp;/.test(html), 'the page is XHTML in its own namespace with no named entities');
check(/Prepared for The Does &lt;family&gt;/.test(html) && /Studio &amp; Co/.test(html) && /hello@example.com/.test(html), 'client, author and contact are on the page, escaped');
check(/<h1>12 Elm Street<\/h1>/.test(html) && /Version 1 · Nov 6, 2026/.test(html), 'the headline and the version label are printed');
check(/<img src="data:image\/jpeg;base64,AAAA" alt=""\/>/.test(html) && /<div class="op-plan"><svg/.test(html), 'the picture goes at the top and the plan beside the text');
check(/\$25,000/.test(html) && /\$20,000 to \$32,000/.test(html) && /About 10 calendar days/.test(html) && /Nov 10, 2026 to Nov 20, 2026/.test(html) && /2 rooms · 215 sf/.test(html), 'budget, schedule and rooms are printed (' + (html.match(/<b>[^<]*<\/b>/g) || []).slice(0, 4).join(' ') + ')');
check(/Specified products/.test(html) && /Shaker cabinets <span>Acme S-12<\/span>/.test(html), 'specified products are listed with brand and model');
B.onePager.show.budget = false; B.onePager.show.products = false; B.onePager.show.plan = false;
const html2 = page.onePagerHtml(B, store.ws.data, { hero: { plan: true }, planSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }, { version: 'Draft' });
check(!/Likely cost/.test(html2) && !/Specified products/.test(html2) && /<figure class="op-hero plan"><svg/.test(html2) && !/op-plan/.test(html2), 'toggles hide the budget and products, and the plan can be the picture at the top');
const bare = store.propertyTemplate('Bare'); store.ws.data.properties.push(bare); op.draftOnePager(bare, store.ws.data);
const html3 = page.onePagerHtml(bare, store.ws.data, { hero: null, planSvg: '' }, {});
check(/op-cover/.test(html3) && /In design/.test(html3) && /Draft/.test(html3), 'a bare property gets a typographic cover and an In design status');
const svg = page.pageSvg(html);
check(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="816" height="1056"') && /<foreignObject/.test(svg) && /<style>/.test(svg), 'the page goes into an 816 x 1056 SVG with its stylesheet for the PDF');

console.log(failed ? failed + ' FAILED' : 'all passed');
process.exit(failed ? 1 : 0);
