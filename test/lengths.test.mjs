// Feet-and-inches formatting and parsing on both sides of the datum (basements sit below it).
import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.indexedDB = { open() { throw new Error('no IndexedDB under Node'); } };
const store = await import('../js/store.js');
store.ws.data = store.emptyWorkspace();
const FT = 0.3048;

test('negative lengths carry the sign on the whole feet-and-inches value', () => {
  store.ws.data.settings.units = 'imperial';
  assert.equal(store.fmtLen(-(7 + 7 / 12) * FT), "-7'-7\"");
  assert.equal(store.fmtLen(-2.32), "-7'-7 5/16\"", 'a basement floor 2.32 m below the first floor, to the sixteenth');
  assert.equal(store.fmtLen(-8 * FT, { short: true }), "-8'");
  assert.equal(store.fmtLen(-6 / 12 * FT), '-6"');
  assert.equal(store.fmtLen(-0.0004), '0"', 'no sign on a value that rounds to zero');
  assert.equal(store.fmtLen((9 + 3 / 12) * FT), "9'-3\"", 'positive lengths are unchanged');
  assert.equal(store.fmtLen(-(11.995 / 12) * FT), "-1'-0\"", 'rounding up to a whole foot keeps the sign');
});

test('typed negative feet-and-inches parse below the datum', () => {
  store.ws.data.settings.units = 'imperial';
  assert.ok(Math.abs(store.parseLen("-7'-7\"") + (7 + 7 / 12) * FT) < 1e-9);
  assert.ok(Math.abs(store.parseLen("-7' 7\"") + (7 + 7 / 12) * FT) < 1e-9);
  assert.ok(Math.abs(store.parseLen("-0'-6\"") + 0.5 * FT) < 1e-9, 'minus zero feet still means below');
  assert.ok(Math.abs(store.parseLen("9'-3\"") - (9 + 3 / 12) * FT) < 1e-9);
  for (const m of [-2.32, -0.4, 0.4, 2.83, 5.64]) {
    assert.ok(Math.abs(store.parseLen(store.fmtLen(m)) - m) < 0.5 / 12 * FT, 'round trip within half an inch: ' + m);
  }
});

test('tape readings with fractions, unicode fractions and metric units parse exactly', () => {
  store.ws.data.settings.units = 'imperial';
  const IN = 0.0254, near = (text, inches) => assert.ok(Math.abs(store.parseLen(text) - inches * IN) < 1e-9, text);
  near('33 1/2"', 33.5); near('33-1/2"', 33.5); near('9½"', 9.5); near('1/4"', 0.25); near('33 1/2 in', 33.5);
  near("2'-9 1/2\"", 33.5); near("2' 9-1/2\"", 33.5); near('85 cm', 85 / 2.54); near('850 mm', 850 / 25.4);
  near("-7'-7\"", -91); near('30"', 30);
  for (const bad of ['3 1/0"', 'x"', '1/"']) assert.ok(Number.isNaN(store.parseLen(bad)), bad + ' is not a length');
  store.ws.data.settings.units = 'metric';
  assert.ok(Math.abs(store.parseLen('850') - 0.85) < 1e-12, 'plain numbers are millimetres in metric');
  assert.ok(Math.abs(store.parseLen('0.85 m') - 0.85) < 1e-12, 'metres still read when marked');
  store.ws.data.settings.units = 'imperial';
});

test('lengths show to the sixteenth of an inch and metric to the millimetre by default', () => {
  store.ws.data.settings.units = 'imperial';
  const IN = 0.0254;
  assert.equal(store.fmtLen(33.5 * IN), "2'-9 1/2\"");
  assert.equal(store.fmtLen(32.5 * IN), "2'-8 1/2\"");
  assert.equal(store.fmtLen(4.5 * IN), '4 1/2"');
  assert.equal(store.fmtLen(3.5 * IN), '3 1/2"');
  assert.equal(store.fmtLen(0.25 * IN), '1/4"');
  assert.equal(store.fmtLen((96 + 3 / 16) * IN), "8'-0 3/16\"");
  assert.equal(store.fmtLen(-(91 + 5 / 8) * IN), "-7'-7 5/8\"");
  assert.equal(store.fmtLen(191.97 * IN), "16'-0\"", 'a hair under 16 feet rounds up to 16 feet');
  assert.equal(store.fmtLen(96 * IN, { short: true }), "8'");
  assert.equal(store.fmtLen((96 + 1 / 2) * IN, { short: true }), "8'-0 1/2\"");
  for (const inches of [33.5, 9.25, 120.0625, -7.75]) assert.ok(Math.abs(store.parseLen(store.fmtLen(inches * IN)) - inches * IN) < 1e-9, 'round trip exact at 1/16": ' + inches);
  store.ws.data.settings.units = 'metric';
  assert.equal(store.fmtLen(0.8509), '851 mm');
  assert.equal(store.fmtLen(2.835), '2835 mm');
  assert.equal(store.fmtLen(3), '3000 mm');
  assert.equal(store.fmtLen(-0.0004), '0 mm');
  assert.equal(store.fmtLen(-2.32), '-2320 mm');
  for (const m of [0.8509, 2.835, -2.32]) assert.ok(Math.abs(store.parseLen(store.fmtLen(m)) - m) < 0.0005, 'mm round trip: ' + m);
  store.ws.data.settings.units = 'imperial';
});

