import type { Context as Chord } from "@earendil-works/chord";
import type { UserMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  DEFAULT_COMPACTION_POLICY,
  Harness,
  InboxDoc,
  SystemEntry,
  UsageDoc,
  UserEntry,
  type AgentEvent,
  type Conversation,
  type ConversationId,
  type Cursor,
  type EntryDraft,
  type EntryId,
  type EntryRecord,
  type Storage,
  type Submission,
  type SubmissionId,
} from "@earendil-works/pi-durable";

import { artifactsOf, registerArtifactKinds, type Artifact } from "../artifacts/kinds";
import type { AskFor } from "./destructive";
import { Binding, FollowUps, Sessions, type Pending } from "./documents";
import { DEFAULT_BRAND, type Brand } from "./brand";
import { DEFAULT_CAPABILITIES, MAX_STEPS, agentExtension } from "./extension";
import { connectGalaxy, connectWeb, type Galaxy } from "./galaxy";
import { agentModels } from "./model";
import { recordsOn, type RecordSummary } from "./notebook";
import { GALAXY_READY, GALAXY_UNREACHABLE, systemText, type GalaxyStatus } from "./prompt";
import { probeWindow, resolve, type LlmConfig, type Target } from "./providers";
import { editRecord } from "./record-write";
import {
  modelsOf,
  SCHEMA,
  thisBuild,
  usageTotals,
  type ExportedEntry,
  type SessionDocument,
} from "./saved";
import { flavoredSkills } from "./skills";
import type { Capability, Python } from "./tool";
import { galaxyOps, agentTools, type AgentFlavor } from "./tools";
import { galaxyWatch, WATCH_TASK, type Watched } from "./watch";

export const context = BACKGROUND_CONTEXT;

/** Earlier artifacts a tool can place; a spec carries its rows, so few are offered. */
const ARTIFACT_LIMIT = 20;

/**
 * How the agent's turns run under pi-durable, whatever the model: what `describe` reports as well.
 */
export const LOOP = {
  toolExecution: "sequential",
  followUpMode: "all",
} as const;

/**
 * The newest artifacts a conversation's results carried, oldest of them first. Read from its
 * whole history rather than its context, so a chart the user saw stays placeable after the turns
 * that made it were summarized away.
 */
export async function artifactsIn(
  conversation: Pick<Conversation, "entries">,
  ctx: Chord,
): Promise<Artifact[]> {
  const found: Artifact[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({}, 200, cursor, ctx);
    found.unshift(...artifactsOf([...page.items].reverse()));
    cursor = page.next;
  } while (cursor && found.length < ARTIFACT_LIMIT);
  return found.slice(-ARTIFACT_LIMIT);
}

/**
 * Events as the page draws them. A snapshot past a compaction holds only what the model is given,
 * so it carries the conversation's whole history instead, through the snapshot's newest entry and
 * in the order it was written, the summary where it landed.
 */
export async function drawnEvents(
  conversation: Pick<Conversation, "entries">,
  events: readonly AgentEvent[],
  ctx: Chord,
): Promise<AgentEvent[]> {
  const drawn: AgentEvent[] = [];
  for (const event of events) {
    if (event.type !== "snapshot" || event.entries[0]?.head === undefined) {
      drawn.push(event);
      continue;
    }
    const maxEntryId = event.entries.reduce(
      (newest, entry) => (entry.id > newest ? entry.id : newest),
      event.entries[0].id,
    );
    const history: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await conversation.entries({ maxEntryId }, 500, cursor, ctx);
      history.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    drawn.push({ ...event, entries: history.sort((a, b) => a.id - b.id) });
  }
  return drawn;
}

export interface RuntimeConfig extends LlmConfig {
  galaxy_root: string;
  /** Headless only; in the browser the user's session authenticates. */
  galaxy_key?: string;
  credentials?: RequestCredentials;
  ai_reserve_tokens?: number;
  ai_keep_recent_tokens?: number;
  ai_compaction?: boolean;
  capabilities?: Capability[];
  max_steps?: number;
}

export interface RuntimeOptions {
  storage: Storage;
  config: RuntimeConfig;
  python: Python;
  /** Where a headless run reads provider keys; a browser has none. */
  env?: Record<string, string | undefined>;
  /** Present when a user can approve a destructive operation. */
  ask?: AskFor;
  /** Galaxy work is polled this often. */
  pollMs?: number;
  /** What a flavor adds: tools, skills, result notes, prompt sections and artifact kinds. */
  flavor?: AgentFlavor;
}

