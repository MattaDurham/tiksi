// The trim estimate (js/trim-estimate.js) and its drawings (js/trim-drawings.js): ends at corners,
// splices, store lengths, kits, hours, supplies, contingency and options, from synthetic rooms and a
// synthetic catalog and price list.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const E = await import('../js/trim-estimate.js');
const Dr = await import('../js/trim-drawings.js');
const T = await import('../js/trims.js');
const D = await import('../js/trim-design.js');

const IN = 0.0254;
const near = (a, b, what, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${what}: ${a} is not ${b}`);

// A synthetic catalog: a baseboard sold in 8 and 12 ft, a chair rail sold in 8 ft or by the foot,
// a cap sold only by the foot, and a wainscot kit for a 96 in run.
const CAT = [
  { id: 'x-base', style: 'baseboard', short: 'Test base', length: '96 in piece', price: 20, W: 0.1, T: 0.015, material: 'MDF' },
  { id: 'x-chair', style: 'chair-rail', short: 'Test chair rail', length: '96 in piece', price: 12, W: 0.06, T: 0.018, material: 'pine' },
  { id: 'x-cap', style: 'wainscot-cap', short: 'Test cap', length: '96 in piece', price: 15, W: 0.05, T: 0.018 },
  { id: 'x-kit', style: 'shaker', short: 'Test kit', length: 'kit for a 96 in run', price: 120, W: 0.09, T: 0.016 },
];
const DATA = {
  labor: { tasks: [
    { id: 'setup', label: 'Set up', per: 'room_days', hours: 0.5 },
    { id: 'base', label: 'Base', per: 'base_lf', hours: 0.05 },
    { id: 'chair', label: 'Chair rail', per: 'chair_lf', hours: 0.04 },
    { id: 'cope', label: 'Cope', per: 'copes', hours: 0.15 },
    { id: 'outside', label: 'Outside', per: 'outside', hours: 0.1 },
    { id: 'rail', label: 'Kit rails', per: 'rail_lf', hours: 0.04 },
  ], tasks_extra: [{ id: 'prime_loose', per: 'trim_lf', hours: 0.01 }] },
  supplies: { items: [
    { id: 'nails', category: 'fasteners', per: 'nails_n16', per_package: 1000, price: 14, unit: 'nails' },
    { id: 'caulk', category: 'finish', per: 'caulk_lf', per_package: 30, price: 6, min: 2 },
    { id: 'tape', category: 'protection', per: 'rooms', per_package: 0, price: 5, min: 1 },
  ], nailing: { base: { per: 'base_lf', gun: 'n16', nails_per_lf: 1.5 }, chair: { per: 'chair_lf', gun: 'n16', nails_per_lf: 1.5 } }, tools: [] },
  options: { scenarios: [{ name: 'Today', per_lf: {} }, { name: 'Cheap base', per_lf: { base: 1.0 }, labor_factor: { base: 0.5 } }, { name: 'Bare', per_lf: {}, prime: true }] },
  stock: { products: {
    'x-base': { sold: 'lengths', lengths: [{ in: 96, price: 20 }, { in: 144, price: 27 }] },
    'x-chair': { sold: 'both', lengths: [{ in: 96, price: 12 }], per_ft: 2.5, max_in: 192 },
    'x-cap': { sold: 'foot', per_ft: 2, max_in: 192 },
  } },
};
const SET = { laborRate: 100, contingency: 0.1, sparePerMoulding: 1 };

// A wall face seen from inside the room: O is its plan start, r its direction, n into the room.
const face = (key, room, name, O, r, n, len, H = 2.4) => ({ key, room, names: [name], O, r, n, h0: 0, h1: len, H, openings: [] });
let nSec = 0;
function run(f, product, x0, x1, endA, endB, extra = {}) {
  const pA = [f.O[0] + f.r[0] * x0, f.O[1] + f.r[1] * x0], pB = [f.O[0] + f.r[0] * x1, f.O[1] + f.r[1] * x1];
  const y = extra.y ?? 0;
  return { section: extra.section || 's' + (++nSec), sectionName: f.names[0], face: f.key, room: f.room, roomId: 'r1', product, style: extra.style || 'baseboard', kind: 'run',
    len: x1 - x0, y, x0, x1, pA, pB, u: f.r, endA, endB, leftIsA: true, h0: x0, h1: x1, v0: y, v1: y + 0.1 };
}

test('inside corners pair up: the longer run goes square into the corner, the shorter one is coped', () => {
  const S = face('S|1', 'Den', 'South wall', [0, 0], [1, 0], [0, 1], 2.4), Ew = face('E|1', 'Den', 'East wall', [2.4, 0], [0, 1], [-1, 0], 1.8);
  const pieces = [run(S, 'x-base', 0, 2.4, 'square', 'inside corner'), run(Ew, 'x-base', 0, 1.8, 'inside corner', 'corner')];
  const est = E.estimateTrim({ pieces, faces: [S, Ew], catalog: CAT, settings: SET, data: DATA });
  const south = est.pieces.find(p => p.wallName === 'South wall'), east = est.pieces.find(p => p.wallName === 'East wall');
  assert.equal(south.endB, 'into corner');
  assert.equal(east.endA, 'inside corner');
  assert.equal(east.endLWord, 'cope');
  assert.equal(east.endB, 'check on site', 'a corner end with nothing to meet is left to check on site');
  assert.equal(est.rooms[0].copes, 1);
  assert.equal(est.rooms[0].check, 1);
  assert.match(south.mark, /^DE-\d\d$/, 'marks start with the room code');
  assert.notEqual(south.name, east.name);
});

test('two runs meeting in line are a butt joint; an outside corner adds the moulding thickness at its long point', () => {
  const S = face('S|1', 'Den', 'South wall', [0, 0], [1, 0], [0, 1], 2.0);
  const pieces = [run(S, 'x-base', 0, 1, 'outside corner', 'corner', { section: 'a' }), run(S, 'x-base', 1, 2, 'corner', 'square', { section: 'b' })];
  const est = E.estimateTrim({ pieces, faces: [S], catalog: CAT, settings: SET, data: DATA });
  const a = est.pieces.find(p => p.section === 'a'), b = est.pieces.find(p => p.section === 'b');
  assert.equal(a.endB, 'joint'); assert.equal(b.endA, 'joint');
  near(a.lin, 1 / IN + 0.015 / IN, 'the outside corner piece runs the thickness past the wall corner');
  near(a.use, a.lin + 0.015 / IN, 'its 45° bevel takes as much again on the board');
  near(b.lin, 1 / IN, 'the joint end is square');
});

test('a run longer than any board is spliced with scarf joints, and boards are bought at the cheapest length that holds the cuts', () => {
  const S = face('S|1', 'Den', 'South wall', [0, 0], [1, 0], [0, 1], 5);
  const est = E.estimateTrim({ pieces: [run(S, 'x-base', 0, 5, 'square', 'square')], faces: [S], catalog: CAT, settings: SET, data: DATA });
  const parts = est.pieces;
  // 12 ft boards are capped at 13 ft of plan length: 196.85" needs two parts of 98.43" plus half the thickness at the scarf
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map(p => p.split), ['1 of 2', '2 of 2']);
  assert.equal(parts[0].endB, 'scarf'); assert.equal(parts[1].endA, 'scarf');
  near(parts[0].lin, 5 / IN / 2 + 0.015 / IN / 2, 'each part gains half the thickness at its scarf');
  // each part (about 99") needs more than an 8 ft board holds, so each is cut from a 12 ft board
  assert.equal(est.boards.length, 2);
  assert.ok(est.boards.every(b => b.stockIn === 144 && b.price === 27));
  near(est.totals.moulding, 2 * 27 + 27, 'two boards and one spare 12 ft board', 1e-9);
  assert.equal(est.buy[0].lines[0].spare, 1);
});

test('short cuts share a board; a product sold by the foot is bought as one length the store cuts', () => {
  const S = face('S|1', 'Den', 'South wall', [0, 0], [1, 0], [0, 1], 3);
  const pieces = [run(S, 'x-base', 0, 1, 'square', 'square', { section: 'a' }), run(S, 'x-base', 1.2, 2.2, 'square', 'square', { section: 'b' }),
    run(S, 'x-chair', 0, 3, 'square', 'square', { section: 'c', y: 0.9, style: 'chair-rail' }), run(S, 'x-cap', 0, 1.5, 'square', 'square', { section: 'd', y: 1.0, style: 'wainscot-cap' })];
  const est = E.estimateTrim({ pieces, faces: [S], catalog: CAT, settings: { ...SET, sparePerMoulding: 0 }, data: DATA });
  const base = est.boards.filter(b => b.product === 'x-base');
  assert.equal(base.length, 1, 'two 39" cuts fit one 8 ft board');
  assert.equal(base[0].stockIn, 96); assert.equal(base[0].cuts.length, 2);
  assert.ok(base[0].gap >= 0.5 && base[0].gap <= 1, 'spare length goes between the cuts, 1/2" to 1"');
  // 118.1" of chair rail: too long for its 8 ft stick, so the store cuts 10 ft (121" needed) off 16 ft stock at $2.50 a foot
  const chair = est.boards.find(b => b.product === 'x-chair');
  assert.equal(chair.how, 'foot'); assert.equal(chair.stockIn, 120); near(chair.price, 25, 'ten feet at $2.50');
  // 59.06" of cap, sold only by the foot: 61" needed, so 6 feet
  const cap = est.boards.find(b => b.product === 'x-cap');
  assert.equal(cap.how, 'foot'); assert.equal(cap.stockIn, 72); near(cap.price, 12, 'six feet at $2');
  assert.match(est.buy.find(b => b.pid === 'x-chair').soldText, /sold in 8'-0" lengths, or cut to length at the store off 16'-0" stock, \$2\.50 a foot/);
});

test('kits are counted two rails a kit, and the kit price is shared by its rails', () => {
  const S = face('S|1', 'Den', 'South wall', [0, 0], [1, 0], [0, 1], 6);
  const rail = (x0, x1, v0) => ({ ...run(S, 'x-kit', x0, x1, 'square', 'square', { style: 'shaker' }), kind: 'rail', v0, v1: v0 + 0.09 });
  const pieces = [rail(0, 2, 0.1), rail(0, 2, 0.8), rail(2.5, 4.5, 0.1)];
  const est = E.estimateTrim({ pieces, faces: [S], catalog: CAT, settings: { ...SET, sparePerMoulding: 0 }, data: DATA });
  assert.equal(est.rooms[0].sticks['x-kit'], 2, 'three rails need two kits');
  near(est.rooms[0].mat, 240, 'two kits at $120');
  assert.equal(est.buy[0].kit, true);
  assert.ok(est.boards.every(b => b.how === 'kit' && b.price === 60));
});

test('hours come from the job measures times the production rates, with set-up per room-day', () => {
  const S = face('S|1', 'Den', 'South wall', [0, 0], [1, 0], [0, 1], 2.4), Ew = face('E|1', 'Den', 'East wall', [2.4, 0], [0, 1], [-1, 0], 1.8);
  const pieces = [run(S, 'x-base', 0, 2.4, 'square', 'inside corner'), run(Ew, 'x-base', 0, 1.8, 'inside corner', 'square')];
  const est = E.estimateTrim({ pieces, faces: [S, Ew], catalog: CAT, settings: SET, data: DATA });
  const r = est.rooms[0], lf = 4.2 / 0.3048;
  near(r.measures.base_lf, lf, 'base length in feet');
  assert.equal(r.days, 1, 'under 6 hours of work is one room-day');
  near(r.hours, 0.5 + lf * 0.05 + 1 * 0.15, 'set-up + base + one cope');
  assert.deepEqual(r.labor.map(l => l.task), ['setup', 'base', 'cope']);
  near(est.totals.labor, r.hours * 100, 'hours at the rate');
});

test('supplies round up to whole packages, honour a minimum, and contingency is on the whole subtotal', () => {
  const S = face('S|1', 'Den', 'South wall', [0, 0], [1, 0], [0, 1], 2.4);
  const est = E.estimateTrim({ pieces: [run(S, 'x-base', 0, 2.4, 'square', 'square')], faces: [S], catalog: CAT, settings: SET, data: DATA });
  const lf = 2.4 / 0.3048;
  const nails = est.supplies.find(s => s.id === 'nails'), caulk = est.supplies.find(s => s.id === 'caulk'), tape = est.supplies.find(s => s.id === 'tape');
  near(nails.need, lf * 1.5, 'nails at 1.5 a foot');
  assert.equal(nails.packages, 1);
  assert.equal(caulk.packages, 2, 'a minimum of two tubes');
  assert.equal(tape.packages, 1);
  near(est.totals.supplies, 14 + 12 + 5, 'supplies');
  near(est.totals.subtotal, est.totals.moulding + est.totals.supplies + est.totals.labor, 'subtotal');
  near(est.totals.total, est.totals.subtotal * 1.1, 'ten per cent contingency');
  near(est.rooms[0].total, est.rooms[0].mat + est.rooms[0].supplies + est.rooms[0].laborCost, 'a room before contingency');
});

test('options reprice the same rooms: per-foot prices for a role, labor factors by task, a priming pass for bare wood', () => {
  const S = face('S|1', 'Den', 'South wall', [0, 0], [1, 0], [0, 1], 2.4);
  const est = E.estimateTrim({ pieces: [run(S, 'x-base', 0, 2.4, 'square', 'square')], faces: [S], catalog: CAT, settings: SET, data: DATA });
  const [today, cheap, bare] = est.scenarios;
  near(today.total, est.totals.total, 'today\'s design is the estimate');
  const bought = est.buy[0].lines.reduce((a, l) => a + l.order * l.lenIn, 0) / 12;
  near(cheap.mould, bought * 1.0, 'feet bought at $1');
  near(cheap.hours, est.totals.hours - est.labor.byTask.base * 0.5, 'base hours halved');
  near(cheap.total, (cheap.mould + cheap.sup + cheap.hours * 100) * 1.1, 'option total');
  near(bare.hours, est.totals.hours + est.house.trim_lf * 0.01, 'priming adds its pass');
});

test('Python-style rounding and feet and inches to the nearest sixteenth', () => {
  assert.equal(E.pyRound(2.5), 2); assert.equal(E.pyRound(3.5), 4); assert.equal(E.pyRound(0.125, 2), 0.12); assert.equal(E.pyRound(0.375, 2), 0.38);
  assert.equal(E.ftin({ inches: 37.75 }), `3'-1 3/4"`);
  assert.equal(E.ftin({ inches: 72.75 }), `6'-3/4"`);
  assert.equal(E.ftin({ inches: 96 }), `8'-0"`);
  assert.equal(E.ftin({ inches: 11.5 }), `11 1/2"`);
  assert.equal(E.ftin(0.015875), `5/8"`);
  assert.deepEqual(E.roomCodes(['Living room', 'Laundry', 'Kitchen', 'Kids room']).map(x => x.code), ['LI', 'LA', 'KI', 'KD']);
});

