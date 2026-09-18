/**
 * Wiring: everything app.ts needs to know about the dashboard is the handful of
 * setters returned here. Keeping it in this file is the point -- app.ts is a
 * 4.7k-line monolith and the place branches collide.
 */

import {
  createDefaultDashboardDocument,
  parseDashboardDocument,
  serializeDashboardDocument,
} from "../../../../shared/dashboard-contract.js";
import type { DashboardDocument } from "../../../../shared/dashboard-contract.js";
import { LoomWidgetKey, decodeJsonWidget } from "../../../../shared/loom-shell-contract.js";
import { normalizeGalaxyLivePayload } from "../../../../shared/galaxy-live-contract.js";
import type { FileNode } from "../../preload/preload.js";
import { DashboardHost } from "./host.js";
import { DashboardSources } from "./data-sources.js";
import type { SessionSnapshot } from "./widget-api.js";
// Side-effect import: fills the registry before the host renders anything.
import "./widgets/index.js";

const SAVE_DEBOUNCE_MS = 300;
/**
 * How often to notice that something else rewrote the layout file. The desktop
 * shell has a cwd watcher and `refreshFromFiles` drives a check off it; the web
 * shell has no watcher at all, so this poll is what makes the two behave the
 * same. One small read of a file capped at 256 KB.
 */
const EXTERNAL_CHECK_MS = 5000;

const CORRUPT_BANNER =
  "The saved dashboard for this analysis could not be read, so this is the default one. " +
  "Your file has been left alone -- changing anything here will replace it.";

const CONFLICT_BANNER =
  "The dashboard was changed elsewhere, so this is the newer version. " +
  "Your last change was not saved.";

export interface DashboardBootstrap {
  host: DashboardHost;
  /** Notebook markdown the brain pushed. Drives the jobs and plan sources too. */
  setNotebook(markdown: string, path?: string | null): void;
  setSession(patch: Partial<Omit<SessionSnapshot, "updatedAt">>): void;
  /** Something on disk changed: re-read the activity log and the file tree. */
  refreshFromFiles(): void;
  /** A new analysis directory: drop the old data and load that workspace's layout. */
  reloadForCwd(): void;
  /** Stop the external-change poll. For tests and teardown. */
  stop(): void;
}

type LoadResult =
  { ok: true; raw: string | null; revision: string | null } | { ok: false; error: string };

type SaveResult =
  | { ok: true; revision?: string | null }
  | {
      ok: false;
      error: string;
      conflict?: boolean;
      raw?: string | null;
      revision?: string | null;
    };

type DashboardShell = {
  loadDashboard?: () => Promise<LoadResult>;
  /**
   * The brain's widget push. The dashboard subscribes here itself rather than
   * being fed from `app.ts`: both shells allow more than one listener on this
   * channel, and app.ts is the file every branch collides in. Its own handler
   * ignores keys it does not know, so the two do not interfere.
   */
  onUiRequest?: (cb: (request: { method: string; [k: string]: unknown }) => void) => () => void;
  saveDashboard?: (raw: string, baseRevision?: string | null) => Promise<SaveResult>;
  readFile?: (
    relPath: string,
    opts?: { tail?: boolean },
  ) => Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error?: string }>;
  listFiles?: (opts?: {
    includeHidden?: boolean;
  }) => Promise<{ ok: true; root: FileNode } | { ok: false; error?: string }>;
};

export interface DashboardInitOptions {
  /** The shell's own "open this file" action, where it has one. */
  openFile?: (relPath: string) => void;
}

