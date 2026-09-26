/**
 * The six read-only data sources a widget sees.
 *
 * Two of them are pulled from the shell (`activity`, `files`) and are marked
 * unavailable where the shell has no file surface. Both shells have one now;
 * remote mode deliberately does not, and the `typeof` guards below are what
 * make that a quiet `available: false` rather than a crash. The other four are
 * pushed by the renderer, and two of those (`invocations`, `plan`) are derived
 * from the notebook markdown rather than re-read off disk, which is what gets
 * the web shell the same jobs and plan views the desktop has.
 */

import { parseInvocationBlocks } from "../galaxy-invocations.js";
import type { FileNode } from "../../preload/preload.js";
import type { GalaxyLivePayload } from "../../../../shared/galaxy-live-contract.js";
import { isNotebookFenceOpen } from "../../../../shared/notebook-fences.js";
import type {
  ActivityEvent,
  DashboardJob,
  ActivitySnapshot,
  DashboardDataSources,
  DataSource,
  FilesSnapshot,
  InvocationSnapshot,
  NotebookSnapshot,
  PlanSection,
  PlanSnapshot,
  PlanStep,
  PlanStepStatus,
  SessionSnapshot,
  Unsubscribe,
} from "./widget-api.js";

/** How many activity events a widget is handed. The tail read caps at 200 lines. */
const ACTIVITY_LIMIT = 200;

class MutableSource<T> implements DataSource<T> {
  private listeners = new Set<(value: T) => void>();

  constructor(private value: T) {}

  get(): T {
    return this.value;
  }

  /** Swap the value without telling anyone. Pair with `notify`. */
  stage(next: T): void {
    this.value = next;
  }

  notify(): void {
    const value = this.value;
    // Copy first: a listener that unsubscribes itself must not skip the next one.
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch (err) {
        console.error("[dashboard] data source listener threw:", err);
      }
    }
  }

  set(next: T): void {
    this.stage(next);
    this.notify();
  }

  subscribe(listener: (value: T) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

// ── Plan parsing ─────────────────────────────────────────────────────────────

const PLAN_HEADING = /^##\s+(Plan\b.*)$/i;
const ANY_H2 = /^##\s+/;
const ROUTING_TAG = /\[([a-z]+)\]\s*$/i;
const STEP_LINE = /^ {0,1}-\s*\[([ xX!])\]\s*(.*)$/;
const STEP_ROUTING = /^\s{2,}-\s*Routing:\s*(.+?)\s*$/i;
const STEP_VERIFICATION = /^\s{2,}-\s*Verification:\s*(.+?)\s*$/i;
const STEP_NUMBER = /^(\d+)[.)]\s*/;
const STEP_ANCHOR = /\{#([A-Za-z0-9_-]+)\}/;
const STEP_BOLD = /\*\*(.+?)\*\*/;
const WHITESPACE = /\s/;
const TRAILING_WS = /\s+$/;
const LEADING_SEPARATOR = /^\s*(?:\u2014|--|-|:)\s*/;

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "plan"
  );
}

function statusFor(marker: string): PlanStepStatus {
  if (marker === "!") return "failed";
  if (marker.toLowerCase() === "x") return "done";
  return "pending";
}

/**
 * Split a step line into its name and its detail at the first ` -- ` (or the
 * em-dash the schema uses).
 *
 * Scanned rather than matched with `/\s+(?:\u2014|--)\s+/`. That pattern
 * backtracks: at every position the leading `\s+` can consume a long run of
 * whitespace before failing to find the dash, and `split` tries every position,
 * so a step whose detail holds a run of spaces was quadratic. Measured on the
 * renderer's synchronous path: 80,000 spaces froze the window for 3.2 seconds
 * and 160,000 for 12.8. An index scan is linear and answers the same question.
 */
function splitOnDash(body: string): [string, string] {
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    const isEm = ch === "\u2014";
    const isDoubleHyphen = ch === "-" && body[i + 1] === "-";
    if (!isEm && !isDoubleHyphen) continue;
    const end = i + (isEm ? 1 : 2);
    // The schema puts whitespace on both sides; a hyphenated word must not
    // split, and neither must a `---` rule.
    if (i === 0 || !WHITESPACE.test(body[i - 1])) continue;
    if (end >= body.length || !WHITESPACE.test(body[end])) continue;
    // Trailing whitespace on the name, leading whitespace on the detail: the
    // caller trims both, so hand back the raw slices.
    return [body.slice(0, i).replace(TRAILING_WS, ""), body.slice(end)];
  }
  return [body, ""];
}