// A 4 x 3 m study with a door in its east wall, drawn as MODEL draws it, with baseboard round it.
function study() {
  const wall = (id, ax, ay, bx, by) => ({ id, level: 'l1', ax, ay, bx, by, thickness: 0.1, height: 2.4 });
  const prop = {
    walls: [wall('s', 0, 0, 4, 0), wall('e', 4, 0, 4, 3), wall('n', 4, 3, 0, 3), wall('w', 0, 3, 0, 0)],
    rooms: [{ id: 'room-study', level: 'l1', name: 'Study', pts: [[0, 0], [4, 0], [4, 3], [0, 3]] }],
    openings: [{ id: 'door', wallId: 'e', type: 'door', t: 0.5, width: 0.8, height: 2.03 }],
    trims: [],
  };
  const projects = [{ id: 'p-trim', name: 'Trim' }, { id: 'p-study', name: 'Study trim', parentId: 'p-trim', roomId: 'room-study' }];
  const env = { prop, projects, levelOf: () => 'l1', wallsOn: () => prop.walls, roomsOn: () => prop.rooms, openingsOn: () => prop.openings, heightOf: w => w.height };
  const d0 = D.trimDesign(env);
  let n = 0;
  for (const w of prop.walls) {
    const side = [1, -1].find(s => (d0.info({ id: 'probe', wallId: w.id, side: s, f0: 0, f1: 1, style: 'baseboard' }) || {}).roomId === 'room-study');
    const t = T.trimTemplate('baseboard', null, w, side, { wallHeight: 2.4 });
    t.id = 'b' + (++n); t.projectId = 'p-study'; t.product = 'lowes-163e12fbdpm';
    prop.trims.push(t);
  }
  return { prop, projects, design: D.trimDesign(env) };
}