export function initDashboard(
  container: HTMLElement,
  opts: DashboardInitOptions = {},
): DashboardBootstrap {
  // Read through a narrow shape rather than the full OrbitAPI: the web shim
  // casts, so a method it never implemented is `undefined` at runtime however
  // the type reads. Every call below is guarded.
  const shell = window.orbit as unknown as DashboardShell;

  const sources = new DashboardSources({
    readFile: shell.readFile?.bind(window.orbit),
    listFiles: shell.listFiles?.bind(window.orbit),
  });

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let pending: DashboardDocument | null = null;
  // Same guard the notebook loader in app.ts uses: a load for the directory we
  // just left must not apply its document over the one we are switching to.
  let loadSeq = 0;
  // The version of the file this renderer believes it is editing. Handed back
  // on every save so a write based on a version somebody else replaced is
  // refused rather than applied over the top.
  let revision: string | null = null;

  const cancelPendingSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    pending = null;
  };

  /** Adopt a document that arrived from disk. Never writes back. */
  const adopt = (raw: string, nextRevision: string | null): boolean => {
    const parsed = parseDashboardDocument(raw);
    if (!parsed.ok) {
      console.error("[dashboard] saved layout rejected:", parsed.problems);
      // Take the revision anyway. The file is unreadable, not unknown, and
      // leaving `revision` at null meant every later save went out against a
      // revision the file never had: the compare-and-swap refused it, the
      // conflict branch re-adopted the same corrupt text, and it never
      // converged -- so the banner's promise that "changing anything here will
      // replace it" was false, and the 5-second poll logged a parse failure
      // for the life of the session. With the revision held, the first
      // deliberate change wins the swap and replaces the file, which is what
      // the banner says and what the design note intended.
      revision = nextRevision;
      host.setBanner(CORRUPT_BANNER);
      return false;
    }
    if (parsed.problems.length > 0) {
      console.warn("[dashboard] saved layout needed repairs:", parsed.problems);
    }
    revision = nextRevision;
    host.setDocument(parsed.document, { persist: false });
    return true;
  };

  const flush = (): void => {
    saveTimer = null;
    const doc = pending;
    pending = null;
    if (!doc || typeof shell.saveDashboard !== "function") return;
    const base = revision;
    void Promise.resolve(shell.saveDashboard(serializeDashboardDocument(doc), base))
      .then((res) => {
        if (res.ok) {
          revision = res.revision ?? null;
          // The banner explained a state that no longer holds. Both of the ones
          // a save can be sitting under say something about the file on disk --
          // that it could not be read, or that somebody else changed it -- and
          // this write just settled both. Leaving it up means the corrupt-layout
          // banner is still promising to replace a file it has already
          // replaced, which I watched it do.
          host.setBanner("");
          return;
        }
        if (res.conflict) {
          // Somebody else -- the brain, another window -- rewrote the file
          // between our load and our save. Take theirs and say so; silently
          // winning would throw away a change the user cannot see.
          console.warn("[dashboard] save conflicted with a newer layout on disk");
          // And drop anything queued behind the rejected save. That document
          // was built on the revision we just lost, so writing it now would
          // stamp it with the revision we are about to adopt and overwrite the
          // external edit we are in the middle of accepting -- the conflict
          // would be reported to the user and then quietly undone a moment
          // later. The queued edit is lost either way; this way the file and
          // the screen agree about which version survived.
          cancelPendingSave();
          if (typeof res.raw === "string") {
            if (adopt(res.raw, res.revision ?? null)) host.setBanner(CONFLICT_BANNER);
          } else {
            revision = res.revision ?? null;
            host.setBanner(CONFLICT_BANNER);
          }
          return;
        }
        console.error("[dashboard] save failed:", res.error);
      })
      .catch((err) => console.error("[dashboard] save failed:", err));
  };

  const host = new DashboardHost(container, {
    sources: sources.sources,
    openFile: opts.openFile,
    persist: (doc) => {
      // A change made while the startup load is still in flight wins: otherwise
      // the load lands after it, puts the disk version back on screen, and the
      // queued save writes the user's version to disk. Screen and file disagree.
      loadSeq++;
      pending = doc;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
    },
  });

  /**
   * Load this workspace's layout. A file that will not parse is left exactly as
   * it is on disk and reported in the banner -- losing someone's layout to a
   * parse bug is worse than showing them the default for one session.
   */
  const load = async (): Promise<void> => {
    const seq = ++loadSeq;
    host.setBanner("");
    if (typeof shell.loadDashboard !== "function") return;
    let res: LoadResult;
    try {
      res = await shell.loadDashboard();
    } catch (err) {
      console.error("[dashboard] load failed:", err);
      return;
    }
    if (seq !== loadSeq) return;
    if (!res.ok) {
      host.setBanner(`Could not read the saved dashboard: ${res.error}`);
      return;
    }
    // No file yet is the normal first run, not a problem worth a banner.
    if (res.raw === null || res.raw.trim() === "") {
      revision = res.revision ?? null;
      return;
    }
    adopt(res.raw, res.revision ?? null);
  };

  /**
   * Has something else rewritten the file? Skipped while a local change is
   * queued -- that write is about to run its own compare-and-swap, which is
   * where a real conflict is reported.
   */
  const checkForExternalChange = async (): Promise<void> => {
    if (pending || saveTimer) return;
    if (typeof shell.loadDashboard !== "function") return;
    const seq = loadSeq;
    let res: LoadResult;
    try {
      res = await shell.loadDashboard();
    } catch {
      return;
    }
    if (seq !== loadSeq || pending || saveTimer) return;
    if (!res.ok) return;
    const next = res.revision ?? null;
    if (next === revision) return;
    if (res.raw === null) {
      revision = next;
      // The file is gone: `/dashboard undo` removes it when the change being
      // undone is the one that created it, and so does deleting it by hand.
      // Taking the revision alone left the pane drawing a layout that no longer
      // exists -- and since the revision had moved, nothing would ask again, so
      // the next edit wrote the deleted layout straight back out. Same answer as
      // a workspace switch: back to the default, without persisting it.
      //
      // Only for `null`, which is "there is no file". A file that is present
      // but empty is a write someone is in the middle of, or a truncation, and
      // throwing away the layout on screen for one of those would be the data
      // loss this pass is here to stop.
      host.setDocument(createDefaultDashboardDocument(), { persist: false });
      // Whatever the banner was saying about the old file, it is not true now.
      host.setBanner("");
      return;
    }
    if (res.raw.trim() === "") {
      revision = next;
      return;
    }
    if (adopt(res.raw, next)) host.setBanner("");
  };

  /**
   * The live Galaxy history the brain projects. Decoding here rather than in
   * the widget keeps the widget off `window.orbit` entirely.
   *
   * Both the parse and the shape are checked. The brain ships on npm
   * independently of the Orbit build, so this is a process boundary between two
   * versions, not just two processes: a payload whose `items` arrived as a
   * string used to throw out of the widget's render, and the host turns that
   * into a sticky error card that only a click recovers. Nothing unrecognisable
   * reaches a widget.
   */
  const offUiRequest =
    typeof shell.onUiRequest === "function"
      ? shell.onUiRequest((request) => {
          if (request.method !== "setWidget") return;
          if (request.widgetKey !== LoomWidgetKey.GalaxyLive) return;
          let decoded: unknown;
          try {
            decoded = decodeJsonWidget(request.widgetLines as string[] | undefined);
          } catch (err) {
            console.error("[dashboard] galaxy widget payload would not parse:", err);
            return;
          }
          const payload = normalizeGalaxyLivePayload(decoded);
          if (!payload) {
            console.error("[dashboard] galaxy widget payload rejected: unusable shape");
            return;
          }
          sources.setGalaxyLive(payload);
        })
      : null;

  void load();
  void sources.refreshActivity();
  void sources.refreshFiles();

  const poll =
    typeof shell.loadDashboard === "function"
      ? setInterval(() => void checkForExternalChange(), EXTERNAL_CHECK_MS)
      : null;

  return {
    host,
    setNotebook: (markdown, path = null) => sources.setNotebook(markdown, path),
    setSession: (patch) => sources.setSession(patch),
    refreshFromFiles: () => {
      void sources.refreshActivity();
      void sources.refreshFiles();
      // The desktop watcher fires here; the poll above covers the web shell.
      void checkForExternalChange();
    },
    reloadForCwd: () => {
      // A save queued against the previous analysis must not land in the new
      // one: the shell resolves the filename against whatever cwd is current
      // by the time the write happens.
      cancelPendingSave();
      revision = null;
      sources.reset();
      // Back to the default first: the new workspace may have no layout of its
      // own, and `load` returning early must not leave the old one on screen.
      host.setDocument(createDefaultDashboardDocument(), { persist: false });
      void load();
      void sources.refreshActivity();
      void sources.refreshFiles();
    },
    stop: () => {
      cancelPendingSave();
      if (poll) clearInterval(poll);
      offUiRequest?.();
    },
  };
}
