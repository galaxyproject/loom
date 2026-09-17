/**
 * Reading Galaxy ids out of a submission tool's result.
 *
 * Pure functions, no I/O and no notebook writes -- the capture hook in
 * galaxy-submission-capture.ts does that part. Everything here is driven by
 * what galaxy-mcp 1.9.0 actually returns, read out of its source rather than
 * its docstrings (spike: `2026-09-16-galaxy-mcp-result-shapes.md`), and by
 * what pi-mcp-adapter does to that result on the way to the extension hook.
 *
 * The rule the whole module is built around: **never guess an id.** A parse
 * that cannot find the field it is looking for, in the shape it expects,
 * returns a reason instead of a value, and the caller logs
 * `submission.unparsed`. A wrong id is worse than no id -- it binds a
 * notebook block, and later a provenance record, to work nobody did.
 *
 * ## What the result actually looks like
 *
 * Every galaxy-mcp tool returns a pydantic `GalaxyResult`
 * (`{data, success, message, count?, pagination?}`), which FastMCP emits as
 * both `structuredContent` and one `TextContent` block holding the same
 * object as JSON. So the payload is always JSON, never prose -- parse it,
 * don't regex it.
 *
 * Two things the spike assumed that the installed code does not do, both
 * checked against `pi-mcp-adapter@2.21.2`:
 *
 * 1. `structuredContent` does **not** survive as a separate field for the
 *    galaxy tools. `resolveMcpResultContent` (tool-registrar.ts:52) only
 *    falls back to it when `content` is empty, and FastMCP always sends a
 *    text block, so on the direct-tools path -- the one Loom uses, since its
 *    tools are named `galaxy_<tool>` -- the text block is all there is.
 * 2. The adapter's output guard truncates text over 50 KiB or 2000 lines
 *    (mcp-output-guard.ts:7-8, :125) and appends a notice, which makes the
 *    JSON unparseable. It spills the full text to a temp file and records the
 *    path at `details.outputGuard.fullOutputPath`. A mapped-over run with
 *    enough outputs hits this, so `resolveResultPayload` reports the path and
 *    the caller re-reads from it rather than losing the biggest submissions.
 */

import * as path from "path";

/** What a submission tool produces, and therefore which block it writes. */
export type SubmissionKind = "invocation" | "jobs" | "udt";

/**
 * Tools whose success means work was submitted to Galaxy.
 *
 * `galaxy_upload_file` (galaxy-mcp's local-path upload) is here alongside the
 * URL one: the spike shows both go through `POST /api/tools` and return the
 * same envelope, so recording one and not the other would leave a silent hole
 * for anyone whose Galaxy MCP server is reachable but whose Loom-native
 * uploader is not.
 */
export const SUBMISSION_TOOLS: Readonly<Record<string, SubmissionKind>> = {
  galaxy_invoke_workflow: "invocation",
  galaxy_run_tool: "jobs",
  galaxy_run_user_tool: "jobs",
  galaxy_upload_file_from_url: "jobs",
  galaxy_upload_file: "jobs",
  // Loom-native (galaxy-upload.ts), not an MCP passthrough: its result shape
  // is ours, so it is parsed from `details` rather than from the JSON text.
  galaxy_upload_local_file: "jobs",
  galaxy_create_user_tool: "udt",
};

export function isSubmissionTool(toolName: string | undefined): boolean {
  return !!toolName && toolName in SUBMISSION_TOOLS;
}

/** One Galaxy job as the submission response described it. */
export interface SubmittedJob {
  jobId: string;
  toolId?: string;
  /**
   * Captured here on purpose: `GET /api/jobs/{id}` drops `tool_version`
   * (no model in the response chain declares it, so pydantic's default
   * `extra="ignore"` discards it), and the submission response is the only
   * place it reliably survives.
   */
  toolVersion?: string;
  historyId?: string;
}

export interface ParsedSubmission {
  kind: SubmissionKind;
  /** Set when `kind === "invocation"`. */
  invocationId?: string;
  /** Set when `kind === "jobs"`; always at least one entry. */
  jobs?: SubmittedJob[];
  /** Set when `kind === "udt"`. */
  udt?: { toolId: string; uuid: string; representation: unknown };
  historyId?: string;
  label: string;
  /**
   * True when Galaxy reported that some jobs in the request did not start
   * (`data.errors` on a `POST /api/tools` response). The jobs that did start
   * are still real and still recorded; the caller notes the partial failure.
   */
  partial?: boolean;
}

