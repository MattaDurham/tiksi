import assert from 'node:assert/strict';
import {
  addMonths, normaliseMaintenance, maintenanceTasks, taskStatus, dueThisMonth, matchTask, parseIcs,
  setTaskInterval, setLastDone, setOff, addSystem, removeSystem, addAppointment,
} from '../js/maintenance.js';

// Month arithmetic stays inside the month.
assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
assert.equal(addMonths('2026-11-15', 3), '2027-02-15');
assert.equal(addMonths('2026-12-02', 12), '2027-12-02');

// Bad records from a file are dropped or repaired, never kept half-formed.
const n = normaliseMaintenance({
  systems: [{ id: 's1', kind: 'chimney' }, { id: 's1', kind: 'piano' }, { id: 'bad id!', kind: 'hvac' }, { id: 's2', kind: 'spaceship', name: 'Well pump' }],
  records: [{ on: 's1', key: 'sweep', intervalMonths: '0', lastDone: '2026-13-40' }, { on: 's1', key: 'sweep', intervalMonths: 6 }],
  appointments: [{ id: 'a2', date: '2026-12-02', start: '09:30', end: '10:00', title: 'Chimney sweep', on: 's1', key: 'sweep' }, { id: 'a1', date: 'tomorrow' }, { id: 'a0', date: '2026-01-05', start: '9am' }],
});
assert.deepEqual(n.systems.map(s => [s.id, s.kind, s.name]), [['s1', 'chimney', ''], ['s2', 'other', 'Well pump']]);
assert.deepEqual(n.records, [{ on: 's1', key: 'sweep', intervalMonths: null, lastDone: '', off: false }]);
assert.deepEqual(n.appointments.map(a => [a.id, a.start]), [['a0', ''], ['a2', '09:30']]);
assert.deepEqual(normaliseMaintenance('nonsense'), { systems: [], records: [], appointments: [] });

// A property with a scanned dishwasher (brand read at onboarding), a fridge, a sofa (no service),
// a chimney and a piano.
const prop = {
  rooms: [{ id: 'r-k', level: 'l0', name: 'Kitchen', pts: [[0, 0], [4, 0], [4, 4], [0, 4]] }],
  fixtures: [
    { id: 'fx-dw', kind: 'appliance', subtype: 'dishwasher', level: 'l0', x: 1, y: 1, name: '', product: { brand: 'Bosch', model: 'SHX78' } },
    { id: 'fx-fr', kind: 'appliance', subtype: 'fridge', level: 'l0', x: 9, y: 9, name: 'Garage fridge' },
    { id: 'fx-so', kind: 'furniture', subtype: 'sofa', level: 'l0', x: 2, y: 2, name: '' },
  ],
  maintenance: normaliseMaintenance(null),
};
addSystem(prop, 'chimney', '', 'sys-ch');
addSystem(prop, 'piano', '', 'sys-pi');
const today = '2026-11-04';
let tasks = maintenanceTasks(prop, today);
assert.deepEqual(tasks.map(t => t.id), ['fx-dw/filter', 'fx-fr/coils', 'fx-fr/water-filter', 'sys-ch/sweep', 'sys-pi/tune']);
assert.equal(tasks[0].what, 'Dishwasher (Bosch SHX78)');
assert.equal(tasks[0].room, 'Kitchen');
assert.equal(tasks[1].room, '');
assert.ok(tasks.every(t => taskStatus(t, today) === 'unknown'), 'no last-done date means nothing to count from');
assert.deepEqual(dueThisMonth(prop, today), []);

// Typed dates: the fridge coils were last cleaned a year ago this month, the piano 13 months ago,
// the dishwasher filter two months ago (due in Jan), the water filter skipped.
setLastDone(prop, 'fx-fr', 'coils', '2025-11-20');
setLastDone(prop, 'sys-pi', 'tune', '2025-10-01');
setLastDone(prop, 'fx-dw', 'filter', '2026-10-01');
setOff(prop, 'fx-fr', 'water-filter', true);
tasks = maintenanceTasks(prop, today);
const st = Object.fromEntries(tasks.map(t => [t.id, taskStatus(t, today)]));
assert.deepEqual(st, { 'fx-dw/filter': 'soon', 'fx-fr/coils': 'due', 'fx-fr/water-filter': 'off', 'sys-ch/sweep': 'unknown', 'sys-pi/tune': 'overdue' });
assert.deepEqual(dueThisMonth(prop, today).map(t => t.id), ['sys-pi/tune', 'fx-fr/coils']);
setTaskInterval(prop, 'fx-dw', 'filter', 1);
assert.equal(maintenanceTasks(prop, today)[0].nextDue, '2026-11-01');
assert.equal(dueThisMonth(prop, today).length, 3);
setTaskInterval(prop, 'fx-dw', 'filter', '');
assert.equal(maintenanceTasks(prop, today)[0].intervalMonths, 3, 'clearing the interval goes back to the typical one');