function parseStep(rest: string, fallbackNumber: number): PlanStep {
  let body = rest;
  let number = fallbackNumber;

  const numbered = body.match(STEP_NUMBER);
  if (numbered) {
    number = Number(numbered[1]);
    body = body.slice(numbered[0].length);
  }

  let anchor: string | null = null;
  const anchored = body.match(STEP_ANCHOR);
  if (anchored) {
    anchor = anchored[1];
    body = body.replace(STEP_ANCHOR, " ");
  }

  // The schema writes `**Name** -- detail`; tolerate an em-dash or a hyphen
  // because the notebook is hand-edited as often as it is generated.
  const bold = body.match(STEP_BOLD);
  const parts = bold
    ? [bold[1], body.slice(body.indexOf(bold[0]) + bold[0].length)]
    : splitOnDash(body);

  return {
    anchor,
    number,
    title: parts[0].trim(),
    status: "pending",
    routing: null,
    verification: null,
    detail: parts[1].replace(LEADING_SEPARATOR, "").trim(),
  };
}

/**
 * Pull `## Plan X: ...` sections and their checkbox steps out of the notebook.
 * Shape per docs/agent/notebook-schema.md. Tolerant by design: a hand-edited
 * notebook that drops the anchors or the numbers still yields usable steps.
 */
/** A fence opener or closer: three or more backticks, or three or more tildes. */
const FENCE_MARKER = /^(`{3,}|~{3,})/;

export function parsePlanSections(markdown: string): PlanSection[] {
  const plans: PlanSection[] = [];
  let current: PlanSection | null = null;

  // A fenced block is prose about a plan, not a plan. The notebook schema tells
  // the agent to show the step format by example, so "- [ ] 1. **Example step**"
  // inside a ```markdown fence is exactly what a well-behaved notebook looks
  // like -- and those examples were counted as real steps, which moved the
  // progress bar and put an invented step in the NEXT box.
  //
  // Which marker opened it is remembered, because a toggle on either one is its
  // own bug: a `~~~` line inside a ```markdown example closed the block, the
  // ``` that really ended it opened a new one, and every checkbox after that
  // was read as a real step again -- the phantom the fence tracking is here to
  // stop, reintroduced by the tracking itself.
  let openedBy: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = FENCE_MARKER.exec(line.trimStart())?.[1];
    if (openedBy !== null) {
      // CommonMark closes a fence with the same character, at least as long as
      // the one that opened it. Anything else is content.
      if (marker && marker[0] === openedBy[0] && marker.length >= openedBy.length) {
        openedBy = null;
      }
      continue;
    }
    if (marker) {
      openedBy = marker;
      continue;
    }
    const heading = line.match(PLAN_HEADING);
    if (heading) {
      let title = heading[1].trim();
      let routing: string | null = null;
      const tag = title.match(ROUTING_TAG);
      if (tag) {
        routing = tag[1].toLowerCase();
        title = title.replace(ROUTING_TAG, "").trim();
      }
      const label = title.split(":")[0] ?? title;
      current = { id: slugify(label), title, routing, steps: [] };
      plans.push(current);
      continue;
    }
    if (ANY_H2.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;

    const step = line.match(STEP_LINE);
    if (step) {
      const parsed = parseStep(step[2], current.steps.length + 1);
      parsed.status = statusFor(step[1]);
      current.steps.push(parsed);
      continue;
    }

    if (current.steps.length === 0) continue;
    const last = current.steps[current.steps.length - 1];
    const routing = line.match(STEP_ROUTING);
    if (routing) {
      last.routing = routing[1];
      continue;
    }
    // Every step is supposed to carry one; a widget showing "what still has to
    // be true" needs the text, not just the fact that it exists.
    const verification = line.match(STEP_VERIFICATION);
    if (verification) last.verification = verification[1];
  }

  return plans;
}

// ── loom-job parsing ─────────────────────────────────────────────────────────

const FENCE_CLOSE = "```";
const JOB_STATUSES = new Set(["in_progress", "completed", "failed", "cancelled", "skipped"]);

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

/**
 * Single Galaxy tool runs recorded as `loom-job` blocks. The brain writes and
 * updates them (extensions/loom/galaxy-job-block.ts); this reads them, the same
 * way galaxy-invocations.ts reads `loom-invocation` blocks rather than importing
 * the brain's writer. Two readers of one on-disk format is a real cost -- if a
 * third appears, move the rest of the grammar into shared/ next to the fence
 * names.
 */
