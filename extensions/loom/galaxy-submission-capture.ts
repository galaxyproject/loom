/**
 * Auto-registration: every Galaxy submission gets a notebook block, the
 * moment it happens, without the agent being asked to do anything.
 *
 * Recording used to be model-initiated -- prose in the system prompt asking
 * for `galaxy_invocation_record` after a submission, and a record tool that
 * verified nothing about the id it was handed. A turn that died between the
 * submit and the record left a running job nobody was tracking, and a
 * distracted model left the same. This hook closes that by reading the id out
 * of Galaxy's own response to the submission, which is also what makes
 * `server_verified: true` mean anything.
 *
 * Two placement facts. It is registered in the mode-independent part of
 * index.ts rather than inside the exec-guard, because the guard is skipped
 * when `LOOM_LOCAL_EXEC=off` (the web/container shell) and capture has to
 * work there too. And it hangs off `tool_execution_start` as well as
 * `tool_execution_end`, because pi's end event carries only `{toolCallId,
 * toolName, result, isError}` -- the tool's *arguments* are on the start
 * event, and `run_user_tool`'s uuid and the uploads' file names exist nowhere
 * else.
 *
 * Attribution is captured at dispatch, not at result. The attempt id is
 * minted when the tool starts and the step anchor is read then too, so a
 * submission that takes thirty seconds to answer is attributed to the step
 * that made it rather than to whatever the agent moved on to. That is the
 * whole reason for the in-flight map.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { stringify as stringifyYaml } from "yaml";
import { appendActivityEvent } from "./activity";
import { getGalaxyConfig } from "./galaxy-api";
import { galaxyCall } from "./mcp-recovery";
import {
  isTerminalJobState,
  jobStatusFromGalaxyState,
  locateJobBlock,
  upsertJobBlock,
  type JobYaml,
} from "./galaxy-job-block";
import { hasUdtBlock, upsertUdtBlock } from "./galaxy-udt-block";
import {
  isSubmissionTool,
  parseGalaxyResultEnvelope,
  parseSubmission,
  resolveResultPayload,
  type ParsedSubmission,
  type ResolvedResult,
} from "./galaxy-submission";
import type { HarnessBlockFields } from "./harness-block-fields";
import {
  NotebookChangedError,
  locateInvocationBlock,
  readNotebook,
  statNotebook,
  upsertInvocationBlock,
  withNotebookLock,
  writeNotebook,
  type InvocationYaml,
} from "./notebook-writer";
import { getCurrentStepAnchor, getNotebookPath, setCurrentStepAnchor } from "./state";
import { ulid } from "./ulid";

/** What a block carries when nothing pointed the submission at a plan step. */
export const UNATTRIBUTED = "unattributed";

/** Where per-attempt provenance lives, relative to the analysis directory. */
export const PROVENANCE_DIR = path.join(".loom", "provenance");
export const UDT_PROVENANCE_DIR = path.join(PROVENANCE_DIR, "udt");

/**
 * What the winning write attempt did. The activity row is built from this
 * rather than from the parsed submission, so a replay that declined to
 * overwrite an id cannot be announced as having recorded it.
 */
interface WriteOutcome {
  udtDefinition?: string;
  udtPending: boolean;
  /** Ids a replay left alone because a block already carried them. */
  replayCollisions: string[];
  wroteInvocation?: string;
  wroteJobs: string[];
  wroteUdt?: string;
}

interface Dispatch {
  attemptId: string;
  toolName: string;
  args: Record<string, unknown>;
  stepAnchor: string;
  submittedAt: string;
  replayed: boolean;
}

/**
 * In-flight submissions, keyed by pi's tool call id.
 *
 * Bounded because a start without a matching end is possible -- an aborted
 * turn, a tool that never returns -- and an unbounded map in a long session
 * is a slow leak. The cap is far above any real concurrent tool count. When
 * it is hit the oldest entry goes, and that submission loses its whole
 * dispatch record: its result is still registered, but with a fresh attempt
 * id, no arguments, and `unattributed`. It never gets someone else's.
 */