// Appointment titles find their service.
tasks = maintenanceTasks(prop, today);
assert.equal(matchTask('Rory: chimney sweep', tasks).id, 'sys-ch/sweep');
assert.equal(matchTask('Piano tuning with Ana', tasks).id, 'sys-pi/tune');
assert.equal(matchTask('Bosch dishwasher repair', tasks).id, 'fx-dw/filter');
assert.equal(matchTask('Dentist', tasks), null);
assert.equal(matchTask('fridge water filter', tasks).id, 'fx-fr/coils', 'a skipped service is never matched');

// A booked visit shows as booked and leaves the due list; once it has happened it fills in the
// last-done date, and the next due date counts from it.
addAppointment(prop, { id: 'ap-1', date: '2026-12-02', start: '09:30', end: '10:00', title: 'Rory: chimney sweep', on: 'sys-ch', key: 'sweep' });
addAppointment(prop, { id: 'ap-2', date: '2026-11-18', start: '', end: '', title: 'Piano tuning', on: 'sys-pi', key: 'tune' });
let ch = maintenanceTasks(prop, today).find(t => t.id === 'sys-ch/sweep');
assert.equal(taskStatus(ch, today), 'booked');
assert.equal(ch.booked.id, 'ap-1');
assert.equal(ch.lastDone, '');
assert.deepEqual(dueThisMonth(prop, today).map(t => t.id), ['fx-fr/coils'], 'booked piano tuning leaves the due list');
const later = '2026-12-03';
ch = maintenanceTasks(prop, later).find(t => t.id === 'sys-ch/sweep');
assert.equal(ch.lastDone, '2026-12-02');
assert.equal(ch.lastDoneFrom, 'appointment');
assert.equal(ch.nextDue, '2027-12-02');
assert.equal(taskStatus(ch, later), 'ok');
// A typed date later than the appointment wins.
setLastDone(prop, 'sys-ch', 'sweep', '2026-12-20');
assert.equal(maintenanceTasks(prop, '2026-12-21').find(t => t.id === 'sys-ch/sweep').lastDoneFrom, 'typed');

// Removing a system removes its dates; its appointments stay, unmatched.
removeSystem(prop, 'sys-ch');
assert.ok(!prop.maintenance.records.some(r => r.on === 'sys-ch'));
assert.deepEqual(prop.maintenance.appointments.find(a => a.id === 'ap-1').on, '');
assert.ok(!maintenanceTasks(prop, today).some(t => t.on === 'sys-ch'));

// A custom system matches on its own name.
addSystem(prop, 'other', 'Well pump', 'sys-wp');
assert.equal(matchTask('Well pump service', maintenanceTasks(prop, today)).id, 'sys-wp/service');

// Calendar files: folded lines, all-day events, floating times, UTC times and escapes.
const ics = [
  'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:Rory: chimney sweep', 'DTSTART;TZID=America/New_York:20261202T093000',
  'DTEND;TZID=America/New_York:20261202T100000', 'END:VEVENT',
  'BEGIN:VEVENT', 'SUMMARY:Gutter cleaning\\, front', '  and back', 'DTSTART;VALUE=DATE:20261110', 'DTEND;VALUE=DATE:20261111', 'END:VEVENT',
  'BEGIN:VEVENT', 'SUMMARY:No start', 'END:VEVENT',
  'BEGIN:VEVENT', 'SUMMARY:Utc call', 'DTSTART:20261105T150000Z', 'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');
const ev = parseIcs(ics);
assert.equal(ev.length, 3);
assert.deepEqual(ev[0], { date: '2026-12-02', start: '09:30', end: '10:00', title: 'Rory: chimney sweep' });
assert.deepEqual(ev[1], { date: '2026-11-10', start: '', end: '', title: 'Gutter cleaning, front and back' });
const utc = new Date(Date.UTC(2026, 10, 5, 15, 0));
assert.equal(ev[2].start, String(utc.getHours()).padStart(2, '0') + ':00', 'UTC times are read in local time');
assert.deepEqual(parseIcs(''), []);

console.log('maintenance checks passed');