test('trimPieces reads the drawn trim through the same layout MODEL draws: corners coped, runs stopped at the door', () => {
  const { prop, projects, design } = study();
  const { pieces, faces } = E.trimPieces({ prop, projects, design });
  assert.equal(faces.length, 4);
  assert.ok(pieces.every(p => p.kind === 'run' && p.room === 'Study' && p.roomId === 'room-study' && p.project === 'p-study'), 'pieces take the room of their subproject');
  assert.equal(pieces.length, 5, 'four walls, the east one in two runs either side of the door');
  const ends = pieces.flatMap(p => [p.endA, p.endB]);
  assert.equal(ends.filter(e => e === 'inside corner').length, 8, 'four inside corners, two ends each');
  assert.equal(ends.filter(e => e === 'square').length, 2, 'the runs stop square at the door casing');
  const est = E.estimateTrim({ pieces, faces, settings: SET });
  assert.equal(est.rooms[0].copes, 4, 'one coped end at each corner');
  assert.equal(est.pieces.filter(p => p.endA === 'into corner' || p.endB === 'into corner').length > 0, true);
  near(est.house.base_lf, pieces.reduce((a, p) => a + p.len, 0) / 0.3048, 'base length from the drawing');
  assert.ok(est.totals.total > est.totals.subtotal && est.warnings.length === 0);
  const only = E.trimPieces({ prop, projects, design, include: t => t.wallId === 's' });
  assert.equal(only.pieces.length, 1);
});