/** Where a new conversation works, as the page or the harness knows it. */
export interface Placement {
  historyId?: string;
  datasetId?: string;
  instructions?: string;
  /**
   * A session found again through the record attached to its history, once the browser kept
   * nothing of it: its identity and record are durable, its conversation was not.
   */
  record?: RecordSummary;
}

const uuid = () => globalThis.crypto?.randomUUID?.() || `s-${Date.now()}-${Math.random()}`;

async function target(config: LlmConfig, env: Record<string, string | undefined>): Promise<Target> {
  const resolved = resolve(config, env);
  if (resolved.provider.probeWindow && !config.ai_context_window && resolved.baseUrl) {
    resolved.contextWindow = (await probeWindow(resolved.baseUrl)) ?? resolved.contextWindow;
  }
  return resolved;
}

/** The model a provider switch changes, and what compaction and the guards read of it. */
interface Current {
  config: RuntimeConfig;
  target: Target;
  model: { provider: string; modelId: string };
  apiKey?: string;
}

/**
 * The agent on pi-durable: one Harness over one storage with the agent's extension installed,
 * and what a host decides around it: which conversation a history continues, the model in use,
 * and how a Stop holds back follow-ups.
 */
export class Runtime {
  /** Why Galaxy did not answer when the session opened, when it did not. */
  galaxyProblem?: string;
  private constructor(
    readonly harness: Harness,
    readonly galaxy: Galaxy,
    readonly galaxyStatus: GalaxyStatus,
    private readonly current: Current,
    private readonly connect: ReturnType<typeof agentModels>["connect"],
    private readonly env: Record<string, string | undefined>,
    readonly brand: Brand,
  ) {}