export type ParseOutcome =
  { ok: true; submission: ParsedSubmission } | { ok: false; reason: string };

function fail(reason: string): ParseOutcome {
  return { ok: false, reason };
}

// ─────────────────────────────────────────────────────────────────────────────
// Getting at the payload
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolvedResult {
  /** A structured payload, when the adapter handed one over directly. */
  value?: unknown;
  /** The result text to JSON.parse. */
  text?: string;
  /** The adapter's spill file for a truncated result; the caller may re-read it. */
  truncatedPath?: string;
  /** Loom-native tool details, when the tool is one of ours. */
  details?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstTextBlock(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const b = asRecord(block);
    if (b && b.type === "text" && typeof b.text === "string") return b.text;
  }
  return undefined;
}

/**
 * Pull the parseable payload out of a `tool_execution_end` result.
 *
 * The result is pi's `AgentToolResult` (`{content, details, usage}`), built
 * by whichever adapter path ran the tool. Preference order is
 * least-mangled-first: the proxy path's raw `details.mcpResult` (which keeps
 * `structuredContent`), then its text, then the content block the direct path
 * leaves, and finally the truncation spill file.
 */
export function resolveResultPayload(result: unknown): ResolvedResult {
  if (typeof result === "string") return { text: result };

  const r = asRecord(result);
  if (!r) return {};

  const details = asRecord(r.details) ?? undefined;
  const out: ResolvedResult = { details };

  const guard = asRecord(details?.outputGuard);
  if (guard?.truncated === true && typeof guard.fullOutputPath === "string") {
    out.truncatedPath = guard.fullOutputPath;
  }

  // Proxy "call" mode attaches the raw CallToolResult. When it was too big for
  // `detailsMaxBytes` the adapter replaces it with an `{omitted: true}`
  // summary, which carries no ids -- skip that rather than parse a summary as
  // a submission.
  const mcpResult = asRecord(details?.mcpResult);
  if (mcpResult && mcpResult.omitted !== true) {
    const structured = asRecord(mcpResult.structuredContent);
    if (structured) {
      out.value = structured;
      return out;
    }
    const text = firstTextBlock(mcpResult.content);
    if (text !== undefined) {
      out.text = text;
      return out;
    }
  }

  const text = firstTextBlock(r.content);
  if (text !== undefined) out.text = text;
  return out;
}

/**
 * Parse the `GalaxyResult` envelope. Returns null when the text is not the
 * envelope we expect -- truncated, prose, or some other tool's shape.
 */
export function parseGalaxyResultEnvelope(
  resolved: ResolvedResult,
): Record<string, unknown> | null {
  let value: unknown = resolved.value;
  if (value === undefined) {
    if (resolved.text === undefined) return null;
    try {
      value = JSON.parse(resolved.text);
    } catch {
      return null;
    }
  }
  const envelope = asRecord(value);
  if (!envelope) return null;
  // `success` defaults to true on the model and every submission tool raises
  // rather than returning false, so the field is usually absent-or-true. Only
  // those two are accepted: a `success` of `"false"`, `0` or `null` is not a
  // GalaxyResult we recognise, and reading it as a success would register a
  // run off a payload we do not understand.
  if ("success" in envelope && envelope.success !== true) return null;
  if (!("data" in envelope)) return null;
  return envelope;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-tool parsers
// ─────────────────────────────────────────────────────────────────────────────

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Accept a value only if it is shaped like an id that can survive a block.
 *
 * The blocks are line-oriented `key: value`, and the id scalars are written
 * unescaped, so an id containing a newline renders as a SECOND `job_id:` line
 * and the parser -- last key wins -- reads back a different id than the one
 * Galaxy returned. That is the precise failure this whole module exists to
 * prevent, so it is rejected at the boundary rather than escaped downstream:
 * a Galaxy id with a newline, a tab or a control character in it is not a
 * Galaxy id, and refusing beats inventing an escaping scheme that the two
 * block parsers would then have to agree on.
 *
 * Deliberately not `/^[0-9a-f]{16}$/`: ids are 16-char lowercase hex on the
 * usual servers, but tool ids are toolshed paths, UDT ids are uuids, and a
 * server with a different id encoding is still a server we should record.
 */
const MAX_ID_LENGTH = 512;

export function idToken(value: unknown): string | undefined {
  const raw = str(value);
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ID_LENGTH) return undefined;
  // No whitespace at all (newline, tab, space) and no C0/C1 control chars.
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(trimmed)) return undefined;
  return trimmed;
}

