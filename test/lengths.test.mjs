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
  assert.ok(Math.abs(store.parseLen('0.85') - 0.85) < 1e-12, 'plain numbers stay metres in metric');
  store.ws.data.settings.units = 'imperial';
});

test('lengths show to the sixteenth of an inch and metric to the millimetre', () => {
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
  assert.equal(store.fmtLen(0.8509), '0.851 m');
  assert.equal(store.fmtLen(2.835), '2.835 m');
  assert.equal(store.fmtLen(3), '3 m');
  assert.equal(store.fmtLen(-0.0004), '0 m');
  store.ws.data.settings.units = 'imperial';
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

test('a number on its own is inches in feet and inches and metres in metric, in every field', () => {
  store.ws.data.settings.units = 'imperial';
  const IN = 0.0254;
  assert.ok(Math.abs(store.parseLen('32') - 32 * IN) < 1e-9, '32 is a 32" door, not 32 feet');
  assert.ok(Math.abs(store.parseLen('33 1/2') - 33.5 * IN) < 1e-9);
  assert.ok(Math.abs(store.parseLen(32) - 32 * IN) < 1e-9, 'a number argument follows the same rule');
  assert.equal(store.bareLengthUnit(), 'inches');
  store.ws.data.settings.units = 'metric';
  assert.ok(Math.abs(store.parseLen('2.4') - 2.4) < 1e-12);
  assert.equal(store.bareLengthUnit(), 'metres');
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
  for (const bad of ['10x12', '2,5', 'about 300', '12,34', '$$5']) {
    const r = store.readMoney(bad);
    assert.ok(Number.isNaN(r.value) && /is not an amount/.test(r.error), bad + ' is refused');
  }
  assert.equal(store.parseMoney('250k'), 250000, 'the older reader takes the new forms too');
  assert.equal(store.parseMoney('10x12'), 0, 'and still gives 0, never 10, for what it cannot read');
});
