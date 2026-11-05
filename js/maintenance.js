// Maintenance: what each home needs serviced, and when. Pure functions; MAINTENANCE
// (maintenanceview.js) draws them.
//
// The service list is built from what the property already knows. Every fixture found at
// onboarding or drawn by hand (prop.fixtures, fixtures.js) gets the typical service of its
// subtype (FIXTURE_SERVICE), and the house systems the owner adds (chimney, HVAC, gutters,
// piano...) get theirs (HOUSE_SYSTEMS). Nothing is copied: delete a fixture and its service
// goes with it. What the household changes or records lives on the property:
//
//   prop.maintenance = {
//     systems       [{ id, kind, name }]                     house systems at this home
//     records       [{ on, key, intervalMonths, lastDone, off }]
//                   on = a fixture or system id, key = the task; only the values set by
//                   hand (null = the typical interval / no date typed)
//     appointments  [{ id, date, start, end, title, on, key, notes }]
//                   a booked visit; on/key name the task it services ('' = not matched).
//                   An appointment on or before today counts as done on its date.
//   }
//
// Dates are local ISO days (YYYY-MM-DD); times are HH:MM or ''.

import { fixtureLabel, roomOfFixture } from './fixtures.js';

// Typical intervals in months. [key, task, months, words an appointment title may use].
export const FIXTURE_SERVICE = {
  fridge: [['coils', 'Clean condenser coils', 12, ['coil', 'fridge', 'refrigerator']], ['water-filter', 'Replace water filter', 6, ['water filter', 'fridge filter', 'refrigerator filter']]],
  dishwasher: [['filter', 'Clean filter and spray arms', 3, ['dishwasher']]],
  range: [['service', 'Clean burners, check the gas connection', 12, ['range', 'stove', 'oven', 'burner']]],
  'washer-dryer': [['vent', 'Clean the dryer vent duct', 12, ['dryer vent', 'dryer', 'lint']], ['hoses', 'Inspect washer hoses', 12, ['washer', 'hose']]],
  'range-hood': [['grease', 'Clean the grease filter', 3, ['hood', 'grease']]],
  'mini-split': [['filters', 'Wash the indoor unit filters', 3, ['mini-split', 'mini split', 'head filter']], ['service', 'Professional coil cleaning', 12, ['mini-split', 'mini split', 'heat pump', 'hvac']]],
  'water-heater': [['flush', 'Flush the tank, check the anode', 12, ['water heater', 'flush', 'anode']]],
  'outdoor-unit': [['service', 'Clear and service the outdoor unit', 12, ['condenser', 'outdoor unit', 'heat pump', 'hvac']]],
  thermostat: [['battery', 'Replace batteries', 12, ['thermostat']]],
  toilet: [['valves', 'Check the flapper and fill valve', 24, ['toilet', 'flapper', 'fill valve']]],
  tub: [['caulk', 'Inspect caulk and grout', 12, ['caulk', 'grout', 'tub']]],
  faucet: [['aerator', 'Clean the aerator', 12, ['faucet', 'aerator']]],
  vent: [['clean', 'Clean the exhaust fan', 12, ['exhaust fan', 'bath fan', 'vent']]],
};

export const HOUSE_SYSTEMS = {
  chimney: { label: 'Chimney', tasks: [['sweep', 'Sweep and inspect', 12, ['chimney', 'sweep', 'flue', 'fireplace']]] },
  hvac: { label: 'HVAC', tasks: [['service', 'Heating and cooling service', 12, ['hvac', 'furnace', 'boiler', 'heating', 'air conditioning', 'tune-up']], ['filter', 'Replace the air filter', 3, ['air filter', 'furnace filter']]] },
  gutters: { label: 'Gutters', tasks: [['clean', 'Clean gutters and downspouts', 6, ['gutter', 'downspout']]] },
  piano: { label: 'Piano', tasks: [['tune', 'Tune', 12, ['piano', 'tuning', 'tuner']]] },
  roof: { label: 'Roof', tasks: [['inspect', 'Inspect the roof and flashing', 12, ['roof', 'flashing', 'shingle']]] },
  alarms: { label: 'Smoke and CO alarms', tasks: [['test', 'Test alarms, replace batteries', 12, ['smoke', 'alarm', 'detector', 'carbon monoxide']]] },
  other: { label: 'Other', tasks: [['service', 'Service', 12, []]] },
};

const ID_RE = /^[\w.:-]{1,80}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const str = (v, max = 200) => typeof v === 'string' ? v.slice(0, max) : '';
const months = v => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 1 && n <= 240 ? n : null; };
const isDate = v => typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));

