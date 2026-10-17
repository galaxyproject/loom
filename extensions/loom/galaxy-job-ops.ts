/**
 * The job reads Orbit's model needs that galaxy-ops 0.3.1 does not have, written as galaxy-ops
 * operations so they run through the same wrapper as every other Galaxy tool: one envelope, the
 * same failure kinds and deadline, Python-shaped failure wording from their `failure` contracts.
 *
 * `run_tool` answers with job ids, and the model polls them, but galaxy-ops' get_job_details only
 * finds a job from the dataset it made. The bridge reads a job by its own id as well, and keeps
 * the dataset route as galaxy-ops wrote it. list_jobs and get_job_logs have no galaxy-ops
 * counterpart at all. They all go away when galaxy-ops ships the same operations.
 */
import {
  getJobDetailsOp,
  GalaxyConnectionError,
  GalaxyValidationError,
  httpError,
  type AnyOperation,
  type GalaxyContext,
  type GetJobDetailsResult,
  type JobDetail,
  type Operation,
} from "@galaxyproject/galaxy-ops";
import { isGalaxyEncodedId } from "./galaxy-api";
import type { GalaxyOpArgs } from "./galaxy-op-policy";
import type { GalaxyBridge } from "./galaxy-ops-tools";

/** A job id is a URL path segment; anything else could walk the URL to another endpoint. */
function encodedJobId(jobId: string): string {
  if (!isGalaxyEncodedId(jobId)) {
    throw new GalaxyValidationError(
      `job_id '${jobId}' is not a Galaxy job id. Job ids are the hexadecimal strings run_tool and list_jobs return; pass one back exactly.`,
    );
  }
  return jobId;
}

async function fetchJob(
  ctx: GalaxyContext,
  jobId: string,
  full: boolean,
): Promise<Record<string, unknown>> {
  const { data, error, response } = await ctx.client.GET("/api/jobs/{job_id}", {
    params: { path: { job_id: jobId }, ...(full ? { query: { full: true } } : {}) },
  });
  if (error || !data) throw httpError(response, error);
  return data as Record<string, unknown>;
}

// The added and relaxed fields come from the operation's own zod fields, so they render, parse
// and laxen through galaxy-ops' zod like every other parameter. dataset_id stops being required
// because a job id alone is now enough.
const jobDetailsInput = {
  ...getJobDetailsOp.input,
  datasetId: getJobDetailsOp.input.datasetId.optional(),
  jobId: getJobDetailsOp.input.datasetId
    .describe("Galaxy job id, as run_tool returns it. Give job_id or dataset_id.")
    .optional(),
};

/** The dataset route's shape on both routes, so the poll guard and parsers read one result. */
type JobDetailsOut = Omit<GetJobDetailsResult, "dataset_id"> & { dataset_id: string | null };

const byJob = (i: { jobId?: string }): i is { jobId: string } => i.jobId !== undefined;
const baseFailure = getJobDetailsOp.failure;

const getJobDetailsBridgeOp: Operation<typeof jobDetailsInput, JobDetailsOut> = {
  ...getJobDetailsOp,
  input: jobDetailsInput,
  async run(i, ctx) {
    if (byJob(i)) {
      const jobId = encodedJobId(i.jobId);
      const job = (await fetchJob(ctx, jobId, false)) as JobDetail;
      return { job, dataset_id: null, job_id: jobId };
    }
    if (i.datasetId === undefined) {
      throw new GalaxyValidationError("Give job_id (from run_tool) or dataset_id.");
    }
    return getJobDetailsOp.run({ datasetId: i.datasetId, historyId: i.historyId }, ctx);
  },
  project(out, i, facts) {
    if (byJob(i)) return { message: `Retrieved job details for job '${out.job_id}'` };
    return (
      getJobDetailsOp.project?.(
        out as GetJobDetailsResult,
        { datasetId: out.dataset_id ?? "", historyId: i.historyId },
        facts,
      ) ?? {}
    );
  },
  failure: baseFailure && {
    shape: baseFailure.shape,
    action: baseFailure.action,
    context: (i) =>
      byJob(i)
        ? { job_id: i.jobId }
        : (baseFailure.context?.({ datasetId: i.datasetId ?? "", historyId: i.historyId }) ?? {}),
    // The base sentence names the dataset; on the job route there is none to name.
    sentence: (text, status, i) =>
      byJob(i)
        ? undefined
        : baseFailure.sentence?.(text, status, {
            datasetId: i.datasetId ?? "",
            historyId: i.historyId,
          }),
  },
};

export const getJobDetailsBridge: GalaxyBridge = {
  op: getJobDetailsBridgeOp as unknown as AnyOperation,
  note: "Pass job_id to read a job directly, or dataset_id to find the job that made a dataset.",
};

/** The model's snake_case keys under these operations' camelCase ones. */
const renamed =
  (names: Record<string, string>) =>
  (args: GalaxyOpArgs): GalaxyOpArgs =>
    Object.fromEntries(Object.entries(args).map(([k, v]) => [names[k] ?? k, v]));

const JOB_ID_PARAMETER = {
  type: "string",
  description: "Galaxy job id, as run_tool or list_jobs returns it.",
} as const;

const LIST_JOBS_LIMIT = { default: 50, max: 500 } as const;

function wholeNumber(name: string, value: unknown, fallback: number, max?: number): number {
  if (value === undefined || value === null) return fallback;
  const ok =
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= (max === undefined ? 0 : 1) &&
    (max === undefined || value <= max);
  if (!ok) {
    const range = max === undefined ? "0 or greater" : `from 1 to ${max}`;
    throw new GalaxyValidationError(`${name} must be a whole number ${range} (got ${value}).`);
  }
  return value;
}

