/**
 * Replaying recorded submission results, for the Tier-1 evals.
 *
 * The capture hook fires on `tool_execution_end`, which needs a real tool
 * call, which needs a model turn. The Tier-1 scenarios are deliberately
 * model-free -- they exist to pin deterministic harness behavior without an
 * API key or a flaky model in the loop -- so they need some way to hand the
 * hook a result. This is it: `LOOM_SUBMISSION_REPLAY` names a JSONL file of
 * recorded results, relative to the session directory, and each line is fed
 * through the same start/end path a real submission takes.
 *
 * Off unless the env var is set, and nothing registers it otherwise -- the
 * same shape as LOOM_TEAM_DISPATCH and LOOM_SESSION_INDEX. Two deliberate
 * constraints, because this writes blocks that claim `submitted_by: harness`
 * and `server_verified: true`:
 *
 * - the file must resolve inside the session directory, so the variable alone
 *   cannot point the replay at something elsewhere on the machine;
 * - every replay writes a `submission.replay` row first, so a notebook
 *   produced this way is never silently indistinguishable from one produced
 *   by real submissions. If you are auditing a record and the activity log
 *   has that row in it, the provenance in that notebook was replayed.
 *
 * Each line: `{tool, args?, result, isError?, stepAnchor?}`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import { appendActivityEvent } from "./activity";
import { handleSubmissionResult } from "./galaxy-submission-capture";
import { getNotebookPath, setCurrentStepAnchor } from "./state";

export interface ReplayEntry {
  tool: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  /** Sets `state.currentStepAnchor` before this entry's dispatch. */
  stepAnchor?: string | null;
}

export function isSubmissionReplayEnabled(): boolean {
  return !!process.env.LOOM_SUBMISSION_REPLAY?.trim();
}

/** Parse a replay file, skipping blank and malformed lines. */
export function parseReplayFile(raw: string): ReplayEntry[] {
  const out: ReplayEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as ReplayEntry;
      if (entry && typeof entry.tool === "string") out.push(entry);
    } catch {
      // Skip, same as the activity log's own hydrate.
    }
  }
  return out;
}

/**
 * Resolve the replay file inside `sessionDir`, or null if it escapes.
 * Exported for the test that pins the containment.
 *
 * Both sides are realpath'd before comparing, so the check is about where the
 * file actually is rather than how it is spelled: a lexical prefix test alone
 * accepts `<session>/replay.jsonl` when that name is a symlink pointing
 * somewhere else entirely. The session directory is realpath'd too, since on
 * macOS a temp dir is reached through a `/var` -> `/private/var` symlink and
 * comparing a resolved file against an unresolved root would reject every
 * legitimate path.
 */
export function resolveReplayPath(sessionDir: string, configured: string): string | null {
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const root = real(sessionDir);
  const resolved = real(path.resolve(sessionDir, configured));
  return resolved.startsWith(root + path.sep) ? resolved : null;
}

export function registerSubmissionReplay(pi: ExtensionAPI): void {
  pi.on("session_start", async () => {
    const configured = process.env.LOOM_SUBMISSION_REPLAY?.trim();
    if (!configured) return;

    const notebookPath = getNotebookPath();
    if (!notebookPath) return;
    const sessionDir = path.dirname(notebookPath);

    const file = resolveReplayPath(sessionDir, configured);
    if (!file || !fs.existsSync(file)) return;

    const entries = parseReplayFile(fs.readFileSync(file, "utf-8"));

    appendActivityEvent(sessionDir, {
      timestamp: new Date().toISOString(),
      kind: "submission.replay",
      source: "submission-replay",
      payload: { file: path.relative(sessionDir, file), entries: entries.length },
    });

    for (const [index, entry] of entries.entries()) {
      // Set it for every entry, not just the ones that name one: leaving the
      // previous entry's anchor in place made an entry with no `stepAnchor`
      // inherit its predecessor's step instead of being unattributed.
      setCurrentStepAnchor(entry.stepAnchor ?? null);
      await handleSubmissionResult(
        `replay-${index}`,
        entry.tool,
        entry.result,
        entry.isError === true,
        // Replay has no start event, so hand the dispatch details straight in
        // rather than letting the hook fall back to "unattributed". `replayed`
        // is what keeps the blocks from claiming a submission Loom watched and
        // a server that answered, neither of which happened here.
        { args: entry.args ?? {}, stepAnchor: entry.stepAnchor ?? null, replayed: true },
      );
    }

    setCurrentStepAnchor(null);
  });
}
