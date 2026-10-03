/**
 * Replaying recorded tool results through the observation build path, for the
 * Tier-1 evals.
 *
 * The triggers fire on tool_result, which needs a real tool call, which needs
 * a model turn -- and the Tier-1 scenarios are deliberately model-free, so
 * they need some way to hand the collector a result. This is it, and it is the
 * same shape as submission-replay.ts, with the same two constraints:
 *
 *  - the file must resolve inside the session directory, so the variable alone
 *    cannot point the replay at something elsewhere on the machine;
 *  - every replay writes an `observation.replay` row first, and every row it
 *    produces carries source `observation-replay`, so a replayed observation
 *    is never indistinguishable from one a real failure raised.
 *
 * It calls buildAndRecordObservation, not deliverObservation, so there is no
 * transport in its call graph: this cannot send, rather than being trusted not
 * to. It also uses a fixed install token so a replay never writes a real one
 * into the config.
 *
 * Each line: `{tool, args?, text?, isError?}`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import { readEnv } from "../../shared/orbit-env.js";
import { normalizeSignature } from "../../shared/observation-contract.js";
import { appendActivityEvent } from "./activity.js";
import { getNotebookPath } from "./state.js";
import { resolveObservationsMode } from "./observations-config.js";
import { shapeForMode } from "./observations.js";
import {
  buildAndRecordObservation,
  decideToolResultObservation,
  factsForToolResult,
  newTriggerState,
  recordObservationActivity,
} from "./observation-triggers.js";

/** Valid-shaped and obviously synthetic, so a replayed row can't look real. */
export const DRY_RUN_INSTALL_TOKEN = "0".repeat(32);

const REPLAY_SOURCE = "observation-replay";

export interface ObservationReplayEntry {
  tool: string;
  args?: Record<string, unknown>;
  text?: string;
  isError?: boolean;
}

export function isObservationReplayEnabled(): boolean {
  return !!readEnv("OBSERVATION_REPLAY")?.trim();
}

export function parseObservationReplayFile(raw: string): ObservationReplayEntry[] {
  const out: ObservationReplayEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as ObservationReplayEntry;
      if (entry && typeof entry.tool === "string") out.push(entry);
    } catch {
      // Skip, same as the activity log's own hydrate.
    }
  }
  return out;
}

/**
 * Both sides are realpath'd before comparing, so the check is about where the
 * file actually is rather than how it is spelled -- a lexical prefix test alone
 * accepts a name inside the session dir that is a symlink to somewhere else.
 */
export function resolveObservationReplayPath(
  sessionDir: string,
  configured: string,
): string | null {
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

export function registerObservationReplay(pi: ExtensionAPI): void {
  pi.on("session_start", async () => {
    const configured = readEnv("OBSERVATION_REPLAY")?.trim();
    if (!configured) return;
    // A hard-disabled install builds nothing, replay or not.
    if (resolveObservationsMode() === "off") return;

    const notebookPath = getNotebookPath();
    if (!notebookPath) return;
    const sessionDir = path.dirname(notebookPath);

    const file = resolveObservationReplayPath(sessionDir, configured);
    if (!file || !fs.existsSync(file)) return;

    const entries = parseObservationReplayFile(fs.readFileSync(file, "utf-8"));

    appendActivityEvent(sessionDir, {
      timestamp: new Date().toISOString(),
      kind: "observation.replay",
      source: REPLAY_SOURCE,
      payload: { file: path.relative(sessionDir, file), entries: entries.length },
    });

    // Built in the shape the configured mode would send, so the replay pins
    // what would actually leave the machine.
    const mode = resolveObservationsMode();
    const shape = shapeForMode(mode === "auto" ? "auto" : "ask");
    const state = newTriggerState();
    const deps = {
      installToken: () => DRY_RUN_INSTALL_TOKEN,
      record: (kind: string, payload: Record<string, unknown>) =>
        recordObservationActivity(kind, payload, REPLAY_SOURCE),
    };

    for (const entry of entries) {
      if (entry.isError === false) continue;
      const facts = factsForToolResult(entry.tool, entry.args ?? {}, entry.text ?? "");
      if (!facts) continue;
      const decision = decideToolResultObservation(state, {
        mcpTool: facts.mcpTool ?? "",
        toolIds: facts.toolIds,
        signature: normalizeSignature(facts.rawSignature),
      });
      if (!decision) continue;
      // Empty description on purpose: a dry run must not make a model call.
      buildAndRecordObservation(
        { ...facts, kind: decision.kind, trigger: decision.trigger },
        "",
        deps,
        shape,
      );
    }
  });
}
