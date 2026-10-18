/**
 * Galaxy invocations panel — an Activity-tab section (rendered after the
 * Galaxy history section). Parses
 * `loom-invocation` YAML blocks from `notebook.md` and draws a live
 * progress row per active workflow, with each run's tool versions and
 * enrichment state, plus a row for every tool run no plan step claims.
 *
 * The brain owns polling Galaxy and rewriting the YAML; this side just
 * reads what's on disk and re-renders on every files:changed event.
 * Hidden when there are no in-progress invocations (with a brief linger
 * so users see the final completed/failed state).
 */

import { galaxyArtifactUrl } from "../../../shared/galaxy-artifact-links.js";
import { isNotebookFenceOpen } from "../../../shared/notebook-fences.js";

export interface Invocation {
  connectionId?: string;
  accountId?: string;
  supersededBy?: string;
  rerouteId?: string;
  invocationId: string;
  galaxyServerUrl: string;
  notebookAnchor: string;
  label: string;
  submittedAt: string;
  status: "in_progress" | "completed" | "failed";
  summary?: string;
  /** False when the brain recorded this run without Galaxy confirming the id. */
  serverVerified?: boolean;
  totalSteps?: number;
  completedSteps?: number;
  totalJobs?: number;
  completedJobs?: number;
  failedJobs?: number;
  lastPolledAt?: string;
  // Harness-written provenance. The brain owns these (see
  // extensions/loom/harness-block-fields.ts); this side only reads them, and
  // mirrors the same drop-what-you-don't-recognise rule so a hand-edited
  // block renders as unknown provenance rather than as a claim.
  attemptId?: string;
  historyId?: string;
  submittedBy?: "harness" | "agent" | "unknown";
  enrichment?: "pending" | "complete" | "unavailable";
  enrichmentAttempts?: number;
  enrichmentError?: string;
  jobs?: BlockJobSummary[];
  drift?: BlockDriftNote[];
  /** The approval registry's verdict, when the run is one it knows about. */
  handoffEligible?: boolean;
}

/**
 * A `loom-job` block nobody bound to a plan step -- a run reconcile found in
 * the history, or one submitted outside any step. Workflow runs are already
 * rows here; a stray tool run is the other kind of work the user should be
 * able to see is unaccounted for. Bound tool runs stay off this panel, as
 * before: they are the plan's, and the dashboard's jobs widget lists them.
 */
export interface UnattributedJob {
  notebookAnchor?: string;
  connectionId?: string;
  accountId?: string;
  supersededBy?: string;
  rerouteId?: string;
  galaxyState?: string;
  lastPolledAt?: string;
  jobId: string;
  galaxyServerUrl: string;
  label: string;
  toolId?: string;
  submittedAt: string;
  status: "in_progress" | "completed" | "failed" | "cancelled" | "skipped";
  serverVerified?: boolean;
  submittedBy?: "harness" | "agent" | "unknown";
  enrichment?: "pending" | "complete" | "unavailable";
  enrichmentAttempts?: number;
  enrichmentError?: string;
  jobs?: BlockJobSummary[];
  handoffEligible?: boolean;
}

/** What the brain writes for a run no plan step claims. */
export const UNATTRIBUTED = "unattributed";

interface BlockJobSummary {
  job_id: string;
  tool_id?: string;
  tool_version?: string;
  state?: string;
  outputs?: { id: string; ext?: string; dbkey?: string }[];
}

interface BlockDriftNote {
  tool_id: string;
  from: string;
  to: string;
}

const SUBMITTED_BY = new Set(["harness", "agent", "unknown"]);
const ENRICHMENT_STATES = new Set(["pending", "complete", "unavailable"]);

/**
 * Parse a single-line JSON array field (`jobs`, `drift`). Malformed values
 * read back as absent -- the row still draws, it just shows no versions.
 */
function jsonArrayField<T>(raw: string | undefined): T[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : undefined;
  } catch {
    return undefined;
  }
}

