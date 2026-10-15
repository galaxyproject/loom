/**
 * What the frame is allowed to see, and how much of it.
 *
 * A panel's `data` config names the sources its content may receive. Nothing
 * is sent that was not named, and a source that was not named is never even
 * subscribed to, so an un-named source cannot reach the frame through a later
 * update either.
 *
 * Everything sent is re-built here into plain JSON-shaped data rather than
 * passed through. Two reasons: `postMessage` structured-clones whatever it is
 * given, so a live object would hand the frame more than the fields we meant,
 * and the caps below are the only thing between a 40 MB notebook and the
 * renderer's main thread.
 */

import type { DashboardDataSources, DataSource, FilesSnapshot, Snapshot } from "../widget-api.js";
import { SANDBOX_MAX_DATA_BYTES } from "./policy.js";

/** The source names a panel may ask for. Anything else in `data` is ignored. */
export const SANDBOX_DATA_SOURCES = [
  "notebook",
  "invocations",
  "plan",
  "activity",
  "files",
  "session",
] as const;

export type SandboxDataSourceName = (typeof SANDBOX_DATA_SOURCES)[number];

/** Per-source caps. Generous for a 400px panel, small next to the message cap. */
const MAX_NOTEBOOK_CHARS = 32 * 1024;
const MAX_INVOCATIONS = 50;
const MAX_JOBS = 100;
const MAX_PLANS = 10;
const MAX_STEPS_PER_PLAN = 100;
const MAX_ACTIVITY_EVENTS = 200;
const MAX_FILE_NODES = 500;
const MAX_FILE_DEPTH = 6;

/**
 * The order sources are dropped in when the whole payload is over the cap:
 * least useful to a view, first to go. The frame is told what was dropped so
 * its content can say so rather than silently drawing less.
 */
const DROP_ORDER: SandboxDataSourceName[] = [
  "files",
  "activity",
  "notebook",
  "invocations",
  "plan",
  "session",
];

export interface SandboxDataPayload {
  sources: Record<string, unknown>;
  /** Source names asked for but dropped to fit the cap. */
  dropped: string[];
}

/** Read a `data` config value into the source names it actually names. */
export function resolveAllowedSources(value: unknown): SandboxDataSourceName[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<SandboxDataSourceName>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const name = entry as SandboxDataSourceName;
    if ((SANDBOX_DATA_SOURCES as readonly string[]).includes(name)) seen.add(name);
  }
  return SANDBOX_DATA_SOURCES.filter((name) => seen.has(name));
}

/** The `DataSource` objects for the allowed names, in a stable order. */
export function allowedDataSources(
  sources: DashboardDataSources,
  allowed: readonly SandboxDataSourceName[],
): Array<DataSource<Snapshot>> {
  return allowed.map((name) => sources[name] as DataSource<Snapshot>);
}

/** Last path segment, for either separator, or null. */
function basename(path: string | null): string | null {
  if (!path) return null;
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || null;
}

function tail(text: string, max: number): string {
  if (typeof text !== "string") return "";
  return text.length <= max ? text : text.slice(text.length - max);
}

function pick<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  return out;
}

/**
 * Copy a file tree with both a depth and a total-node budget. The workspace
 * tree is the one source whose size is set by the user's disk rather than by
 * anything we wrote, and a deep tree would also be the easiest way to blow the
 * stack on the way into `JSON.stringify`.
 */
function copyTree(node: FilesSnapshot["root"], budget: { left: number }, depth: number): unknown {
  if (!node || budget.left <= 0) return null;
  budget.left -= 1;
  const out: Record<string, unknown> = {
    name: node.name,
    relPath: node.relPath,
    type: node.type,
  };
  if (typeof node.size === "number") out.size = node.size;
  if (node.children && depth < MAX_FILE_DEPTH) {
    const children: unknown[] = [];
    for (const child of node.children) {
      if (budget.left <= 0) break;
      children.push(copyTree(child, budget, depth + 1));
    }
    out.children = children;
  }
  return out;
}

