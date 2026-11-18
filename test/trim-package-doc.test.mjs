// The printed trim package (js/trim-package-doc.js): every section of the book, written from a live
// estimate of a synthetic study with baseboard and a chair rail drawn round it. No owner data.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const E = await import('../js/trim-estimate.js');
const T = await import('../js/trims.js');
const D = await import('../js/trim-design.js');
const { trimPackageHtml } = await import('../js/trim-package-doc.js');

// A 4 x 3 m room with a door, baseboard and chair rail on every wall; its name carries markup that
// must come out as text.
const ROOM = 'Study <script>alert(1)</script> & "den"';
function book(ctx = {}) {
  const wall = (id, ax, ay, bx, by) => ({ id, level: 'l1', ax, ay, bx, by, thickness: 0.1, height: 2.4 });
  const prop = {
    walls: [wall('s', 0, 0, 4, 0), wall('e', 4, 0, 4, 3), wall('n', 4, 3, 0, 3), wall('w', 0, 3, 0, 0)],
    rooms: [{ id: 'room-study', level: 'l1', name: ROOM, pts: [[0, 0], [4, 0], [4, 3], [0, 3]] }],
    openings: [{ id: 'door', wallId: 'e', type: 'door', t: 0.5, width: 0.8, height: 2.03 }],
    trims: [],
  };
  const projects = [{ id: 'p-trim', name: 'Trim' }, { id: 'p-study', name: 'Study trim', parentId: 'p-trim', roomId: 'room-study' }];
  const env = { prop, projects, levelOf: () => 'l1', wallsOn: () => prop.walls, roomsOn: () => prop.rooms, openingsOn: () => prop.openings, heightOf: w => w.height };
  const d0 = D.trimDesign(env);
  let n = 0;
  for (const w of prop.walls) {
    const side = [1, -1].find(s => (d0.info({ id: 'probe', wallId: w.id, side: s, f0: 0, f1: 1, style: 'baseboard' }) || {}).roomId === 'room-study');
    for (const [style, product] of [['baseboard', 'lowes-163e12fbdpm'], ['chair-rail', 'hd-10000538']]) {
      const t = T.trimTemplate(style, null, w, side, { wallHeight: 2.4 });
      t.id = 't' + (++n); t.projectId = 'p-study'; t.product = product;
      prop.trims.push(t);
    }
  }
  const { pieces, faces } = E.trimPieces({ prop, projects, design: D.trimDesign(env) });
  const est = E.estimateTrim({ pieces, faces, settings: { laborRate: 90, contingency: 0.1, sparePerMoulding: 1 } });
  return { est, ...trimPackageHtml(est, { title: 'Test House', date: '2026-11-17', design: 'Design 1', status: 'For review', paint: 'Test white', alternates: ['Alt 1, deduct: leave the hall'], notExact: ['A synthetic note.'], ...ctx }) };
}
const text = html => html.replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

test('the book has every section, each on its own named page with its running header', () => {
  const { html, css, pages } = book();
  const heads = [...html.matchAll(/<h1>(.*?)<\/h1>/g)].map(m => m[1]);
  for (const h of ['Wall trim package', 'Options at a glance', 'Buy list', 'Installer bid form', 'Installer bid form, terms', 'Price build-up',
    'Appendix A · Materials and supplies', 'Appendix B · Tools assumed', 'Appendix C · Labor rates', 'Appendix D · Option prices']) assert.ok(heads.includes(h), 'section ' + h);
  assert.equal(heads.filter(h => h.startsWith('Cut list · ')).length, 1, 'a cut list for the room');
  assert.equal(pages, (html.match(/<section class="page/g) || []).length);
  for (let i = 1; i <= pages; i++) assert.match(css, new RegExp(`@page tp${i} \\{ @top-right \\{ content: "`), 'page ' + i + ' names its section');
  assert.match(css, /size: 8\.5in 11in/);
  assert.match(css, /TEST HOUSE \/ WALL TRIM \/ DESIGN 1/);
  assert.match(css, /counter\(page\) " of " counter\(pages\)/);
});

test('its figures are the estimate\'s own', () => {
  const { est, html } = book();
  const t = text(html), T2 = est.totals;
  const m0 = v => '$' + Math.round(v).toLocaleString('en-US'), m2 = v => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  assert.ok(t.includes(`${T2.pieces} pieces to cut`), 'pieces');
  assert.ok(t.includes(`${T2.order} store pieces to order`), 'store pieces');
  assert.ok(t.includes(`${T2.hours.toFixed(1)} carpenter hours at $90/hr`), 'hours at the rate');
  assert.ok(t.includes(`${m0(T2.total)} all in, with 10% contingency`), 'the total');
  assert.ok(t.includes(`Total before sales tax and delivery ${m2(T2.total)}`), 'the price build-up total');
  assert.ok(t.includes(`Moulding before tax and delivery ${m2(T2.moulding)}`), 'the buy list total');
  assert.ok(t.includes(`Labor total ${m2(T2.labor)}`), 'the bid form total');
  assert.ok(t.includes(`Supplies before tax ${m2(T2.supplies)}`), 'the supplies total');
});

test('every room has its wall drawings with their boards and a cut list naming every piece mark', () => {
  const { est, html } = book();
  for (const r of est.rooms) {
    const walls = est.walls.filter(w => w.room === r.name);
    const roomPage = html.split('<section').find(s => s.includes(`<h1>${r.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</h1>`));
    assert.ok(roomPage, 'the room page');
    assert.equal((roomPage.match(/<svg class="elev"/g) || []).length, walls.length, 'one drawing per wall');
    assert.ok((roomPage.match(/<svg class="cutsvg"/g) || []).length >= 1, 'the boards cut for its walls');
  }
  const cut = html.split('<section').find(s => /<h1>Cut list · /.test(s));
  for (const g of est.groups) assert.ok(cut.includes(`· ${g.mark}</div>`), 'mark ' + g.mark + ' in the cut list');
  assert.ok(text(html).includes('Paint trim two coats (Test white)') && text(html).includes('Alt 1, deduct: leave the hall') && text(html).includes('A synthetic note.'));
});

test('a room name with markup in it is printed as text', () => {
  const { html } = book();
  assert.ok(!html.includes('<script>'), 'no script element');
  assert.ok(html.includes('Study &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;den&quot;'), 'escaped as text');
});

test('the business and room pictures are printed when given, and left out when not', () => {
  const plain = book().html;
  assert.ok(!plain.includes('<img') && !plain.includes('class="from"'));
  const { html } = book({ business: { name: 'Synthetic Builders', license: 'X-1' }, pictures: { [ROOM]: ['pic.jpg?a=1&b="2"'] } });
  assert.match(html, /<div class="from"><b>Synthetic Builders<\/b><span>License X-1<\/span><\/div>/);
  assert.ok(html.includes('<img src="pic.jpg?a=1&amp;b=&quot;2&quot;"'), 'the picture, its address escaped');
  assert.match(html, /<span>Synthetic Builders<\/span><span>Date<\/span><\/div>/, 'the business signs the bid form');
});
