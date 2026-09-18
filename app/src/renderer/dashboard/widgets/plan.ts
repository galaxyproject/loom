/**
 * Plan widget -- where the analysis stands against the plan it is following.
 *
 * Reads `ctx.sources.plan`, which the host derives from the notebook markdown
 * per `docs/agent/notebook-schema.md`, so the desktop and the web shell show
 * the same thing without either of them reading a file.
 *
 * The target reader cannot read a terminal, so nothing here shows a machine
 * word: `[hybrid]` becomes a sentence, `- [!]` becomes "Failed", and a step
 * carries a glyph and a word before it carries a colour.
 */

import { safeName, safeNameOr } from "./text-safety.js";
import type { PlanSection, PlanSnapshot, PlanStep, WidgetDefinition } from "../widget-api.js";

/**
 * A `type`, not an `interface`: an interface has no implicit index signature
 * and will not assign to the registry's `WidgetDefinition<Record<string, unknown>>`.
 */
type PlanConfig = {
  /** `latest` draws only the most recent plan; `all` lists the earlier ones under it. */
  plan: "latest" | "all";
  /** Keep finished steps in the checklist. Off leaves only what is still to do. */
  showCompleted: boolean;
};

const EMPTY = "No plan yet -- ask Loom to draft one.";

/**
 * Which earlier plans each panel has open, by panel id.
 *
 * Not in the config, because idly opening an old plan should not write to
 * disk, and not in the closure, because `setConfig` re-mounts the widget: both
 * header buttons would otherwise silently collapse everything the reader had
 * opened.
 *
 * Two caveats, both of which cost this map a bound it did not have.
 *
 * A panel id is unique within a dashboard and deliberately reused across them
 * -- `host.ts` says so, and both shipped presets name their plan panel
 * `p-plan` -- so two plan panels on two dashboards share one entry here. They
 * read the same notebook, so a shared key still means the same plan and the
 * only symptom is that opening a row on one dashboard opens it on the other.
 * Keying on the dashboard as well needs the host to put its id on the widget
 * context; until it does, this is the honest description of what the map is.
 *
 * And nothing used to be removed from it, so "bounded by the 40 panels a
 * document may hold" was true of neither dimension: a session that opens
 * several analyses accumulates a set per panel id it has ever seen, and each
 * set accumulates a key per plan that has ever been expanded. The map is capped
 * below; each set is bounded by `pruneOpened`, which drops every key the
 * notebook no longer offers, so a set can never hold more than the notebook
 * has plans.
 */
const openedByPanel = new Map<string, Set<string>>();

/** Panel ids remembered at once, least recently mounted evicted first. */
export const PANEL_MEMORY_MAX = 40;

function openedFor(panelId: string): Set<string> {
  const existing = openedByPanel.get(panelId);
  if (existing) {
    // Re-insert so the eviction below drops the panel nobody has mounted for
    // longest rather than the one that happens to have been created first.
    openedByPanel.delete(panelId);
    openedByPanel.set(panelId, existing);
    return existing;
  }
  const set = new Set<string>();
  openedByPanel.set(panelId, set);
  while (openedByPanel.size > PANEL_MEMORY_MAX) {
    const oldest = openedByPanel.keys().next();
    if (oldest.done) break;
    openedByPanel.delete(oldest.value);
  }
  return set;
}

/**
 * The open/closed key for one "other plan" row. Plan ids are slugged from the
 * heading and two plans can slug alike, so the key carries the plan's position
 * in the notebook as well -- the position it has in the notebook, not in the
 * filtered list, because which plan is current changes as steps get ticked and
 * a key numbered within the list would shift under the reader.
 */
function openKey(index: number, plan: PlanSection): string {
  return `${index}:${plan.title}`;
}

/**
 * Forget the rows that are no longer on offer. The keys carry a plan's position
 * in the notebook, so editing the notebook retires old ones for good; without
 * this the set only ever grows, and a stale key can hand its open state to a
 * different plan that later lands in the same position.
 */
function pruneOpened(opened: Set<string>, live: ReadonlySet<string>): void {
  for (const key of opened) {
    if (!live.has(key)) opened.delete(key);
  }
}

/**
 * The four routing tags the notebook schema defines, in the words of someone
 * who has to decide whether to leave the laptop open. Definitions follow
 * `docs/agent/galaxy-routing.md`.
 */
const ROUTING_WORDS: Record<string, string> = {
  galaxy: "Runs on Galaxy",
  local: "Runs on this computer",
  hybrid: "Part on Galaxy, part on this computer",
  remote: "One Galaxy workflow, start to finish",
};

