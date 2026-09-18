/**
 * Live Galaxy history panel.
 *
 * Draws the history this analysis is attached to as it moves: one row per
 * visible dataset or collection, a state pill, and a headline counting what is
 * waiting, running, finished and failed. Distinct from the jobs panel, which
 * shows what *Loom* launched and wrote down; this shows what Galaxy itself
 * reports for the history, including work the user did in Galaxy's own UI.
 *
 * Everything here is built with createElement + textContent. Dataset names,
 * collection names and extensions are user-authored strings that arrive from a
 * Galaxy server; `galaxy-invocations.ts` builds its rows with innerHTML and an
 * escape helper, and that is exactly the pattern not to copy into a surface
 * whose whole job is rendering arbitrary Galaxy content. Nothing Galaxy sends
 * is ever parsed as HTML -- notably `peek`, which IS HTML, is not in the
 * payload at all.
 *
 * The widget never fetches. It reads one data source, which the brain fills.
 */

import type { DataSource, WidgetContext, WidgetDefinition, WidgetDispose } from "../widget-api.js";
import type {
  GalaxyLiveHistory,
  GalaxyLiveItem,
  GalaxyLivePayload,
  GalaxyLiveState,
  GalaxyLiveUnavailable,
} from "../../../../../shared/galaxy-live-contract.js";

/** A `type`, not an `interface`: an interface has no implicit index signature,
 *  so it will not assign to the registry's `WidgetDefinition<Record<...>>`. */
type GalaxyHistoryConfig = {
  /** Rows to draw. The payload is capped far higher; this is the panel's own
   *  budget so a short panel does not scroll for a hundred rows. */
  limit: number;
  /** Hide rows that finished cleanly, so a long-running analysis shows only
   *  what is still moving or broken. */
  activeOnly: boolean;
};

/** One sentence per reason. Kept on this side so both shells say the same thing
 *  and the brain never ships prose over the wire. */
const UNAVAILABLE_TEXT: Record<GalaxyLiveUnavailable, string> = {
  "not-configured": "Not connected to a Galaxy server.",
  "no-history": "This analysis is not attached to a Galaxy history yet.",
  unreachable: "Galaxy did not answer. Retrying.",
  unauthorized: "Galaxy rejected the stored API key.",
  // Distinct from the above on purpose: the key is fine, so telling someone to
  // re-enter it sends them to fix something that is not broken.
  forbidden: "This history belongs to another account.",
};

/** For an `unavailable` this build has never heard of. The brain ships on npm
 *  independently of the shell, so a newer reason reaching an older panel is a
 *  supported configuration, and a blank card is the one answer it must not be. */
const UNAVAILABLE_FALLBACK = "Galaxy is not available right now.";

/**
 * What the panel says, and the mark it says it with, for each state Galaxy can
 * report. Never the machine word: "setting_metadata" is not a thing a biologist
 * should have to decode, and the glyph is there so the state survives being
 * read in greyscale or by someone who cannot separate the reds from the greens.
 *
 * Note what is NOT "Finished". `other` is the bucket the contract creates for a
 * state a newer Galaxy invented; calling it finished would show a future
 * failure state as success, and `activeOnly` would then hide it. `empty` is a
 * zero-byte output, which is usually a problem wearing a success state. Both
 * are `unknown`, which reads as "look at this" and survives the filter.
 */
const STATE_PRESENTATION: Record<GalaxyLiveState, { label: string; mark: string; tone: string }> = {
  ok: { label: "Finished", mark: "✓", tone: "done" },
  running: { label: "Running", mark: "●", tone: "busy" },
  queued: { label: "Waiting", mark: "○", tone: "busy" },
  new: { label: "Waiting", mark: "○", tone: "busy" },
  upload: { label: "Uploading", mark: "●", tone: "busy" },
  setting_metadata: { label: "Finishing", mark: "●", tone: "busy" },
  error: { label: "Failed", mark: "✕", tone: "bad" },
  failed_metadata: { label: "Failed", mark: "✕", tone: "bad" },
  paused: { label: "Paused", mark: "⊘", tone: "warn" },
  discarded: { label: "Discarded", mark: "⊘", tone: "warn" },
  deferred: { label: "Deferred", mark: "○", tone: "warn" },
  empty: { label: "Empty", mark: "?", tone: "unknown" },
  other: { label: "Unknown", mark: "?", tone: "unknown" },
};

