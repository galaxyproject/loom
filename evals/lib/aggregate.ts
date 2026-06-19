/**
 * Group per-run results into (scenario, model) cells and compute a majority
 * pass/fail verdict per dimension. A dimension counts toward a cell only if
 * the scenario declares an assertion for it -- otherwise an unexercised
 * dimension would read as a vacuous 100% pass.
 */

import type {
  Assertions,
  Cell,
  Dimension,
  PlanAssertions,
  Scenario,
  ScenarioRun,
} from "./types.js";

export function declaredDimensions(scenario: Scenario): Set<Dimension> {
  const a = scenario.assertions;
  const dims = new Set<Dimension>();
  const planLikes: (PlanAssertions | undefined)[] = [a.plan, a.chatPlan, a.notebook?.plan];

  for (const p of planLikes) {
    if (!p) continue;
    if (p.exists !== undefined || p.minPendingSteps !== undefined || p.eachStepHasDescription)
      dims.add("validity");
    if (p.routingIn) dims.add("routing");
    if (p.mentionsOneOf || p.mentionsNoneOf) dims.add("tools");
  }
  if (a.behavior?.asksClarifyingQuestion) dims.add("behavior");
  if (otherDeclared(a)) dims.add("other");
  return dims;
}

function otherDeclared(a: Assertions): boolean {
  return Boolean(
    a.exitCode !== undefined ||
    a.toolCalls ||
    a.events ||
    a.chatText ||
    a.notebook?.contains?.length ||
    a.notebook?.mustNotContain?.length ||
    a.notebook?.exists !== undefined,
  );
}

export function aggregateCells(runs: ScenarioRun[]): Cell[] {
  const byCell = new Map<string, ScenarioRun[]>();
  for (const r of runs) {
    const key = `${r.scenario.name}::${r.model?.id ?? ""}`;
    const list = byCell.get(key) ?? [];
    list.push(r);
    byCell.set(key, list);
  }

  const cells: Cell[] = [];
  for (const list of byCell.values()) {
    const scenario = list[0].scenario;
    const declared = declaredDimensions(scenario);
    const total = list.length;
    const dimensions: Cell["dimensions"] = {};
    for (const dim of declared) {
      let pass = 0;
      for (const r of list) {
        const failedThisDim = r.failures.some((f) => f.dimension === dim);
        if (!failedThisDim) pass++;
      }
      dimensions[dim] = { pass, total, verdict: pass >= Math.ceil(total / 2) };
    }
    cells.push({
      scenarioName: scenario.name,
      modelId: list[0].model?.id ?? "(none)",
      runs: total,
      dimensions,
    });
  }
  return cells;
}
