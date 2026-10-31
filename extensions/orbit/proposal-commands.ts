/**
 * Propose and approve (#476, registry design v3 §4-§5): the `loom_propose`
 * tool the model writes proposals with, and the `/approve`, `/revoke` and
 * `/pending` commands the user answers with.
 *
 * Consent has to come from a surface the model cannot drive. These are slash
 * commands, which pi runs only for input a person typed (or Orbit's prompt
 * box sent): a message an extension sends on the model's behalf goes through
 * `sendUserMessage`, which does not expand commands. So `loom_propose` can put
 * a proposal in front of the user, and nothing the model does can approve it.
 * A plain chat approval ("go ahead and run it") counts too, but only when it
 * arrives as user-sourced input (never "extension"), says nothing but approve,
 * answers the reply that named the proposal, and that proposal is the only one
 * pending, written by loom_propose in this session and unedited since. Without
 * a dialog it stands in for --yes only in an eval (ORBIT_EVAL_CHAT_APPROVAL).
 *
 * What an approval covers is fixed by the harness, not by the block: `/approve`
 * fetches the template itself, shows the user the table it is about to freeze,
 * re-reads the block afterwards and refuses if it moved, and records the Spec
 * in the signed registry. Any later edit that changes what the proposal
 * amounts to revokes the approval on the next read of the notebook.
 *
 * Submission still goes through the existing tools until `loom_submit` lands.
 */

import { randomBytes } from "crypto";
import * as path from "path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { appendActivityEvent } from "./activity";
import { getGalaxyConfig } from "./galaxy-api";
import {
  ambiguousAnchorMessage,
  listNotebookAnchors,
  resolveNotebookAnchor,
  unknownAnchorMessage,
} from "./notebook-anchors";
import {
  appendProposalBlock,
  findProposalBlocks,
  proposalSightings,
  setProposalSpecRevision,
  withNotebookCas,
  withNotebookLock,
  type ProposalBlock,
} from "./notebook-writer";
import { isRecordMissing, recordStore } from "./record-store";
import { canonicalJson, normalizeServerUrl, sha256Hex } from "./registry";
import {
  approveProposal,
  attemptsForProposal,
  canonicalizeProposal,
  checkInputFormats,
  describePredicate,
  findDrift,
  liveApproval,
  mappedOverSlots,
  newProposalId,
  parseInputs,
  parseOverrides,
  parsePredicate,
  parseTarget,
  pendingProposals,
  PROPOSAL_ID_RE,
  renderProposalTable,
  revokeProposal,
  templateShape,
  validateProposal,
  type Drift,
  type Proposal,
  type TemplateShape,
} from "./registry-proposal";
import {
  flushHeldRevocations,
  getSessionRegistry,
  heldRevocations,
  sessionView,
  type SessionRegistry,
} from "./registry-runtime";

export { sessionView };
import {
  inputFormatFetcherFor,
  primeTemplateReplay,
  TemplateUnavailableError,
  templateFetcherFor,
  type InputFormatFetcher,
  type TemplateFetcher,
} from "./registry-templates";
import { getCurrentHistoryId, getNotebookPath, onNotebookChange } from "./state";
import { readEnv } from "../../shared/orbit-env.js";

/** Everything the propose/approve flow reads from the session, so tests can supply it. */
export interface ProposalDeps {
  registry: () => SessionRegistry | null;
  notebookPath: () => string | null;
  galaxyUrl: () => string | null;
  historyId: () => string | null;
  fetcher: (sessionDir: string) => TemplateFetcher;
  /** Reads the inputs' datatypes for the format check; absent or null skips it. */
  formats?: (sessionDir: string) => InputFormatFetcher | null;
  /** ISO timestamp. */
  now: () => string;
  random: (n: number) => Uint8Array;
  /** Eval-only: ids to mint before falling back to random ones. */
  seededIds?: () => string[];
  /** Eval-only: a chat approval counts where there's no dialog to show the table in. */
  chatWithoutDialog?: () => boolean;
}

