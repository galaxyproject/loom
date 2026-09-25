/**
 * Galaxy invocations panel — an Activity-tab section (rendered after the
 * Galaxy history section). Parses
 * `loom-invocation` YAML blocks from `notebook.md` and draws a live
 * progress row per active workflow.
 *
 * The brain owns polling Galaxy and rewriting the YAML; this side just
 * reads what's on disk and re-renders on every files:changed event.
 * Hidden when there are no in-progress invocations (with a brief linger
 * so users see the final completed/failed state).
 */

export interface Invocation {
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
  jobs?: BlockJobSummary[];
  drift?: BlockDriftNote[];
}

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

const FENCE_OPEN = "```loom-invocation";
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

export function parseInvocationBlocks(content: string): Invocation[] {
  const out: Invocation[] = [];
  const lines = content.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === FENCE_OPEN) {
      const start = i + 1;
      let end = start;
      // Same fence grammar as the brain's scanner (scanFencedBlocks): the body
      // is `key: value` lines and nothing else, and the close is an exact ```.
      // Anything else -- a run of four backticks, another opener, a line of
      // prose, end of file -- means this is not a block.
      while (end < lines.length && isBlockBodyLine(lines[end])) end++;
      if (end >= lines.length || lines[end].trim() !== FENCE_CLOSE) {
        i = start;
        continue;
      }
      const body = lines.slice(start, end);
      const fields: Record<string, string> = {};
      // Raw (un-unescaped) copy for the harness fields, which are bare tokens
      // or single-line JSON. Mirrors parseInvocationBlock in the brain.
      const rawFields: Record<string, string> = {};
      for (const line of body) {
        const m = line.match(/^([a-z_]+):\s*(.*)$/);
        if (m) {
          rawFields[m[1]] = m[2].trim();
          fields[m[1]] = unescape(m[2].trim());
        }
      }
      const status = fields.status as Invocation["status"];
      // `galaxy_server_url` is not required, matching the brain's parser: the
      // harness records a submission whether or not GALAXY_URL happened to be
      // set, and a block the brain polls but this side drops is a run the user
      // cannot see in Activity.
      if (
        fields.invocation_id &&
        fields.notebook_anchor &&
        fields.label &&
        fields.submitted_at &&
        STATUSES.has(status)
      ) {
        const num = (k: string): number | undefined => {
          const raw = fields[k];
          if (!raw) return undefined;
          const n = Number(raw);
          return Number.isFinite(n) ? n : undefined;
        };
        out.push({
          invocationId: fields.invocation_id,
          galaxyServerUrl: fields.galaxy_server_url ?? "",
          notebookAnchor: fields.notebook_anchor,
          label: fields.label,
          submittedAt: fields.submitted_at,
          status,
          summary: fields.summary || undefined,
          serverVerified:
            fields.server_verified === "true"
              ? true
              : fields.server_verified === "false"
                ? false
                : undefined,
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
          jobs: jsonArrayField<BlockJobSummary>(rawFields.jobs),
          drift: jsonArrayField<BlockDriftNote>(rawFields.drift),
        });
      }
      i = end + 1;
    } else {
      i++;
    }
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

  // Provenance, shown only when the block actually carries it. An unrecorded
  // or agent-recorded run says so rather than borrowing the harness's word:
  // "recorded by agent" and a missing marker are different claims.
  const provenance: string[] = [];
  if (inv.submittedBy === "harness" && inv.serverVerified) provenance.push("recorded by harness");
  else if (inv.submittedBy === "agent") provenance.push("recorded by agent");
  else if (inv.submittedBy === "unknown") provenance.push("found on Galaxy");
  if (inv.enrichment === "pending") provenance.push("details pending");
  else if (inv.enrichment === "unavailable") provenance.push("details unavailable");
  if (inv.drift && inv.drift.length > 0) provenance.push(`${inv.drift.length} version drift`);
  const provenanceText = provenance.length > 0 ? ` · ${escapeHtml(provenance.join(" · "))}` : "";

  return `
    <div class="galaxy-invocation-row ${inv.status}">
      <div class="galaxy-invocation-head">
        <span class="galaxy-invocation-label" title="${escapeHtml(inv.label)}">${escapeHtml(inv.label)}</span>
        <span class="galaxy-invocation-counts">${counts || inv.status}</span>
      </div>
      <div class="galaxy-invocation-bar">
        <div class="galaxy-invocation-bar-fill" style="width: ${pct}%"></div>
      </div>
      <div class="galaxy-invocation-meta">
        ${escapeHtml(inv.status)}${hostText} · submitted ${escapeHtml(submitted)}${escapeHtml(unconfirmed)}${provenanceText}
      </div>
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
}): Promise<void> {
  const section = document.getElementById("activity-galaxy-section");
  const body = document.getElementById("galaxy-invocations-body");
  const countEl = document.getElementById("galaxy-invocations-count");
  if (!section || !body || !countEl) return;

  let invocations: Invocation[] = [];
  try {
    const res = await api.readFile("notebook.md");
    if (res.ok) {
      const text = new TextDecoder("utf-8").decode(res.bytes);
      invocations = parseInvocationBlocks(text);
    }
  } catch {
    /* notebook missing — leave invocations empty */
  }

  const inProgress = invocations.filter((i) => i.status === "in_progress");

  if (invocations.length === 0) {
    section.classList.add("hidden");
    return;
  }

  // Sort: in-progress first, then by submittedAt descending
  invocations.sort((a, b) => {
    if (a.status === "in_progress" && b.status !== "in_progress") return -1;
    if (b.status === "in_progress" && a.status !== "in_progress") return 1;
    return b.submittedAt.localeCompare(a.submittedAt);
  });

  body.innerHTML = invocations.map(renderRow).join("");
  countEl.textContent = String(inProgress.length);
  countEl.classList.toggle("zero", inProgress.length === 0);
  section.classList.remove("hidden");

  // Linger logic: when nothing is in-progress, schedule a hide.
  if (inProgress.length === 0) {
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
