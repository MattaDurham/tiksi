// Writes test/fixtures/standard-views.json: synthetic buildings and the standard view set
// js/standard-views.js makes for each. server/standard_scenes.py must make the same set from the
// same input (test/test_standard_scenes.py); rerun this only when the rules change on purpose:
//   node tools/standard-views-fixture.mjs
import { writeFileSync } from 'node:fs';
import { standardSet } from '../js/standard-views.js';

const level = (id, name, elevation, height) => ({ id, name, elevation, height });
const cases = [
  { about: 'one level: a square-cornered kitchen and an L-shaped hall, the hall\'s west wall drawn in two pieces',
    input: { north: 0, levels: [level('lvl-0', 'Main level', 0, 2.44)], walls: [],
      rooms: [
        { id: 'r1', name: 'Kitchen', level: 'lvl-0', z: 0, height: 2.44, pts: [[0, 0], [4, 0], [4, 3], [0, 3]] },
        { id: 'r2', name: 'Hall', level: 'lvl-0', z: 0, height: 2.44, pts: [[4, 0], [6, 0], [6, 1], [5, 1], [5, 3], [4, 3], [4, 1.5]] },
      ] } },
  { about: 'two levels, north turned 30 degrees: a clockwise room with a 1\'-0" jog (no elevation), an angled room, a room with no name, walls only on the empty attic',
    input: { north: 30, levels: [level('lvl-0', 'Ground', 0, 2.7), level('lvl-1', 'Upper', 3, 2.4), level('lvl-2', 'Attic', 5.6, 2)],
      walls: [{ level: 'lvl-0', ax: -1, ay: -1, bx: 7, by: -1 }, { level: 'lvl-2', ax: 0, ay: 0, bx: 5, by: 0 }],
      rooms: [
        { id: 'a', name: 'Living room', level: 'lvl-0', z: 0, height: 2.7, pts: [[0, 0], [0, 4], [5, 4], [5, 2.3048], [5.3048, 2.3048], [5.3048, 0]] },
        { id: 'b', name: 'Bay', level: 'lvl-1', z: 3, height: 2.1, pts: [[0, 0], [3, 0], [3.8, 1.2], [3, 2.4], [0, 2.4]] },
        { id: 'c', name: '', level: 'lvl-1', z: 3, height: 2.4, pts: [[0, 2.4], [3, 2.4], [3, 5], [0, 5]] },
      ] } },
];
for (const c of cases) c.views = standardSet(c.input);
writeFileSync(new URL('../test/fixtures/standard-views.json', import.meta.url), JSON.stringify({ about: 'Inputs and the standard view set js/standard-views.js and server/standard_scenes.py both make from them (tools/standard-views-fixture.mjs).', cases }, null, 1) + '\n');
console.log(cases.map(c => c.views.length + ' views: ' + c.views.map(v => v.name).join('; ')).join('\n'));