  static async open({ storage, config, python, env = {}, ask, pollMs, flavor }: RuntimeOptions) {
    registerArtifactKinds(flavor?.artifactKinds ?? []);
    const brand = flavor?.brand ?? DEFAULT_BRAND;
    const galaxyOptions = {
      root: config.galaxy_root,
      key: config.galaxy_key,
      credentials: config.credentials,
    };
    const galaxy = connectGalaxy(galaxyOptions);
    const { models, connect } = agentModels(env);
    const resolved = await target(config, env);
    const connected = await connect(resolved);
    const current: Current = { config, target: resolved, ...connected };
    let galaxyProblem: string | undefined;
    const galaxyStatus = await galaxy
      .get("api/version")
      .then((): GalaxyStatus => GALAXY_READY)
      .catch((e): GalaxyStatus => {
        galaxyProblem = String((e as Error)?.message ?? e);
        return GALAXY_UNREACHABLE;
      });
    const skills = flavoredSkills(flavor);
    const capabilities = config.capabilities ?? DEFAULT_CAPABILITIES;
    let harness: Harness | undefined;
    const watch = galaxyWatch({
      galaxy,
      pollMs,
      brand,
      editRecord: async (id, edit) => {
        const bound = await harness?.snapshot(Binding, id, context);
        return editRecord({ galaxy, pageId: bound?.pageId }, edit);
      },
    });
    const extension = agentExtension({
      brand,
      galaxy,
      clients: (signal) => ({
        galaxy: connectGalaxy({ ...galaxyOptions, signal }),
        web: connectWeb(signal),
        ops: galaxyOps({ ...galaxyOptions, root: galaxy.root, signal }),
        python: { ...python, run: (code) => python.run(code, signal) },
      }),
      artifacts: async (id, ctx) => {
        const conversation = await harness!.conversation(id, ctx);
        return conversation ? artifactsIn(conversation, ctx) : [];
      },
      watched: (id, ctx) => watchedBy(harness!, id, ctx),
      tools: agentTools(skills, flavor),
      capabilities,
      secrets: () =>
        [current.apiKey, config.galaxy_key].filter((s): s is string => typeof s === "string"),
      prompt: ({ model, provider, datasetId }) => {
        const sections = flavor?.promptSections?.({ model, provider, datasetId }) ?? {};
        return [
          systemText({
            name: brand.name,
            model,
            provider,
            galaxyStatus,
            afterIdentity: sections.afterIdentity,
            terminology: sections.terminology,
            galaxyRoot: galaxy.root,
          }),
          skills.routerText(),
          ...(sections.afterRouter ?? []),
        ]
          .filter(Boolean)
          .join("\n\n");
      },
      ask,
      watch,
    });
    const registry = createRegistry();
    registry.install(extension);
    harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: {
          ...LOOP,
          maxTurns: config.max_steps || MAX_STEPS,
          get compaction() {
            const reserveTokens =
              current.config.ai_reserve_tokens ||
              current.target.maxTokens ||
              DEFAULT_COMPACTION_POLICY.reserveTokens;
            const window = current.target.contextWindow ?? Number.MAX_SAFE_INTEGER;
            return {
              enabled: current.config.ai_compaction !== false,
              reserveTokens,
              keepRecentTokens: Math.min(
                current.config.ai_keep_recent_tokens || DEFAULT_COMPACTION_POLICY.keepRecentTokens,
                Math.max(0, window - reserveTokens),
              ),
            };
          },
        },
        onReport: (error) => console.warn(`[${brand.id}]`, error),
      },
      context,
    );
    const runtime = new Runtime(harness, galaxy, galaxyStatus, current, connect, env, brand);
    runtime.galaxyProblem = galaxyProblem;
    // Before scheduling starts, so no run the store holds takes another step unasked.
    await runtime.hold(await runtime.active());
    harness.resume();
    return runtime;
  }

  /** The model new requests use. */
  get model() {
    return this.current.model;
  }

  /** Switch provider or model for `conversation`, and for every conversation opened after. */
  async switchModel(conversation: Conversation, config: LlmConfig): Promise<void> {
    const merged = { ...this.current.config, ...config };
    const next = await target(merged, this.env);
    Object.assign(this.current, { config: merged, target: next, ...(await this.connect(next)) });
    await conversation.configure({ model: this.model }, context);
  }

  /** A new conversation for `placement`, which its history continues from now on. */
  create(placement: Placement = {}): Promise<Conversation> {
    return this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: this.model,
          ...(placement.instructions ? { instructions: placement.instructions } : {}),
        },
        init: async (tx, id) => {
          Object.assign(await tx.doc(Binding, id), {
            sessionId: placement.record?.sessionId ?? uuid(),
            startedAt: placement.record?.created || new Date().toISOString(),
            ...(placement.record ? { pageId: placement.record.pageId } : {}),
            ...(placement.historyId ? { historyId: placement.historyId } : {}),
            ...(placement.datasetId ? { datasetId: placement.datasetId } : {}),
          });
          if (placement.historyId) {
            (await tx.doc(Sessions)).byHistory[placement.historyId] = id;
          }
        },
      },
      context,
    );
  }

  /** The conversation this browser keeps for the history, now on the dataset it was launched on. */
  async kept(placement: Placement): Promise<Conversation | undefined> {
    const index = await this.harness.snapshot(Sessions, context);
    const known = placement.historyId ? index?.byHistory[placement.historyId] : undefined;
    const found =
      known === undefined
        ? undefined
        : await this.harness.conversation(known as ConversationId, context);
    if (found) {
      await found.configure({ model: this.model }, context);
      if (placement.datasetId) {
        await found.commit(async (tx) => {
          (await tx.doc(Binding, found.id)).datasetId = placement.datasetId;
        }, context);
      }
    }
    return found;
  }

  /** The conversation this history continues, or a new one. */
  async continuing(placement: Placement): Promise<Conversation> {
    return (await this.kept(placement)) ?? this.create(placement);
  }

  /**
   * The brand's records attached to the launch history, for a session this browser no longer keeps.
   */
  records(historyId: string | undefined): Promise<RecordSummary[]> {
    return historyId ? recordsOn(this.galaxy, historyId, this.brand) : Promise.resolve([]);
  }

  /**
   * The user's own message, which lets settled work start runs again. What waited for it goes
   * first, each as the entry its input is placed as, so the run the message starts answers them
   * together, as pi-durable's follow-up mode `all` would place them.
   */
  async submit(conversation: Conversation, text: string): Promise<Submission> {
    const pending = await conversation.commit(async (tx) => {
      const policy = await tx.doc(FollowUps, conversation.id);
      Object.assign(policy, { automatic: 0, paused: false });
      return policy.pending.map((p) => ({ ...p }));
    }, context);
    if (pending.length) {
      // A request id per input: after a crash before the commit below, delivering them again
      // writes nothing twice.
      for (const p of pending) {
        if (await undelivered(this.harness, conversation, p)) {
          await conversation.submit(
            { type: "write", requestId: `held:${p.id}`, entry: placed(p) },
            context,
          );
        }
      }
      await conversation.commit(async (tx) => {
        const policy = await tx.doc(FollowUps, conversation.id);
        policy.pending = policy.pending.filter((p) => !pending.some((d) => d.id === p.id));
      }, context);
    }
    return conversation.submit({ type: "input", content: text }, context);
  }

  /**
   * Every conversation with live work: a run, Galaxy work it watches, or input pi-durable queued,
   * which without a run is input an earlier build held in pi-durable's inbox.
   */
  async active(): Promise<Conversation[]> {
    const { tasks, submissions } = await this.harness.inspect(context);
    const ids = new Set(
      [
        ...tasks.map(({ record }) => record.conversationId),
        ...submissions.map((s) => s.conversationId),
      ].filter((id) => id),
    );
    const found = await Promise.all(
      [...ids].map((id) => this.harness.conversation(id as ConversationId, context)),
    );
    return found.filter((c): c is Conversation => c !== undefined);
  }

  hold(conversations: Conversation[]): Promise<void> {
    return hold(this.harness, conversations, this.brand);
  }

  /** The conversation as a saved session: its context, and what binds it to Galaxy. */
  async export(conversation: Conversation, title = ""): Promise<SessionDocument> {
    const [exported, bound, usage] = await Promise.all([
      exportEntries(conversation),
      this.harness.snapshot(Binding, conversation.id, context),
      this.harness.snapshot(UsageDoc, conversation.id, context),
    ]);
    const totals = Object.values(usage?.models ?? {});
    const now = new Date().toISOString();
    const build = thisBuild();
    return {
      olit_session: SCHEMA,
      ...(bound?.historyId ? { history_id: bound.historyId } : {}),
      ...(bound?.datasetId ? { dataset_id: bound.datasetId } : {}),
      session: {
        id: bound?.sessionId ?? uuid(),
        title,
        createdAt: bound?.startedAt ?? now,
        updatedAt: now,
        turn: exported.filter((e) => e.kind === "pi.user").length,
        ...(bound?.pageId ? { recordPageId: bound.pageId } : {}),
        ...(build ? { build } : {}),
        models: modelsOf(exported),
        usage: usageTotals(totals),
      },
      entries: exported,
    };
  }

  /**
   * A saved session as saved: the conversation already holding that save when it has not moved on
   * since, a new one opened from the document otherwise.
   */
  async open(document: SessionDocument, savedId: string): Promise<Conversation> {
    const index = await this.harness.snapshot(Sessions, context);
    const known = index?.bySaved[savedId];
    if (known && known.updatedAt === document.session.updatedAt) {
      const found = await this.harness.conversation(known.conversation as ConversationId, context);
      if (found && (await lastEntry(found)) === known.last) {
        await found.configure({ model: this.model }, context);
        return found;
      }
    }
    const opened = await this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: this.model },
        init: async (tx, id) => {
          const ids: EntryId[] = [];
          for (const { head, ...entry } of document.entries) {
            const placed =
              head === undefined
                ? {}
                : { head: head === "self" ? ("self" as const) : ids[head.entry] };
            ids.push((await tx.appendEntry(id, { ...entry, ...placed })).id);
          }
          Object.assign(await tx.doc(Binding, id), {
            sessionId: document.session.id,
            startedAt: document.session.createdAt,
            ...(document.history_id ? { historyId: document.history_id } : {}),
            ...(document.dataset_id ? { datasetId: document.dataset_id } : {}),
            ...(document.session.recordPageId ? { pageId: document.session.recordPageId } : {}),
          });
          if (document.history_id) (await tx.doc(Sessions)).byHistory[document.history_id] = id;
          // A save keeps totals, not a breakdown by model.
          const { input, output, cost } = document.session.usage;
          (await tx.doc(UsageDoc, id)).models["saved"] = {
            input,
            output,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: input + output,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost ?? 0 },
          };
        },
      },
      context,
    );
    await this.saved(opened, savedId, document);
    return opened;
  }

  /** Remember that this conversation, as it stands, is what `savedId` holds. */
  async saved(conversation: Conversation, savedId: string, document: SessionDocument) {
    const last = await lastEntry(conversation);
    await this.harness.commit(async (tx) => {
      (await tx.doc(Sessions)).bySaved[savedId] = {
        conversation: conversation.id,
        updatedAt: document.session.updatedAt,
        ...(last === undefined ? {} : { last }),
      };
    }, context);
  }

  close() {
    return this.harness.close(context);
  }
}