const MAX_IN_FLIGHT = 256;
const inFlight = new Map<string, Dispatch>();

/** Test seam: drop in-flight state between cases. */
export function resetSubmissionCapture(): void {
  inFlight.clear();
}

function rememberDispatch(toolCallId: string, toolName: string, args: unknown): Dispatch {
  const dispatch: Dispatch = {
    attemptId: ulid(),
    toolName,
    args: (args && typeof args === "object" ? args : {}) as Record<string, unknown>,
    stepAnchor: getCurrentStepAnchor() ?? UNATTRIBUTED,
    submittedAt: new Date().toISOString(),
    // A real tool call, watched from start to end.
    replayed: false,
  };
  if (inFlight.size >= MAX_IN_FLIGHT) {
    const oldest = inFlight.keys().next();
    if (!oldest.done) inFlight.delete(oldest.value);
  }
  inFlight.set(toolCallId, dispatch);
  return dispatch;
}

/** Supplied by a caller that knows the dispatch details but had no start event. */
export interface DispatchOverride {
  args?: Record<string, unknown>;
  stepAnchor?: string | null;
  /**
   * This submission was read out of a fixture, not out of Galaxy. The blocks
   * it produces make no provenance claim: see `harnessFields`.
   */
  replayed?: boolean;
}

/**
 * Recover the dispatch record, or synthesise one.
 *
 * With no in-flight record and no override we never saw the dispatch, so we do
 * NOT fall back to the current step anchor: that is exactly the misattribution
 * the capture-at-dispatch design exists to avoid. Unattributed is the honest
 * answer. An override is itself a dispatch record -- the replay seam passes
 * one because it has no start event to pair with -- so it may name the step.
 */
function takeDispatch(toolCallId: string, toolName: string, override?: DispatchOverride): Dispatch {
  const found = inFlight.get(toolCallId);
  if (found) {
    inFlight.delete(toolCallId);
    return found;
  }
  return {
    attemptId: ulid(),
    toolName,
    args: override?.args ?? {},
    stepAnchor: override
      ? (override.stepAnchor ?? getCurrentStepAnchor() ?? UNATTRIBUTED)
      : UNATTRIBUTED,
    submittedAt: new Date().toISOString(),
    replayed: override?.replayed === true,
  };
}

function sessionDir(): string | null {
  const nb = getNotebookPath();
  return nb ? path.dirname(nb) : null;
}