test('a new workspace shows inches to 1/16"; the precision is a setting for each unit', () => {
  const fresh = store.emptyWorkspace();
  assert.equal(fresh.settings.units, 'imperial');
  assert.equal(fresh.settings.inchPrecision, 16);
  assert.equal(fresh.settings.mmPrecision, 1);
  const IN = 0.0254, s = store.ws.data.settings;
  s.units = 'imperial';
  const len = 33.36 * IN;   // 2'-9 0.36": no value lands halfway between two marks
  const at = den => { s.inchPrecision = den; return store.fmtLen(len); };
  assert.equal(at(64), "2'-9 23/64\"");
  assert.equal(at(32), "2'-9 3/8\"");
  assert.equal(at(16), "2'-9 3/8\"", '0.36" is nearest 6/16 = 3/8');
  assert.equal(at(8), "2'-9 3/8\"");
  assert.equal(at(4), "2'-9 1/4\"");
  assert.equal(at(2), "2'-9 1/2\"");
  assert.equal(at(1), "2'-9\"");
  s.inchPrecision = 1;
  assert.equal(store.fmtLen(11.6 * IN), "1'-0\"", 'rounding to whole inches still carries into feet');
  assert.equal(store.precisionLabel(), '1"');
  s.inchPrecision = 16;
  assert.equal(store.precisionLabel(), '1/16"');
  s.units = 'metric';
  const mm = step => { s.mmPrecision = step; return store.fmtLen(0.85137); };
  assert.equal(mm(0.1), '851.4 mm');
  assert.equal(mm(0.5), '851.5 mm');
  assert.equal(mm(1), '851 mm');
  assert.equal(mm(5), '850 mm');
  assert.equal(mm(10), '850 mm');
  assert.equal(store.precisionLabel(), '10 mm');
  s.mmPrecision = 0.5;
  assert.equal(store.fmtLen(0.851), '851 mm', 'whole millimetres drop the point');
  s.mmPrecision = 0.1;
  assert.equal(store.fmtLen(-0.00001), '0 mm');
  s.mmPrecision = 1; s.units = 'imperial';
});

test('a saved precision that is not on the list falls back to 1/16" and 1 mm', () => {
  const d = store.emptyWorkspace();
  d.settings.inchPrecision = 3; d.settings.mmPrecision = 2; d.settings.units = 'cubits';
  store.replaceWorkspace(JSON.parse(JSON.stringify(d)));
  assert.equal(store.ws.data.settings.inchPrecision, 16);
  assert.equal(store.ws.data.settings.mmPrecision, 1);
  assert.equal(store.ws.data.settings.units, 'imperial');
  store.ws.data = store.emptyWorkspace();
});

test('typed lengths: the forms people type are read, anything else is refused with a reason', () => {
  store.ws.data.settings.units = 'imperial';
  const IN = 0.0254, near = (text, inches) => assert.ok(Math.abs(store.parseLen(text) - inches * IN) < 1e-9, text + ' reads as ' + inches + '"');
  near('6ft 2in', 74); near('6ft2in', 74); near('6 feet 2 inches', 74); near('6 ft', 72); near("12'6\"", 150); near("12' 6", 150);
  near('12.5\'', 150); near("6''", 6); near('30 in', 30); near('3.8 m', 3.8 / IN); near('2 metres', 2 / IN);
  for (const bad of ['10x12', '2,5 m', '1,200 mm', '6 feet tall', 'about 30"', '12 by 14', '--6"', 'wide']) {
    const r = store.readLength(bad);
    assert.ok(Number.isNaN(r.value) && Number.isNaN(store.parseLen(bad)), bad + ' is refused');
    assert.ok(typeof r.error === 'string' && r.error.length > 10, bad + ' says why: ' + r.error);
  }
  assert.match(store.readLength('2,5 m').error, /point for decimals/);
  assert.equal(store.readLength('').error, 'Type a length.');
});

// What a number typed on its own meant in each length field before this reader, field by
// field. A field may not quietly start reading 12 as 12 inches where it read 12 feet. PLAN, MODEL's
// wall and opening size fields and its moved-object fields went with hand editing (2026-11-13).
const BARE_UNIT_BEFORE = {
  'js/documentcenter.js': ['feet'],
  'js/fixtures-ui.js': ['feet'],
  'js/materialsview.js': ['feet'],
  'js/measurements.js': ['inches'],
  'js/markup-layer.js': ['feet'],
  'js/trim-panel.js': ['inches', 'inches', 'inches'],   // trim heights, box widths and row heights (new 2026-11-13): trim is sized in inches   // the LINE tool's typed length (new 2026-11-12; feet like the other MODEL fields, as SketchUp's model units)
};

