/**
 * Session state — connection, notebook path, file watcher, listeners.
 *
 * The notebook (notebook.md in the session cwd) is the durable record. State
 * here is just enough to wire the file watcher, track Galaxy connection, and
 * route notebook changes to UI listeners.
 */

import type { AnalystState } from "./types";
import { getDefaultNotebookPath } from "./notebook-writer";
import { commitFile, ensureGitRepo } from "./git";
import { appendActivityEvent, loadActivityLog, resetActivity } from "./activity";
import * as fs from "fs";
import * as path from "path";
import chokidar, { type FSWatcher } from "chokidar";

// ─────────────────────────────────────────────────────────────────────────────
// Module state
// ─────────────────────────────────────────────────────────────────────────────

let state: AnalystState = {
  galaxyConnected: false,
  currentHistoryId: null,
  notebookPath: null,
  notebookLoaded: false,
};

export function getState(): AnalystState {
  return state;
}

// Notebook widget visibility mode:
//   "auto"   - not shown yet; auto-shows on the next notebook change (default)
//   "open"   - currently shown; stays in sync as the notebook changes
//   "hidden" - user closed it via /notebook; stays closed (no auto-reopen)
//              until they reopen it
type NotebookWidgetMode = "auto" | "open" | "hidden";
let notebookWidgetMode: NotebookWidgetMode = "auto";

export function getNotebookWidgetMode(): NotebookWidgetMode {
  return notebookWidgetMode;
}

export function setNotebookWidgetMode(mode: NotebookWidgetMode): void {
  notebookWidgetMode = mode;
}

export function resetState(): void {
  stopWatchingNotebook();
  notebookWidgetMode = "auto";
  lastEmittedNotebookContent = null;
  lastInspectedFingerprint = null;
  state = {
    galaxyConnected: false,
    currentHistoryId: null,
    notebookPath: null,
    notebookLoaded: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Notebook change listeners
// ─────────────────────────────────────────────────────────────────────────────

type NotebookChangeListener = (markdown: string) => void;
const notebookChangeListeners: NotebookChangeListener[] = [];

// Content last handed to listeners, plus a cheap stat fingerprint of the file
// state we last inspected. Both feed reemitNotebookIfChanged() so a re-sync
// trigger only emits when notebook.md actually changed.
let lastEmittedNotebookContent: string | null = null;
let lastInspectedFingerprint: string | null = null;

/** Register a callback that fires on every notebook write. Returns unsubscribe. */
export function onNotebookChange(listener: NotebookChangeListener): () => void {
  notebookChangeListeners.push(listener);
  return () => {
    const idx = notebookChangeListeners.indexOf(listener);
    if (idx >= 0) notebookChangeListeners.splice(idx, 1);
  };
}

function notifyNotebookChange(markdown: string): void {
  lastEmittedNotebookContent = markdown;
  for (const listener of notebookChangeListeners) {
    try {
      listener(markdown);
    } catch (err) {
      // Isolate subscribers: one throwing listener must not starve the others
      // or break the caller (e.g. the tool_execution_end hook, which is no
      // longer wrapped the way the watcher path is). #253
      console.error("notebook change listener failed:", err);
    }
  }
}

/**
 * Re-read notebook.md and emit a change if its content differs from what was
 * last emitted; returns whether it emitted.
 *
 * The chokidar watcher tracks a single file path and can miss a bash write
 * that replaces the inode (an atomic temp-and-rename save, e.g. `sed -i` or an
 * editor) or one that races its awaitWriteFinish window, leaving the Notebook
 * panel stale until the next `/notebook`. The tool_execution_end hook calls
 * this after every tool so the panel re-syncs. A cheap stat fingerprint skips
 * the read when the file is untouched, and a content compare suppresses emits
 * when nothing actually changed, so calling this on every tool end is not
 * churn. #253
 */
export function reemitNotebookIfChanged(): boolean {
  const filePath = state.notebookPath;
  if (!filePath) return false;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    // Missing/unreadable right now (e.g. mid-rename); the watcher and the next
    // real write recover. Don't advance the fingerprint so the follow-up is seen.
    return false;
  }

  // Include dev/ino and ctimeMs, not just mtime+size: an atomic temp-and-rename
  // save swaps the inode (changing ino), and ctime moves on any write -- so an
  // inode-replacing or same-size rewrite with a preserved/coarse mtime is still
  // seen as changed, which is the whole point of #253.
  const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  if (fingerprint === lastInspectedFingerprint) return false;

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return false;
  }
  lastInspectedFingerprint = fingerprint;

  // mtime/size moved but the bytes are identical (e.g. a rewrite) -> no churn.
  if (content === lastEmittedNotebookContent) return false;

  notifyNotebookChange(content);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// File watcher — refresh UI + auto-commit on every notebook write
// ─────────────────────────────────────────────────────────────────────────────

let currentWatcher: FSWatcher | null = null;
let watcherPath: string | null = null;
let watcherAutoCommit = false;

function startWatchingNotebook(filePath: string, autoCommit = false): void {
  stopWatchingNotebook();
  if (!fs.existsSync(filePath)) return;
  try {
    watcherPath = filePath;
    watcherAutoCommit = autoCommit;
    currentWatcher = chokidar.watch(filePath, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });
    currentWatcher.on("change", () => {
      if (watcherPath && fs.existsSync(watcherPath)) {
        try {
          const content = fs.readFileSync(watcherPath, "utf-8");
          notifyNotebookChange(content);
          if (watcherAutoCommit) {
            commitFile(watcherPath, "Notebook updated");
          }
        } catch (err) {
          console.error("notebook watcher read failed:", err);
        }
      }
    });
  } catch (err) {
    console.error("failed to start notebook watcher:", err);
  }
}

