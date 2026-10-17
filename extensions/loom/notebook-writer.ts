/**
 * Notebook file I/O.
 *
 * The notebook is plain user/agent-curated markdown. This module provides
 * file-system helpers and string-level utilities for the one structured
 * thing inside a notebook: `loom-invocation` fenced YAML blocks that the
 * Galaxy invocation polling tools read and write.
 */

import * as path from "path";
import {
  NotebookChangedError,
  recordStore,
  withRecordCas,
  withRecordLock,
  type RecordVersion,
} from "./record-store";
import {
  isNotebookFenceOpen,
  notebookFenceOpen,
  replaceNotebookBlocks,
} from "../../shared/notebook-fences.js";
import {
  appendIndexOutsideOpenFence,
  blockLine,
  isFoldableDuplicate,
  scanFencedBlocks,
  mergeHarnessFields,
  parseHarnessFields,
  renderHarnessFieldLines,
  stripHarnessFields,
  type HarnessBlockFields,
} from "./harness-block-fields";
import { parseProposalFields, type Proposal, type ProposalSighting } from "./registry-proposal";

/**
 * Generate slug from title for default filename.
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/**
 * The I/O below is a thin delegate onto the record store (record-store.ts).
 * These names stay because sixteen modules and their tests import them; the
 * lock, the compare-and-swap loop and the atomic file write live in the store.
 */

/** Opaque record version, the expected-value half of a compare-and-swap write. */
export type NotebookStamp = RecordVersion;

export { NotebookChangedError };

/** Per-key mutex chain; see withRecordLock. */
export const withNotebookLock = withRecordLock;

/** Version the record, or null if it isn't there. */
export const statNotebook = (filePath: string) => recordStore(filePath).stat();

/** Write the record; with `expected` it is a compare-and-swap (see RecordStore.write). */
export async function writeNotebook(
  filePath: string,
  content: string,
  expected?: NotebookStamp,
): Promise<void> {
  await recordStore(filePath).write(content, expected);
}

export async function readNotebook(filePath: string): Promise<string> {
  return (await recordStore(filePath).read()).content;
}

/** Read -> apply -> write under compare-and-swap; call with the lock held. See withRecordCas. */
export const withNotebookCas = <T>(
  filePath: string,
  apply: (content: string) => { content: string; result: T },
): Promise<T> => withRecordCas(recordStore(filePath), apply);

/**
 * Default notebook path for a session directory. `title` is kept in the
 * signature for API stability but is no longer used — every session dir
 * stores its notebook as `notebook.md`.
 */
export function getDefaultNotebookPath(_title: string, directory: string): string {
  return path.join(directory, "notebook.md");
}

// ─────────────────────────────────────────────────────────────────────────────
// Invocation YAML blocks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structured Galaxy invocation record embedded in the notebook as a
 * `loom-invocation` fenced YAML block. The block format is intentionally
 * line-oriented and grep-friendly:
 *
 * ```loom-invocation
 * invocation_id: abc123
 * galaxy_server_url: https://usegalaxy.org
 * notebook_anchor: plan-1-step-3
 * label: BWA alignment
 * submitted_at: 2026-04-25T15:30:00Z
 * status: in_progress
 * summary: ""
 * ```
 *
 * Status transitions (`in_progress` → `completed`/`failed`) are written by
 * the invocation polling tools (see tools.ts). The block is the source of
 * truth — there's no in-memory cache.
 */
export interface InvocationYaml extends HarnessBlockFields {
  invocationId: string;
  galaxyServerUrl: string;
  notebookAnchor: string;
  label: string;
  submittedAt: string;
  status: "in_progress" | "completed" | "failed";
  summary?: string;
  /**
   * Whether Galaxy confirmed this invocation id exists at record time.
   *
   * `false` means the record tool asked and didn't get an answer (Galaxy
   * unreachable, credentials gone) — the run is written down anyway, because
   * losing a real submission to a transient network is worse than an
   * unconfirmed line, and the first successful poll upgrades it. Absent means
   * the block predates the field and nothing has claimed either way.
   */
  serverVerified?: boolean;
  // Progress counters — populated by galaxy_invocation_check_*. Persisted
  // back to the YAML so the Orbit renderer can draw a live progress bar
  // without each side polling Galaxy independently. Optional so older
  // blocks (and the initial record-time write) round-trip cleanly.
  totalSteps?: number;
  completedSteps?: number;
  totalJobs?: number;
  completedJobs?: number;
  failedJobs?: number;
  lastPolledAt?: string;
}