/** Mirror of `isBlockBodyLine` in the brain's harness-block-fields. */
function isBlockBodyLine(line: string): boolean {
  return line.trim() === "" || /^[a-z0-9_]+:/.test(line);
}

const FENCE_CLOSE = "```";
const STATUSES = new Set(["in_progress", "completed", "failed"] as const);
// After the last in-progress invocation flips to completed/failed, keep
// the section visible for a few seconds so the user sees the final state
// before it disappears.
const LINGER_MS = 5000;

let lingerTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Mirror of `unescapeYaml` in the brain's notebook-writer. The writer quotes
 * free text with `JSON.stringify`, so a label carrying a backslash or a
 * newline only reads back correctly through `JSON.parse`; stripping the outer
 * quotes and unescaping `\"` by hand showed `C:\\reads` for `C:\reads` and a
 * literal `\n` for a line break, so Activity named a run differently from the
 * notebook it came out of. The fallback is for blocks written under the older
 * rule, which escaped quotes and nothing else.
 */
function unescape(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1).replace(/\\"/g, '"');
    }
  }
  return value;
}

/**
 * Mirror of `unescape` for `enrichment_error`, which the brain always writes
 * JSON-quoted and reads from the raw line.
 */
function quotedText(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (!raw.startsWith('"')) return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" && parsed ? parsed : undefined;
  } catch {
    return undefined;
  }
}

interface RawBlock {
  /** Free-text fields unescaped, as the block writers quote them. */
  fields: Record<string, string>;
  /** The same lines untouched, for the harness fields (bare tokens and JSON). */
  raw: Record<string, string>;
}

/**
 * Every well-formed block of one fence kind. Same fence grammar as the brain's
 * scanner (scanFencedBlocks): the body is `key: value` lines and nothing else,
 * and the close is an exact ```. Anything else -- a run of four backticks,
 * another opener, a line of prose, end of file -- means this is not a block.
 */
function readBlocks(content: string, kind: "invocation" | "job"): RawBlock[] {
  const out: RawBlock[] = [];
  const lines = content.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    if (!isNotebookFenceOpen(lines[i], kind)) {
      i++;
      continue;
    }
    const start = i + 1;
    let end = start;
    while (end < lines.length && isBlockBodyLine(lines[end])) end++;
    if (end >= lines.length || lines[end].trim() !== FENCE_CLOSE) {
      i = start;
      continue;
    }
    const fields: Record<string, string> = {};
    const raw: Record<string, string> = {};
    for (const line of lines.slice(start, end)) {
      const m = line.match(/^([a-z_]+):\s*(.*)$/);
      if (m) {
        raw[m[1]] = m[2].trim();
        fields[m[1]] = unescape(m[2].trim());
      }
    }
    out.push({ fields, raw });
    i = end + 1;
  }
  return out;
}

