import assert from 'node:assert/strict';
import { cpm } from '../js/schedule.js';
const item = (id, durationDays, deps = []) => ({ id, durationDays, deps });
const res = cpm([item('a', 3), item('b', 4, ['a']), item('c', 1)]);
assert.equal(res.end, 7);
assert.equal(res.sched.b.es, 3);
assert.equal(res.sched.c.slack, 6);
assert.equal(res.sched.a.critical, true);
assert.equal(res.cyclic, false);
const cycle = cpm([item('a', 3, ['b']), item('b', 4, ['a']), item('c', 2, ['b'])]);
assert.equal(cycle.cyclic, true);
for (const entry of Object.values(cycle.sched)) for (const field of ['es', 'ef', 'ls', 'lf', 'slack']) assert.ok(Number.isFinite(entry[field]), `${field} remains finite when a cycle is detected`);
const weird = cpm([item('__proto__', '3'), item('constructor', '4', ['__proto__', '__proto__', 'missing']), item('budget', 0)]);
assert.equal(weird.end, 7);
assert.equal(weird.sched.constructor.es, 3);
assert.equal(weird.cyclic, false);
assert.equal(weird.sched.budget, undefined);
console.log('schedule regression checks passed');

// The program's span is its own length, however short; the chart alone keeps a week of width.
const { programSchedule } = await import('../js/program.js');
const short = programSchedule([{ id: 'p', selected: true, items: [item('a', 2), item('b', 1, ['a'])] }], '2026-11-10');
assert.equal(short.days, 3, 'a three-day program reads 3 days, not a week');
assert.equal(programSchedule([{ id: 'p', selected: false, items: [item('a', 2)] }], '2026-11-10').days, 0, 'parked projects take no time');
assert.equal(programSchedule([{ id: 'p', selected: true, startDate: '2026-11-12', items: [item('a', 2)] }, { id: 'q', selected: true, items: [item('b', 3)] }], '2026-11-10').days, 4, 'projects run side by side from their own start dates');
// Spans are whole calendar days, and the last day is the last day with work on it.
const half = programSchedule([{ id: 'p', selected: true, items: [item('a', 0.1), item('b', 0.2, ['a'])] }], '2026-11-10');
assert.equal(half.days, 1, 'a 0.3-day job takes 1 calendar day, not 0.30000000000000004');
assert.equal(half.lastDay, '2026-11-10', 'and ends the day it starts');
assert.equal(programSchedule([{ id: 'p', selected: true, items: [item('a', 2.5)] }], '2026-11-10').days, 3, 'two and a half days take 3 calendar days');
assert.equal(short.lastDay, '2026-11-12', 'a 3-day program from Nov 10 works Nov 10, 11 and 12');
assert.equal(programSchedule([{ id: 'p', selected: true, items: [item('a', 0.2), item('b', 2.2, ['a']), item('c', 0.6, ['b'])] }], '2026-11-10').days, 3, 'float noise (0.2 + 2.2 + 0.6 = 3.0000000000000004) never adds a day');
console.log('program span checks passed');
