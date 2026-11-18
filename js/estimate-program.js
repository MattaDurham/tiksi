// Project the linked package into the existing program. Drawing quantities and legacy scope records
// remain editable in their original locations. Only explicitly covered prices are replaced.
import { estimate } from './bid-estimate.js';
import { crewPlan } from './crew-plan.js';
import { cents } from './bid-stock.js';
import { isoToday } from './store.js';

export function programStart(prop, settings) {
  return (prop?.bidStudio?.program && prop.bidStudio.draft?.start) || settings?.programStart || isoToday();
}
export function rateRange(e, draft) {
  const atRate = (rate) =>
    cents(
      e.total +
        (rate - e.rules.rate) *
          e.hours *
          (1 + (e.rules.contingency + e.rules.overhead + e.rules.profit) / 100),
    );
  return [
    Math.min(e.rules.rate, draft.lowRate ?? e.rules.rate),
    e.rules.rate,
    Math.max(e.rules.rate, draft.highRate ?? e.rules.rate),
  ].map((rate) => ({ rate, total: atRate(rate) }));
}
export function productionScenarios(prop, projects, state, e) {
  return (state.productionCases ?? state.profile?.productionCases ?? []).map((scenario) => {
    const draft = { ...state, production: { ...state.production, ...scenario.production } };
    const scenarioEstimate = estimate(prop, projects, draft);
    const plan = crewPlan(
      scenarioEstimate.rooms,
      state.start,
      e.rules.crew * e.rules.hoursDay,
      state.closed,
      state.twoCoats,
    );
    return {
      name: scenario.name,
      hours: scenarioEstimate.hours,
      total: scenarioEstimate.total,
      finish: plan.finish,
    };
  });
}

export function pricedProgram(prop, projects, start) {
  const binding = prop?.bidStudio?.program;
  const owner = projects.find((p) => p.id === binding?.project);
  if (!owner) return projects;
  const draft = prop.bidStudio.draft || { project: owner.id };
  const e = estimate(prop, projects, draft),
    capacity = e.rules.crew * e.rules.hoursDay;
  const calendar = crewPlan(
    e.rooms,
    start || draft.start || isoToday(),
    capacity,
    draft.closed,
    draft.twoCoats,
  );
  const scopeIds = new Set(e.scope.map((item) => item.id));
  const included = new Set([
    ...(binding.covered || []),
    ...e.scope.filter((s) => s.selected).map((s) => s.id),
  ]);
  const [low, , high] = rateRange(e, draft);
  const cases = productionScenarios(prop, projects, draft, e);
  const values = [e.total, ...cases.map((c) => c.total)];
  const line = {
    id: 'estimate:' + owner.id,
    name: draft.title || 'Drawn finish package',
    unit: 'package',
    qty: 1,
    likely: e.total,
    low: cases.length ? Math.min(...values) : low.total,
    high: cases.length ? Math.max(...values) : high.total,
    durationDays: 0,
    deps: [],
  };
  return projects.map((p) => {
    const items = (p.items || []).map((it) =>
      (owner.selected || p.id === owner.id) && scopeIds.has(it.id) && included.has(it.id)
        ? { ...it, low: 0, likely: 0, high: 0, durationDays: 0 }
        : it,
    );
    if (p.id !== owner.id) return { ...p, items };
    return {
      ...p,
      items: [...items, line],
      crewPlan: calendar,
      estimatedRooms: e.rooms.map((r) => ({
        id: r.key,
        name: r.name,
        stock: r.material,
        hours: r.hours,
        labor: r.hours * e.rules.rate,
      })),
      crewStart: start || draft.start,
      crewSize: e.rules.crew,
      crewDay: e.rules.hoursDay,
      estimateLine: line,
    };
  });
}