const INVOCATION_FENCE_OPEN = notebookFenceOpen("invocation");
const INVOCATION_FENCE_CLOSE = "```";

/**
 * Render an invocation as a `loom-invocation` fenced block. The trailing
 * newline is intentional so blocks can be appended cleanly.
 */
export function renderInvocationYaml(inv: InvocationYaml): string {
  const lines: string[] = [
    INVOCATION_FENCE_OPEN,
    blockLine("invocation_id", inv.invocationId, "invocationId"),
    blockLine("galaxy_server_url", inv.galaxyServerUrl),
    blockLine("notebook_anchor", inv.notebookAnchor, "notebookAnchor"),
    `label: ${escapeYaml(inv.label)}`,
    blockLine("submitted_at", inv.submittedAt),
    `status: ${inv.status}`,
    `summary: ${escapeYaml(inv.summary ?? "")}`,
  ];
  if (inv.serverVerified !== undefined) lines.push(`server_verified: ${inv.serverVerified}`);
  if (inv.totalSteps !== undefined) lines.push(`total_steps: ${inv.totalSteps}`);
  if (inv.completedSteps !== undefined) lines.push(`completed_steps: ${inv.completedSteps}`);
  if (inv.totalJobs !== undefined) lines.push(`total_jobs: ${inv.totalJobs}`);
  if (inv.completedJobs !== undefined) lines.push(`completed_jobs: ${inv.completedJobs}`);
  if (inv.failedJobs !== undefined) lines.push(`failed_jobs: ${inv.failedJobs}`);
  if (inv.lastPolledAt) lines.push(blockLine("last_polled_at", inv.lastPolledAt));
  lines.push(...renderHarnessFieldLines(inv));
  lines.push(INVOCATION_FENCE_CLOSE);
  return lines.join("\n") + "\n";
}

/**
 * Find every `loom-invocation` block in the notebook content and parse
 * each into an InvocationYaml. Skips blocks that fail validation.
 */
export function findInvocationBlocks(content: string): InvocationYaml[] {
  const lines = content.split("\n");
  const result: InvocationYaml[] = [];
  for (const range of scanFencedBlocks(lines, "invocation")) {
    const parsed = parseInvocationBlock(lines.slice(range.start + 1, range.end));
    if (parsed) result.push(parsed);
  }
  return result;
}

/**
 * Find the first `loom-invocation` block physically carrying this id, and what
 * it parses to.
 *
 * Two lookups used to answer "is there a block for this id": the range finder,
 * which matches an `invocation_id:` line inside a fence, and
 * `findInvocationBlocks`, which additionally requires the block to be
 * well-formed. They can disagree -- a block with an empty `label` is found by
 * the first and rejected by the second -- and every caller that asked one
 * question of one and one of the other was reading a different block than the
 * one it was about to overwrite. This answers both from the same physical
 * block, so they cannot drift apart. `present` with a null `record` means the
 * block is there but unreadable, which is a refusal, not a licence to
 * overwrite it.
 */
export function locateInvocationBlock(
  content: string,
  invocationId: string,
): { present: boolean; record: InvocationYaml | null } {
  const lines = content.split("\n");
  const range = findInvocationBlockRanges(content).find((b) => b.invocationId === invocationId);
  if (!range) return { present: false, record: null };
  return { present: true, record: parseInvocationBlock(lines.slice(range.start + 1, range.end)) };
}