/**
 * Hold conversations nobody is looking at: each run ends and its follow-ups wait for the user's
 * next message, while its Galaxy work is still watched. Returns once the pauses are committed and
 * the aborts enqueued, without waiting for a running tool to end.
 *
 * Input pi-durable has queued is recorded in the conversation's own pending list in the commit that
 * pauses it, then withdrawn through `Harness.abortSubmission()`. A boundary may place it in
 * between; delivery then finds it placed and skips it, so it is delivered once either way.
 */
export async function hold(
  harness: Harness,
  conversations: Conversation[],
  brand: Brand = DEFAULT_BRAND,
): Promise<void> {
  const queued: SubmissionId[][] = [];
  for (const conversation of conversations) {
    const ids = await conversation.commit(async (tx) => {
      const policy = await tx.doc(FollowUps, conversation.id);
      policy.paused = true;
      // Read only: a queued input's content is kept in pi-durable's inbox and nowhere public.
      // Queued writes stay, as an abort leaves them.
      const inputs = (await tx.doc(InboxDoc, conversation.id)).items.filter(
        (item) => item.mode !== "write",
      );
      for (const item of inputs) {
        const id = `inbox:${item.id}`;
        if (!policy.pending.some((p) => p.id === id)) {
          policy.pending.push({
            id,
            content: item.content,
            ...(item.entry ? { entry: item.entry } : {}),
          });
        }
      }
      return inputs.map((item) => item.id);
    }, context);
    queued.push(ids);
  }
  // Withdrawing schedules nothing, so when the store opens no run takes a step before the aborts.
  await Promise.all(
    conversations.flatMap((conversation, i) =>
      queued[i].map((id) => harness.abortSubmission(id, context, conversation.id)),
    ),
  );
  // One synchronous pass: every abort mark is enqueued before scheduling can take a step.
  for (const conversation of conversations) {
    conversation
      .abort(context)
      .catch((e) => console.warn(`[${brand.id}] a held conversation did not stop`, e));
  }
}