export const defaultDeps: ProposalDeps = {
  registry: getSessionRegistry,
  notebookPath: getNotebookPath,
  galaxyUrl: () => getGalaxyConfig()?.url ?? null,
  historyId: getCurrentHistoryId,
  fetcher: templateFetcherFor,
  formats: inputFormatFetcherFor,
  now: () => new Date().toISOString(),
  random: (n) => randomBytes(n),
  // An eval can only type "/approve <id>" if it knows the id before the model mints it.
  seededIds: () =>
    (readEnv("EVAL_PROPOSAL_IDS") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  // json mode has no dialog, and an eval can't type --yes into a plain-language approval.
  chatWithoutDialog: () => readEnv("EVAL_CHAT_APPROVAL") === "1",
};

/** No assertion definitions exist yet (#477), so naming one is refused. */
function assertionDefinitions(_ids: string[]): Map<string, unknown> {
  return new Map();
}

function activity(
  deps: ProposalDeps,
  kind: string,
  source: string,
  payload: Record<string, unknown>,
) {
  const nb = deps.notebookPath();
  if (!nb) return;
  appendActivityEvent(path.dirname(nb), { timestamp: deps.now(), kind, source, payload });
}

async function readRecordOrNull(nb: string): Promise<string | null> {
  try {
    return (await recordStore(nb).read()).content;
  } catch {
    return null;
  }
}

/** Why this session can't record approvals, or null when it can. */
function cannotWrite(session: SessionRegistry | null): string | null {
  if (!session) return "the approval registry isn't open in this session";
  if (session.unavailable)
    return `the approval registry couldn't be opened (${session.unavailable})`;
  if (session.store.mode !== "writer") {
    return "the approval registry is read-only in this session (another session holds it)";
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Revoke on edit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Revoke every live approval the notebook, as `content` reads now, no longer
 * backs. Runs on every notebook change and before every command, so an edit
 * can't outlive the next look at the notebook.
 */
export function checkProposalDrift(deps: ProposalDeps, content: string): Drift[] {
  const session = deps.registry();
  if (!session) return [];
  const nb = deps.notebookPath();
  const notebook = content;
  const stepExists = (anchor: string) => {
    const r = resolveNotebookAnchor(notebook, anchor);
    return r.kind === "resolved" && r.anchor === anchor;
  };

  // Drift is computed whatever the store's mode. A session that approved
  // something and then lost the lock (or whose revocation write failed) still
  // holds that approval as live in memory, and every reader has to stop
  // treating it as live the moment the notebook stops backing it.
  const { store } = session;
  const held = heldRevocations(store);
  const fresh = findDrift(store.snapshot(), proposalSightings(notebook), stepExists).filter(
    (d) => !held.has(d.attemptId),
  );
  for (const d of fresh) held.set(d.attemptId, d);
  const written = flushHeldRevocations(store);
  for (const d of fresh) {
    activity(deps, "proposal.revoked", "harness", {
      proposal_id: d.proposalId,
      attempt_id: d.attemptId,
      reason: d.reason,
      ...(written.has(d.attemptId) ? {} : { recorded: "in memory; registry not writable" }),
    });
  }
  if (fresh.length > 0 && nb)
    void clearEchoes(
      nb,
      fresh.map((d) => d.proposalId),
    );
  return fresh;
}

async function clearEchoes(nb: string, ids: string[]): Promise<void> {
  try {
    await withNotebookLock(nb, () =>
      withNotebookCas(nb, (content) => {
        let next = content;
        for (const id of ids) next = setProposalSpecRevision(next, id, null);
        return { content: next, result: undefined };
      }),
    );
  } catch {
    // Display only; the registry already says revoked.
  }
}

/** The drift check against the record as it reads right now. */
export async function checkProposalDriftNow(deps: ProposalDeps): Promise<Drift[]> {
  if (!deps.registry()) return [];
  const nb = deps.notebookPath();
  if (!nb) return [];
  let text: string;
  try {
    text = (await recordStore(nb).read()).content;
  } catch (error) {
    // A notebook that's gone takes its proposals with it. One that can't be
    // read right now (a page outage, a permissions hiccup) is left for the
    // next look.
    if (!isRecordMissing(error)) return [];
    text = "";
  }
  return checkProposalDrift(deps, text);
}

// ─────────────────────────────────────────────────────────────────────────────
// loom_propose
// ─────────────────────────────────────────────────────────────────────────────

export interface ProposeParams {
  step_anchor: string;
  label?: string;
  target: { kind: string; id: string; version?: string };
  history_id?: string;
  inputs: unknown;
  overrides?: unknown;
  predicate?: unknown;
  assertions?: string[];
}

export type ProposeResult =
  | {
      ok: true;
      proposal: Proposal;
      table: string;
      /** Slots given a collection that the run maps over, one job per element. */
      mappedOver: string[];
      /** Inputs whose format couldn't be checked, and why. */
      formatsUnchecked: string[];
    }
  | { ok: false; problems: string[] };

/**
 * The format check (#618), when this session can ask Galaxy. A dataset the
 * slot can't take is a problem; one it couldn't judge is only noted.
 */
async function checkFormats(
  deps: ProposalDeps,
  nb: string,
  proposal: Proposal,
  shape: TemplateShape,
  signal?: AbortSignal,
): Promise<{ problems: string[]; unchecked: string[] }> {
  const fetch = deps.formats?.(path.dirname(nb));
  if (!fetch) return { problems: [], unchecked: [] };
  return checkInputFormats(proposal, shape, await fetch(proposal.inputs, signal));
}

/**
 * Validate a proposal against the fetched template and, only if nothing is
 * wrong, write it to the notebook. The proposal id, server and timestamps are
 * the harness's; the model supplies what to run.
 */
export async function propose(
  deps: ProposalDeps,
  params: ProposeParams,
  signal?: AbortSignal,
): Promise<ProposeResult> {
  const nb = deps.notebookPath();
  if (!nb) return { ok: false, problems: ["no notebook is open"] };
  const serverUrl = deps.galaxyUrl();
  if (!serverUrl) return { ok: false, problems: ["Galaxy isn't connected in this session"] };
  const content = await readRecordOrNull(nb);
  if (content === null) return { ok: false, problems: [`couldn't read ${nb}`] };

  const errors: string[] = [];
  const kind = params.target?.kind;
  const field = kind === "workflow" ? "workflow_id" : kind === "udt" ? "tool_uuid" : "tool_id";
  const target = parseTarget(
    { kind, [field]: params.target?.id, version: params.target?.version },
    errors,
  );
  const inputs = parseInputs(params.inputs ?? [], errors);
  const overrides = parseOverrides(params.overrides ?? [], errors);
  const predicate = parsePredicate(params.predicate ?? { kind: "manual" }, errors);
  const assertions = params.assertions ?? [];
  const historyId = params.history_id?.trim() || deps.historyId();
  if (!historyId) errors.push("history_id is required (no history is selected in this session)");

  const anchor = resolveNotebookAnchor(content, params.step_anchor);
  if (anchor.kind === "unknown") {
    errors.push(unknownAnchorMessage(params.step_anchor, listNotebookAnchors(content)));
  } else if (anchor.kind === "ambiguous") {
    errors.push(ambiguousAnchorMessage(params.step_anchor, anchor.candidates));
  }
  const defined = assertionDefinitions(assertions);
  for (const id of assertions) {
    if (!defined.has(id))
      errors.push(`assertion "${id}" isn't defined; assertions aren't available yet`);
  }
  if (predicate?.kind === "assertions_pass") {
    errors.push("an assertions_pass predicate needs assertions, which aren't available yet");
  }
  if (errors.length > 0 || !target || !inputs || !overrides || !predicate || !historyId) {
    return { ok: false, problems: errors };
  }
  if (anchor.kind !== "resolved") return { ok: false, problems: errors };

  let snapshot;
  try {
    snapshot = await deps.fetcher(path.dirname(nb))(target, historyId, signal);
  } catch (err) {
    return {
      ok: false,
      problems: [err instanceof TemplateUnavailableError ? err.message : String(err)],
    };
  }

  const session = deps.registry();
  const taken = new Set(
    findProposalBlocks(content)
      .map((b) => b.proposalId)
      .filter((id): id is string => id !== null),
  );
  for (const a of Object.values(session?.store.snapshot().attempts ?? {})) {
    if (a.approval) taken.add(a.approval.proposal_id);
  }
  const shape = templateShape(target.kind, snapshot);
  const seeded = deps.seededIds?.().find((id) => PROPOSAL_ID_RE.test(id) && !taken.has(id));
  const proposal = canonicalizeProposal(
    {
      proposalId: seeded ?? newProposalId(deps.random, taken),
      stepAnchor: anchor.anchor,
      ...(params.label?.trim() ? { label: params.label.trim() } : {}),
      target,
      serverUrl,
      historyId,
      inputs,
      overrides,
      predicate,
      assertions,
      templateDigest: sha256Hex(canonicalJson(snapshot.body)),
      createdAt: deps.now(),
    },
    shape,
  );
  const problems = validateProposal(proposal, shape);
  if (problems.length > 0) return { ok: false, problems };
  const formats = await checkFormats(deps, nb, proposal, shape, signal);
  if (formats.problems.length > 0) return { ok: false, problems: formats.problems };

  // Freeze the template it was validated against, when this session can.
  if (!cannotWrite(session)) {
    try {
      session?.store.putTemplate(snapshot.body);
    } catch {
      // The approval fetches and freezes its own; this one is a courtesy.
    }
  }

  try {
    await withNotebookLock(nb, () =>
      withNotebookCas(nb, (fresh) => {
        const again = resolveNotebookAnchor(fresh, proposal.stepAnchor);
        if (again.kind !== "resolved")
          throw new Error(`step ${proposal.stepAnchor} is gone from the notebook`);
        return { content: appendProposalBlock(fresh, proposal), result: undefined };
      }),
    );
  } catch (err) {
    return { ok: false, problems: [`couldn't write the proposal: ${(err as Error).message}`] };
  }

  // So a run whose ids were seeded can always be told apart from a real one.
  if (seeded) activity(deps, "proposal.id_seeded", "harness", { proposal_id: seeded });
  activity(deps, "proposal.created", "loom_propose", {
    proposal_id: proposal.proposalId,
    step_anchor: proposal.stepAnchor,
    target: proposal.target,
    history_id: proposal.historyId,
    template_digest: proposal.templateDigest,
    template_version: snapshot.version,
  });
  return {
    ok: true,
    proposal,
    table: renderProposalTable(proposal, { resolvedVersion: snapshot.version, shape }),
    mappedOver: mappedOverSlots(proposal, shape),
    formatsUnchecked: formats.unchecked,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// /approve, /revoke, /pending
// ─────────────────────────────────────────────────────────────────────────────

export interface CommandReply {
  level: "info" | "warning" | "error";
  message: string;
  /** Set by /approve when it recorded a new live approval: the proposal to submit now. */
  approved?: string;
}

/** What came of an /approve, so a caller needn't read it back out of the wording. */
export interface ApproveReply extends CommandReply {
  /** The live approval's attempt, whether this call recorded it or it was already there. */
  attemptId?: string;
  declined?: true;
}

const PROPOSAL_ARG = /^\s*(\S+)\s*$/;
const APPROVE_ARGS = /^\s*(?!--)(\S+)(?:\s+(--yes))?\s*$/;
const APPROVE_USAGE =
  "Usage: /approve <proposal-id>  (add --yes where there's no dialog to confirm in, e.g. the terminal's json/print modes)";

function locate(content: string, id: string): ProposalBlock | string {
  const blocks = findProposalBlocks(content).filter((b) => b.proposalId === id);
  if (blocks.length === 0)
    return `No proposal ${id} in the notebook. /pending lists the ones there are.`;
  if (blocks.length > 1) {
    return `The notebook has ${blocks.length} blocks claiming ${id}, and there is no telling which one you mean. Remove the extras first.`;
  }
  if (!blocks[0].proposal) {
    return `Proposal ${id} can't be read: ${blocks[0].errors.join("; ")}.`;
  }
  return blocks[0];
}

export interface ApproveOptions {
  /** Shown the harness-rendered table; resolves to the user's answer. Absent = no dialog. */
  confirm?: (title: string, message: string) => Promise<boolean>;
  signal?: AbortSignal;
  /** The user's chat approval; stands in for --yes only where chatWithoutDialog allows it. */
  chat?: string;
  /** canonicalJson of the proposal as loom_propose wrote it; any other content is refused. */
  expected?: string;
}

export async function approveCommand(
  deps: ProposalDeps,
  args: string,
  opts: ApproveOptions = {},
): Promise<ApproveReply> {
  const m = args.match(APPROVE_ARGS);
  if (!m)
    return {
      level: "info",
      message: (await pendingCommand(deps)).message + `\n${APPROVE_USAGE}`,
    };
  const id = m[1];
  const yes = m[2] !== undefined;
  const session = deps.registry();
  const blocked = cannotWrite(session);
  if (blocked || !session) return { level: "warning", message: `Can't approve: ${blocked}.` };
  const serverUrl = deps.galaxyUrl();
  if (!serverUrl || normalizeServerUrl(serverUrl) !== session.store.serverUrl) {
    return {
      level: "warning",
      message:
        `Can't approve: this session's registry is for ${session.store.serverUrl || "no Galaxy server"}` +
        `${serverUrl ? `, but Galaxy is now ${serverUrl}` : ""}. Restart the session once connected.`,
    };
  }
  const nb = deps.notebookPath();
  const content = nb ? await readRecordOrNull(nb) : null;
  if (!nb || content === null) return { level: "warning", message: "Can't approve: no notebook." };
  checkProposalDrift(deps, content);

  const found = locate(content, id);
  if (typeof found === "string") return { level: "warning", message: found };
  const proposal = found.proposal as Proposal;
  if (opts.expected !== undefined && canonicalJson(proposal) !== opts.expected) {
    return {
      level: "warning",
      message: `Not approved: ${id} was edited after it was proposed, so the user hasn't seen what it says now. Show them the block and ask them to type /approve ${id}.`,
    };
  }

  let snapshot;
  try {
    snapshot = await deps.fetcher(path.dirname(nb))(
      proposal.target,
      proposal.historyId,
      opts.signal,
    );
  } catch (err) {
    return { level: "warning", message: `Can't approve ${id}: ${(err as Error).message}.` };
  }
  const shape = templateShape(proposal.target.kind, snapshot);
  const problems = validateProposal(proposal, shape);
  let formatsUnchecked: string[] = [];
  if (problems.length === 0) {
    const formats = await checkFormats(deps, nb, proposal, shape, opts.signal);
    problems.push(...formats.problems);
    formatsUnchecked = formats.unchecked;
  }
  if (problems.length > 0) {
    return {
      level: "warning",
      message: `Not approved -- ${id} doesn't match what Galaxy says now:\n- ${problems.join("\n- ")}`,
    };
  }

  const table = renderProposalTable(proposal, {
    resolvedVersion: snapshot.version,
    plain: true,
    shape,
  });
  // Approval re-fetches and freezes what Galaxy says now, by design; say so
  // when that's not what the proposal was checked against.
  const templateNote =
    proposal.templateDigest && proposal.templateDigest !== sha256Hex(canonicalJson(snapshot.body))
      ? "\n\nGalaxy's template for this target changed since it was proposed; the above was checked against the current one."
      : "";
  const formatNote =
    formatsUnchecked.length > 0
      ? `\n\nFormats not checked:\n- ${formatsUnchecked.join("\n- ")}`
      : "";
  if (opts.confirm) {
    const confirmed = await opts.confirm(
      `Approve ${id}?`,
      `${table}${templateNote}${formatNote}\n\nThis freezes exactly the above.`,
    );
    if (!confirmed)
      return { level: "info", message: `Not approved; ${id} is still pending.`, declined: true };
  } else if (!yes && !(opts.chat !== undefined && deps.chatWithoutDialog?.())) {
    // No dialog to show the table in. Approving anyway would record consent to
    // a spec the user never saw, so they have to see it here and say so.
    const message =
      `Not approved: there's no dialog here to confirm in. This is what /approve would freeze:\n\n` +
      `${table}${templateNote}${formatNote}\n\nIf that's what you want, run /approve ${id} --yes.`;
    activity(deps, "proposal.approval_unconfirmed", "user", {
      proposal_id: id,
      table,
      ...(formatsUnchecked.length > 0 ? { formats_unchecked: formatsUnchecked } : {}),
    });
    return { level: "warning", message };
  }

  // The block must still say what was just shown.
  const latest = await readRecordOrNull(nb);
  const again = latest === null ? null : locate(latest, id);
  if (
    !again ||
    typeof again === "string" ||
    canonicalJson(again.proposal) !== canonicalJson(proposal)
  ) {
    return {
      level: "warning",
      message: `Not approved: ${id} changed in the notebook while it was being approved. Look at it again and re-run /approve.`,
    };
  }

  let result: ReturnType<typeof approveProposal>;
  try {
    result = approveProposal(session.store, {
      proposal,
      snapshot,
      assertionDefinitions: assertionDefinitions(proposal.assertions),
      now: deps.now(),
    });
  } catch (err) {
    // Typically the lock was taken over mid-approval; the store is read-only now.
    return { level: "warning", message: `Not approved: ${(err as Error).message}.` };
  }
  if (!result.ok) {
    return { level: "warning", message: `Not approved:\n- ${result.problems.join("\n- ")}` };
  }
  if (result.unchanged) {
    return {
      level: "info",
      message: `${id} is already approved (attempt ${result.attemptId}).`,
      attemptId: result.attemptId,
    };
  }

  activity(deps, "proposal.approved", "user", {
    proposal_id: id,
    attempt_id: result.attemptId,
    spec_revision: result.specRevision,
    step_anchor: proposal.stepAnchor,
    version: result.spec.target.version,
    template_digest: result.spec.template_ref.digest,
    confirmed_by:
      opts.chat !== undefined
        ? opts.confirm
          ? "chat+dialog"
          : "chat"
        : opts.confirm
          ? "dialog"
          : "--yes",
    ...(opts.chat !== undefined ? { chat_text: opts.chat } : {}),
    // On the record even where a notice goes nowhere (json/print modes).
    table: renderProposalTable(proposal, {
      resolvedVersion: result.spec.target.version,
      specRevision: result.specRevision,
      plain: true,
      shape,
    }),
    // So the record tells a format that fit from one nobody could check.
    ...(formatsUnchecked.length > 0 ? { formats_unchecked: formatsUnchecked } : {}),
    ...(result.superseded.length > 0 ? { superseded: result.superseded } : {}),
  });
  try {
    await withNotebookLock(nb, () =>
      withNotebookCas(nb, (fresh) => ({
        content: setProposalSpecRevision(fresh, id, result.specRevision),
        result: undefined,
      })),
    );
  } catch {
    // The echo is for the reader; the registry already holds the approval.
  }
  return {
    level: "info",
    approved: id,
    message:
      `Approved ${id} (attempt ${result.attemptId}, spec_revision ${result.specRevision.slice(0, 12)}).\n\n` +
      renderProposalTable(proposal, {
        resolvedVersion: result.spec.target.version,
        specRevision: result.specRevision,
        plain: true,
        shape,
      }) +
      `\n\nEditing the proposal from here revokes this approval.`,
    attemptId: result.attemptId,
  };
}

/** The turn /approve starts so the approved run is submitted straight away. */
export function approvedRunPrompt(id: string): string {
  return (
    `[Orbit approval] The user approved ${id}. Submit exactly that run now with the Galaxy tools, ` +
    `then record it with galaxy_job_record (or galaxy_invocation_record for a workflow), passing ` +
    `proposalId: "${id}".`
  );
}

export async function revokeCommand(deps: ProposalDeps, args: string): Promise<CommandReply> {
  const m = args.match(PROPOSAL_ARG);
  if (!m) return { level: "info", message: "Usage: /revoke <proposal-id>" };
  const id = m[1];
  const session = deps.registry();
  const blocked = cannotWrite(session);
  if (blocked || !session) return { level: "warning", message: `Can't revoke: ${blocked}.` };
  await checkProposalDriftNow(deps);
  let revoked: string[];
  try {
    revoked = revokeProposal(session.store, id);
  } catch (err) {
    return { level: "warning", message: `Can't revoke: ${(err as Error).message}.` };
  }
  if (revoked.length === 0) {
    return { level: "info", message: `${id} has no live approval to revoke.` };
  }
  for (const attemptId of revoked) {
    activity(deps, "proposal.revoked", "user", {
      proposal_id: id,
      attempt_id: attemptId,
      reason: "user",
    });
  }
  const nb = deps.notebookPath();
  if (nb) void clearEchoes(nb, [id]);
  return {
    level: "info",
    message: `Revoked the approval of ${id}. /approve it again to re-approve.`,
  };
}

export async function pendingCommand(deps: ProposalDeps): Promise<CommandReply> {
  const session = deps.registry();
  const nb = deps.notebookPath();
  const content = nb ? await readRecordOrNull(nb) : null;
  if (!content)
    return { level: "info", message: "No proposals: the notebook is empty or missing." };
  checkProposalDrift(deps, content);
  const blocks = findProposalBlocks(content);
  const registry = session ? sessionView(session) : undefined;
  const pending = registry
    ? pendingProposals(registry, proposalSightings(content))
    : proposalSightings(content).map((s) => ({ sighting: s, state: "unapproved" as const }));
  const live = registry
    ? blocks.filter((b) => b.proposalId && liveApproval(registry, b.proposalId)).length
    : 0;
  if (pending.length === 0) {
    return {
      level: "info",
      message:
        blocks.length === 0
          ? "No proposals in the notebook."
          : `Nothing pending; ${live} proposal(s) approved.`,
    };
  }
  const why = {
    unapproved: "not approved",
    revoked: "approval revoked",
    restored: "approved in an earlier session; approvals only count in the session that made them",
    invalid: "can't be read",
  } as const;
  const sections = pending.map(({ sighting, state }) => {
    const head = `${sighting.proposalId} -- ${why[state]}`;
    if (!sighting.proposal) {
      const block = blocks.find((b) => b.proposalId === sighting.proposalId);
      return `${head}: ${block?.errors.join("; ") ?? "unreadable"}`;
    }
    return `${head}\n\n${renderProposalTable(sighting.proposal, { compact: true, plain: true })}`;
  });
  const tail =
    registry && session?.store.mode === "writer"
      ? ""
      : "\n\n(The registry is read-only in this session.)";
  return {
    level: "info",
    message:
      `${pending.length} pending proposal(s)${live > 0 ? `, ${live} approved` : ""}. ` +
      `Approve one with /approve <proposal-id>.\n\n${sections.join("\n\n")}${tail}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Binding a recorded run to its proposal
// ─────────────────────────────────────────────────────────────────────────────

export type BindResult = { bound: true; attemptId: string } | { bound: false; reason: string };

/**
 * Note that the agent says a run it recorded carries out an approved proposal.
 * Until `loom_submit` exists the agent submits with the ordinary tools, so this
 * is the agent's claim and is recorded as one: a `proposal.bound` activity row
 * naming the approval's attempt id. It changes nothing in the registry and
 * writes no harness field on the block -- a claim the harness didn't witness
 * must never read as a submission it did.
 */
export async function noteProposalBinding(
  deps: ProposalDeps,
  args: {
    proposalId: string;
    notebookAnchor: string;
    run: { kind: "job" | "invocation"; id: string };
  },
): Promise<BindResult> {
  const session = deps.registry();
  if (!session) return { bound: false, reason: "the approval registry isn't open in this session" };
  await checkProposalDriftNow(deps);
  const live = liveApproval(sessionView(session), args.proposalId);
  if (!live) {
    return { bound: false, reason: `${args.proposalId} has no live approval in this session` };
  }
  if (live.binding.step_anchor !== args.notebookAnchor) {
    return {
      bound: false,
      reason: `${args.proposalId} was approved for ${live.binding.step_anchor}, not ${args.notebookAnchor}`,
    };
  }
  activity(deps, "proposal.bound", "record-tool", {
    proposal_id: args.proposalId,
    attempt_id: live.attempt_id,
    step_anchor: args.notebookAnchor,
    run_kind: args.run.kind,
    run_id: args.run.id,
    declared_by: "agent",
  });
  return { bound: true, attemptId: live.attempt_id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat approval
// ─────────────────────────────────────────────────────────────────────────────

// A whitelist, not a blocklist: every clause must be one of these, so a reply that also asks for
// something else ("yes, use hg19", "go ahead if the checks pass") is never read as consent. At
// least one clause has to approve the run itself; a bare "yes" or "lgtm" may answer another
// question. A false negative only falls back to /approve.
const APPROVE_CLAUSE =
  /^(?:(?:yes|ok|okay|sure|please)\s+)?(?:i\s+approve(?:\s+(?:it|this|that|the\s+run))?|approve(?:\s+(?:it|this|that|the\s+run))?|approved|proceed|go\s+ahead(?:\s+and\s+(?:run|submit|execute)\s+it)?|(?:run|submit|execute)\s+it|do\s+it)(?:\s+(?:now|please))?$/;
const FILLER_CLAUSE =
  /^(?:yes|yep|yeah|ok|okay|sure|great|perfect|thanks|thank\s+you|please|lgtm|sounds\s+good|(?:that|this)(?:'s|\s+is)\s+(?:right|correct|fine)|(?:(?:the|those|these)\s+)?(?:parameters|params|settings|values|table|proposal)?\s*looks?\s+(?:right|good|fine|correct))$/;
const CHAT_APPROVAL_MAX = 200;

/** Whether `text` is nothing but an approval of the run, naming no proposal but `pendingId`. */
export function classifyChatApproval(text: string, pendingId: string): "approve" | "none" {
  const t = text.trim();
  if (!t || t.length > CHAT_APPROVAL_MAX || t.startsWith("/")) return "none";
  const named = t.match(/\bprop-[0-9a-z]{6}\b/gi) ?? [];
  if (!named.every((id) => id.toLowerCase() === pendingId)) return "none";
  const clauses = t
    .toLowerCase()
    .replace(/\bprop-[0-9a-z]{6}\b/g, " ")
    .split(/[.!,;:\n]+|\s+-+\s+|\u2014/)
    .map((c) => c.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!clauses.every((c) => APPROVE_CLAUSE.test(c) || FILLER_CLAUSE.test(c))) return "none";
  return clauses.some((c) => APPROVE_CLAUSE.test(c)) ? "approve" : "none";
}

/**
 * The proposals a chat approval could mean: every unapproved one, plus a revoked or restored one
 * this session proposed that never ran. /pending lists more than this -- a notebook keeps the
 * blocks of runs that finished in an earlier session -- but those aren't open questions, and
 * counting them would make every "go ahead" ambiguous for good.
 */
async function pendingIds(
  deps: ProposalDeps,
  proposedHere: ReadonlyMap<string, string>,
): Promise<{ open: string[]; unapproved: string[] }> {
  const session = deps.registry();
  const nb = deps.notebookPath();
  const content = nb ? await readRecordOrNull(nb) : null;
  if (!session || !content) return { open: [], unapproved: [] };
  checkProposalDrift(deps, content);
  const view = sessionView(session);
  const pending = pendingProposals(view, proposalSightings(content));
  const ran = (id: string) => attemptsForProposal(view, id).some((a) => a.submission);
  return {
    open: pending
      .filter(
        (p) =>
          p.state === "unapproved" ||
          ((p.state === "revoked" || p.state === "restored") &&
            proposedHere.has(p.sighting.proposalId) &&
            !ran(p.sighting.proposalId)),
      )
      .map((p) => p.sighting.proposalId),
    unapproved: pending.filter((p) => p.state === "unapproved").map((p) => p.sighting.proposalId),
  };
}

/** The text of the assistant's messages in one agent run. */
function assistantText(messages: readonly unknown[]): string {
  const out: string[] = [];
  for (const m of messages as Array<{ role?: string; content?: unknown }>) {
    if (m?.role !== "assistant") continue;
    if (typeof m.content === "string") out.push(m.content);
    else if (Array.isArray(m.content))
      for (const part of m.content as Array<{ type?: string; text?: unknown }>)
        if (part?.type === "text" && typeof part.text === "string") out.push(part.text);
  }
  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

function toolText(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

export function registerProposalCommands(pi: ExtensionAPI, deps: ProposalDeps = defaultDeps): void {
  onNotebookChange((content) => {
    checkProposalDrift(deps, content);
  });

  // Only a proposal loom_propose wrote in this session can be approved from chat: a restored or
  // hand-written block was never put in front of this user as a table. The value is what it wrote,
  // so an edit made since can't ride along on an approval of the original.
  const proposedHere = new Map<string, string>();
  // The ones the last agent run named to the user. A chat reply answers that run and nothing
  // older, and a proposal the model never mentioned may not have reached the user at all.
  let offered = new Set<string>();

  // The eval-only template replay is read once, before the model's first turn.
  pi.on("session_start", async () => {
    proposedHere.clear();
    offered = new Set();
    const nb = deps.notebookPath();
    primeTemplateReplay(nb ? path.dirname(nb) : process.cwd());
  });

  pi.on("agent_end", async (event) => {
    const text = assistantText((event as { messages?: unknown[] }).messages ?? []);
    offered = new Set([...proposedHere.keys()].filter((id) => text.includes(id)));
  });

  pi.on("input", async (event, ctx) => {
    const pass = { action: "continue" as const };
    // "extension" is what the model's own follow-ups arrive as; consent cannot come from there.
    if (event.source === "extension" || event.streamingBehavior || offered.size === 0) return pass;
    const pending = await pendingIds(deps, proposedHere);
    const mine = pending.unapproved.filter((id) => offered.has(id));
    if (mine.length === 0) return pass;
    if (classifyChatApproval(event.text, mine[0]) !== "approve") return pass;
    const note = (line: string) => ({
      action: "transform" as const,
      text: `${event.text}\n\n[Orbit: ${line}]`,
      images: event.images,
    });
    // One this session revoked still waits on an approval, so it makes "go ahead" ambiguous too.
    if (pending.open.length > 1 || mine.length > 1) {
      return note(
        `${pending.open.length} proposals are pending (${pending.open.join(", ")}), so this approval doesn't say which. Ask the user to type /approve <proposal-id>; do not submit yet.`,
      );
    }
    const id = mine[0];
    const confirm = ctx.hasUI
      ? (title: string, message: string) => ctx.ui.confirm(title, message)
      : undefined;
    const r = await approveCommand(deps, id, {
      confirm,
      chat: event.text,
      expected: proposedHere.get(id),
    });
    if (r.attemptId) {
      return note(
        `approved ${id} (attempt ${r.attemptId}) from this message. Submit exactly that run now with ` +
          `the Galaxy tools, then record it with galaxy_job_record (or galaxy_invocation_record for a ` +
          `workflow), passing proposalId: "${id}". Do not ask for /approve.`,
      );
    }
    if (r.declined)
      return note(`the user declined the approval dialog; ${id} is still pending. Do not submit.`);
    return note(`not approved -- ${r.message} Do not submit.`);
  });

  pi.registerTool({
    name: "loom_propose",
    label: "Propose Galaxy Run",
    description: `Propose one concrete Galaxy run -- a tool, workflow or user-defined tool with its
exact inputs and parameters -- for the user to approve. The harness fetches the target's template from
Galaxy and checks your proposal against it (dataset slots and their formats, required inputs, parameter names) before
anything is written; if something is wrong you get the list of problems and nothing is written. On
success it writes a loom-proposal block to the notebook and returns a proposal id and a table.
Show the user that table and ask for approval: they can type /approve <proposal-id>, or approve it plainly in chat
while it is the only pending proposal. You cannot approve it yourself; do not submit until the harness confirms
the approval. When asked to draft or review a run's parameters, this table is that review, so propose then.
Give every parameter you set a rationale. Leave version unset to take what Galaxy resolves.
A tool's dataset input also takes a collection (src hdca): on a one-dataset input it runs once per
element, on a multiple input it takes them all in one job.`,
    parameters: Type.Object({
      step_anchor: Type.String({
        description: "The plan step this run is for, e.g. 'plan-a-step-2'.",
      }),
      label: Type.Optional(Type.String({ description: "Short human label, e.g. 'Trim reads'." })),
      target: Type.Object({
        kind: Type.Union([Type.Literal("tool"), Type.Literal("workflow"), Type.Literal("udt")]),
        id: Type.String({
          description: "Tool id, workflow id, or user-defined tool uuid.",
        }),
        version: Type.Optional(
          Type.String({ description: "Pin a version; omit (or 'unpinned') to take Galaxy's." }),
        ),
      }),
      history_id: Type.Optional(
        Type.String({ description: "History to run in; defaults to the session's current one." }),
      ),
      inputs: Type.Array(
        Type.Object({
          slot: Type.String({
            description:
              "Tool: the data parameter name in Galaxy's flat form (e.g. 'reads' or 'cond|in1'). Workflow: the input's step index or label.",
          }),
          src: Type.Union([Type.Literal("hda"), Type.Literal("hdca"), Type.Literal("ldda")]),
          id: Type.String({ description: "Dataset or collection id." }),
        }),
      ),
      overrides: Type.Optional(
        Type.Array(
          Type.Object({
            param: Type.String({
              description: "Parameter name, flat form ('section|param', 'rep_0|x').",
            }),
            value: Type.Unknown(),
            rationale: Type.String({ description: "Why this value." }),
          }),
        ),
      ),
      predicate: Type.Optional(
        Type.Unknown({
          description:
            "When the step counts as done: {kind:'manual'} (default), {kind:'exists_with_ext', ext, min_count?} or {kind:'count_eq', count, ext?}.",
        }),
      ),
    }),
    async execute(_id, params, signal) {
      const result = await propose(deps, params as ProposeParams, signal);
      if (!result.ok) {
        return toolText(
          `Not proposed -- fix these and call loom_propose again:\n- ${result.problems.join("\n- ")}`,
          { error: true, problems: result.problems },
        );
      }
      const id = result.proposal.proposalId;
      proposedHere.set(id, canonicalJson(result.proposal));
      const mapped =
        result.mappedOver.length > 0
          ? ` It maps over the collection given to ${result.mappedOver.join(", ")}: ` +
            `Galaxy runs it once per element, and each job it makes carries out this proposal.`
          : "";
      const unchecked =
        result.formatsUnchecked.length > 0
          ? `\n\nFormats not checked (Galaxy will say at submission if they're wrong):\n- ` +
            result.formatsUnchecked.join("\n- ")
          : "";
      return toolText(
        `Proposed ${id}. Show the user this table, naming ${id}, and ask for approval: they can type ` +
          `/approve ${id}, or approve it plainly in chat in reply while it is the only pending proposal ` +
          `(or say what to change). ` +
          `Do not submit this run until the harness confirms the approval.` +
          `${mapped}\n\n${result.table}${unchecked}`,
        {
          proposalId: id,
          predicate: describePredicate(result.proposal.predicate),
          ...(result.mappedOver.length > 0 ? { mappedOver: result.mappedOver } : {}),
        },
      );
    },
  });

  const reply = (ctx: ExtensionContext, r: CommandReply) => {
    try {
      ctx.ui.notify(r.message, r.level);
    } catch {
      // headless or stale context; the activity log has the record
    }
  };

  pi.registerCommand("approve", {
    description: "Approve a pending Galaxy run proposal: /approve <proposal-id> [--yes]",
    handler: async (args: string | undefined, ctx: ExtensionContext) => {
      const confirm = ctx.hasUI
        ? (title: string, message: string) => ctx.ui.confirm(title, message)
        : undefined;
      const r = await approveCommand(deps, args ?? "", { confirm });
      reply(ctx, r);
      // A slash command starts no turn, so without this the approved run waits
      // for the user's next message. Only the user's /approve reaches here.
      if (r.approved) {
        pi.sendUserMessage(approvedRunPrompt(r.approved), { deliverAs: "followUp" });
      }
    },
  });

  pi.registerCommand("revoke", {
    description: "Revoke the approval of a Galaxy run proposal: /revoke <proposal-id>",
    handler: async (args: string | undefined, ctx: ExtensionContext) => {
      reply(ctx, await revokeCommand(deps, args ?? ""));
    },
  });

  pi.registerCommand("pending", {
    description: "List Galaxy run proposals waiting for approval",
    handler: async (_args: string | undefined, ctx: ExtensionContext) => {
      reply(ctx, await pendingCommand(deps));
    },
  });
}
