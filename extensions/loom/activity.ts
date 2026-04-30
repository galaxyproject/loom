/**
 * Activity log — append-only JSONL record of plan/session events.
 *
 * Written alongside the session's notebook.md (same dir). Every entry is a
 * generic envelope {timestamp, kind, source, payload} so new event kinds can
 * be added without a schema migration. Consumers (activity tab, /summarize)
 * read back by streaming the file.
 *
 * The module also holds an in-memory mirror of the current session's events
 * so the UI bridge can stream them to the shell without re-parsing JSONL on
 * every mutation.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import * as path from "path";

export interface ActivityEvent {
  timestamp: string;
  kind: string;
  source: string;
  payload: Record<string, unknown>;
}

let currentEvents: ActivityEvent[] = [];

type ActivityChangeListener = (events: ActivityEvent[]) => void;
const changeListeners: ActivityChangeListener[] = [];

/** Subscribe to activity updates; returns an unsubscribe function. */
export function onActivityChange(listener: ActivityChangeListener): () => void {
  changeListeners.push(listener);
  return () => {
    const idx = changeListeners.indexOf(listener);
    if (idx >= 0) changeListeners.splice(idx, 1);
  };
}

function notifyActivityChange(): void {
  for (const listener of changeListeners) {
    listener(currentEvents);
  }
}

/** Return a snapshot of the current in-memory event list. */
export function getActivityEvents(): ActivityEvent[] {
  return currentEvents;
}

/** Return the last `n` events (most recent last). Used for context injection. */
export function getRecentActivityEvents(n: number): ActivityEvent[] {
  if (n <= 0) return [];
  return currentEvents.slice(-n);
}

/** Clear the in-memory event list (session boundary / reset). */
export function resetActivity(): void {
  currentEvents = [];
  notifyActivityChange();
}

/**
 * Hydrate the in-memory event list from an existing activity.jsonl on disk.
 * Called on session_start / notebook-path change so the Activity pane shows
 * historical events from previous runs.
 */
export function loadActivityLog(sessionDir: string): void {
  const filePath = path.join(sessionDir, "activity.jsonl");
  currentEvents = [];
  if (!existsSync(filePath)) {
    notifyActivityChange();
    return;
  }
  try {
    const raw = readFileSync(filePath, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as ActivityEvent;
        currentEvents.push(event);
      } catch {
        // Skip malformed lines rather than abort the whole session.
      }
    }
  } catch (err) {
    console.error("activity hydrate failed:", err);
  }
  notifyActivityChange();
}

/**
 * Append an event to <sessionDir>/activity.jsonl. Creates the directory if
 * missing. Returns the absolute path of the file that was written, or null
 * on failure. Also updates the in-memory mirror and notifies listeners so
 * the UI can refresh incrementally.
 */
export function appendActivityEvent(sessionDir: string, event: ActivityEvent): string | null {
  const filePath = path.join(sessionDir, "activity.jsonl");
  try {
    mkdirSync(sessionDir, { recursive: true });
    appendFileSync(filePath, JSON.stringify(event) + "\n", "utf-8");
    currentEvents.push(event);
    notifyActivityChange();
    return filePath;
  } catch (err) {
    console.error("activity append failed:", err);
    return null;
  }
}