export function stopWatchingNotebook(): void {
  if (currentWatcher) {
    try {
      currentWatcher.close();
    } catch {
      /* ignore */
    }
    currentWatcher = null;
  }
  watcherPath = null;
  watcherAutoCommit = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Notebook path
// ─────────────────────────────────────────────────────────────────────────────

export function getNotebookPath(): string | null {
  return state.notebookPath;
}

export function setNotebookPath(notebookFile: string | null): void {
  state.notebookPath = notebookFile;
  state.notebookLoaded = notebookFile !== null;
  // Switching notebooks must not inherit the prior file's emit baselines, or a
  // new notebook that shares the old one's content/fingerprint would be wrongly
  // suppressed and leave the panel stale. #253
  lastEmittedNotebookContent = null;
  lastInspectedFingerprint = null;
  if (notebookFile) {
    startWatchingNotebook(notebookFile, false);
    loadActivityLog(path.dirname(notebookFile));
  } else {
    stopWatchingNotebook();
    resetActivity();
  }
}

export function isNotebookLoaded(): boolean {
  return state.notebookLoaded;
}

export function getDefaultPath(_title: string, directory: string): string {
  return getDefaultNotebookPath(_title, directory);
}

/**
 * Ensure every session has a notebook.md in cwd. Creates an empty file if
 * missing, attaches the watcher, hydrates the activity log, and emits the
 * first notebook-change notification so the Notebook pane paints immediately.
 * Idempotent; safe to call every session_start.
 */
export function initSessionArtifacts(cwd: string): void {
  const notebookPath = path.join(cwd, "notebook.md");
  const sessionDir = cwd;
  // Fresh session: Pi has cleared extension widgets, so reset the mode too.
  notebookWidgetMode = "auto";
  // New session may point at a different notebook.md; force the next re-sync
  // check to re-inspect rather than trust a stale fingerprint. #253
  lastInspectedFingerprint = null;

  try {
    const autoCommit = ensureGitRepo(cwd);

    if (!fs.existsSync(notebookPath)) {
      fs.writeFileSync(notebookPath, "", "utf-8");
      if (autoCommit) {
        commitFile(notebookPath, "Initialize notebook");
      }
    }

    state.notebookPath = notebookPath;
    state.notebookLoaded = true;
    startWatchingNotebook(notebookPath, autoCommit);
    loadActivityLog(sessionDir);

    const content = fs.readFileSync(notebookPath, "utf-8");
    notifyNotebookChange(content);

    appendActivityEvent(sessionDir, {
      timestamp: new Date().toISOString(),
      kind: "session.started",
      source: "session_bootstrap",
      payload: { cwd },
    });
  } catch (err) {
    console.error("initSessionArtifacts failed:", err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Galaxy connection state
// ─────────────────────────────────────────────────────────────────────────────

export function setGalaxyConnection(
  connected: boolean,
  historyId?: string,
  _serverUrl?: string,
): void {
  state.galaxyConnected = connected;
  if (historyId) {
    state.currentHistoryId = historyId;
  }
}

export function getCurrentHistoryId(): string | null {
  return state.currentHistoryId;
}

export function isGalaxyConnected(): boolean {
  return state.galaxyConnected;
}