/**
 * Upsert a `loom-invocation` block in the notebook content keyed by
 * `invocation_id`. If a block with the same id exists, replace it in
 * place (preserving surrounding whitespace). Otherwise append at the
 * end of the file with a leading blank line for readability.
 *
 * Harness-only fields on `inv` are always discarded. They come either from
 * the block already on disk (so an agent or poller write carries them
 * forward untouched) or from the explicit `harness` argument, which only the
 * auto-registration and enrichment paths pass. A caller cannot set
 * `submitted_by: harness` by spreading tool arguments into the record, which
 * is the whole point of that field. `server_verified` is not one of them --
 * see harness-block-fields.ts -- so the record tools' and the poller's writes
 * of it pass straight through.
 */
export function upsertInvocationBlock(
  content: string,
  inv: InvocationYaml,
  harness?: HarnessBlockFields,
): string {
  const blocks = findInvocationBlockRanges(content);
  const lines = content.split("\n");

  // More than one can match when an older writer used the other fence prefix;
  // the first is rewritten and foldable duplicates collapse into it.
  const matching = blocks.filter(
    (b) => b.invocationId === inv.invocationId && isUnambiguousRange(lines, b.start),
  );
  const existing = matching[0];
  // Provenance comes off the block this write is about to replace, read from
  // its raw lines rather than from a second scan of the file. A scan can land
  // on a different block with the same id, and it drops a block the strict
  // parser rejects -- either way the carry-forward would be sourced from
  // somewhere other than the bytes being overwritten.
  const onDiskRaw = existing
    ? rawInvocationFields(lines.slice(existing.start + 1, existing.end))
    : {};
  const onDisk = parseHarnessFields((key) => onDiskRaw[key]);
  const merged: InvocationYaml = {
    ...stripHarnessFields(inv),
    ...mergeHarnessFields(onDisk, harness ?? {}),
  };
  const newBlock = renderInvocationYaml(merged).trimEnd().split("\n");

  if (existing) {
    const replaced = matching.filter(
      (b) =>
        b === existing ||
        isFoldableDuplicate(
          onDiskRaw.attempt_id,
          rawInvocationFields(lines.slice(b.start + 1, b.end)).attempt_id,
        ),
    );
    return replaceNotebookBlocks(content, replaced, newBlock);
  }

  return appendBlock(content, newBlock);
}

/**
 * Whether a block starting here can be replaced in place.
 *
 * Only when no Loom fence before it is still open. Past an unclosed opener the
 * scanners cannot tell whose closing fence is whose: a bare ``` after an
 * unterminated `loom-job` and a `loom-invocation` opener could end either one,
 * and reading it as the invocation's means its "body" runs through whatever
 * the user wrote in between. Field-shaped prose (`note: keep this`) sits
 * inside that body and a replacement would take it with it.
 *
 * Refusing to replace is the answer rather than a stricter body rule, because
 * "every line is a field this version knows" is not a property we can require:
 * a notebook written by a newer Loom carries fields this one has never heard
 * of, and the parsers ignore unknown keys on purpose. So a block in the
 * ambiguous region is left exactly as it is and a clean one is written above
 * the orphan. That costs one duplicate in an already-broken notebook, and the
 * duplicate is unambiguous, so it is the one every write after this finds.
 */
export function isUnambiguousRange(lines: readonly string[], start: number): boolean {
  return start < appendIndexOutsideOpenFence(lines);
}

/**
 * Append a rendered block, or slot it in ahead of an unclosed fence so its own
 * closing line cannot become that fence's. See `appendIndexOutsideOpenFence`.
 */
export function appendBlock(content: string, newBlock: string[]): string {
  const lines = content.split("\n");
  const at = appendIndexOutsideOpenFence(lines);
  if (at < lines.length) {
    const before = lines.slice(0, at).join("\n").replace(/\s+$/, "");
    const sep = before.length > 0 ? "\n\n" : "";
    return `${before}${sep}${newBlock.join("\n")}\n\n${lines.slice(at).join("\n")}`;
  }
  const trimmed = content.replace(/\s+$/, "");
  const sep = trimmed.length > 0 ? "\n\n" : "";
  return trimmed + sep + newBlock.join("\n") + "\n";
}

/**
 * What one Galaxy poll learned about an invocation — the fields the poller
 * owns, and nothing else.
 *
 * Deliberately not a whole `InvocationYaml`: `label`, `notebook_anchor`,
 * `submitted_at` and friends belong to whoever recorded the invocation, and
 * writing back a copy captured before the Galaxy round trip would clobber an
 * edit the agent made in the meantime — #391 again, one block down.
 */