/**
 * Whether a pending input is still the user's to deliver. Input pi-durable had queued is withdrawn
 * first, in case a crash came before hold() withdrew it; once withdrawn nothing can place it, and
 * input a boundary placed before then is in the transcript already.
 */
async function undelivered(
  harness: Harness,
  conversation: Conversation,
  pending: Pending,
): Promise<boolean> {
  let free = true;
  if (pending.id.startsWith("inbox:")) {
    const id = Number(pending.id.slice("inbox:".length)) as SubmissionId;
    await harness.abortSubmission(id, context, conversation.id);
    const record = await (await harness.submission(id, context))?.status(context);
    free = record === undefined || (record.status === "unanswered" && record.entry === undefined);
  }
  return free;
}

/** The entry a pending input is placed as: its own kind, or the user's message pi-durable writes. */
function placed(pending: Pending): EntryDraft {
  const message = { role: "user", content: pending.content, timestamp: Date.now() } as UserMessage;
  return {
    kind: pending.entry?.kind ?? UserEntry.kind,
    ...(pending.entry?.data === undefined ? {} : { data: pending.entry.data }),
    model: [message],
  };
}

/** Galaxy work the conversation watches, with the state its watch last read. */
export async function watchedBy(
  harness: Harness,
  conversationId: ConversationId,
  ctx: Chord,
): Promise<Watched[]> {
  const { tasks } = await harness.inspect(ctx);
  return tasks.flatMap(({ record }) => {
    if (record.kind !== WATCH_TASK || record.conversationId !== conversationId) return [];
    const state = (record.state as { checkpoint?: { state?: string } }).checkpoint?.state;
    return [{ ...(record.input as unknown as Watched), ...(state ? { state } : {}) }];
  });
}

/**
 * The conversation's whole history, oldest first and without system entries, as schema 5 saves it:
 * a head marker names the entry the context starts at by its position, or the first saved one
 * after it when that is a system entry.
 */
async function exportEntries(conversation: Conversation): Promise<ExportedEntry[]> {
  const history: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({}, 500, cursor, context);
    history.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  const kept = history.filter((entry) => !SystemEntry.is(entry)).sort((a, b) => a.id - b.id);
  const at = (id: EntryId) => kept.findIndex((entry) => entry.id >= id);
  return kept.map((entry, position) => {
    // A head on a system entry just before its carrier lands on the carrier itself; by position
    // that names no earlier entry, and the document would not open again.
    const head = entry.head === undefined ? undefined : at(entry.head);
    return {
      kind: entry.kind,
      ...(entry.model === undefined ? {} : { model: [...entry.model] }),
      ...(entry.data === undefined ? {} : { data: entry.data }),
      ...(head === undefined
        ? {}
        : { head: head === position ? ("self" as const) : { entry: head } }),
    };
  });
}

/** The id of the newest entry of the conversation's active context. */
async function lastEntry(conversation: Conversation): Promise<number | undefined> {
  return (await conversation.context(context)).entries.at(-1)?.id;
}
