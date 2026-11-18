// Allocate person-hours against one shared crew. An hour charged to one room cannot also be used in another.
import { addDays, dayDiff } from './store.js';

const PHASES = [
  'Layout and installation',
  'Surface preparation',
  'First coat',
  'Second coat',
  'Cleanup and walkthrough',
];
function stages(task, finish) {
  if (finish && task.id === 'paint')
    return [
      [2, 0.5],
      [3, 0.5],
    ];
  if (task.id === 'cleanup') return [[4, 1]];
  if (['finish', 'caulk', 'fill'].includes(task.id)) return [[1, 1]];
  return [[0, 1]];
}
export function crewPlan(rooms, start, capacity, closed = [], finish = false) {
  const days = [],
    phases = [],
    byRoom = new Map(),
    firstCoat = new Map(),
    off = new Set(closed);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
    !Number.isFinite(Date.parse(start)) ||
    !(capacity > 0) ||
    rooms.reduce((sum, r) => sum + r.hours, 0) / capacity > 3660
  )
    return { days, phases, rooms: [], finish: '' };
  let date = start,
    used = 0;
  function next() {
    date = addDays(date, 1);
    used = 0;
  }
  function available() {
    while (off.has(date) || [0, 6].includes(new Date(date + 'T12:00:00Z').getUTCDay())) next();
  }
  const queues = PHASES.map(() => []);
  for (const room of rooms)
    for (const task of room.labor) {
      for (const [phase, fraction] of stages(task, finish)) {
        if (task.extended > 0)
          queues[phase].push({
            room: room.name,
            key: room.key,
            task: task.label,
            hours: task.extended * fraction,
          });
      }
    }
  for (const [index, queue] of queues.entries()) {
    const phase = { name: PHASES[index], hours: 0, segments: [] };
    for (const job of queue) {
      if (index === 3 && date <= firstCoat.get(job.key)) {
        date = addDays(firstCoat.get(job.key), 1);
        used = 0;
      }
      let remaining = job.hours;
      while (remaining > 1e-8) {
        available();
        const hours = Math.min(remaining, capacity - used);
        let day = days.at(-1);
        if (day?.date !== date) {
          day = { date, hours: 0, tasks: [] };
          days.push(day);
        }
        const from = dayDiff(start, date) + used / capacity;
        day.tasks.push({ roomKey: job.key, room: job.room, task: job.task, phase: phase.name, hours });
        day.hours += hours;
        phase.hours += hours;
        const last = phase.segments.at(-1);
        if (last && Math.abs(last[1] - from) < 1e-8) last[1] = from + hours / capacity;
        else phase.segments.push([from, from + hours / capacity]);
        const r = byRoom.get(job.key) || { room: job.room, hours: 0, first: days.length, from: date };
        r.hours += hours;
        r.to = date;
        r.last = days.length;
        byRoom.set(job.key, r);
        if (index === 2) firstCoat.set(job.key, date);
        used += hours;
        remaining -= hours;
        if (capacity - used < 1e-8) next();
      }
    }
    if (phase.hours) phases.push(phase);
  }
  return { days, phases, rooms: [...byRoom.values()], finish: days.at(-1)?.date || '' };
}
