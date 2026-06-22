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

/** Register a callback that fires on every notebook write. Returns unsubscribe. */
export function onNotebookChange(listener: NotebookChangeListener): () => void {
  notebookChangeListeners.push(listener);
  return () => {
    const idx = notebookChangeListeners.indexOf(listener);
    if (idx >= 0) notebookChangeListeners.splice(idx, 1);
  };
}

function notifyNotebookChange(markdown: string): void {
  for (const listener of notebookChangeListeners) {
    listener(markdown);
  }
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

/**
 * Current notebook content, or null when no notebook is loaded or it can't be
 * read. Lets a bridge that captures ctx on session_start replay an already-bound
 * notebook's widgets on resume: the watcher uses `ignoreInitial`, so a resumed
 * (`--continue`) session never re-fires a change for the notebook it inherits.
 */
export function readCurrentNotebook(): string | null {
  const p = state.notebookPath;
  if (!p) return null;
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

export function setNotebookPath(notebookFile: string | null): void {
  state.notebookPath = notebookFile;
  state.notebookLoaded = notebookFile !== null;
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

/**
 * Whether Galaxy is effectively reachable for API calls — either env creds are
 * present (`GALAXY_URL` + `GALAXY_API_KEY`, exactly what the API client resolves
 * in `getGalaxyConfig`) or a `galaxy_connect` tool flipped the in-session flag.
 * Single source of truth shared by the status bar (`context.ts`), the
 * embed-token mint gate (`embed-token-bridge.ts`), and the `/execute`
 * precondition gate (`init-gate.ts`); the raw `state.galaxyConnected` flag alone
 * is false on an env-creds resume until a Galaxy tool runs, which would wrongly
 * report disconnected / suppress the mint / block a `[galaxy]` plan.
 */
export function isGalaxyEffectivelyConnected(): boolean {
  return Boolean(process.env.GALAXY_URL && process.env.GALAXY_API_KEY) || state.galaxyConnected;
}