export function parseJobBlocks(content: string): DashboardJob[] {
  const out: DashboardJob[] = [];
  const lines = content.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    if (!isNotebookFenceOpen(lines[i], "job")) {
      i++;
      continue;
    }
    const start = i + 1;
    let end = start;
    while (end < lines.length && lines[end].trim() !== FENCE_CLOSE) end++;

    const fields: Record<string, string> = {};
    for (const line of lines.slice(start, end)) {
      const m = line.match(/^([a-z_]+):\s*(.*)$/);
      if (m) fields[m[1]] = unquote(m[2]);
    }
    if (
      fields.job_id &&
      fields.galaxy_server_url &&
      fields.notebook_anchor &&
      fields.label &&
      fields.submitted_at &&
      JOB_STATUSES.has(fields.status)
    ) {
      out.push({
        jobId: fields.job_id,
        galaxyServerUrl: fields.galaxy_server_url,
        notebookAnchor: fields.notebook_anchor,
        label: fields.label,
        toolId: fields.tool_id || null,
        submittedAt: fields.submitted_at,
        status: fields.status as DashboardJob["status"],
        summary: fields.summary || undefined,
        serverVerified:
          fields.server_verified === "true"
            ? true
            : fields.server_verified === "false"
              ? false
              : undefined,
        galaxyState: fields.galaxy_state || undefined,
        lastPolledAt: fields.last_polled_at || undefined,
      });
    }
    i = end + 1;
  }
  return out;
}

// ── Activity parsing ─────────────────────────────────────────────────────────

/** Parse an activity.jsonl tail. Unparsable or non-object lines are skipped. */
export function parseActivityLines(text: string): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    events.push({
      timestamp: typeof record.timestamp === "string" ? record.timestamp : "",
      kind: typeof record.kind === "string" ? record.kind : "event",
      source: typeof record.source === "string" ? record.source : "",
      payload:
        record.payload !== null && typeof record.payload === "object"
          ? (record.payload as Record<string, unknown>)
          : {},
    });
  }
  return events.slice(-ACTIVITY_LIMIT);
}

// ── The source set ───────────────────────────────────────────────────────────

/** The slice of `window.orbit` the pulled sources need. Both members optional. */
export interface DashboardShellApi {
  readFile?: (
    relPath: string,
    opts?: { tail?: boolean },
  ) => Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error?: string }>;
  listFiles?: (opts?: {
    includeHidden?: boolean;
  }) => Promise<{ ok: true; root: FileNode } | { ok: false; error?: string }>;
}

function sessionsEqual(a: SessionSnapshot, b: SessionSnapshot): boolean {
  return (
    a.status === b.status &&
    a.streaming === b.streaming &&
    a.cwd === b.cwd &&
    a.model === b.model &&
    a.costUsd === b.costUsd &&
    a.tokens.input === b.tokens.input &&
    a.tokens.output === b.tokens.output &&
    a.tokens.cacheRead === b.tokens.cacheRead &&
    a.tokens.cacheWrite === b.tokens.cacheWrite
  );
}

function emptySession(): SessionSnapshot {
  return {
    status: "unknown",
    streaming: false,
    cwd: "",
    model: null,
    costUsd: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    updatedAt: Date.now(),
  };
}

export class DashboardSources {
  private notebook = new MutableSource<NotebookSnapshot>({
    markdown: "",
    path: null,
    updatedAt: 0,
  });
  private invocations = new MutableSource<InvocationSnapshot>({
    invocations: [],
    jobs: [],
    updatedAt: 0,
  });
  private plan = new MutableSource<PlanSnapshot>({ plans: [], updatedAt: 0 });
  private activity = new MutableSource<ActivitySnapshot>({
    events: [],
    available: false,
    updatedAt: 0,
  });
  private files = new MutableSource<FilesSnapshot>({
    root: null,
    available: false,
    updatedAt: 0,
  });
  private session = new MutableSource<SessionSnapshot>(emptySession());
  /**
   * Pushed by the brain, which is the only process with Galaxy credentials in
   * every shell. `null` until the first payload lands -- distinct from a
   * payload carrying `unavailable`, which is Galaxy answered and there is
   * nothing to show.
   */
  private galaxy = new MutableSource<GalaxyLivePayload | null>(null);