export interface InvocationPollUpdate {
  invocationId: string;
  totalSteps: number;
  completedSteps: number;
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  lastPolledAt: string;
  /**
   * True when this update came from a Galaxy round trip that answered — which
   * is proof the id exists, and the only thing that clears a block recorded
   * `server_verified: false`.
   */
  serverVerified?: boolean;
  /** Present only when this poll decided the invocation reached a terminal state. */
  transition?: { status: InvocationYaml["status"]; summary: string };
}

/**
 * Fold a batch of freshly-polled invocations into notebook content that was
 * read *after* the poll, so the result is built on current bytes rather than a
 * pre-poll snapshot (#391). Each update is merged onto the block as it exists
 * in `content`, so fields the poller doesn't own survive.
 *
 * Three updates are dropped rather than applied:
 *   - the block is gone from `content` — someone deleted it while we were
 *     talking to Galaxy, and `upsertInvocationBlock` would resurrect it at the
 *     end of the file;
 *   - the block on disk carries a newer `last_polled_at` than ours — a second
 *     poller (another Loom process, or the agent calling check_all while the
 *     background timer is mid-tick) already recorded a later reading, and our
 *     counters would walk it backwards;
 *   - the update would reopen a block that is already terminal on disk. A poll
 *     that saw a job erroring while others ran writes `in_progress` on purpose,
 *     and a slow round trip can deliver that verdict *after* a faster checker
 *     recorded the run's real end — our timestamp is later, our snapshot isn't.
 *     Nothing ever moves a terminal block back to running, so the reopening is
 *     always the stale one.
 *
 * A transition always lands, including one terminal state correcting another:
 * completion is inferred from the jobs Galaxy has materialized so far, so a
 * poll that catches a workflow mid-schedule can call it complete and a later
 * one has to be able to say otherwise. Refusing that would pin `completed` next
 * to a nonzero `failed_jobs` — the counters and the status must agree.
 *
 * Returns the ids written, and separately the ids whose status this batch
 * actually changed. The caller needs the second set to know which transitions
 * are its to announce: re-writing `completed` over `completed` is a refresh,
 * not news, and shouldn't produce a second "your workflow finished" toast.
 */
export function applyInvocationUpdates(
  content: string,
  updates: InvocationPollUpdate[],
): { content: string; applied: string[]; transitioned: string[] } {
  let next = content;
  const applied: string[] = [];
  const transitioned: string[] = [];
  for (const update of updates) {
    const current = findInvocationBlocks(next).find((b) => b.invocationId === update.invocationId);
    if (!current) continue;
    if (isNewerPoll(current.lastPolledAt, update.lastPolledAt)) continue;
    if (update.transition?.status === "in_progress" && current.status !== "in_progress") continue;
    const merged: InvocationYaml = {
      ...current,
      totalSteps: update.totalSteps,
      completedSteps: update.completedSteps,
      totalJobs: update.totalJobs,
      completedJobs: update.completedJobs,
      failedJobs: update.failedJobs,
      lastPolledAt: update.lastPolledAt,
      // A poll Galaxy answered is proof the id exists, so it clears a block the
      // record tool could only write unverified. A block with no flag at all
      // predates the field; leave it alone rather than churn every old block in
      // the notebook on the next tick.
      ...(update.serverVerified && current.serverVerified === false
        ? { serverVerified: true }
        : {}),
      ...(update.transition ?? {}),
    };
    next = upsertInvocationBlock(next, merged);
    applied.push(update.invocationId);
    if (merged.status !== current.status) transitioned.push(update.invocationId);
  }
  return { content: next, applied, transitioned };
}

/**
 * How far ahead of now an on-disk `last_polled_at` may sit and still be read as
 * a real reading. A competing poller stamps its update within milliseconds of
 * ours -- the window only has to cover clock differences between two writers of
 * the same file, which is seconds at worst.
 */
const MAX_POLL_CLOCK_SKEW_MS = 60_000;