// Bring prop.maintenance from a file or another device into shape (always an object).
export function normaliseMaintenance(m) {
  m = m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  const list = v => Array.isArray(v) ? v.filter(x => x && typeof x === 'object' && !Array.isArray(x)) : [];
  const systems = [], seen = new Set();
  for (const s of list(m.systems)) {
    if (!ID_RE.test(s.id) || seen.has(s.id)) continue;
    seen.add(s.id);
    const kind = Object.hasOwn(HOUSE_SYSTEMS, s.kind) ? s.kind : 'other';
    systems.push({ id: s.id, kind, name: str(s.name, 120) });
  }
  const records = [], keys = new Set();
  for (const r of list(m.records)) {
    if (!ID_RE.test(r.on) || !ID_RE.test(r.key) || keys.has(r.on + '/' + r.key)) continue;
    keys.add(r.on + '/' + r.key);
    records.push({ on: r.on, key: r.key, intervalMonths: months(r.intervalMonths), lastDone: isDate(r.lastDone) ? r.lastDone : '', off: r.off === true });
  }
  const appointments = [];
  for (const a of list(m.appointments)) {
    if (!ID_RE.test(a.id) || !isDate(a.date)) continue;
    const matched = ID_RE.test(a.on) && ID_RE.test(a.key);
    appointments.push({
      id: a.id, date: a.date, start: TIME_RE.test(a.start) ? a.start : '', end: TIME_RE.test(a.end) ? a.end : '',
      title: str(a.title), on: matched ? a.on : '', key: matched ? a.key : '', notes: str(a.notes, 1000),
    });
  }
  appointments.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  return { systems, records, appointments };
}

// ---------- dates ----------

const parts = iso => iso.split('-').map(Number);
const iso = (y, m, d) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// `n` calendar months after the day, kept inside the month (Jan 31 + 1 = Feb 28 or 29).
export function addMonths(day, n) {
  const [y, m, d] = parts(day);
  const total = y * 12 + (m - 1) + n, ny = Math.floor(total / 12), nm = total % 12 + 1;
  return iso(ny, nm, Math.min(d, daysIn(ny, nm)));
}
export function monthBounds(today) {
  const [y, m] = parts(today);
  return { first: iso(y, m, 1), last: iso(y, m, daysIn(y, m)) };
}

// ---------- the service list ----------

function fixtureWhat(f) {
  const p = f.product && typeof f.product === 'object' ? f.product : null;
  const make = p ? [p.brand, p.model].filter(x => typeof x === 'string' && x).join(' ') : '';
  return make ? `${fixtureLabel(f)} (${make})` : fixtureLabel(f);
}
export function systemLabel(s) { return s.name || (HOUSE_SYSTEMS[s.kind] || HOUSE_SYSTEMS.other).label; }

// Every task at the property, in onboarding order (fixtures, then systems), with its interval,
// last-done date (typed, or the latest appointment that has happened, whichever is later),
// next due date and the next booked appointment.
export function maintenanceTasks(prop, today) {
  const m = prop.maintenance || { systems: [], records: [], appointments: [] };
  const rec = new Map(m.records.map(r => [r.on + '/' + r.key, r]));
  const rooms = new Map((prop.rooms || []).map(r => [r.id, r.name]));
  const out = [];
  const push = (base, [key, task, typical, words]) => {
    const r = rec.get(base.on + '/' + key) || {};
    const id = base.on + '/' + key;
    const visits = m.appointments.filter(a => a.on === base.on && a.key === key);
    const past = visits.filter(a => a.date <= today).pop() || null;
    const booked = visits.find(a => a.date > today) || null;
    let lastDone = r.lastDone || '', from = lastDone ? 'typed' : '';
    if (past && past.date > lastDone) { lastDone = past.date; from = 'appointment'; }
    const intervalMonths = r.intervalMonths || typical;
    out.push(Object.assign({}, base, {
      id, key, task, words, typicalMonths: typical, intervalMonths, custom: !!r.intervalMonths, off: !!r.off,
      lastDone, lastDoneFrom: from, lastAppointment: from === 'appointment' ? past : null,
      nextDue: lastDone ? addMonths(lastDone, intervalMonths) : '', booked,
    }));
  };
  for (const f of prop.fixtures || []) {
    const list = FIXTURE_SERVICE[f.subtype];
    if (!list) continue;
    const roomId = roomOfFixture(prop.rooms, f);
    for (const t of list) push({ on: f.id, source: 'fixture', what: fixtureWhat(f), room: rooms.get(roomId) || '' }, t);
  }
  for (const s of m.systems) {
    const tasks = s.kind === 'other' ? [['service', 'Service', 12, (s.name || '').toLowerCase().split(/\W+/).filter(w => w.length > 2)]] : HOUSE_SYSTEMS[s.kind].tasks;
    for (const t of tasks) push({ on: s.id, source: 'system', what: systemLabel(s), room: '' }, t);
  }
  return out;
}

