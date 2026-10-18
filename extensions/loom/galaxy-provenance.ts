/**
 * Per-attempt provenance files: `<analysis>/.loom/provenance/<attempt_id>.json`.
 *
 * The notebook block carries a compact summary of each recorded run; this is
 * the full record behind it -- every job's tool, version, effective params,
 * inputs and outputs, as Galaxy reported them. Written only by the harness,
 * into the `.loom/` tree the write jail already protects from the agent's file
 * tools and bash redirects, so it is the half of the record the model cannot
 * edit after the fact.
 *
 * The file is created when the attempt is first recorded (by the submission
 * hook, or by reconcile for a run nobody recorded), and that first write names
 * the Galaxy ids the attempt owns. Enrichment only ever adds job records to a
 * file whose owned ids include the block asking. That matters because the
 * notebook is not protected: `attempt_id` sits in a block the agent can edit,
 * and without the ownership check a block re-pointed at another attempt's id
 * would merge its own jobs into that attempt's record -- a forged attribution
 * written by the harness itself.
 *
 * Writes are atomic (a sibling temp file renamed over the target), refuse to
 * go through a symlink at any level below the analysis directory, and are
 * serialised per file inside this process.
 */

import * as fs from "fs";
import { currentGalaxyConnection, matchesGalaxyOrigin } from "./galaxy-connections.js";
import * as fsp from "fs/promises";
import * as path from "path";
import { randomBytes } from "crypto";
import { isGalaxyFetchOverridden, sameGalaxyServer } from "./galaxy-api";
import { isUlid } from "./ulid";

export const PROVENANCE_SCHEMA_VERSION = 1;

/** Relative to the analysis directory. Same tree the UDT definitions use. */
export const PROVENANCE_DIR_PARTS = [".loom", "provenance"] as const;

/** What a field is when Galaxy did not say. Never inferred from anything else. */
export const UNKNOWN = "unknown";
export type Maybe<T> = T | typeof UNKNOWN;

export type AttemptKind = "invocation" | "jobs";

/** One input or output dataset of a job. */
export interface ProvenanceDataset {
  /** The tool's own name for the input/output slot. */
  name: string;
  id: string;
  src: Maybe<string>;
  dataset_name: Maybe<string>;
  ext: Maybe<string>;
  dbkey: Maybe<string>;
  create_time: Maybe<string>;
  state: Maybe<string>;
}

export interface ProvenanceJob {
  job_id: string;
  tool_id: Maybe<string>;
  tool_version: Maybe<string>;
  /**
   * Where `tool_version` came from, since job details never carry it.
   * `notebook` is the block's own summary, for an attempt recorded before
   * these files existed -- editable text, and labelled as such.
   */
  tool_version_source:
    "submission" | "invocation_step" | "job_listing" | "tool_id" | "notebook" | typeof UNKNOWN;
  state: Maybe<string>;
  exit_code: number | null | typeof UNKNOWN;
  create_time: Maybe<string>;
  update_time: Maybe<string>;
  command_version: Maybe<string>;
  params: Record<string, unknown> | typeof UNKNOWN;
  inputs: ProvenanceDataset[] | typeof UNKNOWN;
  outputs: ProvenanceDataset[] | typeof UNKNOWN;
  output_collections: { name: string; id: string; src: Maybe<string> }[] | typeof UNKNOWN;
  /** For a workflow step job: which step produced it. */
  step?: {
    order_index: number | typeof UNKNOWN;
    label: Maybe<string>;
    subworkflow_invocation_id?: string;
  };
  /** Set when this job's details could not be fetched; the fields above are then `unknown`. */
  unavailable?: string;
}

export interface AttemptRecord {
  schema: number;
  attempt_id: string;
  kind: AttemptKind;
  galaxy_server_url: string;
  connection_id?: string;
  account_id?: string;
  history_id: Maybe<string>;
  /** Who made the submission, as far as the harness knows. Mirrors the block. */
  submitted_by: "harness" | "agent" | "unknown" | "replay";
  created_at: string;
  /** The Galaxy ids this attempt owns. Set at creation and never widened. */
  ids: { invocation_id?: string; job_ids?: string[] };
  /**
   * Who decided `ids` and `submitted_by`. `submission` and `reconcile` read
   * them out of Galaxy's own answers; `notebook` means the record was created
   * late, from a block that predates these files, so both came from notebook
   * text the agent can edit and are only as good as that text.
   */
  origin: "submission" | "reconcile" | "notebook";
  /**
   * What Galaxy said about each job when the attempt was recorded -- the
   * submission response is the only answer that carries `tool_version`, and
   * keeping it here rather than reading it back off the block means a hand
   * edit to the block's summary cannot become the recorded version.
   */
  seeds?: Record<string, { tool_id?: string; tool_version?: string }>;
  /** Set when any of this record came from the Tier-1 fixture seam, not a server. */
  fixture?: true;
  enrichment: {
    state: "pending" | "complete" | "unavailable";
    attempts: number;
    /**
     * Attempts per block (`job:<id>` / `invocation:<id>`). The count that
     * decides when a block goes unavailable lives here, not in the block's
     * `enrichment_attempts`, which is notebook text: editing it would let the
     * agent retry forever or exhaust a record on purpose.
     */
    attempts_by_block?: Record<string, number>;
    error?: string;
    updated_at: string;
  };
  jobs: Record<string, ProvenanceJob>;
}

