/**
 * Session state — connection, notebook path, file watcher, listeners.
 *
 * The notebook (notebook.md in the session cwd, or the record store a shell
 * installed) is the durable record. State here is just enough to wire the
 * record watcher, track Galaxy connection, and route notebook changes to UI
 * listeners.
 */

import type { AnalystState } from "./types";
import { getDefaultNotebookPath } from "./notebook-writer";
import { commitFile, ensureGitRepo } from "./git";
import { appendActivityEvent, loadActivityLog, resetActivity } from "./activity";
import { installedRecordStore, recordStore } from "./record-store";
import * as path from "path";

// ─────────────────────────────────────────────────────────────────────────────
// Module state
// ─────────────────────────────────────────────────────────────────────────────

let state: AnalystState = {
  galaxyConnected: false,
  currentHistoryId: null,
  notebookPath: null,
  notebookLoaded: false,
  currentStepAnchor: null,
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
    currentStepAnchor: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Notebook change listeners
// ─────────────────────────────────────────────────────────────────────────────

type NotebookChangeListener = (markdown: string) => void;
const notebookChangeListeners: NotebookChangeListener[] = [];

// Content last handed to listeners, plus the record version we last
// inspected. Both feed reemitNotebookIfChanged() so a re-sync
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
 * Re-read the record and emit a change if its content differs from what was
 * last emitted; returns whether it emitted.
 *
 * The chokidar watcher tracks a single file path and can miss a bash write
 * that replaces the inode (an atomic temp-and-rename save, e.g. `sed -i` or an
 * editor) or one that races its awaitWriteFinish window, leaving the Notebook
 * panel stale until the next `/notebook`; under the page backend it is the only
 * way an out-of-band page edit is seen at all. The tool_execution_end hook calls
 * this after every tool so the panel re-syncs. The store's cheap version check
 * skips the read when the record is untouched, and a content compare suppresses
 * emits when nothing actually changed, so calling this on every tool end is not
 * churn. #253
 */
export async function reemitNotebookIfChanged(): Promise<boolean> {
  const key = state.notebookPath;
  if (!key) return false;
  const store = recordStore(key);

  const version = await store.stat();
  // Missing/unreadable right now (e.g. mid-rename): the watcher and the next
  // real write recover. Don't advance the fingerprint so the follow-up is seen.
  if (!version || version === lastInspectedFingerprint) return false;

  let content: string;
  try {
    ({ content } = await store.read());
  } catch {
    return false;
  }
  lastInspectedFingerprint = version;

  // mtime/size moved but the bytes are identical (e.g. a rewrite) -> no churn.
  if (content === lastEmittedNotebookContent) return false;

  notifyNotebookChange(content);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Record watcher -- refresh UI + auto-commit on every notebook write
// ─────────────────────────────────────────────────────────────────────────────

let unsubscribeWatch: (() => void) | null = null;

function startWatchingNotebook(key: string, autoCommit = false): void {
  stopWatchingNotebook();
  const store = recordStore(key);
  unsubscribeWatch = store.onChange((content) => {
    notifyNotebookChange(content);
    if (autoCommit && store.kind === "file") commitFile(key, "Notebook updated");
  });
}

export function stopWatchingNotebook(): void {
  unsubscribeWatch?.();
  unsubscribeWatch = null;
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
 * Ensure every session has a record. On the desktop that is notebook.md in
 * cwd, created empty if missing; under a shell that installed a record store
 * it is whatever the shell bound. Attaches the watcher, hydrates the activity
 * log, and emits the first notebook-change notification so the Notebook pane
 * paints immediately. Idempotent; safe to call every session_start.
 */
export async function initSessionArtifacts(cwd: string): Promise<void> {
  const notebookPath = installedRecordStore()?.key ?? path.join(cwd, "notebook.md");
  const sessionDir = cwd;
  // Fresh session: Pi has cleared extension widgets, so reset the mode too.
  notebookWidgetMode = "auto";
  // New session may point at a different notebook.md; force the next re-sync
  // check to re-inspect rather than trust a stale fingerprint. #253
  lastInspectedFingerprint = null;

  try {
    const store = recordStore(notebookPath);
    // Auto-commit needs a working tree; a page has none.
    const autoCommit = store.kind === "file" ? ensureGitRepo(cwd) : false;

    if ((await store.ensure()) && autoCommit) {
      commitFile(notebookPath, "Initialize notebook");
    }

    state.notebookPath = notebookPath;
    state.notebookLoaded = true;
    startWatchingNotebook(notebookPath, autoCommit);
    loadActivityLog(sessionDir);

    notifyNotebookChange((await store.read()).content);

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

// ─────────────────────────────────────────────────────────────────────────────
// Current plan step
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Point subsequent Galaxy submissions at a plan step, or clear the pointer.
 *
 * Set by /execute from the plan it parsed; cleared when the agent run that
 * /execute started settles. It is deliberately in-memory and deliberately
 * coarse: it says which step the agent was *asked* to work on, not which step
 * a given submission belongs to. The submission hook reads it once, at
 * dispatch, and carries the value forward with the attempt -- reading it again
 * when the result lands would attribute a slow submission to whatever step was
 * current by then.
 */
export function setCurrentStepAnchor(anchor: string | null): void {
  state.currentStepAnchor = anchor && anchor.trim().length > 0 ? anchor.trim() : null;
}

export function getCurrentStepAnchor(): string | null {
  return state.currentStepAnchor;
}

export function isGalaxyConnected(): boolean {
  return state.galaxyConnected;
}
