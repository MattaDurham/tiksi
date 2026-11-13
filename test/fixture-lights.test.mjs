import assert from 'node:assert/strict';
import { classifyFixture, groupFixtures, polygonArea, roomLumens, candela, fixtureSummary, ROOM_LUMENS_PER_M2, STRIP_LUMENS_PER_M } from '../js/fixture-lights.js';

// Names as SketchUp and Blender exports carry them.
const c = classifyFixture;
assert.deepEqual(
  { ...c('Recessed downlight - 6 in LED trim (Halo RL6 class, proposed)') },
  { kind: 'downlight', label: 'Recessed downlight', lumens: 850, kelvin: null, cone: true, stated: false });
assert.equal(c('4" recessed can light').lumens, 650);
for (const name of ['Recessed light', 'Recessed lighting', 'Recessed luminaire', 'Recessed 6 in LED trim', 'Recessed LED panel']) {
  assert.equal(c(name)?.kind, 'downlight', name);
}
assert.equal(c('Ceiling light - 13 in drum flush mount, brushed nickel').lumens, 1600);
assert.equal(c('Ceiling light 1 (flush disc)').kind, 'flush');
assert.equal(c('Ceiling light 1 (flush disc)').lumens, 1100);
assert.equal(c('Pendant over island - canopy and brass stem').kind, 'pendant');
assert.equal(c('Bath | two-globe sconce arm').lumens, 900);
assert.equal(c('Bedroom | brass sconce shade').lumens, 450);
assert.equal(c('Wall sconce - plug-in, black arm, opal globe (proposed)').kind, 'sconce');
assert.equal(c('Ceiling fan - Minka-Aire Light Wave 52 in coal (proposed)').lumens, 1000);
assert.equal(c('Ceiling fan - plain 52 in'), null, 'a fan with no light gives none');
assert.equal(c('Balloon lamp - pink crochet').kind, 'lamp');
assert.equal(c('LED strip - warm').kelvin, 2700);
assert.equal(c('LED strip under upper rack').lumens, null, 'a strip is sized by its length');
// Stated output and colour win over the estimate.
assert.deepEqual([c('Pendant 1200 lm 3000K').lumens, c('Pendant 1200 lm 3000K').kelvin, c('Pendant 1200 lm 3000K').stated], [1200, 3000, true]);
// Not light sources.
for (const name of ['Light switch (ceiling lights + LED strip)', 'Light bath tile', 'Skylight - 2x4', 'Bath | vanity top with sink', 'Light oak flooring', 'Wall', '', null]) {
  assert.equal(c(name), null, String(name));
}
for (const name of ['Recessed convector', 'Bedroom | recessed cabinet convector cover', 'Recessed radiator',
  'Recessed heating cover', 'Recessed heater', 'Recessed cabinet', 'Recessed wall niche', 'Recessed grille', 'Recessed trim']) {
  assert.equal(c(name), null, name + ' must not emit estimated light');
}

// Parts of one fixture join by where they sit; the same fixture drawn twice is two fixtures.
const box = (name, x, y, z, w = 0.1, h = 0.1, d = 0.1) => ({ name, min: [x - w / 2, y - h / 2, z - d / 2], max: [x + w / 2, y + h / 2, z + d / 2] });
const parts = [
  box('Bath | two-globe sconce backplate', 1, 1.8, 0, 0.12, 0.2, 0.02),
  box('Bath | two-globe sconce arm', 1, 1.8, 0.08, 0.3, 0.03, 0.12),
  box('Bath | two-globe sconce globe', 0.88, 1.85, 0.15, 0.1, 0.1, 0.1),
  box('Bath | two-globe sconce globe.001', 1.12, 1.85, 0.15, 0.1, 0.1, 0.1),
  box('Bath | two-globe sconce backplate', 3, 1.8, 0, 0.12, 0.2, 0.02),
  box('Recessed downlight - 6 in LED trim', 2, 2.43, 2, 0.17, 0.02, 0.17),
  box('Recessed downlight - 6 in LED trim', 3.2, 2.43, 2, 0.17, 0.02, 0.17),
  box('LED strip under upper rack', 5, 1.4, 1, 1.5, 0.01, 0.02),
  box('Light switch (ceiling lights + LED strip)', 1.3, 1.2, 0, 0.07, 0.11, 0.01),
  box('Sofa', 2, 0.4, 3, 2, 0.8, 0.9),
  box('Recessed convector cover', 2, 0.4, 2, 1.3, 0.5, 0.05),
  box('Recessed radiator', 3.2, 0.4, 2, 0.8, 0.5, 0.05),
  box('Recessed heating cover', 5, 0.4, 2, 1, 0.5, 0.05),
];
const fx = groupFixtures(parts);
assert.equal(fx.length, 5, JSON.stringify(fx.map(f => f.name)));
const sconces = fx.filter(f => f.kind === 'sconce');
assert.equal(sconces.length, 2);
assert.equal(sconces[0].lumens, 900);
assert.ok(Math.abs(sconces[0].at[0] - 1) < 0.01 && Math.abs(sconces[0].at[1] - 1.8125) < 0.05, 'a wall light shines from the middle of its parts');
const downs = fx.filter(f => f.kind === 'downlight');
assert.equal(downs.length, 2);
assert.ok(downs.every(d => d.cone && d.lumens === 850 && Math.abs(d.at[1] - (2.42 - 0.03)) < 1e-9), 'a downlight shines from just under its trim');
const strip = fx.find(f => f.kind === 'strip');
assert.equal(strip.lumens, Math.round(STRIP_LUMENS_PER_M * 1.5));
assert.deepEqual(groupFixtures([]), []);
assert.deepEqual(groupFixtures([{ name: 'Pendant', min: [0, NaN, 0], max: [1, 1, 1] }]), [], 'a part with no position is skipped');

// A traced room with no fixture: an estimate from its floor area.
assert.equal(polygonArea([[0, 0], [4, 0], [4, 3], [0, 3]]), 12);
assert.equal(polygonArea([[0, 0], [0, 3], [4, 3], [4, 0]]), 12, 'either winding');
assert.equal(roomLumens(12), 12 * ROOM_LUMENS_PER_M2);
assert.equal(roomLumens(-1), 0);

// Intensity: all round, lumens / 4 pi; a downward cone concentrates the same lumens.
assert.ok(Math.abs(candela(4 * Math.PI) - 1) < 1e-12);
assert.ok(candela(850, 50) > candela(850) * 2, 'a 100-degree beam is several times brighter on axis');
assert.ok(Math.abs(candela(2 * Math.PI, 90) - 1) < 1e-12, 'a half-sphere of 2 pi lumens is 1 candela');
assert.equal(candela('x'), 0);

// The panel's account, brightest total first.
const summary = fixtureSummary([...fx, { kind: 'room', lumens: 1800 }]);
assert.deepEqual(summary.map(s => [s.label, s.count, s.lumens]),
  [['Wall sconce', 2, 900], ['Estimated ceiling light', 1, 1800], ['Recessed downlight', 2, 850], ['LED strip', 1, 450]]);

console.log('Fixture light checks passed.');
