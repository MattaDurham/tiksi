// The program: a property's selected projects, totalled as BUDGET shows them and laid out
// as SCHEDULE draws them. BUDGET, SCHEDULE and the one-pager all read these functions, so
// the cost and the span a client sees are the ones on those pages. Pure data, no DOM.
//
// Selected means pr.selected is set: a project without the flag is parked, as BUDGET shows
// it. Subprojects are projects of their own (with a parentId) and count when selected.

import { projectTotals, itemPriced, dayDiff, addDays } from './store.js';

// The projects of a property as BUDGET and SCHEDULE list them: the property's own, and any
// whose property is missing from the workspace (they show under every property).
export function programProjects(prop, data) {
  const d = data || { properties: [], projects: [] };
  const known = new Set((d.properties || []).map(x => x.id));
  return (d.projects || []).filter(pr => pr && ((prop && pr.propertyId === prop.id) || !known.has(pr.propertyId)));
}
export const selectedProjects = projects => (projects || []).filter(pr => pr && pr.selected);

// Low, likely and high of the selected projects, and how many of their items carry a price.
export function programTotals(projects) {
  const t = { low: 0, likely: 0, high: 0, priced: 0 };
  for (const pr of selectedProjects(projects)) {
    const x = projectTotals(pr);
    t.low += x.low; t.likely += x.likely; t.high += x.high;
    t.priced += (pr.items || []).filter(itemPriced).length;
  }
  return t;
}

// Whole calendar days for a span that may end part-way through a day (half-day items): a
// job that ends at day 2.5 takes 3 calendar days. The small allowance keeps float noise
// (0.1 + 0.2) from adding a day.
export const wholeDays = span => span > 0 ? Math.ceil(span - 1e-9) : 0;

// The last calendar day with work on it, for a span of `span` days from `start` (ISO date):
// a one-day job that starts Nov 10 ends Nov 10. '' when there is no work.
export const lastWorkDay = (start, span) => start && wholeDays(span) > 0 ? addDays(start, wholeDays(span) - 1) : '';

// The selected projects laid out from `start` (ISO date): each project's critical path,
// starting on its own start date when that is later, side by side. `days` is the program's
// span in whole calendar days from start to the last finish (0 when nothing has a duration),
// and `lastDay` the last calendar day with work on it.
export function programSchedule(projects, start) {
  const plans = selectedProjects(projects).filter(p => (p.items || []).some(i => (Number(i.durationDays) || 0) > 0)).map(p => {
    const lag = p.startDate && start ? dayDiff(start, p.startDate) : 0;
    const offset = lag > 0 ? lag : 0;
    const { sched, end, cyclic } = cpm(p.items || []);
    return { p, offset, sched, end, cyclic, finish: offset + end };
  });
  const days = wholeDays(Math.max(0, ...plans.map(x => x.finish)));
  return { plans, days, lastDay: lastWorkDay(start, days) };
}

// ---------- critical path (CPM) ----------
export function cpm(items) {
  // items: [{id, durationDays, deps[]}] -> map id -> {es, ef, ls, lf, slack, critical}
  const sched = Object.create(null), byId = Object.create(null);
  const list = items.filter(i => Number.isFinite(Number(i.durationDays)) && Number(i.durationDays) > 0);
  for (const it of list) byId[it.id] = it;

  // Deduplicate edges, and ignore dependencies outside this project and budget-only items.
  const indeg = Object.create(null), succs = Object.create(null), predecessors = Object.create(null);
  for (const it of list) {
    const deps = [...new Set(it.deps || [])].filter(d => Object.hasOwn(byId, d));
    predecessors[it.id] = deps;
    indeg[it.id] = deps.length;
    for (const d of deps) (succs[d] ||= []).push(it.id);
  }
  const queue = list.filter(i => !indeg[i.id]).map(i => i.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const s of succs[id] || []) if (--indeg[s] === 0) queue.push(s);
  }
  const cyclic = order.length < list.length;
  if (cyclic) for (const it of list) if (!order.includes(it.id)) order.push(it.id);

  // In a cycle, use only predecessors already scheduled. Rebuild the successor graph from
  // those accepted edges so the backward pass never reads an unfinished successor's LS.
  const acceptedSuccs = Object.create(null);
  for (const id of order) {
    const deps = predecessors[id].filter(d => Object.hasOwn(sched, d));
    for (const dep of deps) (acceptedSuccs[dep] ||= []).push(id);
    const es = deps.length ? Math.max(...deps.map(d => sched[d].ef)) : 0;
    sched[id] = { es, ef: es + Number(byId[id].durationDays) };
  }
  const end = Math.max(0, ...Object.values(sched).map(s => s.ef));
  for (const id of [...order].reverse()) {
    const ss = acceptedSuccs[id] || [];
    const lf = ss.length ? Math.min(...ss.map(s => sched[s].ls)) : end;
    sched[id].lf = lf;
    sched[id].ls = lf - Number(byId[id].durationDays);
    sched[id].slack = sched[id].ls - sched[id].es;
    sched[id].critical = sched[id].slack < 0.001;
  }
  return { sched, end, cyclic };
}