test('every length field reads a number on its own in the unit it always did', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const root = new URL('../js/', import.meta.url);
  const found = {};
  for (const name of (await readdir(root)).filter(n => n.endsWith('.js') && n !== 'store.js')) {
    const src = await readFile(new URL(name, root), 'utf8');
    // parseLen's bare number is feet unless the call says otherwise; readLength's is inches.
    for (const m of src.matchAll(/\b(parseLen|readLength)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
      if (/^\s*import\b/m.test(src.slice(src.lastIndexOf('\n', m.index) + 1, m.index))) continue;
      const unit = (m[2].match(/,\s*'(feet|inches)'\s*$/) || [])[1] || (m[1] === 'parseLen' ? 'feet' : 'inches');
      (found['js/' + name] ||= []).push(unit);
    }
  }
  assert.deepEqual(found, BARE_UNIT_BEFORE);
});

test('a number on its own is feet where the field read feet, inches in MEASURE, millimetres in metric', () => {
  store.ws.data.settings.units = 'imperial';
  const FT = 0.3048;
  assert.equal(store.parseLen('12'), 12 * FT, 'a 12 in PLAN is still a 12-foot wall');
  assert.equal(store.parseLen('12', 'feet'), 12 * FT);
  assert.equal(store.parseLen('6 1/2'), 6.5 * FT);
  assert.equal(store.parseLen(9), 9 * FT, 'a number argument follows the same rule');
  assert.equal(store.readLength('32').value, 32 / 12 * FT, 'a tape reading of 32 is 32 inches');
  assert.equal(store.readLength('33 1/2', 'inches').value, 33.5 / 12 * FT);
  assert.equal(store.parseLen('32', 'inches'), 32 / 12 * FT);
  assert.equal(store.bareLengthUnit(), 'inches');
  assert.equal(store.bareLengthUnit('feet'), 'feet');
  assert.match(store.readLength('ten', 'feet').error, /a number on its own is feet\.$/);
  assert.throws(() => store.readLength('12', 'yards'), /inches or feet/);
  store.ws.data.settings.units = 'metric';
  assert.equal(store.parseLen('2400'), 2.4);
  assert.equal(store.readLength('2400').value, 2.4);
  assert.equal(store.readLength('2.4 m').value, 2.4);
  assert.equal(store.bareLengthUnit('feet'), 'millimetres');
  store.ws.data.settings.units = 'imperial';
});

test('typed lengths store exactly the metres the earlier reader stored', () => {
  store.ws.data.settings.units = 'imperial';
  // The earlier reader worked out (feet + inches / 12) * 0.3048. Saved walls, openings and
  // undo steps are compared exactly, so the new reader must give the same number to the bit.
  const FT = 0.3048;
  assert.equal(store.parseLen('8"'), 8 / 12 * FT);
  assert.equal(store.parseLen('8"'), 0.2032);
  assert.equal(store.parseLen("12'-6\""), (12 + 6 / 12) * FT);
  assert.equal(store.parseLen("2'-9 1/2\""), (2 + 9.5 / 12) * FT);
  assert.equal(store.parseLen("-7'-7\""), -((7 + 7 / 12) * FT));
  assert.equal(store.parseLen('33 1/2"'), 33.5 / 12 * FT);
  assert.equal(store.parseLen('85 cm'), 0.85);
});

test('typed money: thousands, k and m are read, anything else is refused with a reason', () => {
  const val = t => store.readMoney(t).value;
  assert.equal(val('250k'), 250000);
  assert.equal(val('$250,000'), 250000);
  assert.equal(val('$1.2m'), 1200000);
  assert.equal(val('1.2 million'), 1200000);
  assert.equal(val('1,250,000.50'), 1250000.5);
  assert.equal(val('-$500'), -500);
  assert.equal(val(''), 0, 'blank is no amount');
  // What the earlier reader took is still read the same.
  assert.equal(val('1200$'), 1200);
  assert.equal(val('+500'), 500);
  assert.equal(val('5.'), 5);
  assert.equal(val('$ 1 200'), 1200, 'a space may group thousands');
  assert.equal(val('250 000.75'), 250000.75);
  assert.equal(val('$-500'), -500);
  assert.equal(val('250 k'), 250000);
  for (const bad of ['10x12', '2,5', 'about 300', '12,34', '$$5', '1500 2000', '1 2', '--5', '-$-500', '+-5', '$5$', '1,200 000']) {
    const r = store.readMoney(bad);
    assert.ok(Number.isNaN(r.value) && /is not an amount/.test(r.error), bad + ' is refused');
  }
  assert.equal(store.parseMoney('250k'), 250000, 'the older reader takes the new forms too');
  assert.equal(store.parseMoney('10x12'), 0, 'and still gives 0, never 10, for what it cannot read');
});