function presentation(state: GalaxyLiveState): { label: string; mark: string; tone: string } {
  return STATE_PRESENTATION[state] ?? STATE_PRESENTATION.other;
}

/** True for the states the "only active" filter keeps: anything that has not
 *  reached a clean finish. Failures stay visible -- they are the whole point. */
function isStillInteresting(state: GalaxyLiveState): boolean {
  return state !== "ok";
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
 * "1 failed, 3 running, 18 finished" -- ordered by what the user needs to see
 * first, not alphabetically, and silent about states with no items. The words
 * are the panel's own vocabulary, never Galaxy's state strings.
 */
export function summarizeCounts(counts: Partial<Record<GalaxyLiveState, number>>): string {
  const order: GalaxyLiveState[] = [
    "error",
    "failed_metadata",
    "paused",
    "running",
    "upload",
    "setting_metadata",
    "queued",
    "new",
    "ok",
    "empty",
    "deferred",
    "discarded",
    "other",
  ];
  const parts: string[] = [];
  const merged = new Map<string, number>();
  for (const state of order) {
    const n = counts[state];
    if (!n) continue;
    // `error` and `failed_metadata` both read "Failed"; two lines saying
    // "1 failed, 1 failed" is worse than one saying "2 failed".
    const label = presentation(state).label.toLowerCase();
    if (!merged.has(label)) parts.push(label);
    merged.set(label, (merged.get(label) ?? 0) + n);
  }
  if (!parts.length) return "nothing yet";
  return parts.map((label) => `${merged.get(label)} ${label}`).join(", ");
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago the brain last heard from Galaxy. A progress bar nobody has
 * refreshed in an hour and a progress bar that has not moved in an hour look
 * identical, so the panel always says which.
 */
export function describeAge(ageMs: number): string {
  // A stamp we cannot read is not "just now", which is the one direction this
  // line must never round towards.
  if (!Number.isFinite(ageMs)) return "an unknown time ago";
  // A small negative age is clock skew between the brain and the renderer.
  if (ageMs < 45_000) return "just now";
  // Rounding without the clamp reads "60 min ago" and "24 hours ago" for the
  // last millisecond of each bucket, immediately before "1 hour"/"1 day".
  if (ageMs < HOUR) return `${Math.min(59, Math.round(ageMs / MINUTE))} min ago`;
  if (ageMs < DAY) {
    const hours = Math.min(23, Math.round(ageMs / HOUR));
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  const days = Math.round(ageMs / DAY);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** Past this, the numbers above are old enough that saying so matters more than
 *  showing them. The brain re-pushes at least once a minute while it is armed. */
const STALE_AFTER_MS = 5 * MINUTE;

function renderRow(item: GalaxyLiveItem): HTMLElement {
  const row = el("div", "gx-live-row");
  row.append(el("span", "gx-live-hid", String(item.hid)));

  const name = el("span", "gx-live-name", item.name || "(unnamed)");
  // The full name is also user content; title is an attribute, not markup.
  name.title = item.name;
  row.append(name);

  if (item.kind === "collection") {
    // `0` is a real answer Galaxy gives (an empty collection) and is not the
    // same as "the server did not say".
    const n = item.elementCount;
    row.append(el("span", "gx-live-kind", n === undefined ? "collection" : `collection (${n})`));
  } else if (item.extension) {
    row.append(el("span", "gx-live-kind", item.extension));
  }

  const { label, mark, tone } = presentation(item.state);
  const pill = el("span", `gx-live-pill gx-live-${tone}`);
  pill.append(el("span", "gx-live-mark", mark));
  pill.append(document.createTextNode(label));
  row.append(pill);
  return row;
}

/** A positive integer row budget. A persisted config round-tripped through a
 *  text input can arrive as NaN, 0 or a string; `slice(0, NaN)` returns nothing,
 *  which would render a full history as empty. */
function rowBudget(limit: unknown): number {
  const n = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 25;
}

/**
 * The scrolling part. Everything above it -- the name, the counts and the
 * staleness line -- is pinned, because a panel four rows tall scrolls, and the
 * line saying how old these numbers are is the last thing that should be
 * allowed to disappear below the fold.
 */
function renderHistory(
  body: HTMLElement,
  history: GalaxyLiveHistory,
  config: GalaxyHistoryConfig,
): void {
  const matching = history.items.filter((i) => !config.activeOnly || isStillInteresting(i.state));
  const shown = matching.slice(0, rowBudget(config.limit));

  // Rows exist that this panel is not drawing, for two unrelated reasons: the
  // server had more than it sent us, and the panel's own filter/budget dropped
  // some. Report the sum, and say so even when the visible list is empty --
  // that is precisely the case where "nothing here" would be the lie, because
  // under `activeOnly` a quiet list can sit above hundreds of withheld rows.
  const withheld = history.truncated + (history.items.length - shown.length);
  const moreLine = (): void => {
    if (withheld <= 0) return;
    // `truncatedExact` is false when the server's own count was unavailable and
    // all we know is that at least one more row exists.
    const figure = history.truncatedExact ? `${withheld}` : `${withheld}+`;
    body.append(el("p", "gx-live-more", `+ ${figure} more`));
  };

  if (!shown.length) {
    // Three different nothings, and saying the wrong one is how a panel starts
    // lying. `activeOnly` hiding everything is not an empty history, and a
    // count above an empty list is not an empty history either.
    let message: string;
    if (config.activeOnly && history.items.length) message = "Nothing running right now.";
    else if (history.truncated > 0) message = "Nothing to show on this page.";
    else message = "This history has no datasets yet.";
    body.append(el("p", "gx-live-empty", message));
    moreLine();
    return;
  }

  const list = el("div", "gx-live-list");
  for (const item of shown) list.append(renderRow(item));
  body.append(list);
  moreLine();
}

/** What a shell that does not carry the Galaxy source shows. Distinct from
 *  `null`, which means "connected, first payload has not landed yet". */
const NO_SOURCE: GalaxyLivePayload = {
  version: 1,
  serverHost: null,
  history: null,
  unavailable: "not-configured",
  updatedAt: "",
};

export interface GalaxyHistoryRenderOptions {
  /** Epoch-ms "now", so the staleness line is testable without faking a clock. */
  now?: number;
  /** Epoch-ms the panel was mounted, used only to word the pre-first-payload
   *  message honestly: "waiting" stops being true after a while. */
  mountedAt?: number;
}

export function renderGalaxyHistory(
  root: HTMLElement,
  payload: GalaxyLivePayload | null,
  config: GalaxyHistoryConfig,
  opts: GalaxyHistoryRenderOptions = {},
): void {
  const now = opts.now ?? Date.now();
  root.replaceChildren();
  const body = el("div", "gx-live");

  if (!payload) {
    // A panel that says "waiting" forever is its own kind of wrong. After the
    // brain has had several poll ticks to say something, stop implying one is
    // about to arrive.
    const waited = opts.mountedAt === undefined ? 0 : now - opts.mountedAt;
    body.append(
      el(
        "p",
        "gx-live-empty",
        waited > 45_000 ? "No word from Galaxy yet." : "Waiting for Galaxy…",
      ),
    );
    root.append(body);
    return;
  }

  const head = el("div", "gx-live-head");
  head.append(el("span", "gx-live-title", payload.history?.name ?? "Galaxy"));
  if (payload.serverHost) head.append(el("span", "gx-live-host", payload.serverHost));
  body.append(head);

  if (!payload.history) {
    const reason = payload.unavailable
      ? (UNAVAILABLE_TEXT[payload.unavailable] ?? UNAVAILABLE_FALLBACK)
      : "No history yet.";
    body.append(el("p", "gx-live-empty", reason));
    root.append(body);
    return;
  }

  // Say out loud when the counts describe a page rather than the history, so
  // the number above the list can never be read as a total it is not. Skipped
  // when there is nothing to count: "nothing yet (newest 0)" above "nothing to
  // show on this page" spends two lines of a narrow panel saying one thing,
  // and the line below it already says how much is withheld.
  if (payload.history.items.length > 0) {
    const summary = summarizeCounts(payload.history.counts);
    body.append(
      el(
        "p",
        "gx-live-counts",
        payload.history.countsComplete
          ? summary
          : `${summary} (newest ${payload.history.items.length})`,
      ),
    );
  }

  // Above the list, not below it: showing numbers nobody has refreshed as if
  // they were live is the worst thing this surface could do, and in a short
  // panel anything under the list is off-screen.
  // Always drawn, even for a stamp that will not parse: the panel's one
  // promise is that it says when Galaxy was last asked, and a line that
  // silently disappears is worse than one admitting it does not know.
  const asOf = Date.parse(payload.updatedAt);
  const age = Number.isFinite(asOf) ? now - asOf : NaN;
  const line = el("p", "gx-live-checked", `Checked ${describeAge(age)}`);
  if (!Number.isFinite(age) || age > STALE_AFTER_MS) line.classList.add("gx-live-stale");
  body.append(line);

  const scroller = el("div", "gx-live-scroll");
  renderHistory(scroller, payload.history, config);
  body.append(scroller);
  root.append(body);
}

export const galaxyHistoryWidget: WidgetDefinition<GalaxyHistoryConfig> = {
  type: "galaxy-history",
  label: "Galaxy history",
  description: "The Galaxy history this analysis is attached to, as jobs finish.",
  defaultConfig: { limit: 25, activeOnly: false },

  mount(element: HTMLElement, ctx: WidgetContext<GalaxyHistoryConfig>): WidgetDispose {
    // The source is a required key on `DashboardDataSources`, but a host built
    // before it existed -- or a test harness -- can hand over a bag without it,
    // and `undefined.get()` inside mount would turn the panel into an error card
    // for something that is not an error.
    const source = (ctx.sources as { galaxy?: DataSource<GalaxyLivePayload | null> }).galaxy;
    let latest: GalaxyLivePayload | null = null;
    // Not a constant: `DashboardSources.reset()` pushes null when the user
    // switches analysis directory, without re-mounting the widget. Measuring
    // from the original mount would then say "No word from Galaxy yet." the
    // instant they switch, which reads as a broken Galaxy rather than as a
    // panel that has been waiting two seconds.
    let waitingSince = Date.now();

    const toggle = el("button", "dash-panel-btn gx-live-toggle");
    toggle.type = "button";
    const paintToggle = (pressed: boolean): void => {
      toggle.textContent = pressed ? "Show all" : "Only active";
      toggle.classList.toggle("active", pressed);
      toggle.setAttribute("aria-pressed", String(pressed));
    };
    paintToggle(ctx.config.activeOnly);
    // setConfig re-mounts (host contract), which is what actually repaints the
    // list. Flip the label here too so the control is never left showing the
    // opposite of what it just did if a host ever persists without re-mounting.
    toggle.addEventListener("click", () => {
      const next = !ctx.config.activeOnly;
      ctx.setConfig({ activeOnly: next });
      paintToggle(next);
    });
    ctx.header.append(toggle);

    const draw = (): void =>
      renderGalaxyHistory(element, latest, ctx.config, {
        now: Date.now(),
        mountedAt: waitingSince,
      });

    if (!source) {
      // A shell without the Galaxy source (or a build where it is off) gets a
      // sentence, not an error card: nothing is broken, there is just no data.
      // It must not say "waiting", which is what a panel that is about to get
      // data says -- this one never will.
      renderGalaxyHistory(element, NO_SOURCE, ctx.config, {
        now: waitingSince,
        mountedAt: waitingSince,
      });
      return () => toggle.remove();
    }

    // Draw something before subscribing. The host contract says `subscribe`
    // delivers the current value immediately unless asked not to, but a blank
    // box is the failure mode if that ever changes, and `get()` costs nothing.
    latest = source.get();
    draw();
    const unsubscribe = ctx.subscribe(source, (payload) => {
      if (payload === null && latest !== null) waitingSince = Date.now();
      latest = payload;
      draw();
    });

    // The staleness line is a clock, not data, so it must not cost a push. The
    // brain pushes on change; this redraws the "checked N ago" line in between,
    // which is what lets a panel nobody is updating admit it.
    const clock = setInterval(draw, 30_000);
    // Through onDispose rather than the returned dispose: a later render that
    // throws turns the panel into an error card, and the widget never gets to
    // return one.
    ctx.onDispose(() => clearInterval(clock));

    return () => {
      unsubscribe();
      toggle.remove();
    };
  },
};