interface ListJobsInput {
  historyId?: unknown;
  limit?: unknown;
  offset?: unknown;
}

const listJobsOp = {
  name: "list_jobs",
  domain: "jobs",
  summary:
    "List the jobs in a history, newest first: each row's id, tool_id, state and create_time. Use it to find the job behind a step or to see what is still running; get_job_details and get_job_logs take a row's id.",
  input: {},
  readOnly: true,
  async run(i: ListJobsInput, ctx: GalaxyContext): Promise<unknown[]> {
    if (typeof i.historyId !== "string" || i.historyId === "") {
      throw new GalaxyValidationError("list_jobs needs history_id.");
    }
    const limit = wholeNumber("limit", i.limit, LIST_JOBS_LIMIT.default, LIST_JOBS_LIMIT.max);
    const offset = wholeNumber("offset", i.offset, 0);
    const { data, error, response } = await ctx.client.GET("/api/jobs", {
      params: {
        query: {
          history_id: i.historyId,
          view: "collection",
          order_by: "create_time",
          // Galaxy sends no total, so one row past the page is how project knows another exists.
          limit: limit + 1,
          offset,
        },
      },
    });
    if (error || !data) throw httpError(response, error);
    // A non-list here is not a job index at all; reading it as zero jobs would hide that.
    if (!Array.isArray(data)) {
      throw new GalaxyConnectionError("Galaxy's job index did not return a list");
    }
    return data as unknown[];
  },
  project: (rows: unknown[], i: ListJobsInput) => {
    // run already refused anything these would throw on.
    const limit = wholeNumber("limit", i.limit, LIST_JOBS_LIMIT.default, LIST_JOBS_LIMIT.max);
    const offset = wholeNumber("offset", i.offset, 0);
    const page = rows.slice(0, limit);
    const hasNext = rows.length > limit;
    const next = offset + page.length;
    return {
      data: page,
      message: `Retrieved ${page.length} jobs for history '${String(i.historyId)}'`,
      count: page.length,
      pagination: {
        // A lower bound: Galaxy's job index does not count the rest.
        total_items: offset + rows.length,
        returned_items: page.length,
        limit,
        offset,
        has_next: hasNext,
        has_previous: offset > 0,
        next_offset: hasNext ? next : null,
        previous_offset: offset > 0 ? Math.max(0, offset - limit) : null,
        helper_text:
          `Showing ${page.length} jobs from offset ${offset}. ` +
          (hasNext ? `Use offset=${next} for the next page.` : "This is the last page."),
      },
    };
  },
  failure: {
    shape: "raise-for-status",
    action: "List jobs",
    context: (i: ListJobsInput) => ({ history_id: i.historyId }),
  },
};

export const listJobsBridge: GalaxyBridge = {
  op: listJobsOp as unknown as AnyOperation,
  parameters: {
    type: "object",
    properties: {
      history_id: { type: "string", description: "Encoded id of the history whose jobs to list." },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: LIST_JOBS_LIMIT.max,
        default: LIST_JOBS_LIMIT.default,
        description: `Most jobs to return (default ${LIST_JOBS_LIMIT.default}, at most ${LIST_JOBS_LIMIT.max}).`,
      },
      offset: {
        type: "integer",
        minimum: 0,
        default: 0,
        description: "Jobs to skip from the newest, for the next page (default 0).",
      },
    },
    required: ["history_id"],
    additionalProperties: false,
  },
  inputOf: renamed({ history_id: "historyId" }),
};

/** Every log a job can carry, as `GET /api/jobs/{id}?full=true` names them. */
const LOG_FIELDS = [
  "state",
  "exit_code",
  "stdout",
  "stderr",
  "job_stdout",
  "job_stderr",
  "tool_stdout",
  "tool_stderr",
] as const;

interface JobLogsInput {
  jobId?: unknown;
}

const getJobLogsOp = {
  name: "get_job_logs",
  domain: "jobs",
  summary:
    "Get a job's state, exit code and logs: stdout and stderr as the tool and as Galaxy's job runner wrote them. Read these to see why a job failed.",
  input: {},
  readOnly: true,
  async run(i: JobLogsInput, ctx: GalaxyContext): Promise<Record<string, unknown>> {
    if (typeof i.jobId !== "string") throw new GalaxyValidationError("get_job_logs needs job_id.");
    const jobId = encodedJobId(i.jobId);
    const job = await fetchJob(ctx, jobId, true);
    // Only what the server sent: an absent log is not an empty one.
    const out: Record<string, unknown> = { job_id: jobId };
    for (const key of LOG_FIELDS) if (key in job) out[key] = job[key];
    return out;
  },
  project: (_out: unknown, i: JobLogsInput) => ({
    message: `Retrieved logs for job '${String(i.jobId)}'`,
  }),
  failure: {
    shape: "raise-for-status",
    action: "Get job logs",
    context: (i: JobLogsInput) => ({ job_id: i.jobId }),
  },
};

export const getJobLogsBridge: GalaxyBridge = {
  op: getJobLogsOp as unknown as AnyOperation,
  parameters: {
    type: "object",
    properties: { job_id: JOB_ID_PARAMETER },
    required: ["job_id"],
    additionalProperties: false,
  },
  inputOf: renamed({ job_id: "jobId" }),
};
