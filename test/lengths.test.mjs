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
  assert.equal(store.fmtLen(-2.32), "-7'-7\"", 'a basement floor 2.32 m below the first floor');
  assert.equal(store.fmtLen(-8 * FT, { short: true }), "-8'");
  assert.equal(store.fmtLen(-6 / 12 * FT), '-6"');
  assert.equal(store.fmtLen(-0.001), '0"', 'no sign on a value that rounds to zero');
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
