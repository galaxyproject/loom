import type {
  GalaxyActivitySnapshot,
  RecentGalaxyHistory,
  RecentGalaxyInvocation,
} from "../../../shared/loom-shell-contract.js";

interface ActivityAPI {
  refreshGalaxyActivity(): Promise<void>;
  openGalaxyActivity(url: string): Promise<{ opened: boolean }>;
}
const escape = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const utcDate = (value: string): Date =>
  new Date(/Z$|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`);
function timestamp(value: string): string {
  const date = utcDate(value);
  if (!Number.isFinite(date.getTime())) return "Time unavailable";
  return `<time datetime="${date.toISOString()}" title="${escape(date.toLocaleString())}">${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</time>`;
}
const icon = (kind: "history" | "run"): string =>
  `<span class="recent-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">${kind === "history" ? '<path d="M3 7h7l2-3h9v16H3z"/><path d="M3 7V4h7l2 3"/>' : '<rect x="3" y="3" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M6 8v10h9M9 5h9v11"/>'}</svg></span>`;

export class RecentGalaxyPanel {
  private snapshot?: GalaxyActivitySnapshot;
  private view: "histories" | "invocations" = "histories";
  private query = "";
  private request = 0;
  private timeout?: ReturnType<typeof setTimeout>;
  private notice = "Waiting for Loom…";
  private pending = false;
  private expanded = new Set<string>();
  private readonly panel: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly api: ActivityAPI,
  ) {
    root.innerHTML = `<div class="recent-heading"><div><div class="recent-eyebrow">GALAXY WORKSPACE</div><h2>Recent on Galaxy</h2><div class="recent-server"><span class="recent-connection-dot"></span><span data-server>Waiting for connection</span></div></div><button type="button" class="recent-refresh">Refresh</button></div>
      <div class="recent-tabs" role="tablist" aria-label="Recent Galaxy work"><button id="recent-histories-tab" type="button" role="tab" aria-controls="recent-galaxy-panel" aria-selected="true" data-view="histories">Histories <span data-count="histories">—</span></button><button id="recent-invocations-tab" type="button" role="tab" aria-controls="recent-galaxy-panel" aria-selected="false" tabindex="-1" data-view="invocations">Workflow runs <span data-count="invocations">—</span></button></div>
      <div class="recent-filter"><label class="recent-search"><span aria-hidden="true">⌕</span><input type="search" aria-label="Search recent histories" placeholder="Find a recent history…" /></label><span data-sort>Last updated ↓</span></div>
      <div class="recent-notice hidden" role="status"></div><div id="recent-galaxy-panel" role="tabpanel" aria-labelledby="recent-histories-tab" tabindex="0"></div>
      <div class="recent-footer" aria-live="polite"><span data-summary></span><span data-updated></span></div>`;
    this.panel = root.querySelector<HTMLElement>("#recent-galaxy-panel")!;
    root.querySelector(".recent-refresh")!.addEventListener("click", () => void this.refresh());
    root.querySelector<HTMLInputElement>("input")!.addEventListener("input", (event) => {
      this.query = (event.target as HTMLInputElement).value;
      this.render();
    });
    root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((tab) => {
      tab.addEventListener("click", () => this.select(tab.dataset.view as typeof this.view));
      tab.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        this.select(
          event.key === "Home"
            ? "histories"
            : event.key === "End"
              ? "invocations"
              : this.view === "histories"
                ? "invocations"
                : "histories",
        );
        root.querySelector<HTMLButtonElement>(`[data-view="${this.view}"]`)!.focus();
      });
    });
    root.addEventListener("click", (event) => {
      const link = (event.target as Element).closest<HTMLAnchorElement>("a[data-galaxy-link]");
      if (!link) return;
      event.preventDefault();
      void api
        .openGalaxyActivity(link.href)
        .then((result) => {
          if (!result.opened)
            this.showNotice(
              "Couldn’t open Galaxy. You can copy the link and open it in your browser.",
            );
        })
        .catch(() =>
          this.showNotice("Couldn’t open Galaxy. Copy the link to open it in your browser."),
        );
    });
    this.panel.addEventListener(
      "toggle",
      (event) => {
        const details = event.target as HTMLDetailsElement;
        const id = details.dataset.run;
        if (id) {
          if (details.open) this.expanded.add(id);
          else this.expanded.delete(id);
        }
      },
      true,
    );
    this.render();
  }

  private showNotice(message: string): void {
    const notice = this.root.querySelector<HTMLElement>(".recent-notice")!;
    notice.textContent = message;
    notice.classList.toggle("hidden", !message);
  }
  private select(view: typeof this.view): void {
    this.view = view;
    this.query = "";
    this.root.querySelector<HTMLInputElement>("input")!.value = "";
    this.render();
    this.panel.scrollTop = 0;
  }

  /** Called only with the brain-owned widget, not notebook-derived guesses. */
  update(snapshot: GalaxyActivitySnapshot): void {
    if (!snapshot || !Array.isArray(snapshot.histories) || !Array.isArray(snapshot.invocations))
      return;
    if (snapshot.server && !/^https?:\/\//i.test(snapshot.server)) return;
    if (snapshot.server !== this.snapshot?.server) this.expanded.clear();
    this.snapshot = snapshot;
    this.pending = snapshot.phase === "loading";
    if (!this.pending) {
      clearTimeout(this.timeout);
      this.request++;
    }
    this.notice = "";
    this.render();
  }

  reset(message = "Waiting for Loom…"): void {
    this.request++;
    clearTimeout(this.timeout);
    this.snapshot = undefined;
    this.pending = false;
    this.expanded.clear();
    this.notice = message;
    this.render();
  }

  async refresh(): Promise<void> {
    const request = ++this.request;
    this.pending = true;
    this.notice = "";
    this.render();
    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => {
      if (request !== this.request) return;
      this.pending = false;
      this.notice = "No response from Loom. Restart the agent or try Refresh again.";
      this.render();
    }, 20_000);
    try {
      await this.api.refreshGalaxyActivity();
    } catch {
      if (request !== this.request) return;
      clearTimeout(this.timeout);
      this.pending = false;
      this.notice = "Loom is unavailable. Restart the agent to refresh Galaxy activity.";
      this.render();
    }
  }

  private url(path: string): string {
    return escape(`${this.snapshot!.server!.replace(/\/+$/, "")}${path}`);
  }
  private historyUrl(id: string): string {
    return this.url(`/histories/view?id=${encodeURIComponent(id)}`);
  }
  private historyRow(h: RecentGalaxyHistory): string {
    return `<article class="recent-row history-row">${icon("history")}<div class="recent-copy"><a class="recent-name" data-galaxy-link href="${this.historyUrl(h.id)}">${escape(h.name)}</a><div class="recent-meta">${h.count !== undefined ? `${h.count.toLocaleString()} items · ` : ""}Updated ${timestamp(h.updatedAt)}${h.published ? '<span class="history-visibility">Published</span>' : ""}</div></div><a class="row-open" data-galaxy-link href="${this.historyUrl(h.id)}" aria-label="Open ${escape(h.name)} in Galaxy">↗</a></article>`;
  }
  private invocationRow(run: RecentGalaxyInvocation): string {
    const style = ["completed", "failed", "cancelled"].includes(run.state) ? run.state : "";
    const label = run.state.charAt(0).toUpperCase() + run.state.slice(1);
    return `<details class="recent-row run-row" data-run="${escape(run.id)}" ${this.expanded.has(run.id) ? "open" : ""}><summary>${icon("run")}<div class="recent-copy"><span class="recent-name">${escape(run.name)}</span><span class="recent-meta">${escape(run.historyName)}</span><span class="recent-meta">Started ${timestamp(run.createdAt)}</span></div><span class="run-state ${style}" title="Invocation state reported by Galaxy; not scientific verification">${escape(label)}</span></summary><div class="run-details"><dl><dt>Run ID</dt><dd><code>${escape(run.id)}</code></dd><dt>Updated</dt><dd>${timestamp(run.updatedAt)}</dd><dt>State</dt><dd>${escape(label)} · reported by Galaxy</dd></dl><div class="run-actions"><a data-galaxy-link href="${this.url(`/workflows/invocations/${encodeURIComponent(run.id)}`)}">Open invocation ↗</a><a data-galaxy-link href="${this.historyUrl(run.historyId)}">Open history ↗</a></div></div></details>`;
  }

  private render(): void {
    const data = this.snapshot;
    const histories = this.view === "histories";
    const disconnected = data?.phase === "disconnected";
    const error = histories ? data?.historiesError : data?.invocationsError;
    const source = data?.[this.view] || [];
    const updatedAt = histories ? data?.historiesUpdatedAt : data?.invocationsUpdatedAt;
    const query = this.query.trim().toLocaleLowerCase();
    const rows = source.filter((row) =>
      `${row.name} ${"historyName" in row ? row.historyName : ""} ${row.id}`
        .toLocaleLowerCase()
        .includes(query),
    );
    this.root.querySelector<HTMLButtonElement>(".recent-refresh")!.disabled = this.pending;
    this.root.querySelector(".recent-refresh")!.textContent = this.pending
      ? "Refreshing…"
      : "Refresh";
    this.root.querySelector("[data-server]")!.textContent = data?.server
      ? new URL(data.server).host
      : disconnected
        ? "Not connected"
        : "Galaxy";
    this.root.querySelector<HTMLElement>(".recent-connection-dot")!.style.background =
      disconnected || !data ? "var(--text-dim)" : error ? "var(--warning)" : "var(--success)";
    this.root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((tab) => {
      const selected = tab.dataset.view === this.view;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    for (const key of ["histories", "invocations"] as const)
      this.root.querySelector(`[data-count="${key}"]`)!.textContent =
        data && !disconnected ? String(data[key].length) : "—";
    const input = this.root.querySelector<HTMLInputElement>("input")!;
    input.placeholder = histories ? "Find a recent history…" : "Find a workflow or history…";
    input.setAttribute(
      "aria-label",
      histories ? "Search recent histories" : "Search recent workflow runs",
    );
    this.root.querySelector("[data-sort]")!.textContent = histories
      ? "Last updated ↓"
      : "Last started ↓";
    this.panel.setAttribute("aria-labelledby", `recent-${this.view}-tab`);
    this.panel.setAttribute("aria-busy", String(this.pending));
    const scroll = this.panel.scrollTop;
    const emptyMessage = disconnected
      ? "Connect to Galaxy in Preferences to see your recent work."
      : this.pending
        ? "Loading recent Galaxy activity…"
        : error ||
          this.notice ||
          (query
            ? "No matching results. Try another name."
            : histories
              ? "No recent histories."
              : "No recent workflow runs.");
    this.panel.innerHTML = rows.length
      ? rows
          .map((row) =>
            histories
              ? this.historyRow(row as RecentGalaxyHistory)
              : this.invocationRow(row as RecentGalaxyInvocation),
          )
          .join("")
      : `<div class="recent-empty" role="status">${escape(emptyMessage)}</div>`;
    this.panel.scrollTop = scroll;
    this.showNotice(
      source.length
        ? [this.notice, error ? `${error} Showing last-known data.` : ""].filter(Boolean).join(" ")
        : "",
    );
    this.root.querySelector("[data-summary]")!.textContent = disconnected
      ? ""
      : `${rows.length} ${query ? "matching" : "recent"} ${histories ? "histories" : "runs"}`;
    this.root.querySelector("[data-updated]")!.textContent = updatedAt
      ? `${error ? "Last success" : "Updated"} ${utcDate(updatedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} · every minute`
      : "";
  }
}
