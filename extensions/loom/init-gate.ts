/**
 * Precondition check for /execute and /run.
 *
 * Galaxy workflows can run for hours and cost real compute, so the cost of
 * a bad launch is high. This gate runs before the slash command tells the
 * agent to work, catching the cheap failures (no plan; stale Galaxy creds;
 * step without acceptance criteria) up front so we don't burn an
 * invocation on a half-formed input.
 *
 * Two-layer policy:
 * - **Hard fail** -- env-broken cases (no notebook; plan needs Galaxy but
 *   no active connection). The slash command does not send the agent
 *   prompt. The user gets a remediation message in chat.
 * - **Soft fail** -- everything else. The slash command still sends the
 *   prompt, but the prompt carries the failure list so the agent can
 *   resolve with the user before invoking anything.
 */

import { getNotebookPath, isGalaxyConnected, getCurrentHistoryId } from "./state.js";
import { recordStore } from "./record-store.js";
import { isLocalShellDisabled } from "./local-exec.js";
import { getGalaxyConfig } from "./galaxy-api.js";
import { galaxyToolFamily } from "./galaxy-tool-source.js";
import { hasConnectTool } from "../../shared/galaxy-mcp-tools.js";

export type Routing = "local" | "hybrid" | "remote" | "unknown";

/**
 * Whether Galaxy can take this plan's work. With a connect tool in the family, connecting is a
 * step the model takes and `isGalaxyConnected()` records it. In-process tools have no such step:
 * they reach Galaxy whenever credentials are configured.
 */
function galaxyReady(): boolean {
  return hasConnectTool(galaxyToolFamily()) ? isGalaxyConnected() : getGalaxyConfig() !== null;
}

/** `[galaxy]` is the old spelling of `[remote]`; existing notebooks still use it. */
export function normalizeRouting(tag: string | undefined): Routing {
  const t = tag?.toLowerCase();
  if (!t) return "unknown";
  return t === "galaxy" ? "remote" : (t as Routing);
}

// Same spelling the evidence gate matches steps on, so an anchor captured
// here and an anchor written into a block are the same string.
const STEP_ANCHOR = /\{#([^}]+)\}/;

export interface ParsedPlanRef {
  title: string;
  routing: Routing;
  nextStep: {
    line: number;
    raw: string;
    descriptionLength: number;
    /**
     * The step's `{#plan-a-step-3}` anchor without the braces or the hash,
     * matching how `notebook_anchor` is spelled in the invocation and job
     * blocks. Absent when the step carries no anchor.
     */
    anchor?: string;
  } | null;
}

export interface GateFailure {
  name: "notebook" | "plan" | "galaxy_connection" | "history" | "acceptance" | "local_exec";
  severity: "hard" | "soft";
  remediation: string;
}

export interface GateResult {
  ok: boolean;
  hardFailed: boolean;
  failures: GateFailure[];
  plan: ParsedPlanRef | null;
}

export interface ProjectContext {
  historyId?: string;
  galaxyUrl?: string;
}

/**
 * Find the most recent `## Plan X: <title> [routing]` section. Returns
 * the heading info plus the first pending (`- [ ]`) step in that section.
 * Returns null if no plan heading is present.
 */
export function parseMostRecentPlan(content: string): ParsedPlanRef | null {
  const lines = content.split("\n");
  let latestPlanLine = -1;
  let latestPlanTitle = "";
  let latestPlanRouting: Routing = "unknown";

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(
      /^##\s+Plan\s+([^:]+):\s*(.+?)(?:\s*\[(local|galaxy|hybrid|remote)\])?\s*$/i,
    );
    if (m) {
      latestPlanLine = i;
      latestPlanTitle = `${m[1].trim()}: ${m[2].trim()}`;
      latestPlanRouting = normalizeRouting(m[3]);
    }
  }

  if (latestPlanLine === -1) return null;

  // Find first `- [ ]` line within the plan section (until the next `## ` h2).
  let nextStep: ParsedPlanRef["nextStep"] = null;
  for (let i = latestPlanLine + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break; // next section
    const stepMatch = lines[i].match(/^\s*-\s+\[\s\]\s+(.*)$/);
    if (stepMatch) {
      const anchor = stepMatch[1].match(STEP_ANCHOR)?.[1]?.trim();
      nextStep = {
        line: i,
        raw: stepMatch[1],
        descriptionLength: measureStepDescription(stepMatch[1]),
        ...(anchor ? { anchor } : {}),
      };
      break;
    }
  }

  return { title: latestPlanTitle, routing: latestPlanRouting, nextStep };
}

/**
 * Heuristic: does the step have anything beyond a bare `**Title**`? Strips
 * the leading number, the bold-wrapped title, the optional `{#anchor}`,
 * and any em-dash separator, then counts what remains. Used by the
 * acceptance-criteria check.
 */