/** Trim a label to something a notebook row can show without wrapping. */
function label(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

/**
 * A workflow invocation. `POST /api/workflows/{id}/invocations` answers with
 * the *collection* view (`WorkflowInvocationResponse` is a left-to-right
 * union and `to_dict()` defaults to `view="collection"`), so there are no
 * `steps` and no job ids here -- only the invocation itself. `model_class` is
 * checked so a differently-shaped success can't be read as an invocation.
 */
function parseInvokeWorkflow(data: unknown, args: Record<string, unknown>): ParseOutcome {
  if (Array.isArray(data)) {
    // Batch invocation answers with a list. galaxy-mcp never sets `batch`, so
    // reaching this means the contract moved; refuse rather than pick one.
    return fail("invoke_workflow returned a list (batch invocation); not registering");
  }
  const d = asRecord(data);
  if (!d) return fail("invoke_workflow result has no data object");

  const modelClass = str(d.model_class);
  if (modelClass !== "WorkflowInvocation") {
    return fail(`invoke_workflow data.model_class is ${modelClass ?? "missing"}`);
  }
  const invocationId = idToken(d.id);
  if (!invocationId) return fail("invoke_workflow data.id is missing or not an id-shaped string");

  const workflowId = str(d.workflow_id) ?? str(args.workflow_id);
  return {
    ok: true,
    submission: {
      kind: "invocation",
      invocationId,
      historyId: idToken(d.history_id) ?? idToken(args.history_id),
      label: label(workflowId ? `Workflow ${workflowId}` : "Galaxy workflow"),
    },
  };
}

/**
 * Anything that goes through `POST /api/tools`: `run_tool`, `run_user_tool`,
 * and both uploads. `data.jobs` is authoritative and is a list even for a
 * single job -- a map-over submission puts one entry per job there while
 * `data.outputs` can be empty (the outputs surface as
 * `data.implicit_collections` instead).
 */
function parseToolRun(
  data: unknown,
  args: Record<string, unknown>,
  labelFor: (jobs: SubmittedJob[]) => string,
): ParseOutcome {
  const d = asRecord(data);
  if (!d) return fail("tool run result has no data object");
  if (!Array.isArray(d.jobs)) return fail("tool run data.jobs is missing or not a list");

  const jobs: SubmittedJob[] = [];
  for (const entry of d.jobs) {
    const j = asRecord(entry);
    const jobId = j ? idToken(j.id) : undefined;
    // One malformed entry means we do not know how many jobs really started,
    // so the whole submission is unparsed rather than partly recorded.
    if (!j || !jobId) return fail("tool run data.jobs has an entry with no id-shaped id");
    // Galaxy's job dicts carry `model_class: "Job"`. When the field is there
    // it has to say Job: an invocation id written into a job block sends the
    // pollers to /api/jobs/<invocation id>, which fails quietly forever.
    // Checked only when present, so a server that omits it still records.
    const modelClass = str(j.model_class);
    if (modelClass && modelClass !== "Job") {
      return fail(`tool run data.jobs entry has model_class ${modelClass}, expected Job`);
    }
    jobs.push({
      jobId,
      toolId: idToken(j.tool_id),
      toolVersion: idToken(j.tool_version),
      historyId: idToken(j.history_id),
    });
  }
  if (jobs.length === 0) return fail("tool run data.jobs is empty");

  // Present only on partial failure, when some jobs ran and some did not.
  const errors = d.errors;
  const partial = Array.isArray(errors)
    ? errors.length > 0
    : !!asRecord(errors) && Object.keys(asRecord(errors)!).length > 0;

  return {
    ok: true,
    submission: {
      kind: "jobs",
      jobs,
      // Where Galaxy says the jobs landed beats where they were requested to
      // land: the block claims server_verified, so every field on it should be
      // the server's answer wherever the server gave one.
      historyId: jobs[0].historyId ?? idToken(args.history_id),
      label: label(labelFor(jobs)),
      ...(partial ? { partial: true } : {}),
    },
  };
}

/**
 * A user-defined tool creation. `data` is Galaxy's `UnprivilegedToolResponse`;
 * `representation` there is the stored (and lifted) definition, which is
 * better provenance than the agent's input because it is what Galaxy will
 * actually run. `tool_id` is nullable in the schema, so fall back to the
 * definition's own id before giving up.
 */
function parseCreateUserTool(data: unknown, _args: Record<string, unknown>): ParseOutcome {
  const d = asRecord(data);
  if (!d) return fail("create_user_tool result has no data object");

  const uuid = idToken(d.uuid);
  if (!uuid) return fail("create_user_tool data.uuid is missing or not an id-shaped string");

  // Only what Galaxy stored. The agent's own `args.representation` is NOT a
  // fallback: preserving it under a block that says the harness recorded this
  // would file the agent's draft as the definition Galaxy will actually run,
  // and those can differ (Galaxy lifts and validates the representation on the
  // way in). With nothing server-side to preserve there is nothing to claim.
  const representation = d.representation;
  const repr = asRecord(representation);
  if (representation === undefined || !repr) {
    return fail("create_user_tool returned no stored representation to preserve");
  }
  const toolId = idToken(d.tool_id) ?? idToken(repr.id);
  if (!toolId) return fail("create_user_tool has no id-shaped tool id");

  return {
    ok: true,
    submission: {
      kind: "udt",
      udt: { toolId, uuid, representation },
      label: label(`User tool ${str(repr.name) ?? toolId}`),
    },
  };
}

/**
 * Loom's own uploader. Not an MCP passthrough, so the ids come from the tool's
 * `details` rather than from a `GalaxyResult`: `galaxy-upload.ts` reads
 * `jobs[]` off the `/tools/fetch` response and carries the ids there.
 */
function parseLocalUpload(
  details: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
): ParseOutcome {
  if (!details) return fail("upload result carried no details");
  if (details.error) return fail("upload reported a failure");
  if (!Array.isArray(details.jobs)) return fail("upload details carry no job ids");

  const jobs: SubmittedJob[] = [];
  for (const entry of details.jobs) {
    const jobId = idToken(entry);
    if (!jobId) return fail("upload details.jobs has an entry that is not an id-shaped string");
    jobs.push({ jobId, toolId: "__DATA_FETCH__" });
  }
  if (jobs.length === 0) return fail("upload details.jobs is empty");

  const fileName = str(args.file_name) ?? (str(args.path) ? path.basename(String(args.path)) : "");
  return {
    ok: true,
    submission: {
      kind: "jobs",
      jobs,
      historyId: idToken(details.historyId) ?? idToken(args.history_id),
      label: label(fileName ? `Upload ${fileName}` : "Upload to Galaxy"),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a successful submission tool result into the ids to record.
 *
 * `args` is the tool's own input, captured at dispatch: `run_user_tool` never
 * echoes the uuid it was given, and the uploads' file names live only there.
 */
export function parseSubmission(
  toolName: string,
  args: Record<string, unknown>,
  resolved: ResolvedResult,
): ParseOutcome {
  const kind = SUBMISSION_TOOLS[toolName];
  if (!kind) return fail(`${toolName} is not a submission tool`);

  if (toolName === "galaxy_upload_local_file") {
    return parseLocalUpload(resolved.details, args);
  }

  const envelope = parseGalaxyResultEnvelope(resolved);
  if (!envelope) {
    return fail(
      resolved.truncatedPath
        ? "result was not parseable JSON even after re-reading the adapter's spill file"
        : "result was not a parseable GalaxyResult envelope",
    );
  }
  const data = envelope.data;

  switch (toolName) {
    case "galaxy_invoke_workflow":
      return parseInvokeWorkflow(data, args);
    case "galaxy_run_tool":
      return parseToolRun(
        data,
        args,
        (jobs) => str(args.tool_id) ?? jobs[0].toolId ?? "Galaxy tool run",
      );
    case "galaxy_run_user_tool":
      // The uuid is the hook's own input and never appears in `data`; the
      // resolved tool id does, on each job.
      return parseToolRun(data, args, (jobs) =>
        `User tool ${jobs[0].toolId ?? str(args.tool_uuid) ?? ""}`.trim(),
      );
    case "galaxy_upload_file_from_url":
      return parseToolRun(data, args, () => `Upload ${str(args.url) ?? "from URL"}`);
    case "galaxy_upload_file":
      return parseToolRun(data, args, () => {
        const p = str(args.path);
        return p ? `Upload ${path.basename(p)}` : "Upload to Galaxy";
      });
    case "galaxy_create_user_tool":
      return parseCreateUserTool(data, args);
    default:
      return fail(`${toolName} has no parser`);
  }
}