function record(kind: string, payload: Record<string, unknown>): void {
  const dir = sessionDir();
  if (!dir) return;
  appendActivityEvent(dir, {
    timestamp: new Date().toISOString(),
    kind,
    source: "submission-capture",
    payload,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Filenames
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Make a Galaxy-supplied tool id safe to use as a filename.
 *
 * The id reaches us from Galaxy, but Galaxy derived it from the agent's own
 * tool definition, so it is agent-influenced and a path separator or a `..`
 * in it would write outside `.loom/provenance/udt/`. Everything outside a
 * conservative allowlist becomes an underscore, leading dots go, and the
 * result is capped; an id that sanitises away to nothing is rejected by the
 * caller rather than written to some default name.
 */
export function safeProvenanceFilename(toolId: string): string | null {
  const cleaned = toolId
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  if (!cleaned || /^_+$/.test(cleaned)) return null;
  return cleaned;
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing the record
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The provenance the upsert functions will not take from a caller's block
 * object. `server_verified` is deliberately not one of them: it is the record
 * tools' own tri-state field, so the hook sets it on the block like they do --
 * with `true`, which it has earned, having read the id out of Galaxy's answer
 * to this very submission.
 *
 * A replayed submission claims neither. `submitted_by: harness` means Loom
 * watched the submission happen and `server_verified: true` means it read the
 * id out of the server's own answer, and under `LOOM_SUBMISSION_REPLAY` both
 * came out of a file on disk -- no tool ran and no server was asked. The
 * `submission.replay` activity row says so, but that row lives in a sidecar
 * the analysis repo gitignores, and the notebook is the durable record: a
 * block written from a fixture must not read like one written from a run. The
 * rest still rides along, because `attempt_id` and `enrichment` are facts
 * about the record rather than claims about a server.
 */
function harnessFields(dispatch: Dispatch, historyId?: string): HarnessBlockFields {
  return {
    attemptId: dispatch.attemptId,
    ...(historyId ? { historyId } : {}),
    ...(dispatch.replayed ? {} : { submittedBy: "harness" as const }),
    enrichment: "pending",
    enrichmentAttempts: 0,
  };
}

/**
 * Write every block this submission produces in one locked read-modify-write.
 *
 * One lock for the whole set, not one per job: a mapped-over run produces a
 * block per job, and N separate read-modify-write cycles against the same
 * file is N chances to lose one to a concurrent writer.
 */
async function writeBlocks(
  notebookPath: string,
  submission: ParsedSubmission,
  dispatch: Dispatch,
): Promise<WriteOutcome> {
  const udtPending = submission.kind === "udt" && !!submission.udt;
  const galaxyServerUrl = getGalaxyConfig()?.url ?? "";
  const harness = harnessFields(dispatch, submission.historyId);
  let udtDefinition: string | undefined;
  // What the last (and therefore the winning) `applyBlocks` attempt actually
  // did. Rebuilt on every attempt, because the CAS may run it more than once
  // against fresh content, and only the attempt that lands is true.
  let replayCollisions: string[] = [];
  let wroteInvocation: string | undefined;
  let wroteJobs: string[] = [];
  let wroteUdt: string | undefined;

  /**
   * A replay must not write over a block that is already there.
   *
   * Replay rebuilds a notebook from fixtures, and a block already carrying
   * that id was written by something that actually happened -- overwriting it
   * would put a fixture's label, anchor and timestamp on a real run, and the
   * carry-forward would hand the replay the real block's `submitted_by:
   * harness` on the way through, which is exactly the claim a replayed block
   * is not allowed to make. Skipping is the only answer that leaves both
   * records honest.
   */
  const replayWouldOverwrite = (
    content: string,
    id: string,
    kind: "invocation" | "job" | "udt",
  ): boolean => {
    if (!dispatch.replayed) return false;
    const present =
      kind === "invocation"
        ? locateInvocationBlock(content, id).present
        : kind === "job"
          ? locateJobBlock(content, id).present
          : hasUdtBlock(content, id);
    if (present) replayCollisions.push(id);
    return present;
  };

  /** Apply this submission's blocks to whatever the notebook currently says. */
  const applyBlocks = (content: string): string => {
    let next = content;
    replayCollisions = [];
    wroteInvocation = undefined;
    wroteJobs = [];
    wroteUdt = undefined;

    if (submission.kind === "invocation" && submission.invocationId) {
      const inv: InvocationYaml = {
        invocationId: submission.invocationId,
        galaxyServerUrl,
        notebookAnchor: dispatch.stepAnchor,
        label: submission.label,
        submittedAt: dispatch.submittedAt,
        status: "in_progress",
        ...(dispatch.replayed ? {} : { serverVerified: true }),
      };
      if (!replayWouldOverwrite(next, submission.invocationId, "invocation")) {
        next = upsertInvocationBlock(next, inv, harness);
        wroteInvocation = submission.invocationId;
      }
    }

    for (const job of submission.jobs ?? []) {
      if (replayWouldOverwrite(next, job.jobId, "job")) continue;
      const block: JobYaml = {
        jobId: job.jobId,
        galaxyServerUrl,
        notebookAnchor: dispatch.stepAnchor,
        label: submission.label,
        ...(job.toolId ? { toolId: job.toolId } : {}),
        submittedAt: dispatch.submittedAt,
        // A job that was already terminal when the call returned must not be
        // written as in_progress: the poller would "discover" it finished on
        // its next tick and wake the agent to verify work it already saw.
        ...(isTerminalJobState(job.state)
          ? { status: jobStatusFromGalaxyState(job.state), galaxyState: job.state }
          : { status: "in_progress" as const }),
        ...(dispatch.replayed ? {} : { serverVerified: true }),
      };
      // tool_version is only ever in the submission response -- GET
      // /api/jobs/{id} drops it -- so seed the job summary with it now rather
      // than hoping enrichment can find it later.
      wroteJobs.push(job.jobId);
      next = upsertJobBlock(next, block, {
        ...harness,
        ...(job.historyId && !submission.historyId ? { historyId: job.historyId } : {}),
        jobs: [
          {
            jobId: job.jobId,
            ...(job.toolId ? { toolId: job.toolId } : {}),
            ...(job.toolVersion ? { toolVersion: job.toolVersion } : {}),
          },
        ],
      });
    }

    if (
      submission.udt &&
      udtDefinition &&
      !replayWouldOverwrite(next, submission.udt.uuid, "udt")
    ) {
      wroteUdt = submission.udt.uuid;
      next = upsertUdtBlock(next, {
        toolId: submission.udt.toolId,
        toolUuid: submission.udt.uuid,
        definition: udtDefinition,
        createdAt: dispatch.submittedAt,
        notebookAnchor: dispatch.stepAnchor,
        attemptId: dispatch.attemptId,
      });
    }

    return next;
  };

  // The definition file is written once, outside the retry: it is keyed by
  // uuid and created exclusively, so re-running applyBlocks must not re-write
  // it.
  if (submission.kind === "udt" && submission.udt) {
    udtDefinition =
      (await writeUdtDefinition(
        path.dirname(notebookPath),
        submission.udt.toolId,
        submission.udt.uuid,
        submission.udt.representation,
      )) ?? undefined;
  }

  await withNotebookLock(notebookPath, async () => {
    // Compare-and-swap, retried, rather than a blind write. The lock only
    // serialises writers inside THIS process; the agent's own edit/write
    // tools, a user's editor, and a second Loom process on the same notebook
    // are all outside it, and a submission lands at an arbitrary moment
    // relative to them. Without the stamp, capture renames content it read
    // before someone else's edit straight over that edit (#391).
    for (let attempt = 0; ; attempt++) {
      const stamp = await statNotebook(notebookPath);
      const content = await readNotebook(notebookPath);
      try {
        await writeNotebook(notebookPath, applyBlocks(content), stamp ?? undefined);
        return;
      } catch (err) {
        // Rebuild on the current bytes and try again. After a few collisions
        // give up and let the caller record the submission as unrecorded
        // rather than claim a block that never landed.
        if (!(err instanceof NotebookChangedError) || attempt >= 2) throw err;
      }
    }
  });

  return {
    ...(udtDefinition ? { udtDefinition } : {}),
    udtPending,
    replayCollisions,
    wroteInvocation,
    wroteJobs,
    wroteUdt,
  };
}

/**
 * Persist a user-defined tool's definition beside the notebook. Returns the
 * analysis-relative path written, or null when the id can't be made into a
 * safe filename.
 */
async function writeUdtDefinition(
  analysisDir: string,
  toolId: string,
  uuid: string,
  representation: unknown,
): Promise<string | null> {
  // The uuid is in the filename, not just the tool id, because the uuid is
  // what identifies a definition: recreating `clean_table` yields a new uuid
  // and a new (possibly different) definition, and naming by tool id alone
  // meant the second write overwrote the first while both notebook blocks
  // went on pointing at the surviving file. It also settles the case where
  // two distinct tool ids sanitise to the same name.
  const safeTool = safeProvenanceFilename(toolId);
  const safeUuid = safeProvenanceFilename(uuid);
  if (!safeUuid) return null;
  const stem = safeTool ? `${safeTool}-${safeUuid}` : safeUuid;

  const relative = path.join(UDT_PROVENANCE_DIR, `${stem}.yaml`);
  const absolute = path.join(analysisDir, relative);
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  try {
    // `wx` is O_CREAT | O_EXCL: create it or fail. That refuses to follow a
    // symlink planted at the path (writing through it would land outside the
    // provenance directory) and refuses to overwrite an existing definition.
    await fsp.writeFile(absolute, stringifyYaml(representation), {
      encoding: "utf-8",
      flag: "wx",
    });
  } catch (err) {
    // Already there: the uuid is in the name, so the same uuid means the same
    // definition and the existing file is the record. Anything else is a real
    // failure and the caller reports the submission as unrecorded.
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
  }
  // Always POSIX separators in the notebook: the block is read on whatever
  // platform opens the analysis next, not the one that wrote it.
  return relative.split(path.sep).join("/");
}

// ─────────────────────────────────────────────────────────────────────────────
// The hook
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-read a result the MCP adapter truncated.
 *
 * Over 50 KiB (or 2000 lines) pi-mcp-adapter replaces the text with a preview
 * plus a notice and spills the full copy to a temp file. The preview is not
 * valid JSON, so without this a big mapped-over submission -- precisely the
 * one whose record matters most -- would log `submission.unparsed`.
 */
function rereadTruncated(resolved: ResolvedResult): ResolvedResult {
  if (!resolved.truncatedPath) return resolved;
  try {
    return {
      ...resolved,
      value: undefined,
      text: fs.readFileSync(resolved.truncatedPath, "utf-8"),
    };
  } catch {
    return resolved;
  }
}

/**
 * Handle one finished submission tool. Exported so the Tier-1 scenarios can
 * replay a recorded result through exactly this path.
 */
export async function handleSubmissionResult(
  toolCallId: string,
  toolName: string,
  result: unknown,
  isError: boolean,
  dispatchOverride?: DispatchOverride,
): Promise<void> {
  const dispatch = takeDispatch(toolCallId, toolName, dispatchOverride);

  // A failed submission is not a submission: galaxy-mcp raises rather than
  // returning success=false, and nothing was created.
  if (isError) return;

  const notebookPath = getNotebookPath();
  if (!notebookPath) return;

  let resolved = resolveResultPayload(result);
  let outcome = parseSubmission(toolName, dispatch.args, resolved);
  // Re-read the adapter's spill file ONLY when the inline payload was never a
  // readable envelope -- that is the truncation case this exists for. If the
  // envelope parsed and the tool-specific parse still said no, we understood
  // the answer and it was "nothing to record"; going to the spill file then
  // would let a different payload overturn a verdict we already reached.
  if (
    !outcome.ok &&
    resolved.truncatedPath &&
    parseGalaxyResultEnvelope(resolved) === null &&
    toolName !== "galaxy_upload_local_file"
  ) {
    resolved = rereadTruncated(resolved);
    outcome = parseSubmission(toolName, dispatch.args, resolved);
  }

  if (!outcome.ok) {
    record("submission.unparsed", {
      tool: toolName,
      attempt_id: dispatch.attemptId,
      step_anchor: dispatch.stepAnchor,
      reason: outcome.reason,
    });
    return;
  }

  const submission = outcome.submission;
  let written: WriteOutcome;
  try {
    written = await writeBlocks(notebookPath, submission, dispatch);
  } catch (err) {
    // The run is real and running whether or not we managed to write it down;
    // say so rather than claiming a registration that did not land.
    record("submission.unparsed", {
      tool: toolName,
      attempt_id: dispatch.attemptId,
      step_anchor: dispatch.stepAnchor,
      reason: `could not write the record: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  // A user-defined tool whose definition could not be stored is not recorded:
  // the block would point at a file that is not there, and the whole reason
  // the harness intercepts a UDT creation is to keep the definition. Say
  // unparsed instead of claiming a registration.
  if (written.udtPending && !written.udtDefinition) {
    record("submission.unparsed", {
      tool: toolName,
      attempt_id: dispatch.attemptId,
      step_anchor: dispatch.stepAnchor,
      reason: "could not store the tool definition, so the creation is unrecorded",
    });
    return;
  }

  if (written.replayCollisions.length > 0) {
    record("submission.replay_skipped", {
      tool: toolName,
      attempt_id: dispatch.attemptId,
      step_anchor: dispatch.stepAnchor,
      ids: written.replayCollisions,
      reason: "the notebook already has a block for these ids; a fixture must not overwrite one",
    });
  }

  // Nothing landed, so there is no registration to announce. Saying otherwise
  // would put a row in the log claiming a block that is not there -- the same
  // untruth `submission.unparsed` exists to avoid on the other side.
  const wroteNothing =
    !written.wroteInvocation && written.wroteJobs.length === 0 && !written.wroteUdt;
  if (wroteNothing) return;

  // /execute's step anchor names the step it started on, but one /execute now
  // carries on through the authorized plan. Only the first run it lands is
  // known to be for that step; leaving the anchor armed filed step 2 and 3
  // under step 1, which the evidence gate then read as step 1's evidence.
  // Later runs come out unattributed until the model binds them.
  if (!dispatch.replayed && dispatch.stepAnchor === getCurrentStepAnchor()) {
    setCurrentStepAnchor(null);
  }

  record("submission.registered", {
    tool: toolName,
    attempt_id: dispatch.attemptId,
    step_anchor: dispatch.stepAnchor,
    kind: submission.kind,
    label: submission.label,
    submitted_by: dispatch.replayed ? "replay" : "harness",
    ...(submission.historyId ? { history_id: submission.historyId } : {}),
    // The ids that were actually written, not the ids the result carried: a
    // mapped-over replay can land some of its jobs and skip others.
    ...(written.wroteInvocation ? { invocation_id: written.wroteInvocation } : {}),
    ...(written.wroteJobs.length > 0 ? { job_ids: written.wroteJobs } : {}),
    ...(written.wroteUdt && submission.udt
      ? { tool_id: submission.udt.toolId, tool_uuid: written.wroteUdt }
      : {}),
    // The path is reported from what was actually written, not from what we
    // meant to write, so the row can't claim a definition that never landed.
    ...(written.udtDefinition ? { definition: written.udtDefinition } : {}),
    ...(submission.partial ? { partial: true } : {}),
  });
}

export function registerSubmissionCapture(pi: ExtensionAPI): void {
  pi.on("tool_execution_start", async (event) => {
    // The same submission can arrive as `galaxy_run_tool`, as
    // `mcp__galaxy__run_tool`, or through pi's `mcp` proxy tool with the real
    // name and args nested inside -- the proxy is what the reconnect guidance
    // steers the model to. Record it under its real name either way.
    const call = galaxyCall(
      event.toolName,
      (event.args && typeof event.args === "object" ? event.args : {}) as Record<string, unknown>,
    );
    if (!call || !isSubmissionTool(call.name)) return;
    rememberDispatch(event.toolCallId, call.name, call.args);
  });

  pi.on("tool_execution_end", async (event) => {
    // The end event has no args, so a proxied call is only recognisable by the
    // dispatch its start left behind.
    const toolName = inFlight.get(event.toolCallId)?.toolName ?? event.toolName;
    if (!isSubmissionTool(toolName)) return;
    try {
      await handleSubmissionResult(
        event.toolCallId,
        toolName,
        event.result,
        event.isError === true,
      );
    } catch (err) {
      // Never let capture take the turn down: the submission already happened.
      console.error("[submission-capture] failed:", err);
    }
  });
}
