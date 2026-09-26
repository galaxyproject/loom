/**
 * Galaxy history panel — the "Galaxy history" section in the Activity tab.
 * Surfaces the Galaxy history the notebook is bound to as a clickable link that
 * opens the history in the user's default browser.
 *
 * Data sources, and why:
 *  - history id comes from the `loom-galaxy-page` YAML block the brain writes
 *    into notebook.md (the same on-disk pattern the invocations panel reads).
 *    This is the notebook's bound page history, not the brain's live
 *    `state.currentHistoryId` — the brain does not persist the live history
 *    anywhere the shell can read, so surfacing it would require a new
 *    brain->shell channel. See the test+fix notes for that follow-up.
 *  - the server origin comes from the brain's *effective* Galaxy connection
 *    (window.orbit.getGalaxyStatus -> { connected, url }), not the server
 *    recorded in the binding. The binding records the server at bind time; the
 *    effective status is the connection the user is on right now -- a saved
 *    profile *or* an exported GALAXY_URL/GALAXY_API_KEY. Reading masked config
 *    alone missed the env-driven / auto-connect path, so the section stayed
 *    hidden even though the footer dot was green and a history was bound (#290,
 *    follow-up to #284). Driving off the effective status means the section
 *    hides on disconnect, tracks profile switches, and matches the footer dot
 *    exactly, and the opened link always targets the server Orbit is connected
 *    to.
 *
 * Hidden when Galaxy is not connected, when no binding exists, or when the URL
 * can't be built. Building the web URL is a shell concern — the Loom brain
 * stays shell-neutral.
 */

import { isNotebookFenceOpen } from "../../../shared/notebook-fences.js";

const BINDING_FENCE_CLOSE = "```";

interface GalaxyHistoryBinding {
  historyId: string;
}

function unescape(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

/**
 * Parse `loom-galaxy-page` blocks from notebook.md, keeping the history id the
 * link needs. Mirrors the brain-side findGalaxyPageBlocks() grammar
 * (extensions/loom/galaxy-page-binding.ts).
 */
export function parseGalaxyHistoryBindings(content: string): GalaxyHistoryBinding[] {
  const out: GalaxyHistoryBinding[] = [];
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (isNotebookFenceOpen(lines[i], "galaxy-page")) {
      const start = i + 1;
      let end = start;
      while (end < lines.length && lines[end].trim() !== BINDING_FENCE_CLOSE) end++;
      const fields: Record<string, string> = {};
      for (const line of lines.slice(start, end)) {
        const m = line.match(/^([a-z_]+):\s*(.*)$/);
        if (m) fields[m[1]] = unescape(m[2].trim());
      }
      if (fields.history_id) {
        out.push({ historyId: fields.history_id });
      }
      i = end + 1;
    } else {
      i++;
    }
  }
  return out;
}

/**
 * Build the canonical Galaxy history-view URL. Appends to the full server URL
 * (after stripping trailing slashes) so subpath deployments like
 * `https://example.org/galaxy` resolve to `https://example.org/galaxy/histories/view`,
 * matching how galaxy-api.ts builds `${url}/api...`. Resolving against the
 * origin (`new URL("/histories/view", serverUrl)`) would drop the prefix.
 * Returns null when the server URL is unparseable so we never render a broken
 * or unsafe link.
 */
export function buildHistoryUrl(serverUrl: string, historyId: string): string | null {
  try {
    const base = serverUrl.replace(/\/+$/, "");
    const url = new URL(`${base}/histories/view`);
    url.searchParams.set("id", historyId);
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Render the Galaxy history section. Uses the first binding block (today's MVP
 * is one binding per notebook) for the history id and the brain's effective
 * Galaxy connection for the server. Hides the section when Galaxy is not
 * connected, there's no binding, or the URL can't be built.
 */
export async function refreshGalaxyHistory(api: {
  readFile: (p: string) => Promise<{ ok: true; bytes: Uint8Array } | { ok: false }>;
  getGalaxyStatus: () => Promise<{ connected: boolean; url: string | null }>;
  openGalaxyHistory: (url: string) => Promise<{ opened: boolean }>;
}): Promise<void> {
  const section = document.getElementById("activity-galaxy-history-section");
  const body = document.getElementById("galaxy-history-body");
  if (!section || !body) return;

  const hide = (): void => {
    section.classList.add("hidden");
    body.replaceChildren();
  };

  let serverUrl: string | null = null;
  try {
    const status = await api.getGalaxyStatus();
    // Gate on the same `connected` notion the footer dot uses (which decrypts
    // the key) rather than URL presence, so the section and the dot agree.
    if (status.connected) serverUrl = status.url;
  } catch {
    /* status unavailable — treat as not connected */
  }
  if (!serverUrl) {
    hide();
    return;
  }

  let bindings: GalaxyHistoryBinding[] = [];
  try {
    const res = await api.readFile("notebook.md");
    if (res.ok) {
      const text = new TextDecoder("utf-8").decode(res.bytes);
      bindings = parseGalaxyHistoryBindings(text);
    }
  } catch {
    /* notebook missing — no binding */
  }

  const binding = bindings[0];
  const historyUrl = binding ? buildHistoryUrl(serverUrl, binding.historyId) : null;

  if (!binding || !historyUrl) {
    hide();
    return;
  }

  let host: string;
  try {
    host = new URL(serverUrl).host;
  } catch {
    host = serverUrl;
  }

  const row = document.createElement("div");
  row.className = "galaxy-history-row";

  const link = document.createElement("a");
  link.className = "galaxy-history-link";
  // Real destination in href (hover/copy-link shows where it goes); the click
  // handler preventDefaults and routes through the host-pinned IPC path so the
  // Electron window never navigates. main.ts's will-navigate guard backstops
  // this if the handler ever fails to attach.
  link.href = historyUrl;
  link.textContent = "History";
  link.title = `Open history ${binding.historyId} in Galaxy (${host})`;
  link.addEventListener("click", (e) => {
    e.preventDefault();
    void api.openGalaxyHistory(historyUrl);
  });

  const meta = document.createElement("span");
  meta.className = "galaxy-history-meta";
  meta.textContent = host;

  row.append(link, meta);
  body.replaceChildren(row);
  section.classList.remove("hidden");
}