/**
 * True when `onDisk` is a strictly later poll timestamp than `ours`.
 *
 * A timestamp further ahead than the skew window did not come from a poll: it
 * came from someone editing the block, and honouring it silences the poller for
 * that invocation permanently -- every later update looks stale forever. Nobody
 * can outrun the clock, so an implausible future reading is ignored rather than
 * obeyed.
 */
function isNewerPoll(onDisk: string | undefined, ours: string | undefined): boolean {
  if (!onDisk || !ours) return false;
  const a = Date.parse(onDisk);
  const b = Date.parse(ours);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  if (a > Date.now() + MAX_POLL_CLOCK_SKEW_MS) return false;
  return a > b;
}

interface InvocationBlockRange {
  invocationId: string;
  start: number;
  end: number;
}

function findInvocationBlockRanges(content: string): InvocationBlockRange[] {
  const lines = content.split("\n");
  const result: InvocationBlockRange[] = [];
  for (const range of scanFencedBlocks(lines, "invocation")) {
    let invocationId: string | null = null;
    for (let i = range.start + 1; i < range.end; i++) {
      const m = lines[i].match(/^invocation_id:\s*(.+)$/);
      if (m) invocationId = m[1].trim();
    }
    if (invocationId) result.push({ invocationId, start: range.start, end: range.end });
  }
  return result;
}

/**
 * A YAML boolean, or undefined for anything else — including a hand-edited
 * value we can't read. Absent and unreadable both mean "nobody has claimed
 * this", which is the honest default for a flag about a server round trip.
 */
function parseBooleanField(raw: string | undefined): boolean | undefined {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

/**
 * The block's `key: value` lines, untouched.
 *
 * Harness fields are bare tokens or single-line JSON, so they are read from
 * the raw text: running `unescapeYaml` over a JSON array would strip nothing
 * today but would silently mangle the first value that starts and ends with a
 * quote. The upsert reads carry-forward provenance through here too, which is
 * why it is separate from `parseInvocationBlock` -- provenance has to survive
 * a block the strict parser rejects.
 */
function rawInvocationFields(blockLines: string[]): Record<string, string> {
  const rawFields: Record<string, string> = {};
  for (const line of blockLines) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) rawFields[m[1]] = m[2].trim();
  }
  return rawFields;
}