function snapshotFor(name: SandboxDataSourceName, sources: DashboardDataSources): unknown {
  switch (name) {
    case "notebook": {
      const s = sources.notebook.get();
      return {
        markdown: tail(s.markdown, MAX_NOTEBOOK_CHARS),
        // The file name, not the path it sits at. `session.cwd` is withheld
        // below for saying something about the machine rather than about the
        // analysis, and an absolute notebook path is the same cwd plus a
        // filename -- sending it would have made that omission pointless.
        name: basename(s.path),
        updatedAt: s.updatedAt,
      };
    }
    case "invocations": {
      const s = sources.invocations.get();
      return {
        invocations: s.invocations
          .slice(-MAX_INVOCATIONS)
          .map((inv) =>
            pick(inv, [
              "invocationId",
              "label",
              "status",
              "submittedAt",
              "summary",
              "totalSteps",
              "completedSteps",
              "totalJobs",
              "completedJobs",
              "failedJobs",
              "lastPolledAt",
            ]),
          ),
        jobs: s.jobs
          .slice(-MAX_JOBS)
          .map((job) =>
            pick(job, [
              "jobId",
              "label",
              "toolId",
              "status",
              "submittedAt",
              "summary",
              "galaxyState",
              "lastPolledAt",
            ]),
          ),
        updatedAt: s.updatedAt,
      };
    }
    case "plan": {
      const s = sources.plan.get();
      return {
        plans: s.plans.slice(0, MAX_PLANS).map((plan) => ({
          id: plan.id,
          title: plan.title,
          routing: plan.routing,
          steps: plan.steps.slice(0, MAX_STEPS_PER_PLAN).map((step) => ({
            anchor: step.anchor,
            number: step.number,
            title: step.title,
            status: step.status,
            routing: step.routing,
            verification: step.verification,
            detail: step.detail,
          })),
        })),
        updatedAt: s.updatedAt,
      };
    }
    case "activity": {
      const s = sources.activity.get();
      return {
        events: s.events.slice(-MAX_ACTIVITY_EVENTS).map((event) => ({
          timestamp: event.timestamp,
          kind: event.kind,
          source: event.source,
        })),
        available: s.available,
        updatedAt: s.updatedAt,
      };
    }
    case "files": {
      const s = sources.files.get();
      return {
        root: copyTree(s.root, { left: MAX_FILE_NODES }, 0),
        available: s.available,
        updatedAt: s.updatedAt,
      };
    }
    case "session": {
      const s = sources.session.get();
      // Deliberately not `cwd`: an absolute path is the one field here that
      // says something about the machine rather than about the analysis, and
      // no view needs it to draw.
      return {
        status: s.status,
        streaming: s.streaming,
        model: s.model,
        costUsd: s.costUsd,
        tokens: { ...s.tokens },
        updatedAt: s.updatedAt,
      };
    }
  }
}

/**
 * UTF-8 bytes, not UTF-16 code units. `String.length` would let a notebook of
 * CJK or emoji through at roughly three times the cap it is being measured
 * against, and the HTML cap next door is already measured in real bytes.
 */
export function byteLength(text: string): number {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}

function sizeOf(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : byteLength(json);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Build the payload for the named sources, dropping whole sources until it
 * fits. Dropping a whole source rather than truncating inside one keeps what
 * does arrive internally consistent -- half a plan is worse than no plan.
 */
export function collectSandboxData(
  sources: DashboardDataSources,
  allowed: readonly SandboxDataSourceName[],
): SandboxDataPayload {
  const collected: Record<string, unknown> = {};
  for (const name of allowed) {
    try {
      collected[name] = snapshotFor(name, sources);
    } catch {
      // A source that throws on read must not take the whole view with it.
      collected[name] = null;
    }
  }

  const dropped: string[] = [];
  for (const name of DROP_ORDER) {
    if (sizeOf(collected) <= SANDBOX_MAX_DATA_BYTES) break;
    if (!(name in collected)) continue;
    delete collected[name];
    dropped.push(name);
  }

  return { sources: collected, dropped };
}