function numberField(fields: Record<string, string>, key: string): number | undefined {
  const raw = fields[key];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function verifiedField(raw: string | undefined): boolean | undefined {
  return raw === "true" ? true : raw === "false" ? false : undefined;
}

export function parseInvocationBlocks(content: string): Invocation[] {
  const out: Invocation[] = [];
  for (const { fields, raw: rawFields } of readBlocks(content, "invocation")) {
    const status = fields.status as Invocation["status"];
    // `galaxy_server_url` is not required, matching the brain's parser: the
    // harness records a submission whether or not GALAXY_URL happened to be
    // set, and a block the brain polls but this side drops is a run the user
    // cannot see in Activity.
    if (
      !fields.invocation_id ||
      !fields.notebook_anchor ||
      !fields.label ||
      !fields.submitted_at ||
      !STATUSES.has(status)
    ) {
      continue;
    }
    const num = (k: string) => numberField(fields, k);
    out.push({
      invocationId: fields.invocation_id,
      galaxyServerUrl: fields.galaxy_server_url ?? "",
      connectionId: rawFields.galaxy_connection_id,
      accountId: rawFields.galaxy_account_id,
      supersededBy: rawFields.superseded_by,
      rerouteId: rawFields.reroute_id,
      notebookAnchor: fields.notebook_anchor,
      label: fields.label,
      submittedAt: fields.submitted_at,
      status,
      summary: fields.summary || undefined,
      serverVerified: verifiedField(fields.server_verified),
      totalSteps: num("total_steps"),
      completedSteps: num("completed_steps"),
      totalJobs: num("total_jobs"),
      completedJobs: num("completed_jobs"),
      failedJobs: num("failed_jobs"),
      lastPolledAt: fields.last_polled_at || undefined,
      attemptId: rawFields.attempt_id || undefined,
      historyId: rawFields.history_id || undefined,
      submittedBy: SUBMITTED_BY.has(rawFields.submitted_by)
        ? (rawFields.submitted_by as Invocation["submittedBy"])
        : undefined,
      enrichment: ENRICHMENT_STATES.has(rawFields.enrichment)
        ? (rawFields.enrichment as Invocation["enrichment"])
        : undefined,
      enrichmentAttempts: num("enrichment_attempts"),
      enrichmentError: quotedText(rawFields.enrichment_error),
      jobs: jsonArrayField<BlockJobSummary>(rawFields.jobs),
      drift: jsonArrayField<BlockDriftNote>(rawFields.drift),
      handoffEligible: verifiedField(rawFields.handoff_eligible),
    });
  }
  return out;
}

const JOB_STATUSES = new Set(["in_progress", "completed", "failed", "cancelled", "skipped"]);

/** `loom-job` blocks whose anchor is `unattributed`. See UnattributedJob. */
export function parseUnattributedJobBlocks(
  content: string,
  includeBound = false,
): UnattributedJob[] {
  const out: UnattributedJob[] = [];
  for (const { fields, raw } of readBlocks(content, "job")) {
    if (
      !fields.job_id ||
      (!includeBound && fields.notebook_anchor !== UNATTRIBUTED) ||
      !fields.label ||
      !fields.submitted_at ||
      !JOB_STATUSES.has(fields.status)
    ) {
      continue;
    }
    out.push({
      jobId: fields.job_id,
      notebookAnchor: fields.notebook_anchor,
      galaxyState: fields.galaxy_state,
      lastPolledAt: fields.last_polled_at,
      galaxyServerUrl: fields.galaxy_server_url ?? "",
      connectionId: raw.galaxy_connection_id,
      accountId: raw.galaxy_account_id,
      supersededBy: raw.superseded_by,
      rerouteId: raw.reroute_id,
      label: fields.label,
      toolId: fields.tool_id || undefined,
      submittedAt: fields.submitted_at,
      status: fields.status as UnattributedJob["status"],
      serverVerified: verifiedField(fields.server_verified),
      submittedBy: SUBMITTED_BY.has(raw.submitted_by)
        ? (raw.submitted_by as UnattributedJob["submittedBy"])
        : undefined,
      enrichment: ENRICHMENT_STATES.has(raw.enrichment)
        ? (raw.enrichment as UnattributedJob["enrichment"])
        : undefined,
      enrichmentAttempts: numberField(fields, "enrichment_attempts"),
      enrichmentError: quotedText(raw.enrichment_error),
      jobs: jsonArrayField<BlockJobSummary>(raw.jobs),
      handoffEligible: verifiedField(raw.handoff_eligible),
    });
  }
  return out;
}

/**
 * A toolshed id carries its version as its last segment; the readable name is
 * the segment before it (`.../repos/iuc/fastp/fastp/0.24.0` -> `fastp`).
 */
function shortToolName(toolId: string): string {
  const m = /\/repos\/[^/]+\/[^/]+\/([^/]+)\/[^/]+$/.exec(toolId);
  return m ? m[1] : toolId;
}

const MAX_VERSIONS_SHOWN = 4;

/**
 * `fastp 0.24.0 · bwa_mem 0.7.17 · 2 version(s) unknown` -- per tool, from the
 * block's per-job summary. Empty when the block has no summary yet.
 */
export function describeToolVersions(jobs: BlockJobSummary[] | undefined): string {
  if (!jobs || jobs.length === 0) return "";
  const versions = new Map<string, string>();
  let unknown = 0;
  for (const job of jobs) {
    if (!job || typeof job !== "object") continue;
    const tool = typeof job.tool_id === "string" ? shortToolName(job.tool_id) : undefined;
    const version = typeof job.tool_version === "string" ? job.tool_version : undefined;
    if (!tool || !version) {
      unknown++;
      continue;
    }
    const key = `${tool} ${version}`;
    if (!versions.has(key)) versions.set(key, key);
  }
  const shown = [...versions.values()];
  const parts = shown.slice(0, MAX_VERSIONS_SHOWN);
  if (shown.length > MAX_VERSIONS_SHOWN) parts.push(`+${shown.length - MAX_VERSIONS_SHOWN} more`);
  if (unknown > 0) parts.push(`${unknown} version${unknown === 1 ? "" : "s"} unknown`);
  return parts.join(" · ");
}

/** The provenance clause shared by invocation and job rows. */
function provenanceParts(block: {
  submittedBy?: "harness" | "agent" | "unknown";
  serverVerified?: boolean;
  enrichment?: "pending" | "complete" | "unavailable";
  enrichmentAttempts?: number;
  drift?: BlockDriftNote[];
  notebookAnchor?: string;
  handoffEligible?: boolean;
}): string[] {
  // An unrecorded or agent-recorded run says so rather than borrowing the
  // harness's word: "recorded by agent" and a missing marker are different
  // claims.
  const parts: string[] = [];
  if (block.submittedBy === "harness" && block.serverVerified) parts.push("recorded by harness");
  else if (block.submittedBy === "agent") parts.push("recorded by agent");
  else if (block.submittedBy === "unknown") parts.push("found on Galaxy");
  if (block.notebookAnchor === UNATTRIBUTED) parts.push("unattributed");
  if (block.enrichment === "pending") {
    parts.push(
      block.enrichmentAttempts && block.enrichmentAttempts > 0
        ? `details pending (retry ${block.enrichmentAttempts})`
        : "details pending",
    );
  } else if (block.enrichment === "complete") parts.push("details recorded");
  else if (block.enrichment === "unavailable") parts.push("details unavailable");
  if (block.drift && block.drift.length > 0) parts.push(`${block.drift.length} version drift`);
  // Only a run the registry knows about carries this; silence means no record,
  // not "not eligible".
  if (block.handoffEligible === true) parts.push("eligible to hand off");
  else if (block.handoffEligible === false) parts.push("not eligible to hand off");
  return parts;
}

function serverHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown server";
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function rerouteControl(
  kind: "job" | "invocation",
  record: {
    galaxyServerUrl: string;
    connectionId?: string;
    supersededBy?: string;
    rerouteId?: string;
    status: string;
  },
  id: string,
): string {
  if (record.supersededBy)
    return `<div class="galaxy-invocation-meta">Replacement attempt: ${escapeHtml(record.supersededBy)}${record.rerouteId ? ` <button class="plan-btn galaxy-reroute-status" data-route="${escapeHtml(record.rerouteId)}">Reroute status</button>` : ""}</div>`;
  if (!["in_progress", "failed", "cancelled"].includes(record.status) || !record.galaxyServerUrl)
    return "";
  const payload = JSON.stringify({
    kind,
    id,
    source: record.connectionId || record.galaxyServerUrl,
  });
  return `<button type="button" class="plan-btn galaxy-run-elsewhere" data-reroute="${escapeHtml(payload)}">Run elsewhere…</button>`;
}

function renderRow(inv: Invocation): string {
  const total = inv.totalJobs ?? 0;
  const done = inv.completedJobs ?? 0;
  const failed = inv.failedJobs ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  const stepsText =
    inv.totalSteps !== undefined ? `${inv.completedSteps ?? 0}/${inv.totalSteps} steps` : "";
  const jobsText =
    total > 0 ? `${done}/${total} jobs${failed > 0 ? ` · ${failed} failed` : ""}` : "";
  const counts = [stepsText, jobsText].filter(Boolean).join(" · ");

  let host: string;
  try {
    host = new URL(inv.galaxyServerUrl).host;
  } catch {
    host = inv.galaxyServerUrl;
  }
  const submitted = inv.submittedAt.replace("T", " ").replace(/\.\d+Z$/, "Z");
  // A block written before a Galaxy server was configured names none; drop the
  // segment rather than drawing an empty one between two separators.
  const hostText = host ? ` · ${escapeHtml(host)}` : "";
  // A block Galaxy never confirmed is still a block: say so rather than drawing
  // it identically to a run we know exists.
  const unconfirmed = inv.serverVerified === false ? " · unconfirmed" : "";
  const url = galaxyArtifactUrl(inv.galaxyServerUrl, "invocation", inv.invocationId);
  const label = url
    ? `<a class="galaxy-invocation-label" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="Open Galaxy invocation">${escapeHtml(inv.label)}</a>`
    : `<span class="galaxy-invocation-label" title="${escapeHtml(inv.label)}">${escapeHtml(inv.label)}</span>`;

  // Provenance, shown only when the block actually carries it.
  const provenance = provenanceParts(inv);
  const provenanceText = provenance.length > 0 ? ` · ${escapeHtml(provenance.join(" · "))}` : "";
  const versions = describeToolVersions(inv.jobs);
  const errorTitle = inv.enrichmentError ? ` title="${escapeHtml(inv.enrichmentError)}"` : "";

  return `
    <div class="galaxy-invocation-row ${inv.status}">
      <div class="galaxy-invocation-head">
        ${label}
        <span class="galaxy-invocation-counts">${counts || inv.status}</span>
      </div>
      <div class="galaxy-invocation-bar">
        <div class="galaxy-invocation-bar-fill" style="width: ${pct}%"></div>
      </div>
      <div class="galaxy-invocation-meta"${errorTitle}>
        ${escapeHtml(inv.status)}${hostText}${inv.accountId ? ` · account ${escapeHtml(inv.accountId)}` : ""} · submitted ${escapeHtml(submitted)}${escapeHtml(unconfirmed)}${provenanceText}
      </div>
      ${versions ? `<div class="galaxy-invocation-meta galaxy-invocation-versions">${escapeHtml(versions)}</div>` : ""}
      <div class="galaxy-invocation-meta">Last successful check: ${escapeHtml(inv.lastPolledAt || "not yet observed")}</div>
      ${rerouteControl("invocation", inv, inv.invocationId)}
    </div>
  `;
}

function renderUnattributedJobRow(job: UnattributedJob): string {
  const submitted = job.submittedAt.replace("T", " ").replace(/\.\d+Z$/, "Z");
  const url = galaxyArtifactUrl(job.galaxyServerUrl, "job", job.jobId);
  const label = url
    ? `<a class="galaxy-invocation-label" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="Open Galaxy job">${escapeHtml(job.label)}</a>`
    : `<span class="galaxy-invocation-label" title="${escapeHtml(job.label)}">${escapeHtml(job.label)}</span>`;
  const unconfirmed = job.serverVerified === false ? " · unconfirmed" : "";
  const provenance = provenanceParts({
    ...job,
    notebookAnchor: job.notebookAnchor || UNATTRIBUTED,
  });
  const versions = describeToolVersions(job.jobs);
  const errorTitle = job.enrichmentError ? ` title="${escapeHtml(job.enrichmentError)}"` : "";
  // `completed`/`failed` reuse the invocation row's colouring; the rest draw neutral.
  const statusClass = job.status === "completed" || job.status === "failed" ? job.status : "";
  return `
    <div class="galaxy-invocation-row galaxy-unattributed-job ${statusClass}">
      <div class="galaxy-invocation-head">
        ${label}
        <span class="galaxy-invocation-counts">${escapeHtml(job.notebookAnchor && job.notebookAnchor !== UNATTRIBUTED ? job.notebookAnchor : "tool run")}</span>
      </div>
      <div class="galaxy-invocation-meta"${errorTitle}>
        ${escapeHtml(job.galaxyState || job.status)} · ${escapeHtml(serverHost(job.galaxyServerUrl))}${job.accountId ? ` · account ${escapeHtml(job.accountId)}` : ""} · submitted ${escapeHtml(submitted)}${escapeHtml(unconfirmed)} · ${escapeHtml(provenance.join(" · "))}
      </div>
      ${versions ? `<div class="galaxy-invocation-meta galaxy-invocation-versions">${escapeHtml(versions)}</div>` : ""}
      <div class="galaxy-invocation-meta">Last successful check: ${escapeHtml(job.lastPolledAt || "not yet observed")}</div>
      ${rerouteControl("job", job, job.jobId)}
    </div>
  `;
}

/**
 * Render the invocations section from notebook.md. Hides the section
 * when no invocations exist (with a linger after the last in-progress
 * one finishes so the final state is briefly visible).
 */
export async function refreshGalaxyInvocations(api: {
  readFile: (p: string) => Promise<{ ok: true; bytes: Uint8Array } | { ok: false }>;
  prompt?: (message: string) => Promise<void>;
}): Promise<void> {
  const section = document.getElementById("activity-galaxy-section");
  const body = document.getElementById("galaxy-invocations-body");
  const countEl = document.getElementById("galaxy-invocations-count");
  if (!section || !body || !countEl) return;

  let invocations: Invocation[] = [];
  let strayJobs: UnattributedJob[] = [];
  try {
    const res = await api.readFile("notebook.md");
    if (res.ok) {
      const text = new TextDecoder("utf-8").decode(res.bytes);
      invocations = parseInvocationBlocks(text);
      strayJobs = parseUnattributedJobBlocks(text, true);
    }
  } catch {
    /* notebook missing — leave invocations empty */
  }

  const inProgressCount =
    invocations.filter((i) => i.status === "in_progress").length +
    strayJobs.filter((j) => j.status === "in_progress").length;

  if (invocations.length === 0 && strayJobs.length === 0) {
    section.classList.add("hidden");
    return;
  }

  // Sort: in-progress first, then by submittedAt descending
  invocations.sort((a, b) => {
    if (a.status === "in_progress" && b.status !== "in_progress") return -1;
    if (b.status === "in_progress" && a.status !== "in_progress") return 1;
    return b.submittedAt.localeCompare(a.submittedAt);
  });

  strayJobs.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));

  body.innerHTML =
    invocations.map(renderRow).join("") + strayJobs.map(renderUnattributedJobRow).join("");
  for (const button of body.querySelectorAll<HTMLButtonElement>(".galaxy-run-elsewhere")) {
    button.disabled = !api.prompt;
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api.prompt?.("/reroute " + button.dataset.reroute);
      } finally {
        button.disabled = false;
      }
    });
  }
  for (const button of body.querySelectorAll<HTMLButtonElement>(".galaxy-reroute-status")) {
    button.disabled = !api.prompt;
    button.addEventListener(
      "click",
      () => void api.prompt?.("/reroute status " + button.dataset.route),
    );
  }
  countEl.textContent = String(inProgressCount);
  countEl.classList.toggle("zero", inProgressCount === 0);
  section.classList.remove("hidden");

  // Linger logic: when nothing is in-progress, schedule a hide.
  if (inProgressCount === 0) {
    if (lingerTimer) clearTimeout(lingerTimer);
    lingerTimer = setTimeout(() => {
      lingerTimer = null;
      section.classList.add("hidden");
    }, LINGER_MS);
  } else if (lingerTimer) {
    clearTimeout(lingerTimer);
    lingerTimer = null;
  }
}
