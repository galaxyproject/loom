import type { Context as Chord } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  DEFAULT_COMPACTION_POLICY,
  Harness,
  UsageDoc,
  type Conversation,
  type ConversationId,
  type Cursor,
  type EntryRecord,
  type Extension,
  type Storage,
} from "@earendil-works/pi-durable";

import { artifactsOf, type Artifact } from "../artifacts/kinds";
import { Binding, FollowUps, Sessions } from "./documents";
import { DEFAULT_BRAND, type Brand } from "./brand";
import { connectGalaxy, type Galaxy } from "./galaxy";
import { agentModels } from "./model";
import type { RecordSummary } from "./records";
import { probeWindow, resolve, type LlmConfig, type Target } from "./providers";
import { modelsOf, SCHEMA, thisBuild, usageTotals, type SessionDocument } from "./saved";
import type { Capability } from "./tool";

export const context = BACKGROUND_CONTEXT;

export { GALAXY_READY, GALAXY_UNREACHABLE, type GalaxyStatus } from "./galaxy-status";
import { GALAXY_READY, GALAXY_UNREACHABLE, type GalaxyStatus } from "./galaxy-status";

/** The model calls one run may make before it stops, unless the config says otherwise. */
export const MAX_TURNS = 100;

/** Earlier artifacts a tool can place; a spec carries its rows, so few are offered. */
const ARTIFACT_LIMIT = 20;

/**
 * How the agent's turns run under pi-durable, whatever the model: what `describe` reports as well.
 */
export const LOOP = {
  toolExecution: "sequential",
  followUpMode: "all",
  promptPlacement: "lead",
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
  /** How often the Orbit brain's watch polls Galaxy at first; tests and drives shorten it. */
  poll_ms?: number;
}

export interface RuntimeOptions {
  storage: Storage;
  config: RuntimeConfig;
  /** Where a headless run reads provider keys; a browser has none. */
  env?: Record<string, string | undefined>;
  /** Whose runtime: the tag its warnings carry. */
  brand?: Brand;
  /**
   * The brain the conversations run on (Orbit's sealed extension and the shell's tasks). The model,
   * compaction, storage and the conversations are the runtime's.
   */
  extensions: Extension[];
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
 * The agent on pi-durable: one Harness over one storage with the brain's extensions installed,
 * and what a host decides around it: which conversation a history continues, the model in use,
 * and how a Stop holds back follow-ups.
 */
export class Runtime {
  /** Why Galaxy did not answer when the session opened, when it did not. */
  galaxyProblem?: string;
  /** The models the runtime connects through, for a brain that looks one up. */
  models?: Pick<ReturnType<typeof agentModels>["models"], "getModel">;
  private constructor(
    readonly harness: Harness,
    readonly galaxy: Galaxy,
    readonly galaxyStatus: GalaxyStatus,
    private readonly current: Current,
    private readonly connect: ReturnType<typeof agentModels>["connect"],
    private readonly env: Record<string, string | undefined>,
    readonly brand: Brand,
  ) {}

  static async open({
    storage,
    config,
    env = {},
    brand = DEFAULT_BRAND,
    extensions,
  }: RuntimeOptions) {
    const galaxy = connectGalaxy({
      root: config.galaxy_root,
      key: config.galaxy_key,
      credentials: config.credentials,
    });
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
    const registry = createRegistry();
    for (const installed of extensions) registry.install(installed);
    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: {
          ...LOOP,
          maxTurns: config.max_steps || MAX_TURNS,
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
    runtime.models = models;
    // Before scheduling starts, so no run the store holds takes another step unasked.
    await runtime.hold(await runtime.active());
    harness.resume();
    return runtime;
  }

  /** The model new requests use. */
  get model() {
    return this.current.model;
  }

  /** The key the model is reached with, for a brain that scrubs it from what it shows. */
  get apiKey(): string | undefined {
    return this.current.apiKey;
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

  /** Make `conversation` the one its history continues again, as it was before another took over. */
  async continues(conversation: Conversation): Promise<void> {
    const bound = await this.harness.snapshot(Binding, conversation.id, context);
    if (!bound?.historyId) return;
    const historyId = bound.historyId;
    await this.harness.commit(async (tx) => {
      (await tx.doc(Sessions)).byHistory[historyId] = conversation.id;
    }, context);
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

  /** Every conversation with live work: a run, or Galaxy work it watches. */
  async active(): Promise<Conversation[]> {
    const { tasks } = await this.harness.inspect(context);
    const ids = new Set(tasks.map(({ record }) => record.conversationId).filter((id) => id));
    const found = await Promise.all(
      [...ids].map((id) => this.harness.conversation(id as ConversationId, context)),
    );
    return found.filter((c): c is Conversation => c !== undefined);
  }

  hold(conversations: Conversation[]): Promise<void> {
    return hold(conversations, this.brand);
  }

  /** The conversation as a saved session: its context, and what binds it to Galaxy. */
  async export(conversation: Conversation, title = ""): Promise<SessionDocument> {
    const [exported, bound, usage] = await Promise.all([
      conversation.export(context),
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
        turn: exported.entries.filter((e) => e.kind === "pi.user").length,
        ...(bound?.pageId ? { recordPageId: bound.pageId } : {}),
        ...(build ? { build } : {}),
        models: modelsOf(exported.entries),
        usage: usageTotals(totals),
      },
      entries: [...exported.entries],
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
    const opened = await this.harness.importConversation(
      { entries: document.entries },
      {
        ownership: { kind: "ownerless" },
        agent: { model: this.model },
        init: async (tx, id) => {
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
 */
export async function hold(
  conversations: Conversation[],
  brand: Brand = DEFAULT_BRAND,
): Promise<void> {
  for (const conversation of conversations) {
    await conversation.commit(async (tx) => {
      (await tx.doc(FollowUps, conversation.id)).paused = true;
    }, context);
  }
  // One synchronous pass: every abort mark is enqueued before scheduling can take a step.
  for (const conversation of conversations) {
    conversation
      .abort(context, { keepQueued: true })
      .catch((e) => console.warn(`[${brand.id}] a held conversation did not stop`, e));
  }
}

/** The id of the newest entry of the conversation's active context. */
async function lastEntry(conversation: Conversation): Promise<number | undefined> {
  return (await conversation.context(context)).entries.at(-1)?.id;
}