// Where a task stands this month.
//   off       the household skips it
//   booked    an appointment is on the calendar
//   overdue   due before this month
//   due       due this month
//   soon      due in the next two months
//   ok        later
//   unknown   no last-done date yet, so nothing to count from
export function taskStatus(t, today) {
  if (t.off) return 'off';
  if (t.booked) return 'booked';
  if (!t.nextDue) return 'unknown';
  const { first, last } = monthBounds(today);
  if (t.nextDue < first) return 'overdue';
  if (t.nextDue <= last) return 'due';
  if (t.nextDue <= monthBounds(addMonths(first, 2)).last) return 'soon';
  return 'ok';
}

// What to do this month: overdue first, then due, earliest first.
export function dueThisMonth(prop, today) {
  return maintenanceTasks(prop, today)
    .map(t => Object.assign(t, { status: taskStatus(t, today) }))
    .filter(t => t.status === 'overdue' || t.status === 'due')
    .sort((a, b) => a.nextDue.localeCompare(b.nextDue) || a.what.localeCompare(b.what));
}

// The task an appointment title is about: the most words matched, then the first task. Matches
// on the task's words and on the fixture or system name ("Rory: chimney sweep" -> Chimney).
export function matchTask(title, tasks) {
  const text = ' ' + String(title || '').toLowerCase().replace(/[^a-z0-9-]+/g, ' ') + ' ';
  let best = null, bestScore = 0;
  for (const t of tasks) {
    if (t.off) continue;
    const words = new Set([...(t.words || []), ...t.what.toLowerCase().replace(/\(.*\)/, '').split(/[^a-z0-9-]+/).filter(w => w.length > 2)]);
    let score = 0;
    for (const w of words) if (text.includes(' ' + w + ' ') || (w.includes(' ') && text.includes(w)) || text.includes(' ' + w + 's ')) score += w.includes(' ') ? 2 : 1;
    if (score > bestScore) { best = t; bestScore = score; }
  }
  return best;
}

// ---------- calendar files ----------

// The events in an .ics calendar file: [{ date, start, end, title }] in local time. Handles
// folded lines, all-day events (VALUE=DATE), floating and TZID times (taken as written) and
// UTC times (converted to this machine's zone).
export function parseIcs(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { ev = {}; continue; }
    if (line === 'END:VEVENT') { if (ev && ev.start) events.push(ev); ev = null; continue; }
    if (!ev) continue;
    const at = line.indexOf(':');
    if (at < 0) continue;
    const name = line.slice(0, at).split(';')[0].toUpperCase(), value = line.slice(at + 1).trim();
    if (name === 'SUMMARY') ev.title = value.replace(/\\([,;\\])/g, '$1').replace(/\\n/gi, ' ');
    else if (name === 'DTSTART') ev.start = icsTime(value);
    else if (name === 'DTEND') ev.end = icsTime(value);
  }
  return events.filter(e => e.start).map(e => ({
    date: e.start.date, start: e.start.time, end: e.end && e.end.date === e.start.date ? e.end.time : '', title: e.title || 'Appointment',
  }));
}
function icsTime(v) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d{0,2}(Z)?)?$/.exec(v);
  if (!m) return null;
  if (!m[4]) return { date: iso(+m[1], +m[2], +m[3]), time: '' };
  if (m[6]) {
    const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
    return { date: iso(t.getFullYear(), t.getMonth() + 1, t.getDate()), time: `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` };
  }
  return { date: iso(+m[1], +m[2], +m[3]), time: `${m[4]}:${m[5]}` };
}

// ---------- edits ----------

function ensure(prop) { prop.maintenance = normaliseMaintenance(prop.maintenance); return prop.maintenance; }
function record(prop, on, key) {
  const m = ensure(prop);
  let r = m.records.find(x => x.on === on && x.key === key);
  if (!r) m.records.push(r = { on, key, intervalMonths: null, lastDone: '', off: false });
  return r;
}
export function setTaskInterval(prop, on, key, value) { record(prop, on, key).intervalMonths = months(value); }
export function setLastDone(prop, on, key, day) { record(prop, on, key).lastDone = isDate(day) ? day : ''; }
export function setOff(prop, on, key, off) { record(prop, on, key).off = !!off; }

export function addSystem(prop, kind, name, id) {
  const m = ensure(prop);
  const s = { id, kind: Object.hasOwn(HOUSE_SYSTEMS, kind) ? kind : 'other', name: str(name, 120).trim() };
  m.systems.push(s);
  return s;
}
// A system and everything recorded against it go together.
export function removeSystem(prop, id) {
  const m = ensure(prop);
  m.systems = m.systems.filter(s => s.id !== id);
  m.records = m.records.filter(r => r.on !== id);
  for (const a of m.appointments) if (a.on === id) { a.on = ''; a.key = ''; }
}

export function addAppointment(prop, a) {
  const m = ensure(prop);
  m.appointments.push(a);
  prop.maintenance = normaliseMaintenance(m);
  return prop.maintenance.appointments.find(x => x.id === a.id) || null;
}
export function removeAppointment(prop, id) {
  const m = ensure(prop);
  m.appointments = m.appointments.filter(a => a.id !== id);
}