interface StepGlyph {
  glyph: string;
  word: string;
  state: string;
}

/**
 * A checkbox says done, failed or neither. It does not say "running" -- a step
 * Galaxy is working on right now and a step nobody has touched are the same
 * `- [ ]` -- so the pending word is "To do" rather than anything that implies
 * we know what the machine is doing. The jobs panel owns that question.
 */
const STEP_LOOK: Record<PlanStep["status"], StepGlyph> = {
  done: { glyph: "✓", word: "Done", state: "state-done" },
  failed: { glyph: "✕", word: "Failed", state: "state-failed" },
  pending: { glyph: "○", word: "To do", state: "state-waiting" },
};

interface PlanCounts {
  total: number;
  done: number;
  failed: number;
}

function countSteps(steps: PlanStep[]): PlanCounts {
  let done = 0;
  let failed = 0;
  for (const step of steps) {
    if (step.status === "done") done++;
    else if (step.status === "failed") failed++;
  }
  return { total: steps.length, done, failed };
}

/**
 * Which plan the panel is about.
 *
 * "The last one written down" is the obvious rule and it is wrong in the case
 * this panel exists for. The agent drafts a follow-up plan while the current
 * one is still running, so a notebook whose Plan A just failed at step 3 very
 * often has an untouched Plan B underneath it -- and the last-one rule then
 * puts "no steps done yet" at the top of the dashboard while the jobs panel
 * directly below reports the failure. The two panels contradict each other and
 * the wrong one is first.
 *
 * So: the last plan that has been started and still has a step to do. If none
 * has -- everything is over, or nothing has begun -- fall back to the last one
 * that has any steps at all, which is right for both of those. The rest stay
 * reachable through "older".
 *
 * "Still has a step to do" rather than "is not finished" on purpose. A plan
 * whose last unticked step failed has nothing pending and nothing more will
 * happen in it, but it is not all-done either; reading that as unfinished
 * pinned it as the current plan for good, and no plan written after it could
 * ever take over. It also made the panel disagree with itself, because the
 * header summarises those same counts as "Finished, but 1 step failed".
 *
 * The one case this deliberately answers differently from "the last plan" is a
 * started-then-abandoned plan sitting above a finished one: the abandoned plan
 * wins, because it is the one with work outstanding. That is the point of the
 * panel, and the finished plan is one click away under "other plans".
 *
 * `undefined` for an empty list rather than a lie in the signature: the caller
 * in this file has already returned by then, but this is exported.
 */
export function currentPlan(plans: PlanSection[]): PlanSection | undefined {
  for (let i = plans.length - 1; i >= 0; i--) {
    const counts = countSteps(plans[i].steps);
    const started = counts.done > 0 || counts.failed > 0;
    const pending = counts.total - counts.done - counts.failed;
    if (started && pending > 0) return plans[i];
  }
  // A heading with nothing under it is not a plan the panel can answer with.
  // The agent writes the heading first and the steps a moment later, so the
  // last section in the notebook is routinely empty while a real plan with
  // real steps sits above it -- and answering with the empty one hides that
  // plan completely, since "other plans" only appears once a second plan
  // exists and the reader has asked for it. The lax heading match in the host
  // parser widens this further: any `## Plan ...` line in ordinary prose
  // arrives here as a stepless section.
  for (let i = plans.length - 1; i >= 0; i--) {
    if (plans[i].steps.length > 0) return plans[i];
  }
  // Nothing anywhere has a step: the last heading is as good an answer as
  // there is, and "No steps written down yet" is the honest thing to say.
  return plans[plans.length - 1];
}

function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.max(0, Math.min(100, (part / whole) * 100));
}

/**
 * Only the four tags the schema defines become a sentence. The host's heading
 * parser reads any trailing `[word]` as routing, so `## Plan A: Call variants
 * on [chrM]` arrives here as routing "chrm" -- saying `Routed "chrm"` would
 * present a chromosome name to a non-developer as a routing decision. An
 * unrecognised tag draws no line at all.
 */
function routingSentence(routing: string | null): string | null {
  if (!routing) return null;
  return ROUTING_WORDS[routing.toLowerCase()] ?? null;
}

/**
 * Step routing is free text (`local`, `Galaxy (bwa-mem2/2.2.1)`, whatever a
 * hand edit left behind), so only the two shapes the schema actually writes
 * are reworded. Everything else is shown as the notebook has it.
 */