function measureStepDescription(raw: string): number {
  const stripped = raw
    .replace(/^\d+\.\s*/, "")
    .replace(/\*\*[^*]+\*\*/, "")
    .replace(/\{#[^}]+\}/, "")
    .replace(/^[\s—\-:|]+/, "")
    .trim();
  return stripped.length;
}

/**
 * Parse the optional `## Project context` block. The block is plain
 * key-value lines beneath the heading, terminated by the next `## ` h2 or
 * EOF. Today this only carries `history_id` and `galaxy_url`; future
 * fields can join the same shape.
 */
export function parseProjectContext(content: string): ProjectContext | null {
  const lines = content.split("\n");
  const startIdx = lines.findIndex((l) => /^##\s+Project\s+context\s*$/i.test(l));
  if (startIdx === -1) return null;

  const ctx: ProjectContext = {};
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break;
    const m = lines[i].match(/^([a-z_]+):\s*(.+)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "history_id") ctx.historyId = value;
    else if (key === "galaxy_url") ctx.galaxyUrl = value;
  }
  return ctx;
}

/**
 * Run the precondition checks. Pure of side effects -- the caller (the
 * /execute or /run handler) decides whether to notify, whether to still
 * send the agent prompt, etc.
 */
export async function checkPreconditions(): Promise<GateResult> {
  const failures: GateFailure[] = [];

  const nbPath = getNotebookPath();
  const store = nbPath ? recordStore(nbPath) : null;
  if (!store || (await store.stat()) === null) {
    return {
      ok: false,
      hardFailed: true,
      failures: [
        {
          name: "notebook",
          severity: "hard",
          remediation: "No notebook open in this directory.",
        },
      ],
      plan: null,
    };
  }

  let content: string;
  try {
    ({ content } = await store.read());
  } catch {
    return {
      ok: false,
      hardFailed: true,
      failures: [
        {
          name: "notebook",
          severity: "hard",
          remediation: `Could not read ${nbPath}.`,
        },
      ],
      plan: null,
    };
  }

  const plan = parseMostRecentPlan(content);

  if (!plan || !plan.nextStep) {
    failures.push({
      name: "plan",
      severity: "soft",
      remediation: plan
        ? `Plan "${plan.title}" has no pending (\`- [ ]\`) steps. Ask the user whether to draft a follow-up plan or pick a different one.`
        : `No plan section in ${nbPath}. Don't auto-draft one -- ask the user what they want to work on first.`,
    });
    return { ok: false, hardFailed: false, failures, plan };
  }

  const needsGalaxy = plan.routing === "hybrid" || plan.routing === "remote";

  let hardFailed = false;

  // A plan whose routing requires a local execution leg can't run when the
  // shell removed bash (Windows remote-only). unknown is included because an
  // untagged plan falls back to local. remote has no local leg and passes
  // untouched. This is the user-facing "re-tag your plan" affordance -- the
  // actual containment is the removed bash tool, not this gate.
  const needsLocalShell =
    plan.routing === "local" || plan.routing === "hybrid" || plan.routing === "unknown";
  if (needsLocalShell && isLocalShellDisabled()) {
    hardFailed = true;
    failures.push({
      name: "local_exec",
      severity: "hard",
      remediation: `Plan "${plan.title}" needs local execution, unavailable on Windows (remote-only) -- re-tag the plan \`[remote]\`, or enable local power mode (future).`,
    });
  }

  if (needsGalaxy && !galaxyReady()) {
    hardFailed = true;
    failures.push({
      name: "galaxy_connection",
      severity: "hard",
      remediation: `Plan "${plan.title}" routes to Galaxy but there's no active connection. Run /connect to (re)authenticate.`,
    });
  }

  if (needsGalaxy && !getCurrentHistoryId()) {
    const ctx = parseProjectContext(content);
    if (!ctx?.historyId) {
      failures.push({
        name: "history",
        severity: "soft",
        remediation:
          "No Galaxy history selected for this project. Ask the user which history to use, or create a fresh one before invoking workflows.",
      });
    }
  }

  // Acceptance-criteria heuristic: a step with no description beyond the
  // bold title is a poor target. Loose threshold (>= 8 chars of remaining
  // text after stripping number/title/anchor) so well-formed plans pass
  // and only truly-empty ones trip.
  if (plan.nextStep.descriptionLength < 8) {
    failures.push({
      name: "acceptance",
      severity: "soft",
      remediation: `Step on line ${plan.nextStep.line + 1} has no description beyond its title. Confirm the acceptance criteria with the user before running.`,
    });
  }

  return {
    ok: failures.length === 0,
    hardFailed,
    failures,
    plan,
  };
}

/**
 * Render the failure list as a short markdown bullet list, suitable for
 * embedding in either the chat notification or the agent prompt.
 */
export function renderFailures(failures: GateFailure[]): string {
  if (failures.length === 0) return "";
  return failures.map((f) => `- **${f.name}**: ${f.remediation}`).join("\n");
}