export class ProvenanceRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvenanceRefusal";
  }
}

/** Analysis-relative POSIX path of an attempt's file, for activity rows. */
export function provenanceRelativePath(attemptId: string): string {
  return [...PROVENANCE_DIR_PARTS, `${attemptId}.json`].join("/");
}

/**
 * The absolute path for an attempt, or a refusal. The id is a ULID or nothing:
 * it reaches here from a notebook block, so it is agent-editable text, and a
 * filename built from it must not be able to name anything but one file in one
 * directory.
 */
export function provenancePath(analysisDir: string, attemptId: string): string {
  if (!isUlid(attemptId)) {
    throw new ProvenanceRefusal(`"${attemptId}" is not an attempt id`);
  }
  return path.join(analysisDir, ...PROVENANCE_DIR_PARTS, `${attemptId}.json`);
}

/**
 * Make sure every directory from the analysis dir down to the provenance dir
 * is a real directory. A symlinked `.loom` or `provenance` would carry the
 * write somewhere the jail never looked at.
 */
async function ensureProvenanceDir(analysisDir: string, create = true): Promise<string | null> {
  let current = analysisDir;
  for (const part of PROVENANCE_DIR_PARTS) {
    current = path.join(current, part);
    let stat: fs.Stats | null = null;
    try {
      stat = await fsp.lstat(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }
    if (!stat && !create) return null;
    if (!stat) {
      try {
        await fsp.mkdir(current);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      }
      stat = await fsp.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ProvenanceRefusal(`${current} is not a plain directory`);
    }
  }
  return current;
}

/** Per-file promise chain, so two enrichment passes never interleave a read-modify-write. */
const fileLocks = new Map<string, Promise<unknown>>();

function withFileLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  const prior = fileLocks.get(file) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(work);
  const settled = next.catch(() => undefined);
  fileLocks.set(file, settled);
  void settled.then(() => {
    if (fileLocks.get(file) === settled) fileLocks.delete(file);
  });
  return next;
}

/**
 * Read an attempt's record. Null when there is none. A file that is there but
 * is not a record -- a symlink, unparseable, or naming a different attempt --
 * is a refusal rather than a null, so a caller never mistakes a planted file
 * for permission to start a fresh one over it.
 */
export async function readAttemptRecord(
  analysisDir: string,
  attemptId: string,
): Promise<AttemptRecord | null> {
  const file = provenancePath(analysisDir, attemptId);
  // The directories are checked on the way in too: reading through a
  // symlinked `.loom` would hand back a record planted somewhere else.
  if (!(await ensureProvenanceDir(analysisDir, false))) return null;
  let stat: fs.Stats;
  try {
    stat = await fsp.lstat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
  if (!stat.isFile()) throw new ProvenanceRefusal(`${file} is not a plain file`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsp.readFile(file, "utf-8"));
  } catch {
    throw new ProvenanceRefusal(`${file} is not a readable provenance record`);
  }
  if (!isAttemptRecord(parsed) || parsed.attempt_id !== attemptId) {
    throw new ProvenanceRefusal(`${file} does not hold the record for ${attemptId}`);
  }
  return parsed;
}

function isAttemptRecord(value: unknown): value is AttemptRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<AttemptRecord>;
  return (
    typeof v.attempt_id === "string" &&
    (v.kind === "invocation" || v.kind === "jobs") &&
    !!v.ids &&
    typeof v.ids === "object" &&
    !!v.jobs &&
    typeof v.jobs === "object" &&
    !!v.enrichment &&
    typeof v.enrichment === "object"
  );
}