function parseInvocationBlock(blockLines: string[]): InvocationYaml | null {
  const rawFields = rawInvocationFields(blockLines);
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawFields)) fields[key] = unescapeYaml(value);
  const status = fields.status as InvocationYaml["status"];
  // `galaxy_server_url` is metadata, not identity, and it is deliberately not
  // required: it comes from GALAXY_URL, which can be absent (or arrive later
  // via /connect) while the submission itself is perfectly real. Requiring it
  // meant a block written without it parsed back as null, so the poller never
  // saw the run and the notebook looked like it had a record when nothing was
  // watching. The job block has always tolerated an empty one; these now agree.
  if (
    !fields.invocation_id ||
    !fields.notebook_anchor ||
    !fields.label ||
    !fields.submitted_at ||
    (status !== "in_progress" && status !== "completed" && status !== "failed")
  ) {
    return null;
  }
  const numField = (key: string): number | undefined => {
    const raw = fields[key];
    if (raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    invocationId: fields.invocation_id,
    galaxyServerUrl: fields.galaxy_server_url ?? "",
    notebookAnchor: fields.notebook_anchor,
    label: fields.label,
    submittedAt: fields.submitted_at,
    status,
    summary: fields.summary || undefined,
    serverVerified: parseBooleanField(fields.server_verified),
    totalSteps: numField("total_steps"),
    completedSteps: numField("completed_steps"),
    totalJobs: numField("total_jobs"),
    completedJobs: numField("completed_jobs"),
    failedJobs: numField("failed_jobs"),
    lastPolledAt: fields.last_polled_at || undefined,
    ...parseHarnessFields((key) => rawFields[key]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Proposal blocks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `loom-proposal` block: a concrete run the model proposes and the user can
 * approve (registry design v3 §5). Same line grammar as every other block --
 * one `key: value` per line, the structured fields as single-line JSON --
 * and the same forward compatibility: unknown keys are ignored on read.
 *
 * ```loom-proposal
 * proposal_id: prop-7k2m9x
 * step_anchor: plan-a-step-2
 * label: Trim reads
 * target: {"kind":"tool","tool_id":"fastp","version":"unpinned"}
 * server_url: https://usegalaxy.org
 * history_id: df8fe5ddadbf3ab1
 * inputs: [{"slot":"reads","src":"hda","id":"4b6e2f1a9c3d5e70"}]
 * overrides: [{"param":"threads","value":4,"rationale":"four cores"}]
 * predicate: {"kind":"manual"}
 * assertions: []
 * template_digest: <sha256 of the template it was validated against>
 * created_at: 2026-10-07T12:00:00.000Z
 * spec_revision: <written by the harness after /approve>
 * ```
 *
 * Nothing in the block is trusted. `spec_revision` is written by the harness
 * after an approval so a reader can see one happened, but it is display only:
 * the parser does not return it, and whether a proposal is approved is a
 * question for the registry.
 */
export interface ProposalBlock {
  /** The id the block claims, even when the rest of it doesn't parse. */
  proposalId: string | null;
  proposal: Proposal | null;
  errors: string[];
  start: number;
  end: number;
}

const PROPOSAL_FENCE_OPEN = notebookFenceOpen("proposal");

export function renderProposalBlock(p: Proposal, harness: { specRevision?: string } = {}): string {
  const lines: string[] = [
    PROPOSAL_FENCE_OPEN,
    blockLine("proposal_id", p.proposalId),
    blockLine("step_anchor", p.stepAnchor),
  ];
  if (p.label) lines.push(`label: ${escapeYaml(p.label)}`);
  lines.push(
    `target: ${JSON.stringify(p.target)}`,
    blockLine("server_url", p.serverUrl),
    blockLine("history_id", p.historyId),
    `inputs: ${JSON.stringify(p.inputs)}`,
    `overrides: ${JSON.stringify(p.overrides)}`,
    `predicate: ${JSON.stringify(p.predicate)}`,
    `assertions: ${JSON.stringify(p.assertions)}`,
  );
  if (p.templateDigest) lines.push(blockLine("template_digest", p.templateDigest));
  if (p.createdAt) lines.push(blockLine("created_at", p.createdAt));
  if (harness.specRevision && /^[0-9a-f]{64}$/.test(harness.specRevision)) {
    lines.push(`spec_revision: ${harness.specRevision}`);
  }
  lines.push("```");
  return lines.join("\n") + "\n";
}

/** Every `loom-proposal` block, readable or not, in notebook order. */
export function findProposalBlocks(content: string): ProposalBlock[] {
  const lines = content.split("\n");
  const out: ProposalBlock[] = [];
  for (const range of scanFencedBlocks(lines, "proposal")) {
    const raw = rawInvocationFields(lines.slice(range.start + 1, range.end));
    const get = (key: string): string | undefined =>
      raw[key] === undefined ? undefined : key === "label" ? unescapeYaml(raw[key]) : raw[key];
    const { proposal, errors } = parseProposalFields(get);
    out.push({
      proposalId: raw.proposal_id || null,
      proposal,
      errors,
      start: range.start,
      end: range.end,
    });
  }
  return out;
}

/** What the notebook says about each proposal id, for the registry's checks. */
export function proposalSightings(content: string): ProposalSighting[] {
  return findProposalBlocks(content)
    .filter((b): b is ProposalBlock & { proposalId: string } => b.proposalId !== null)
    .map((b) => ({ proposalId: b.proposalId, proposal: b.proposal }));
}

/**
 * Append a new proposal block. Refuses an id the notebook already has: a
 * proposal is written once, and a changed one is a new proposal.
 */
export function appendProposalBlock(content: string, p: Proposal): string {
  if (findProposalBlocks(content).some((b) => b.proposalId === p.proposalId)) {
    throw new Error(`proposal ${p.proposalId} is already in the notebook`);
  }
  return appendBlock(content, renderProposalBlock(p).trimEnd().split("\n"));
}

/**
 * Write `spec_revision` into the one block carrying this id, or take it out
 * (`null`, after a revoke), touching no other line of it. Returns the content
 * unchanged when there isn't exactly one unambiguous block -- the registry
 * already holds the truth, and this is only the echo.
 */
export function setProposalSpecRevision(
  content: string,
  proposalId: string,
  specRevision: string | null,
): string {
  if (specRevision !== null && !/^[0-9a-f]{64}$/.test(specRevision)) return content;
  const lines = content.split("\n");
  const blocks = findProposalBlocks(content).filter((b) => b.proposalId === proposalId);
  if (blocks.length !== 1 || !isUnambiguousRange(lines, blocks[0].start)) return content;
  const { start, end } = blocks[0];
  const body = lines.slice(start + 1, end).filter((l) => !/^spec_revision:/.test(l));
  if (specRevision !== null) body.push(`spec_revision: ${specRevision}`);
  return [...lines.slice(0, start + 1), ...body, ...lines.slice(end)].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Session summary YAML blocks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `loom-session` block, appended on `session_shutdown`. Pairs with the
 * notebook's role as the durable record: when a Pi session dies mid-poll,
 * a fresh session can read the most recent `loom-session` block to learn
 * what was in flight and re-orient. `orphaned_active_steps` is 0 today
 * (typed plan-step blocks don't exist yet); the field is here so the
 * schema stays stable when that follow-up lands.
 */
export interface SessionSummaryYaml {
  id: string;
  startedAt: string;
  endedAt: string;
  notebook: string;
  orphanedActiveSteps: number;
}

const SESSION_FENCE_OPEN = notebookFenceOpen("session");
const SESSION_FENCE_CLOSE = "```";

export function renderSessionSummaryYaml(s: SessionSummaryYaml): string {
  const lines: string[] = [
    SESSION_FENCE_OPEN,
    `id: ${s.id}`,
    `started_at: ${s.startedAt}`,
    `ended_at: ${s.endedAt}`,
    `notebook: ${s.notebook}`,
    `orphaned_active_steps: ${s.orphanedActiveSteps}`,
    SESSION_FENCE_CLOSE,
  ];
  return lines.join("\n") + "\n";
}

/**
 * Append a session summary block at the end of the notebook content. This is
 * the low-level primitive used for a session id never seen before; callers
 * that finalize a session should use `upsertSessionSummaryBlock`, which keys
 * on `id` and routes here only for first-seen ids.
 */
export function appendSessionSummaryBlock(content: string, s: SessionSummaryYaml): string {
  const block = renderSessionSummaryYaml(s).trimEnd();
  const trimmed = content.replace(/\s+$/, "");
  const sep = trimmed.length > 0 ? "\n\n" : "";
  return trimmed + sep + block + "\n";
}

/**
 * Upsert a `loom-session` block keyed by `id`. A first-seen id appends a new
 * block (chronological log of distinct sessions); a seen id collapses every
 * block sharing that id, plus the new finalize, into a single merged block
 * that spans the session id's full lifetime.
 *
 * Why upsert and not append (#260): Pi can hand back the *same* session id
 * when an idle session is resumed, so a blind append wrote two blocks under
 * one id and broke the id's role as a unique key. Collapsing keeps exactly
 * one block per id -- and self-heals a notebook the old append path already
 * left with duplicates.
 *
 * The merged block keeps the position of the id's first block, so blocks stay
 * in first-seen order. That order can diverge from strict `ended_at` order if
 * a non-latest session is resumed; no consumer relies on positional recency
 * today, and keeping the slot avoids reshuffling the user's notebook.
 */
export function upsertSessionSummaryBlock(content: string, s: SessionSummaryYaml): string {
  const matching = findSessionSummaryBlockRanges(content).filter((r) => r.summary.id === s.id);
  if (matching.length === 0) {
    return appendSessionSummaryBlock(content, s);
  }
  const merged = matching.reduce((acc, r) => mergeSessionSummary(acc, r.summary), s);
  const newBlock = renderSessionSummaryYaml(merged).trimEnd().split("\n");
  return replaceNotebookBlocks(content, matching, newBlock);
}

/**
 * Merge finalizes of the same session id into one record. Keep the earliest
 * start and the latest end so the block spans the whole lifetime across
 * resumes; carry the orphan count from whichever finalize ended later (the
 * authoritative end state).
 */
function mergeSessionSummary(
  prev: SessionSummaryYaml,
  next: SessionSummaryYaml,
): SessionSummaryYaml {
  const nextEndsLater = compareTimestamps(next.endedAt, prev.endedAt) >= 0;
  return {
    id: next.id,
    startedAt:
      compareTimestamps(next.startedAt, prev.startedAt) < 0 ? next.startedAt : prev.startedAt,
    endedAt: nextEndsLater ? next.endedAt : prev.endedAt,
    notebook: next.notebook,
    orphanedActiveSteps: nextEndsLater ? next.orphanedActiveSteps : prev.orphanedActiveSteps,
  };
}

// Order two timestamps. The shutdown writer always emits valid ISO-8601 UTC,
// which Date.parse compares correctly (including across offsets). Fall back to
// a lexical compare only if a hand-edited value won't parse, so the result is
// still deterministic rather than NaN-poisoned.
function compareTimestamps(a: string, b: string): number {
  const na = Date.parse(a);
  const nb = Date.parse(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

interface SessionSummaryBlockRange {
  summary: SessionSummaryYaml;
  start: number;
  end: number;
}

function findSessionSummaryBlockRanges(content: string): SessionSummaryBlockRange[] {
  const result: SessionSummaryBlockRange[] = [];
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (isNotebookFenceOpen(lines[i], "session")) {
      const start = i;
      let end = start + 1;
      while (end < lines.length && lines[end].trim() !== SESSION_FENCE_CLOSE) {
        end++;
      }
      const summary = parseSessionSummaryBlock(lines.slice(start + 1, end));
      if (summary) result.push({ summary, start, end });
      i = end + 1;
    } else {
      i++;
    }
  }
  return result;
}

/**
 * Find every `loom-session` block in the notebook content and parse each.
 * Skips blocks that fail validation. Used by `session_start` to surface
 * any orphaned-active state from the previous session.
 */
export function findSessionSummaryBlocks(content: string): SessionSummaryYaml[] {
  const result: SessionSummaryYaml[] = [];
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (isNotebookFenceOpen(lines[i], "session")) {
      const start = i + 1;
      let end = start;
      while (end < lines.length && lines[end].trim() !== SESSION_FENCE_CLOSE) {
        end++;
      }
      const parsed = parseSessionSummaryBlock(lines.slice(start, end));
      if (parsed) result.push(parsed);
      i = end + 1;
    } else {
      i++;
    }
  }
  return result;
}

function parseSessionSummaryBlock(blockLines: string[]): SessionSummaryYaml | null {
  const fields: Record<string, string> = {};
  for (const line of blockLines) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) fields[m[1]] = unescapeYaml(m[2].trim());
  }
  if (!fields.id || !fields.started_at || !fields.ended_at || !fields.notebook) {
    return null;
  }
  const orphaned = Number(fields.orphaned_active_steps);
  return {
    id: fields.id,
    startedAt: fields.started_at,
    endedAt: fields.ended_at,
    notebook: fields.notebook,
    orphanedActiveSteps: Number.isFinite(orphaned) ? orphaned : 0,
  };
}

/**
 * Quote a free-text value so it stays on one line.
 *
 * `JSON.stringify` rather than hand-rolled quoting: the old version escaped
 * quotes but passed a newline straight through, so a label spanning two lines
 * rendered as two block fields and the second one was read back as a field of
 * the caller's choosing. A label is agent-supplied on both record tools, which
 * made that a way to write provenance the writers refuse.
 */
function escapeYaml(value: string): string {
  // Quote if contains characters that would confuse the line parser.
  if (/[:#"\\\u0000-\u001f\u007f-\u009f]/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function unescapeYaml(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      // Blocks written before escapeYaml used JSON quoting: quotes were
      // escaped, a lone backslash was not, so JSON.parse can fail on a value
      // that was perfectly readable under the old rule.
      return value.slice(1, -1).replace(/\\"/g, '"');
    }
  }
  return value;
}