function stepRouting(routing: string | null): string | null {
  if (!routing) return null;
  // `safeName` replaces a run of overrides with one space, so the result of a
  // wholly hostile routing string is `" "` -- truthy, and nothing here trims it.
  const trimmed = safeName(routing).trim();
  if (!trimmed) return null;
  if (/^local$/i.test(trimmed)) return "On this computer";
  // Step routing is free text, so it is a name like any other.
  const galaxy = trimmed.match(/^galaxy\b(\s*)(.*)$/i);
  if (!galaxy) return trimmed;
  if (!galaxy[2]) return "On Galaxy";
  // `Galaxy, then local` has no gap after the word, so inserting one would
  // render "On Galaxy , then local".
  return galaxy[1] ? `On Galaxy ${galaxy[2]}` : `On ${trimmed}`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * The one line that answers "is this going well".
 *
 * Everything here has to be true of the checkboxes alone. "Stopped" is not --
 * a plan can carry a failed step and go on past it -- and neither is "not
 * started", because an unticked box covers both "nobody has begun" and "Galaxy
 * is running it right now".
 */
function summarize(counts: PlanCounts): { text: string; state: string; glyph: string } {
  if (counts.total === 0) {
    return { text: "No steps written down yet", state: "state-unknown", glyph: "?" };
  }
  if (counts.failed > 0) {
    const what = `${counts.failed} ${plural(counts.failed, "step", "steps")} failed`;
    const left = counts.total - counts.done - counts.failed;
    let text: string;
    if (left > 0) text = `${what} -- ${left} still to do`;
    // Nothing pending is not the same as finished: every step can have failed.
    else if (counts.done === 0) text = `${what} -- nothing done`;
    else text = `Finished, but ${what}`;
    return { text, state: "state-failed", glyph: "✕" };
  }
  if (counts.done >= counts.total) {
    const what = counts.total === 1 ? "the only step is done" : `all ${counts.total} steps done`;
    return { text: `Finished -- ${what}`, state: "state-done", glyph: "✓" };
  }
  if (counts.done === 0) {
    const what = `${counts.total} ${plural(counts.total, "step", "steps")} to do`;
    return { text: `No steps done yet -- ${what}`, state: "state-waiting", glyph: "○" };
  }
  return {
    text: `In progress -- ${counts.done} of ${counts.total} steps done`,
    state: "state-running",
    glyph: "●",
  };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * A step title comes out of the notebook, so it is model-written text. A bidi
 * override in it reorders the whole row -- the same treatment the log panel
 * gives a tool argument, for the same reason.
 */
function stepLabel(step: PlanStep): string {
  const title = safeNameOr(step.title || step.detail, "Untitled step");
  return `${step.number}. ${title}`;
}

function progressBar(counts: PlanCounts): HTMLElement {
  const bar = el("div", "dash-bar");
  bar.setAttribute("role", "img");
  const parts = [`${counts.done} of ${counts.total} steps done`];
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  bar.setAttribute("aria-label", parts.join(", "));

  const done = el("span", "dash-bar-done");
  done.style.width = `${percent(counts.done, counts.total)}%`;
  const failed = el("span", "dash-bar-fail");
  failed.style.width = `${percent(counts.failed, counts.total)}%`;
  bar.append(done, failed);
  return bar;
}

function stateChip(look: StepGlyph): HTMLElement {
  const chip = el("span", `state ${look.state}`);
  const glyph = el("span", "state-glyph", look.glyph);
  glyph.setAttribute("aria-hidden", "true");
  chip.append(glyph);
  return chip;
}

function stepRow(step: PlanStep): HTMLElement {
  const look = STEP_LOOK[step.status];
  const row = el("div", "dash-row-item");
  if (step.status === "failed") row.classList.add("is-failed");
  row.append(stateChip(look));

  const main = el("div", "dash-row-main");
  const title = el("div", "dash-row-title", stepLabel(step));
  if (step.status === "pending") title.classList.add("is-muted");
  // The row is one line wide in a 175px panel, so the full text has to be
  // reachable some other way than by reading it.
  title.title = stepLabel(step);
  main.append(title);

  const meta: string[] = [look.word];
  const routing = stepRouting(step.routing);
  if (routing) meta.push(routing);
  main.append(el("div", "dash-meta", meta.join(" · ")));

  row.append(main);
  return row;
}

/**
 * One callout: a failure, or the next thing to do.
 *
 * Both get drawn when a plan has both, failure first. A `- [!]` is sticky --
 * the notebook schema has no way to clear one, and a plan routinely carries an
 * old failure and keeps going -- so a failure must not stand in for the next
 * step, and a pending step must not hide a failure.
 */
function calloutFor(step: PlanStep, kind: "failed" | "next"): HTMLElement {
  const failed = kind === "failed";
  const box = el("div", "dash-plan-next");
  if (failed) box.classList.add("is-failed");

  const head = el("div", "dash-plan-next-head");
  head.append(stateChip(STEP_LOOK[step.status]));
  head.append(el("span", "dash-plan-next-label", failed ? "Needs you" : "Next"));
  box.append(head);

  box.append(el("div", "dash-plan-next-title", stepLabel(step)));

  const routing = stepRouting(step.routing);
  if (routing) box.append(el("div", "dash-meta", routing));
  if (step.detail) box.append(el("div", "dash-plan-next-detail", safeName(step.detail)));
  // What still has to become true. On a failed step that is the clearest thing
  // the notebook has about what went wrong, so it is not suppressed there.
  if (step.verification) {
    box.append(el("div", "dash-plan-next-detail", `Done when: ${safeName(step.verification)}`));
  }
  // A "Needs you" box with nothing in it but a step number is a call to action
  // with no action in it.
  if (failed && !step.detail && !step.verification) {
    box.append(el("div", "dash-plan-next-detail", "The notebook does not say what went wrong."));
  }
  return box;
}

function planHeading(plan: PlanSection): DocumentFragment {
  const frag = document.createDocumentFragment();
  frag.append(el("div", "dash-plan-title", safeNameOr(plan.title, "Untitled plan")));
  const routing = routingSentence(plan.routing);
  if (routing) frag.append(el("div", "dash-plan-routing dash-meta", routing));
  return frag;
}

function stepList(steps: PlanStep[], showCompleted: boolean): HTMLElement {
  const list = el("div", "dash-rows");
  const shown = showCompleted ? steps : steps.filter((step) => step.status !== "done");
  for (const step of shown) list.append(stepRow(step));

  const hidden = steps.length - shown.length;
  if (hidden > 0) {
    list.append(
      el(
        "div",
        "dash-meta dash-plan-hidden",
        `${hidden} finished ${plural(hidden, "step", "steps")} hidden`,
      ),
    );
  }
  if (shown.length === 0 && hidden === 0) {
    list.append(el("div", "dash-meta", "This plan has no steps written down yet."));
  }
  return list;
}

export const planWidget: WidgetDefinition<PlanConfig> = {
  type: "plan",
  label: "Plan",
  description: "Where the analysis plan stands.",
  defaultConfig: { plan: "latest", showCompleted: true },

  mount(root, ctx) {
    root.classList.add("dash-plan");

    const opened = openedFor(ctx.panelId);

    const showCompleted = ctx.config.showCompleted !== false;
    const scope: PlanConfig["plan"] = ctx.config.plan === "all" ? "all" : "latest";

    const completedBtn = el("button", "dash-panel-btn");
    completedBtn.type = "button";
    completedBtn.textContent = showCompleted ? "all steps" : "to do";
    completedBtn.title = showCompleted
      ? "Hide the steps that are already done"
      : "Show the steps that are already done";
    completedBtn.classList.toggle("active", !showCompleted);
    completedBtn.addEventListener("click", () => ctx.setConfig({ showCompleted: !showCompleted }));

    const scopeBtn = el("button", "dash-panel-btn", "older");
    scopeBtn.type = "button";
    scopeBtn.title =
      scope === "all" ? "Show only the current plan" : "List the earlier plans as well";
    scopeBtn.classList.toggle("active", scope === "all");
    scopeBtn.addEventListener("click", () =>
      ctx.setConfig({ plan: scope === "all" ? "latest" : "all" }),
    );
    // Only meaningful once a second plan exists; the subscription reveals it.
    scopeBtn.hidden = true;

    ctx.header.append(completedBtn, scopeBtn);
    // Through onDispose, not the returned dispose: that one only owns `root`,
    // and a widget that fails never gets to return one at all. The host does
    // rebuild the header slot per render, but relying on that is relying on
    // host internals the widget is told not to reach for.
    ctx.onDispose(() => {
      completedBtn.remove();
      scopeBtn.remove();
    });

    const body = el("div", "dash-plan-body");
    root.append(body);

    const draw = (snapshot: PlanSnapshot): void => {
      body.textContent = "";
      const plans = snapshot.plans;
      // Hidden with one plan, because "all" and "latest" then draw the same
      // thing -- but never hidden while the config says "all", or a layout
      // written when there were two plans could not be turned back.
      scopeBtn.hidden = plans.length < 2 && scope !== "all";

      if (plans.length === 0) {
        body.append(el("p", "dash-plan-empty", EMPTY));
        return;
      }

      // Against every plan the notebook still has, not just the ones on offer
      // as "other": which plan is current changes as steps get ticked, and a
      // row the reader opened should survive its plan taking a turn at the top.
      pruneOpened(opened, new Set(plans.map((plan, index) => openKey(index, plan))));

      const current = currentPlan(plans);
      if (!current) return;
      const counts = countSteps(current.steps);
      const verdict = summarize(counts);

      body.append(planHeading(current));
      if (counts.total > 0) body.append(progressBar(counts));

      const summary = el("div", `dash-plan-summary state ${verdict.state}`);
      const glyph = el("span", "state-glyph", verdict.glyph);
      glyph.setAttribute("aria-hidden", "true");
      summary.append(glyph, el("span", undefined, verdict.text));
      body.append(summary);

      const failedStep = current.steps.find((step) => step.status === "failed");
      if (failedStep) body.append(calloutFor(failedStep, "failed"));
      const nextStep = current.steps.find((step) => step.status === "pending");
      if (nextStep) body.append(calloutFor(nextStep, "next"));

      if (current.steps.length > 0) body.append(stepList(current.steps, showCompleted));

      if (scope === "all" && plans.length > 1)
        body.append(olderPlans(plans, current, opened, showCompleted));
    };

    ctx.subscribe(ctx.sources.plan, draw);

    return () => {
      root.classList.remove("dash-plan");
      root.textContent = "";
    };
  },
};

/**
 * The plans this panel is not currently about, newest first, collapsed. Each is
 * a real button with `aria-expanded` so the keyboard and a screen reader get
 * the same affordance the mouse does.
 *
 * "Other" rather than "earlier": the plan on show is the one being worked on,
 * which is not always the last one written down, so a draft below it lands
 * here too.
 */
function olderPlans(
  plans: PlanSection[],
  current: PlanSection,
  opened: Set<string>,
  showCompleted: boolean,
): HTMLElement {
  const wrap = el("div", "dash-plan-older");
  // Each entry keeps the position it has in the notebook, not its position in
  // this filtered list -- see `openKey`.
  const others = plans
    .map((plan, index) => ({ plan, index }))
    .filter((entry) => entry.plan !== current);
  wrap.append(
    el(
      "div",
      "dash-plan-older-head dash-meta",
      `${others.length} other ${plural(others.length, "plan", "plans")}`,
    ),
  );

  for (let i = others.length - 1; i >= 0; i--) {
    const { plan, index } = others[i];
    const key = openKey(index, plan);
    const counts = countSteps(plan.steps);
    // The same verdict the current plan gets, so the two never disagree about
    // what "finished" or "stopped" means.
    const verdict = summarize(counts);

    const title = safeNameOr(plan.title, "Untitled plan");
    const row = el("button", "dash-plan-older-row");
    row.type = "button";
    row.append(stateChip({ glyph: verdict.glyph, word: verdict.text, state: verdict.state }));
    const label = el("span", "dash-row-title", title);
    label.title = title;
    row.append(label);
    row.append(
      el(
        "span",
        "dash-meta dash-plan-older-count",
        counts.total > 0 ? `${counts.done}/${counts.total}` : "--",
      ),
    );
    // The row is too narrow for the state word beside the title, and the glyph
    // is aria-hidden decoration, so the word reaches a screen reader through
    // the button's name instead.
    row.setAttribute("aria-label", `${title} -- ${verdict.text}`);

    const detail = el("div", "dash-plan-older-detail");
    const paint = (): void => {
      const isOpen = opened.has(key);
      row.setAttribute("aria-expanded", isOpen ? "true" : "false");
      row.classList.toggle("is-open", isOpen);
      detail.hidden = !isOpen;
      detail.textContent = "";
      if (!isOpen) return;
      const routing = routingSentence(plan.routing);
      if (routing) detail.append(el("div", "dash-plan-routing dash-meta", routing));
      detail.append(stepList(plan.steps, showCompleted));
    };
    row.addEventListener("click", () => {
      if (opened.has(key)) opened.delete(key);
      else opened.add(key);
      paint();
    });
    paint();

    wrap.append(row, detail);
  }
  return wrap;
}