async function writeAtomically(file: string, record: AttemptRecord): Promise<void> {
  const dir = path.dirname(file);
  const temp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  // `wx`: a planted file or symlink at the temp name fails the open instead of
  // being written through.
  await fsp.writeFile(temp, JSON.stringify(record, null, 2) + "\n", {
    encoding: "utf-8",
    flag: "wx",
  });
  try {
    // rename() replaces a symlink at the target rather than following it, and
    // readers see the old record or the new one, never half of either.
    await fsp.rename(temp, file);
  } catch (err) {
    await fsp.rm(temp, { force: true });
    throw err;
  }
}

export interface AttemptSeed {
  attemptId: string;
  kind: AttemptKind;
  galaxyServerUrl: string;
  historyId?: string;
  submittedBy: AttemptRecord["submitted_by"];
  ids: AttemptRecord["ids"];
  origin: AttemptRecord["origin"];
  seeds?: AttemptRecord["seeds"];
  createdAt?: string;
}

/**
 * Create the attempt's record if there is none, and return whatever is there.
 *
 * Creation is exclusive and first-writer-wins: the ids an attempt owns are
 * decided once, by whoever recorded it first, and later callers get the
 * existing record back to check themselves against rather than a chance to
 * restate it.
 */
export async function ensureAttemptRecord(
  analysisDir: string,
  seed: AttemptSeed,
): Promise<AttemptRecord> {
  const file = provenancePath(analysisDir, seed.attemptId);
  return withFileLock(file, async () => {
    const existing = await readAttemptRecord(analysisDir, seed.attemptId);
    if (existing) return existing;
    await ensureProvenanceDir(analysisDir);
    const now = new Date().toISOString();
    const record: AttemptRecord = {
      schema: PROVENANCE_SCHEMA_VERSION,
      attempt_id: seed.attemptId,
      kind: seed.kind,
      galaxy_server_url: seed.galaxyServerUrl,
      ...(currentGalaxyConnection()
        ? {
            connection_id: currentGalaxyConnection()!.id,
            account_id: currentGalaxyConnection()!.accountId,
          }
        : {}),
      // A record made from notebook text takes nothing from that text it would
      // then vouch for: who submitted it and which history it ran in are left
      // unknown (enrichment fills the history from Galaxy's own answer).
      history_id: seed.origin === "notebook" ? UNKNOWN : (seed.historyId ?? UNKNOWN),
      submitted_by: seed.origin === "notebook" ? "unknown" : seed.submittedBy,
      created_at: seed.createdAt ?? now,
      ids: normalizeIds(seed.ids),
      origin: seed.origin,
      ...(seed.origin !== "notebook" && seed.seeds && Object.keys(seed.seeds).length > 0
        ? { seeds: seed.seeds }
        : {}),
      ...(isGalaxyFetchOverridden() ? { fixture: true as const } : {}),
      enrichment: { state: "pending", attempts: 0, updated_at: now },
      jobs: {},
    };
    try {
      await fsp.writeFile(file, JSON.stringify(record, null, 2) + "\n", {
        encoding: "utf-8",
        flag: "wx",
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      const raced = await readAttemptRecord(analysisDir, seed.attemptId);
      if (raced) return raced;
      throw err;
    }
    return record;
  });
}

function normalizeIds(ids: AttemptRecord["ids"]): AttemptRecord["ids"] {
  return {
    ...(ids.invocation_id ? { invocation_id: ids.invocation_id } : {}),
    ...(ids.job_ids && ids.job_ids.length > 0 ? { job_ids: [...new Set(ids.job_ids)] } : {}),
  };
}

/** Whether this record was created for the block asking about it. */
export function attemptOwns(
  record: AttemptRecord,
  blockKind: "invocation" | "job",
  id: string,
): boolean {
  if (blockKind === "invocation") {
    return record.kind === "invocation" && record.ids.invocation_id === id;
  }
  return record.kind === "jobs" && (record.ids.job_ids ?? []).includes(id);
}

export interface EnrichmentWrite {
  blockKind: "invocation" | "job";
  blockId: string;
  state: AttemptRecord["enrichment"]["state"];
  attempts: number;
  error?: string;
  /** Job records to add or refresh. Keys outside what the attempt owns are refused. */
  jobs: ProvenanceJob[];
  /** The server these answers came from; must be the one the attempt was recorded on. */
  serverUrl: string;
  /** The history Galaxy says these jobs ran in, when it said. Must match the attempt's. */
  historyId?: string;
}

/**
 * Fold one enrichment result into an existing attempt record.
 *
 * Refuses unless the record was created for this block -- see the module
 * note. For a tool-run attempt each job record must be one of the job ids the
 * attempt owns; for an invocation, the step jobs are whatever Galaxy says the
 * invocation ran, which the ownership of the invocation id already vouches for.
 */
export async function writeEnrichment(
  analysisDir: string,
  attemptId: string,
  update: EnrichmentWrite,
): Promise<AttemptRecord> {
  const file = provenancePath(analysisDir, attemptId);
  return withFileLock(file, async () => {
    const record = await ownedRecord(analysisDir, attemptId, update);
    if (
      update.historyId &&
      record.history_id !== UNKNOWN &&
      record.history_id !== update.historyId
    ) {
      throw new ProvenanceRefusal(
        `Galaxy says these jobs ran in history ${update.historyId}, not the attempt's ${record.history_id}`,
      );
    }
    if (update.blockKind === "job") {
      const owned = new Set(record.ids.job_ids ?? []);
      for (const job of update.jobs) {
        if (!owned.has(job.job_id)) {
          throw new ProvenanceRefusal(`job ${job.job_id} is not part of attempt ${attemptId}`);
        }
      }
    }
    const jobs = { ...record.jobs };
    for (const job of update.jobs) jobs[job.job_id] = job;
    const next: AttemptRecord = {
      ...record,
      ...(record.history_id === UNKNOWN && update.historyId
        ? { history_id: update.historyId }
        : {}),
      ...(isGalaxyFetchOverridden() ? { fixture: true as const } : {}),
      jobs,
      enrichment: {
        state: attemptState(record, jobs, update.state),
        attempts: update.attempts,
        attempts_by_block: {
          ...record.enrichment.attempts_by_block,
          [`${update.blockKind}:${update.blockId}`]: update.attempts,
        },
        ...(update.error ? { error: update.error } : {}),
        updated_at: new Date().toISOString(),
      },
    };
    await ensureProvenanceDir(analysisDir);
    await writeAtomically(file, next);
    return next;
  });
}

/** The record, when it exists, belongs to this block, and was recorded on this server. */
async function ownedRecord(
  analysisDir: string,
  attemptId: string,
  who: { blockKind: "invocation" | "job"; blockId: string; serverUrl: string },
): Promise<AttemptRecord> {
  const record = await readAttemptRecord(analysisDir, attemptId);
  if (!record) throw new ProvenanceRefusal(`no provenance record for ${attemptId}`);
  if (!attemptOwns(record, who.blockKind, who.blockId)) {
    throw new ProvenanceRefusal(
      `${who.blockKind} ${who.blockId} is not part of attempt ${attemptId}`,
    );
  }
  // Ids are only unique per server, so a record is bound to the server it was
  // recorded on: another server's job with a colliding id is another job.
  if (
    !recordMatchesOrigin(record) ||
    (record.galaxy_server_url && !sameGalaxyServer(record.galaxy_server_url, who.serverUrl))
  ) {
    throw new ProvenanceRefusal(
      `attempt ${attemptId} was recorded on ${record.galaxy_server_url}, not ${who.serverUrl}`,
    );
  }
  return record;
}

/** Count one failed enrichment attempt for a block, in the record rather than the notebook. */
export async function noteEnrichmentRetry(
  analysisDir: string,
  attemptId: string,
  who: { blockKind: "invocation" | "job"; blockId: string; serverUrl: string },
  attempts: number,
  error: string,
): Promise<void> {
  const file = provenancePath(analysisDir, attemptId);
  await withFileLock(file, async () => {
    const record = await ownedRecord(analysisDir, attemptId, who);
    await ensureProvenanceDir(analysisDir);
    await writeAtomically(file, {
      ...record,
      enrichment: {
        ...record.enrichment,
        attempts: Math.max(record.enrichment.attempts, attempts),
        attempts_by_block: {
          ...record.enrichment.attempts_by_block,
          [`${who.blockKind}:${who.blockId}`]: attempts,
        },
        error,
        updated_at: new Date().toISOString(),
      },
    });
  });
}

/**
 * A mapped tool run is one attempt but several blocks, each enriched on its
 * own, so the attempt's state is read off its jobs rather than taken from
 * whichever block wrote last: complete only when every owned job has a full
 * record, unavailable as soon as one cannot have one.
 */
function attemptState(
  record: AttemptRecord,
  jobs: Record<string, ProvenanceJob>,
  reported: AttemptRecord["enrichment"]["state"],
): AttemptRecord["enrichment"]["state"] {
  if (record.kind === "invocation") return reported;
  const owned = record.ids.job_ids ?? [];
  if (owned.some((id) => jobs[id]?.unavailable)) return "unavailable";
  if (reported === "unavailable") return "unavailable";
  return owned.every((id) => jobs[id]) ? "complete" : "pending";
}

/** Synchronous existence check, for the evidence gate's tool_call hook. */
export function readAttemptRecordSync(
  analysisDir: string,
  attemptId: string,
): AttemptRecord | null {
  try {
    const file = provenancePath(analysisDir, attemptId);
    let dir = analysisDir;
    for (const part of PROVENANCE_DIR_PARTS) {
      dir = path.join(dir, part);
      if (!fs.lstatSync(dir).isDirectory()) return null;
    }
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    return isAttemptRecord(parsed) && parsed.attempt_id === attemptId ? parsed : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconcile cursor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where reconcile keeps what it has already looked at: when the analysis
 * started (the earliest work it will claim for this analysis) and, per
 * server and history, the newest `create_time` it has seen. Beside the
 * attempt records for the same reason they are here -- the window decides
 * what gets written as unattributed work, and the agent must not be able to
 * move it. Not a ULID name, so it can never collide with an attempt.
 */
function reconcileStateFile(): string {
  const connection = currentGalaxyConnection();
  return connection
    ? `reconcile-state-${connection.id}-${connection.accountId?.replace(/[^a-zA-Z0-9-]/g, "_") || "unknown"}.json`
    : "reconcile-state.json";
}

export function recordMatchesOrigin(record: AttemptRecord): boolean {
  return matchesGalaxyOrigin({
    galaxyServerUrl: record.galaxy_server_url,
    connectionId: record.connection_id,
    accountId: record.account_id,
  });
}

export interface ReconcileState {
  schema: number;
  analysis_started_at: string;
  histories: Record<string, { stamp: string }>;
  /**
   * Per server, the history a page binding bound this analysis to, sealed the
   * first time reconcile used it. Only consulted before the harness has
   * submitted anything; a later edit to the notebook's binding cannot move it.
   */
  bound_histories?: Record<string, string>;
}

export async function readReconcileState(analysisDir: string): Promise<ReconcileState | null> {
  if (!(await ensureProvenanceDir(analysisDir, false))) return null;
  const file = path.join(analysisDir, ...PROVENANCE_DIR_PARTS, reconcileStateFile());
  try {
    const stat = await fsp.lstat(file);
    if (!stat.isFile()) return null;
    const parsed = JSON.parse(await fsp.readFile(file, "utf-8")) as Partial<ReconcileState>;
    if (
      typeof parsed.analysis_started_at !== "string" ||
      Number.isNaN(Date.parse(parsed.analysis_started_at))
    ) {
      return null;
    }
    return {
      schema: PROVENANCE_SCHEMA_VERSION,
      analysis_started_at: parsed.analysis_started_at,
      histories: parsed.histories && typeof parsed.histories === "object" ? parsed.histories : {},
      ...(parsed.bound_histories && typeof parsed.bound_histories === "object"
        ? { bound_histories: parsed.bound_histories }
        : {}),
    };
  } catch {
    return null;
  }
}

export async function writeReconcileState(
  analysisDir: string,
  state: ReconcileState,
): Promise<void> {
  const dir = await ensureProvenanceDir(analysisDir);
  if (!dir) return;
  const file = path.join(dir, reconcileStateFile());
  await withFileLock(file, async () => {
    const temp = path.join(
      dir,
      `.${reconcileStateFile()}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    await fsp.writeFile(temp, JSON.stringify(state, null, 2) + "\n", {
      encoding: "utf-8",
      flag: "wx",
    });
    try {
      await fsp.rename(temp, file);
    } catch (err) {
      await fsp.rm(temp, { force: true });
      throw err;
    }
  });
}

/**
 * Every attempt record in the analysis. Unreadable or planted files are
 * skipped: this feeds decisions (which history is bound, which ids are
 * claimed), and only a well-formed record named for its own attempt counts.
 */
export async function listAttemptRecords(analysisDir: string): Promise<AttemptRecord[]> {
  const dir = await ensureProvenanceDir(analysisDir, false);
  if (!dir) return [];
  const out: AttemptRecord[] = [];
  for (const name of await fsp.readdir(dir)) {
    const id = name.endsWith(".json") ? name.slice(0, -5) : "";
    if (!isUlid(id)) continue;
    try {
      const record = await readAttemptRecord(analysisDir, id);
      if (record) out.push(record);
    } catch {
      // Not a record this module wrote.
    }
  }
  return out;
}