  readonly sources: DashboardDataSources;
  /**
   * Bumped by `reset()`. A pulled read that was already in flight against the
   * previous analysis directory checks this before applying its result, so a
   * slow file read cannot land the old workspace's data in the new one.
   */
  private generation = 0;
  /**
   * `files:changed` arrives in bursts. Two overlapping reads of the same file
   * can resolve out of order and leave the older tail on screen, so a refresh
   * that arrives while one is in flight is collapsed into a single re-run.
   */
  private inFlight = { activity: false, files: false };
  private again = { activity: false, files: false };

  constructor(private api: DashboardShellApi = {}) {
    this.sources = {
      notebook: this.notebook,
      invocations: this.invocations,
      plan: this.plan,
      activity: this.activity,
      files: this.files,
      session: this.session,
      galaxy: this.galaxy,
    };
  }

  /** A live Galaxy history projection the brain pushed over the widget channel. */
  setGalaxyLive(payload: GalaxyLivePayload | null): void {
    this.galaxy.set(payload);
  }

  /**
   * The notebook markdown the brain pushed. Invocations and plan steps are
   * re-derived here, so both shells get them without a file read.
   */
  setNotebook(markdown: string, path: string | null = null): void {
    const updatedAt = Date.now();
    // Stage all three before notifying any: three of the widgets read from the
    // same markdown, and a listener on `notebook` that reaches for
    // `sources.plan.get()` must not see the previous plan.
    this.notebook.stage({ markdown, path, updatedAt });
    this.invocations.stage({
      invocations: parseInvocationBlocks(markdown),
      jobs: parseJobBlocks(markdown),
      updatedAt,
    });
    this.plan.stage({ plans: parsePlanSections(markdown), updatedAt });
    this.notebook.notify();
    this.invocations.notify();
    this.plan.notify();
  }

  /**
   * Called from the renderer's usage accounting, which runs on essentially
   * every streaming token, so an unchanged patch must not wake every session
   * widget. Only `tokens` is nested, and it is compared field by field.
   */
  setSession(patch: Partial<Omit<SessionSnapshot, "updatedAt">>): void {
    const current = this.session.get();
    const next = { ...current, ...patch, updatedAt: Date.now() };
    if (sessionsEqual(current, next)) return;
    this.session.set(next);
  }

  /** Re-read the activity log tail. No-op where the shell has no file read. */
  async refreshActivity(): Promise<void> {
    if (typeof this.api.readFile !== "function") return;
    if (this.inFlight.activity) {
      this.again.activity = true;
      return;
    }
    this.inFlight.activity = true;
    const generation = this.generation;
    let events: ActivityEvent[] = [];
    let available = false;
    try {
      const res = await this.api.readFile("activity.jsonl", { tail: true });
      if (res.ok) {
        events = parseActivityLines(new TextDecoder("utf-8").decode(res.bytes));
        available = true;
      }
    } catch {
      /* no activity log yet, or no file surface at all */
    }
    this.inFlight.activity = false;
    if (generation !== this.generation) return;
    this.activity.set({ events, available, updatedAt: Date.now() });
    if (this.again.activity) {
      this.again.activity = false;
      await this.refreshActivity();
    }
  }

  /** Re-read the workspace file tree. No-op where the shell has no listing. */
  async refreshFiles(): Promise<void> {
    if (typeof this.api.listFiles !== "function") return;
    if (this.inFlight.files) {
      this.again.files = true;
      return;
    }
    this.inFlight.files = true;
    const generation = this.generation;
    let root: FileNode | null = null;
    let available = false;
    try {
      const res = await this.api.listFiles();
      if (res.ok) {
        root = res.root;
        available = true;
      }
    } catch {
      /* no file surface */
    }
    this.inFlight.files = false;
    if (generation !== this.generation) return;
    this.files.set({ root, available, updatedAt: Date.now() });
    if (this.again.files) {
      this.again.files = false;
      await this.refreshFiles();
    }
  }

  /** Called on a cwd switch or /new so a new analysis does not inherit the old one's data. */
  reset(): void {
    this.generation++;
    this.again.activity = false;
    this.again.files = false;
    const updatedAt = Date.now();
    this.notebook.set({ markdown: "", path: null, updatedAt });
    this.invocations.set({ invocations: [], jobs: [], updatedAt });
    this.plan.set({ plans: [], updatedAt });
    this.activity.set({ events: [], available: false, updatedAt });
    this.files.set({ root: null, available: false, updatedAt });
    this.session.set(emptySession());
    // The previous analysis's history is not this one's, and the brain will not
    // re-push until its next poll tick -- an old panel left on screen in the
    // meantime is the stale-number failure this surface exists to avoid.
    this.galaxy.set(null);
  }
}
