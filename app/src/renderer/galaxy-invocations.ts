/**
 * Galaxy invocations panel — third section in the Activity tab. Parses
 * `loom-invocation` YAML blocks from `notebook.md` and draws a live
 * progress row per active workflow.
 *
 * The brain owns polling Galaxy and rewriting the YAML; this side just
 * reads what's on disk and re-renders on every files:changed event.
 * Hidden when there are no in-progress invocations (with a brief linger
 * so users see the final completed/failed state).
 */

interface Invocation {
  invocationId: string;
  galaxyServerUrl: string;
  notebookAnchor: string;
  label: string;
  submittedAt: string;
  status: "in_progress" | "completed" | "failed";
  summary?: string;
  totalSteps?: number;
  completedSteps?: number;
  totalJobs?: number;
  completedJobs?: number;
  failedJobs?: number;
  lastPolledAt?: string;
}

const FENCE_OPEN = "```loom-invocation";
const FENCE_CLOSE = "```";
const STATUSES = new Set(["in_progress", "completed", "failed"] as const);
// After the last in-progress invocation flips to completed/failed, keep
// the section visible for a few seconds so the user sees the final state
// before it disappears.
const LINGER_MS = 5000;

let lingerTimer: ReturnType<typeof setTimeout> | null = null;

function unescape(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

export function parseInvocationBlocks(content: string): Invocation[] {
  const out: Invocation[] = [];
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === FENCE_OPEN) {
      const start = i + 1;
      let end = start;
      while (end < lines.length && lines[end].trim() !== FENCE_CLOSE) end++;
      const body = lines.slice(start, end);
      const fields: Record<string, string> = {};
      for (const line of body) {
        const m = line.match(/^([a-z_]+):\s*(.*)$/);
        if (m) fields[m[1]] = unescape(m[2].trim());
      }
      const status = fields.status as Invocation["status"];
      if (
        fields.invocation_id &&
        fields.galaxy_server_url &&
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
          galaxyServerUrl: fields.galaxy_server_url,
          notebookAnchor: fields.notebook_anchor,
          label: fields.label,
          submittedAt: fields.submitted_at,
          status,
          summary: fields.summary || undefined,
          totalSteps: num("total_steps"),
          completedSteps: num("completed_steps"),
          totalJobs: num("total_jobs"),
          completedJobs: num("completed_jobs"),
          failedJobs: num("failed_jobs"),
          lastPolledAt: fields.last_polled_at || undefined,
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
        ${escapeHtml(inv.status)} · ${escapeHtml(host)} · submitted ${escapeHtml(submitted)}
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
