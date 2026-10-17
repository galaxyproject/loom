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
import { recordStore } from "./record-store";
import { canonicalJson, normalizeServerUrl, sha256Hex } from "./registry";
import {
  approveProposal,
  canonicalizeProposal,
  describePredicate,
  findDrift,
  liveApproval,
  newProposalId,
  parseInputs,
  parseOverrides,
  parsePredicate,
  parseTarget,
  pendingProposals,
  renderProposalTable,
  revokeProposal,
  templateShape,
  validateProposal,
  type Drift,
  type Proposal,
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
  primeTemplateReplay,
  TemplateUnavailableError,
  templateFetcherFor,
  type TemplateFetcher,
} from "./registry-templates";
import { getCurrentHistoryId, getNotebookPath, onNotebookChange } from "./state";

/** Everything the propose/approve flow reads from the session, so tests can supply it. */
export interface ProposalDeps {
  registry: () => SessionRegistry | null;
  notebookPath: () => string | null;
  galaxyUrl: () => string | null;
  historyId: () => string | null;
  fetcher: (sessionDir: string) => TemplateFetcher;
  /** ISO timestamp. */
  now: () => string;
  random: (n: number) => Uint8Array;
}

export const defaultDeps: ProposalDeps = {
  registry: getSessionRegistry,
  notebookPath: getNotebookPath,
  galaxyUrl: () => getGalaxyConfig()?.url ?? null,
  historyId: getCurrentHistoryId,
  fetcher: templateFetcherFor,
  now: () => new Date().toISOString(),
  random: (n) => randomBytes(n),
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
  let text = nb ? await readRecordOrNull(nb) : null;
  // A notebook that's gone takes its proposals with it. One that exists but
  // can't be read right now is left for the next look.
  if (text === null && nb && (await recordStore(nb).stat()) === null) text = "";
  if (text === null) return [];
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
  { ok: true; proposal: Proposal; table: string } | { ok: false; problems: string[] };

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
  const proposal = canonicalizeProposal(
    {
      proposalId: newProposalId(deps.random, taken),
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
    table: renderProposalTable(proposal, { resolvedVersion: snapshot.version }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// /approve, /revoke, /pending
// ─────────────────────────────────────────────────────────────────────────────

export interface CommandReply {
  level: "info" | "warning" | "error";
  message: string;
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
}

export async function approveCommand(
  deps: ProposalDeps,
  args: string,
  opts: ApproveOptions = {},
): Promise<CommandReply> {
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
  const problems = validateProposal(proposal, templateShape(proposal.target.kind, snapshot));
  if (problems.length > 0) {
    return {
      level: "warning",
      message: `Not approved -- ${id} doesn't match what Galaxy says now:\n- ${problems.join("\n- ")}`,
    };
  }

  const table = renderProposalTable(proposal, { resolvedVersion: snapshot.version, plain: true });
  // Approval re-fetches and freezes what Galaxy says now, by design; say so
  // when that's not what the proposal was checked against.
  const templateNote =
    proposal.templateDigest && proposal.templateDigest !== sha256Hex(canonicalJson(snapshot.body))
      ? "\n\nGalaxy's template for this target changed since it was proposed; the above was checked against the current one."
      : "";
  if (opts.confirm) {
    const confirmed = await opts.confirm(
      `Approve ${id}?`,
      `${table}${templateNote}\n\nThis freezes exactly the above.`,
    );
    if (!confirmed) return { level: "info", message: `Not approved; ${id} is still pending.` };
  } else if (!yes) {
    // No dialog to show the table in. Approving anyway would record consent to
    // a spec the user never saw, so they have to see it here and say so.
    const message =
      `Not approved: there's no dialog here to confirm in. This is what /approve would freeze:\n\n` +
      `${table}${templateNote}\n\nIf that's what you want, run /approve ${id} --yes.`;
    activity(deps, "proposal.approval_unconfirmed", "user", { proposal_id: id, table });
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
    return { level: "info", message: `${id} is already approved (attempt ${result.attemptId}).` };
  }

  activity(deps, "proposal.approved", "user", {
    proposal_id: id,
    attempt_id: result.attemptId,
    spec_revision: result.specRevision,
    step_anchor: proposal.stepAnchor,
    version: result.spec.target.version,
    template_digest: result.spec.template_ref.digest,
    confirmed_by: opts.confirm ? "dialog" : "--yes",
    // On the record even where a notice goes nowhere (json/print modes).
    table: renderProposalTable(proposal, {
      resolvedVersion: result.spec.target.version,
      specRevision: result.specRevision,
      plain: true,
    }),
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
    message:
      `Approved ${id} (attempt ${result.attemptId}, spec_revision ${result.specRevision.slice(0, 12)}).\n\n` +
      renderProposalTable(proposal, {
        resolvedVersion: result.spec.target.version,
        specRevision: result.specRevision,
        plain: true,
      }) +
      `\n\nEditing the proposal from here revokes this approval.`,
  };
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
// Registration
// ─────────────────────────────────────────────────────────────────────────────

function toolText(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

export function registerProposalCommands(pi: ExtensionAPI, deps: ProposalDeps = defaultDeps): void {
  onNotebookChange((content) => {
    checkProposalDrift(deps, content);
  });

  // The eval-only template replay is read once, before the model's first turn.
  pi.on("session_start", async () => {
    const nb = deps.notebookPath();
    primeTemplateReplay(nb ? path.dirname(nb) : process.cwd());
  });

  pi.registerTool({
    name: "loom_propose",
    label: "Propose Galaxy Run",
    description: `Propose one concrete Galaxy run -- a tool, workflow or user-defined tool with its
exact inputs and parameters -- for the user to approve. The harness fetches the target's template from
Galaxy and checks your proposal against it (dataset slots, required inputs, parameter names) before
anything is written; if something is wrong you get the list of problems and nothing is written. On
success it writes a loom-proposal block to the notebook and returns a proposal id and a table.
Show the user that table and ask them to type /approve <proposal-id>. You cannot approve it yourself.
Give every parameter you set a rationale. Leave version unset to take what Galaxy resolves.`,
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
      return toolText(
        `Proposed ${id}. Show the user this table and ask them to type /approve ${id} ` +
          `(or say what to change). Do not submit this run until they have approved it.\n\n${result.table}`,
        { proposalId: id, predicate: describePredicate(result.proposal.predicate) },
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
      reply(ctx, await approveCommand(deps, args ?? "", { confirm }));
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