test('drawings: each wall with its pieces, and the boards cut for it, carry their detail hooks', () => {
  const { prop, projects, design } = study();
  const { pieces, faces } = E.trimPieces({ prop, projects, design });
  const est = E.estimateTrim({ pieces, faces, settings: SET });
  const wall = est.walls.find(w => w.openings.length);
  const svg = Dr.elevationSvg(wall, est, { maxW: 640, maxH: 300, fluid: true });
  assert.match(svg, /^<svg class="elev"/);
  assert.match(svg, /width="100%"/);
  const marks = est.pieces.filter(p => p.wall === wall.id).map(p => p.mark);
  for (const m of marks) assert.ok(svg.includes(`data-d="piece:${m}"`), 'every piece on the wall opens its detail');
  assert.ok(svg.includes('class="ev-open"'), 'the door is drawn');
  const boards = est.boards.filter(b => b.wall === wall.id);
  const html = Dr.cutsHtml(boards.length ? boards : est.boards, wall.id, est, { fluid: true });
  assert.match(html, /<svg class="cutsvg"/);
  assert.ok(est.boards.some(b => html.includes(`data-d="stick:${b.key}"`)));
  const printed = Dr.cutSvg(Dr.stickGroups(est.boards.slice(0, 1)), wall.id, est, { fs: 1.9 });
  assert.match(printed, /width="529\.2pt"/, 'printed boards are 7.35 in wide');
  assert.equal(Dr.stickLabel([{ id: 'Base 1' }, { id: 'Base 2' }, { id: 'Base 3' }]), 'Base 1–3');
});
