/**
 * pi-coding-agent's ExtensionAPI over pi-durable: the host Orbit's brain (extensions/loom) is
 * written against, reproduced on the browser worker's runtime. Registrations become one
 * pi-durable extension; pi's events are emitted from the seams pi-durable has (sections, the
 * generation and tool hooks, the event stream, and the host's own submit/command/shutdown), in
 * pi's order and with pi's composition rules (copied from pi-coding-agent's runner.js). What has
 * no seam is accepted and recorded as a note rather than failing, so a conformance run can list
 * every reach Orbit makes past this shell.
 */
import type { Context as Chord, JsonValue } from "@earendil-works/chord";
import type {
  AssistantMessage,
  Message,
  Model,
  ToolResultMessage,
  TSchema,
} from "@earendil-works/pi-ai";
import type {
  EventBus,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionToolContext,
  ModelRegistry,
  RegisteredCommand,
  SourceInfo,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  CompactionTask,
  ConversationBusy,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  LiveDoc,
  section,
  ToolTask,
  watchEvents,
  type AgentEvent,
  type AgentEventStream,
  type Conversation,
  type ConversationId,
  type EntryRecord,
  type Extension,
  type Harness,
  type HookApi,
  type JsonObject,
  type ModelRef,
  type PromptInput,
  type Submission,
  type SubmissionId,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";

/** Every name pi's `on()` overloads accept; a union, since an overload set has no inferable first parameter. */
export type PiEventName =
  | "project_trust"
  | "resources_discover"
  | "session_start"
  | "session_info_changed"
  | "session_before_switch"
  | "session_before_fork"
  | "session_before_compact"
  | "session_compact"
  | "session_compact_failed"
  | "session_shutdown"
  | "mcp_servers_change"
  | "session_before_tree"
  | "session_tree"
  | "context"
  | "context_with_system"
  | "cache_warming_decision"
  | "before_provider_request"
  | "before_provider_headers"
  | "after_provider_response"
  | "provider_stream_event"
  | "before_agent_start"
  | "agent_start"
  | "agent_end"
  | "agent_before_settle"
  | "agent_settled"
  | "ui_prompt_start"
  | "ui_prompt_end"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "model_select"
  | "thinking_level_select"
  | "tool_call"
  | "tool_result"
  | "user_bash"
  | "input";
export type SessionReason = "startup" | "reload" | "new" | "resume" | "fork";
export type ShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";
export type InputSource = "interactive" | "rpc" | "extension";
/** A free-form label the host sets; stamped on every note. */
export type HostPhase = string;

/** The pi events this host emits; every other name is accepted and noted `silent` at seal. */
export const EMITTED_EVENTS = [
  "session_start",
  "session_shutdown",
  "session_before_compact",
  "before_agent_start",
  "agent_start",
  "turn_start",
  "context",
  "context_with_system",
  "message_end",
  "tool_execution_start",
  "tool_call",
  "tool_result",
  "tool_execution_end",
  "turn_end",
  "agent_end",
  "agent_settled",
  "input",
  "model_select",
] as const satisfies readonly PiEventName[];

/** pi's own text, verbatim: ui-bridge.ts matches /ctx is stale/i and progress-updates.ts stops on the throw. */
export const STALE_CTX_MESSAGE =
  "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";

export class NotInThisShell extends Error {
  override readonly name = "NotInThisShell";
  constructor(
    readonly member: string,
    readonly detail?: string,
  ) {
    super(`${member} is not available in this shell${detail ? `: ${detail}` : ""}`);
  }
}

export type AskRequest =
  | { kind: "confirm"; title: string; message: string }
  | { kind: "select"; title: string; options: string[] }
  | { kind: "input"; title: string; placeholder?: string }
  | { kind: "editor"; title: string; prefill?: string };
/** `undefined` means dismissed. */
export type AskAnswer = boolean | string | undefined;

/** What a shell gives the brain to reach a person. `ask` present <=> ctx.hasUI. */
export interface PiHostUi {
  notify?(
    text: string,
    level: "info" | "warning" | "error",
    conversationId: ConversationId | undefined,
  ): void;
  ask?(
    request: AskRequest,
    conversationId: ConversationId | undefined,
    signal?: AbortSignal,
  ): Promise<AskAnswer>;
  setStatus?(key: string, text: string | undefined): void;
  setWidget?(key: string, lines: string[] | undefined): void;
}

export interface PiHostModel {
  provider: string;
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number };
}

export type HostNote =
  | { kind: "refused"; member: string; detail?: string; phase: HostPhase }
  | { kind: "silent"; event: PiEventName; handlers: number }
  | { kind: "dropped"; member: string; phase: HostPhase }
  | { kind: "handler-error"; event: string; error: unknown; phase: HostPhase }
  | { kind: "busy"; member: "sendUserMessage"; phase: HostPhase };

export interface PiHostOptions {
  /** The extension's name, which is also its section key. */
  name: string;
  /** ctx.cwd; "/" by default. */
  cwd?: string;
  ui?: PiHostUi;
  /** ctx.model. */
  model?: () => PiHostModel | undefined;
  /** sessionManager.getSessionId(); the conversation id by default. */
  sessionId?: () => string;
  phase?: () => HostPhase;
  onNote?: (note: HostNote) => void;
}

export interface PiHost {
  /** Hand to galaxyAnalystExtension(pi). A plain object: auto-resume.ts reassigns registerCommand. */
  readonly api: ExtensionAPI;
  /** Freeze registrations and build the pi-durable extension. */
  seal(): Extension;
  /** Bind the live conversation: event stream, branch snapshot, submit/abort/configure. */
  attach(harness: Harness, conversation: Conversation, context: Chord): Promise<void>;
  /** pi's session_start; needs attach(). */
  start(reason: SessionReason): Promise<void>;
  /** The input chain, message_end(user), then Conversation.submit. undefined when handled or rejected busy. */
  submit(
    text: string,
    options?: { source?: InputSource; deliverAs?: "steer" | "followUp" },
  ): Promise<Submission | undefined>;
  /** Run a registered command through its stored (possibly wrapped) handler. false when unknown. */
  command(name: string, args: string): Promise<boolean>;
  /** session_shutdown, invalidate every issued ctx, stop the event stream. */
  shutdown(reason: ShutdownReason): Promise<void>;
  readonly handlers: ReadonlyMap<PiEventName, number>;
  /** Registration order; a later same-name registration replaces. */
  readonly tools: readonly string[];
  readonly commands: ReadonlyMap<string, { description?: string }>;
  readonly notes: readonly HostNote[];
}

type Handler = (event: any, ctx: any) => unknown;
type AnyTool = ToolDefinition<any, any, any>;
type SessionMessageEntry = {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: Message;
};
type PiMessage = Message & { customType?: string; display?: boolean };

interface Run {
  /** LiveDoc.run.inputs[0]; a change means a new run. */
  id: SubmissionId | undefined;
  /** The last before_agent_start override. */
  systemPrompt?: string;
  turn: number;
  turnOpen: boolean;
  /** The last afterResponse. */
  assistant?: AssistantMessage;
  /** This round, in call order. */
  toolResults: ToolResultMessage[];
  /** Call ids that saw tool_execution_start. */
  started: Set<string>;
  startedAt: Map<string, number>;
  /** callId -> the validated (and possibly tool_call-mutated) arguments, which pi hands to tool_result too. */
  args: Map<string, Record<string, unknown>>;
  /** callId -> the reason our own beforeTool returned. */
  blocked: Map<string, string>;
}

interface Bound {
  harness: Harness;
  conversation: Conversation;
  context: Chord;
  stream: AgentEventStream;
  busy: boolean;
  inbox: number;
  agentModel?: ModelRef;
  branch: SessionMessageEntry[];
  /** Where the run's messages start in the context, for agent_end. */
  contextLenAtRunStart: number;
  /** The run the stream has most recently reported started. */
  lastStarted?: SubmissionId;
  /** Renders waiting for the stream to report their run started. */
  starts: Map<SubmissionId, Array<() => void>>;
  /**
   * A run pi-durable started in the same commit that ended the previous one: queued follow-ups,
   * which pi delivers inside one agent run, so the shim keeps one run too.
   */
  continuing?: SubmissionId;
}

/** pi-durable keeps details as JSON; this also strips `undefined` the way a JSON round trip does. */
const json = <T>(x: T): T => (x === undefined ? x : JSON.parse(JSON.stringify(x)));

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error ?? "unknown error");

const codeOf = (result: ToolExecutionResult) =>
  result.diagnostics?.find((d) => d.severity === "error")?.code;

const sameMessages = (left: readonly unknown[], right: readonly unknown[]) =>
  left.length === right.length && left.every((m, i) => m === right[i]);

const freshRun = (id: SubmissionId | undefined): Run => ({
  id,
  turn: 0,
  turnOpen: false,
  toolResults: [],
  started: new Set(),
  startedAt: new Map(),
  args: new Map(),
  blocked: new Map(),
});

function toPiModel(m: PiHostModel | undefined): Model<any> | undefined {
  if (!m) return undefined;
  // ctx.model only ever feeds provider/id/cost reads in Orbit; the rest is pi's shape filled in.
  return {
    provider: m.provider,
    id: m.id,
    name: m.id,
    api: "openai-completions",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow ?? 128000,
    maxTokens: m.maxTokens ?? 4096,
  } as Model<any>;
}

const abortedAssistant = (ref: ModelRef | undefined): AssistantMessage =>
  ({
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: ref?.provider ?? "",
    model: ref?.modelId ?? "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "aborted",
    timestamp: Date.now(),
  }) as AssistantMessage;

const modelOf = (ref: ModelRef | undefined) =>
  ref ? toPiModel({ provider: ref.provider, id: ref.modelId }) : undefined;

/** How long a section render waits for the stream to report its run started. */
const RUN_START_WAIT_MS = 5000;

export function createPiHost(options: PiHostOptions): PiHost {
  const handlers = new Map<PiEventName, Handler[]>();
  const tools = new Map<string, AnyTool>();
  const commands = new Map<string, RegisteredCommand>();
  const notes: HostNote[] = [];
  let sealed = false;
  let stale: string | undefined;
  let bound: Bound | undefined;
  let run = freshRun(undefined);
  let lastPrompt = "";
  let lastSystemPrompt = "";
  let lastOffered: string[] | undefined;
  let otherConversationNoted = false;

  const phase = () => options.phase?.() ?? "run";
  const note = (n: HostNote) => {
    notes.push(n);
    options.onNote?.(n);
  };
  const refused = (member: string, detail?: string) =>
    note({ kind: "refused", member, ...(detail === undefined ? {} : { detail }), phase: phase() });
  const dropped = (member: string) => note({ kind: "dropped", member, phase: phase() });
  const handlerError = (event: string, error: unknown) =>
    note({ kind: "handler-error", event, error, phase: phase() });
  const handlersOf = (event: PiEventName) => handlers.get(event)?.slice() ?? [];
  const conversationId = () => bound?.conversation.id;

  // ── ctx ────────────────────────────────────────────────────────────────────────────────────

  function assertActive() {
    if (stale !== undefined) throw new Error(stale);
  }

  const ask = async (request: AskRequest, member: string, signal?: AbortSignal) => {
    if (!options.ui?.ask) {
      refused(member);
      return undefined;
    }
    return options.ui.ask(request, conversationId(), signal);
  };

  const ui = {
    notify: (message: string, level: "info" | "warning" | "error" = "info") => {
      if (options.ui?.notify) options.ui.notify(message, level, conversationId());
      else dropped("ctx.ui.notify");
    },
    confirm: async (title: string, message: string, opts?: { signal?: AbortSignal }) =>
      (await ask({ kind: "confirm", title, message }, "ctx.ui.confirm", opts?.signal)) === true,
    select: async (title: string, choices: string[], opts?: { signal?: AbortSignal }) => {
      const answer = await ask(
        { kind: "select", title, options: choices },
        "ctx.ui.select",
        opts?.signal,
      );
      return typeof answer === "string" ? answer : undefined;
    },
    input: async (title: string, placeholder?: string, opts?: { signal?: AbortSignal }) => {
      const answer = await ask({ kind: "input", title, placeholder }, "ctx.ui.input", opts?.signal);
      return typeof answer === "string" ? answer : undefined;
    },
    editor: async (title: string, prefill?: string) => {
      const answer = await ask({ kind: "editor", title, prefill }, "ctx.ui.editor");
      return typeof answer === "string" ? answer : undefined;
    },
    setStatus: (key: string, text: string | undefined) => {
      if (options.ui?.setStatus) options.ui.setStatus(key, text);
      else dropped(`ctx.ui.setStatus ${key}`);
    },
    setWidget: (key: string, content: unknown) => {
      if (options.ui?.setWidget && (content === undefined || Array.isArray(content))) {
        options.ui.setWidget(key, content as string[] | undefined);
      } else dropped(`ctx.ui.setWidget ${key}`);
    },
    setToolsExpanded: () => dropped("ctx.ui.setToolsExpanded"),
    getToolsExpanded: () => false,
    setWorkingMessage: () => refused("ctx.ui.setWorkingMessage"),
    setWorkingVisible: () => refused("ctx.ui.setWorkingVisible"),
    setWorkingIndicator: () => refused("ctx.ui.setWorkingIndicator"),
    setHiddenThinkingLabel: () => refused("ctx.ui.setHiddenThinkingLabel"),
    setTitle: () => refused("ctx.ui.setTitle"),
    setFooter: () => refused("ctx.ui.setFooter"),
    setHeader: () => refused("ctx.ui.setHeader"),
    pasteToEditor: () => refused("ctx.ui.pasteToEditor"),
    setEditorText: () => refused("ctx.ui.setEditorText"),
    getEditorText: () => {
      refused("ctx.ui.getEditorText");
      return "";
    },
    setEditorComponent: () => refused("ctx.ui.setEditorComponent"),
    getEditorComponent: () => {
      refused("ctx.ui.getEditorComponent");
      return undefined;
    },
    addAutocompleteProvider: () => refused("ctx.ui.addAutocompleteProvider"),
    get theme() {
      refused("ctx.ui.theme");
      // No terminal, no theme; nothing in Orbit reads one.
      return {} as Theme;
    },
    getAllThemes: () => {
      refused("ctx.ui.getAllThemes");
      return [];
    },
    getTheme: () => {
      refused("ctx.ui.getTheme");
      return undefined;
    },
    setTheme: () => {
      refused("ctx.ui.setTheme");
      return { success: false, error: "not in this shell" };
    },
    custom: () => {
      throw new NotInThisShell("ctx.ui.custom");
    },
    onTerminalInput: () => {
      throw new NotInThisShell("ctx.ui.onTerminalInput");
    },
  };

  const sessionManager = {
    getBranch: () => bound?.branch ?? [],
    getEntries: () => bound?.branch ?? [],
    getSessionId: () => options.sessionId?.() ?? String(conversationId() ?? ""),
    getSessionFile: () => undefined,
    getSessionDir: () => options.cwd ?? "/",
    getCwd: () => options.cwd ?? "/",
    getLeafId: () => {
      refused("ctx.sessionManager.getLeafId");
      return null;
    },
    getLeafEntry: () => {
      refused("ctx.sessionManager.getLeafEntry");
      return undefined;
    },
    getEntry: () => {
      refused("ctx.sessionManager.getEntry");
      return undefined;
    },
    getLabel: () => {
      refused("ctx.sessionManager.getLabel");
      return undefined;
    },
    getHeader: () => {
      refused("ctx.sessionManager.getHeader");
      return null;
    },
    getTree: () => {
      refused("ctx.sessionManager.getTree");
      return [];
    },
    getSessionName: () => {
      refused("ctx.sessionManager.getSessionName");
      return undefined;
    },
    buildContextEntries: () => {
      refused("ctx.sessionManager.buildContextEntries");
      return [];
    },
    buildSessionProjection: () => {
      refused("ctx.sessionManager.buildSessionProjection");
      return { entries: [], messages: [], thinkingLevel: "off", model: null };
    },
  };

  // Orbit reads find/getAll/getAvailable; the other two dozen members of pi's registry manage
  // providers and auth this shell does not have, so only the three are offered.
  const modelRegistry = {
    find: () => {
      refused("ctx.modelRegistry.find");
      return undefined;
    },
    getAll: () => [],
    getAvailable: () => [],
  } as unknown as ModelRegistry;

  /** A fresh ctx per emit, as pi makes one; every member checks for staleness first. */
  function makeCtx(signal: AbortSignal | undefined): ExtensionContext {
    const ctx: ExtensionContext = {
      get ui() {
        assertActive();
        return ui;
      },
      get mode() {
        assertActive();
        return "rpc" as const;
      },
      get hasUI() {
        assertActive();
        return options.ui?.ask !== undefined;
      },
      get cwd() {
        assertActive();
        return options.cwd ?? "/";
      },
      get sessionManager() {
        assertActive();
        return sessionManager;
      },
      get modelRegistry() {
        assertActive();
        return modelRegistry;
      },
      get model() {
        assertActive();
        return toPiModel(options.model?.());
      },
      get scopedModels() {
        assertActive();
        return [];
      },
      get thinkingLevel() {
        assertActive();
        return undefined;
      },
      get signal() {
        assertActive();
        return signal;
      },
      isIdle: () => {
        assertActive();
        return !bound?.busy;
      },
      isProjectTrusted: () => {
        assertActive();
        return false;
      },
      abort: () => {
        assertActive();
        if (bound) void bound.conversation.abort(bound.context).catch(() => {});
      },
      hasPendingMessages: () => {
        assertActive();
        return (bound?.inbox ?? 0) > 0;
      },
      shutdown: () => {
        assertActive();
        throw new NotInThisShell("ctx.shutdown");
      },
      getContextUsage: () => {
        assertActive();
        refused("ctx.getContextUsage");
        return undefined;
      },
      compact: (opts?: { onError?: (error: Error) => void }) => {
        assertActive();
        refused("ctx.compact");
        opts?.onError?.(new NotInThisShell("ctx.compact"));
      },
      getSystemPrompt: () => {
        assertActive();
        return lastSystemPrompt;
      },
    };
    return ctx;
  }

  function makeToolCtx(signal: AbortSignal | undefined): ExtensionToolContext {
    return Object.defineProperties(makeCtx(signal), {
      tools: { get: () => [] },
      executeTool: {
        value: () => {
          throw new NotInThisShell("ctx.executeTool");
        },
      },
    }) as ExtensionToolContext;
  }

  function makeCommandCtx(): ExtensionCommandContext {
    const throws = (member: string) => () => {
      assertActive();
      throw new NotInThisShell(member);
    };
    // Built without `reload`: this shell cannot do one, and /connect, the one command that asks
    // for it, returns before then in a shell with no files.
    return Object.defineProperties(makeCtx(undefined), {
      waitForIdle: {
        value: () => {
          assertActive();
          return bound ? bound.conversation.waitForIdle(bound.context) : Promise.resolve();
        },
      },
      newSession: { value: throws("ctx.newSession") },
      fork: { value: throws("ctx.fork") },
      switchSession: { value: throws("ctx.switchSession") },
      navigateTree: { value: throws("ctx.navigateTree") },
      getSystemPromptOptions: { value: throws("ctx.getSystemPromptOptions") },
    }) as ExtensionCommandContext;
  }

  // ── emit engine (runner.js) ────────────────────────────────────────────────────────────────

  async function emit(event: PiEventName, payload: object, signal?: AbortSignal) {
    const ctx = makeCtx(signal);
    for (const handler of handlersOf(event)) {
      try {
        await handler({ type: event, ...payload }, ctx);
      } catch (error) {
        handlerError(event, error);
      }
    }
  }

  /** The same event object to every handler, no catch: a throw blocks, as pi's does. */
  async function emitToolCall(
    event: {
      type: "tool_call";
      toolName: string;
      toolCallId: string;
      input: Record<string, unknown>;
    },
    signal: AbortSignal | undefined,
  ) {
    const ctx = makeCtx(signal);
    let result: { block?: boolean; reason?: string; terminate?: boolean } | undefined;
    for (const handler of handlersOf("tool_call")) {
      const r = (await handler(event, ctx)) as typeof result;
      if (r) {
        result = r;
        if (r.block) break;
      }
    }
    if (result?.terminate) refused("tool_call.terminate");
    return result;
  }

  async function emitToolResult(
    event: {
      type: "tool_result";
      toolName: string;
      toolCallId: string;
      input: Record<string, unknown>;
      content: ToolResultMessage["content"];
      details: unknown;
      isError: boolean;
      usage?: unknown;
      structuredContent?: unknown;
    },
    signal: AbortSignal | undefined,
  ) {
    const ctx = makeCtx(signal);
    const current = { ...event };
    let modified = false;
    for (const handler of handlersOf("tool_result")) {
      try {
        const r = (await handler(current, ctx)) as Partial<typeof current> | undefined;
        if (!r) continue;
        if (r.content !== undefined) {
          current.content = r.content;
          if (r.structuredContent === undefined) delete current.structuredContent;
          modified = true;
        }
        if (r.details !== undefined) {
          current.details = r.details;
          modified = true;
        }
        if (r.structuredContent !== undefined) {
          current.structuredContent = r.structuredContent;
          modified = true;
        }
        if (r.isError !== undefined) {
          current.isError = r.isError;
          modified = true;
        }
        if (r.usage !== undefined) {
          current.usage = r.usage;
          modified = true;
        }
      } catch (error) {
        handlerError("tool_result", error);
      }
    }
    return modified ? current : undefined;
  }

  async function emitMessageEnd<M extends { role: string }>(message: M, signal?: AbortSignal) {
    const ctx = makeCtx(signal);
    let current = message;
    let modified = false;
    for (const handler of handlersOf("message_end")) {
      try {
        const r = (await handler({ type: "message_end", message: current }, ctx)) as
          { message?: M } | undefined;
        if (!r?.message) continue;
        if (r.message.role !== current.role) {
          handlerError(
            "message_end",
            new Error("message_end handlers must return a message with the same role"),
          );
          continue;
        }
        current = r.message;
        modified = true;
      } catch (error) {
        handlerError("message_end", error);
      }
    }
    return modified ? current : undefined;
  }

  async function emitBeforeAgentStart(prompt: string, signal: AbortSignal | undefined) {
    const systemPrompt = () => run.systemPrompt ?? lastSystemPrompt;
    const ctx = Object.defineProperties(makeCtx(signal), {
      getSystemPrompt: {
        value: () => {
          assertActive();
          return systemPrompt();
        },
      },
    });
    for (const handler of handlersOf("before_agent_start")) {
      try {
        const event = {
          type: "before_agent_start",
          prompt,
          images: undefined,
          get systemPrompt() {
            return systemPrompt();
          },
          systemPromptOptions: {} as any,
        };
        const r = (await handler(event, ctx)) as
          { systemPrompt?: string; message?: unknown } | undefined;
        if (r?.message) refused("before_agent_start.message");
        if (r?.systemPrompt !== undefined) run.systemPrompt = r.systemPrompt;
      } catch (error) {
        handlerError("before_agent_start", error);
      }
    }
  }

  /** pi's custom-role message as its convertToLlm renders it for the provider. */
  const customToUser = (m: PiMessage): Message =>
    m.role === ("custom" as string)
      ? ({
          role: "user",
          content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content,
          timestamp: m.timestamp,
        } as Message)
      : (m as Message);

  async function emitContext(messages: readonly Message[], signal: AbortSignal | undefined) {
    const ctx = makeCtx(signal);
    let current: PiMessage[] = structuredClone(messages) as PiMessage[];
    const system = current.flatMap((m, index) =>
      m.role === "system" ? [[index, m] as const] : [],
    );
    for (const handler of handlersOf("context")) {
      try {
        const visible = current.filter((m) => m.role !== "system");
        const snapshot = visible.slice();
        const r = (await handler({ type: "context", messages: visible }, ctx)) as
          { messages?: PiMessage[] } | undefined;
        const returned = r?.messages ?? (sameMessages(visible, snapshot) ? undefined : visible);
        if (!returned) continue;
        const out = returned.map(customToUser) as PiMessage[];
        // Every system message goes back where it was: pi-durable can carry several pi.system
        // entries, where pi re-heads only the leading one.
        for (const [index, m] of system) out.splice(Math.min(index, out.length), 0, m);
        current = out;
      } catch (error) {
        handlerError("context", error);
      }
    }
    for (const handler of handlersOf("context_with_system")) {
      try {
        const r = (await handler({ type: "context_with_system", messages: current }, ctx)) as
          { messages?: PiMessage[] } | undefined;
        current = r?.messages ?? current;
      } catch (error) {
        handlerError("context_with_system", error);
      }
    }
    return current as Message[];
  }

  async function emitInput(text: string, source: InputSource, deliverAs?: "steer" | "followUp") {
    const ctx = makeCtx(undefined);
    let current = text;
    for (const handler of handlersOf("input")) {
      try {
        const r = (await handler(
          { type: "input", text: current, images: undefined, source, streamingBehavior: deliverAs },
          ctx,
        )) as { action?: string; text?: string } | undefined;
        if (r?.action === "handled") return { handled: true as const, text: current };
        if (r?.action === "transform" && typeof r.text === "string") current = r.text;
      } catch (error) {
        handlerError("input", error);
      }
    }
    return { handled: false as const, text: current };
  }

  // ── registrations ──────────────────────────────────────────────────────────────────────────

  function wrap(def: AnyTool): ToolRegistration {
    return defineTool({
      name: def.name,
      description: def.description,
      // Two pi-ai copies in the program: Orbit's TypeBox schema is passed through untouched so
      // pi-ai validates it as it does today (strict for @sinclair/typebox, see the orbit test).
      parameters: def.parameters as unknown as TSchema,
      ...(def.executionMode ? { executionMode: def.executionMode } : {}),
      ...(def.prepareArguments ? { prepareArguments: def.prepareArguments } : {}),
      execute: async (args, api, chord) => {
        run.startedAt.set(api.callId, Date.now());
        const toolCtx = makeToolCtx(chord.abortSignal);
        const onUpdate = (partial: { details?: unknown } | undefined) => {
          if (partial?.details !== undefined)
            void api.details(json(partial.details) as JsonValue, chord);
        };
        try {
          const r = await def.execute(api.callId, args, chord.abortSignal, onUpdate, toolCtx);
          return {
            output: r.content ?? [],
            details: json(r.details) ?? {},
            isError: r.isError === true,
          };
        } catch (error) {
          if (chord.abortSignal?.aborted) throw error;
          // pi-agent-core turns a throw into an error result; a pi-durable throw would fault the task.
          return {
            output: [{ type: "text", text: errorText(error) }],
            details: {},
            isError: true,
          };
        }
      },
    });
  }

  const api: ExtensionAPI = {
    on: (event: PiEventName, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const at = list.indexOf(handler);
        if (at >= 0) list.splice(at, 1);
      };
    },
    registerTool: (def: AnyTool) => {
      if (sealed) {
        refused("registerTool", def.name);
        return;
      }
      tools.set(def.name, def);
    },
    registerCommand: (name: string, opts: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
      if (sealed) {
        refused("registerCommand", name);
        return;
      }
      commands.set(name, { name, ...opts } as RegisteredCommand);
    },
    sendUserMessage: (content: unknown, opts?: { deliverAs?: "steer" | "followUp" }) => {
      if (typeof content !== "string") {
        refused("sendUserMessage", "non-text content");
        return;
      }
      if (!bound) {
        // A late send (a follow-up timer, a tool's tail) after shutdown; pi reports, never throws.
        refused("sendUserMessage", "no conversation attached");
        return;
      }
      submit(content, { source: "extension", deliverAs: opts?.deliverAs }).catch((error) =>
        handlerError("sendUserMessage", error),
      );
    },
    sendMessage: (message: { customType: string }) => refused("sendMessage", message.customType),
    appendEntry: (customType: string) => refused("appendEntry", customType),
    getActiveTools: () => lastOffered ?? [...tools.keys()],
    setModel: async (model: { provider: string; id: string }) => {
      if (!bound) {
        refused("setModel", `${model.provider}/${model.id}`);
        return false;
      }
      await bound.conversation.configure(
        { model: { provider: model.provider, modelId: model.id } },
        bound.context,
      );
      return true;
    },
    getAllTools: () =>
      [...tools.values()].map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        exposure: "direct" as const,
        sourceInfo: SOURCE,
      })),
    getCommands: () =>
      [...commands.values()].map((c) => ({
        name: c.name,
        description: c.description,
        source: "extension" as const,
        sourceInfo: SOURCE,
      })),
    getSettings: () => {
      refused("getSettings");
      return {} as ReturnType<ExtensionAPI["getSettings"]>;
    },
    setActiveTools: () => refused("setActiveTools"),
    getThinkingLevel: () => {
      refused("getThinkingLevel");
      return "off";
    },
    setThinkingLevel: () => refused("setThinkingLevel"),
    registerShortcut: () => refused("registerShortcut"),
    registerFlag: (name: string) => refused("registerFlag", name),
    getFlag: (name: string) => {
      refused("getFlag", name);
      return undefined;
    },
    registerMessageRenderer: (customType: string) => refused("registerMessageRenderer", customType),
    registerMarkdownTransformer: () => refused("registerMarkdownTransformer"),
    registerEntryRenderer: (customType: string) => refused("registerEntryRenderer", customType),
    registerToolRenderer: () => refused("registerToolRenderer"),
    setSessionName: () => refused("setSessionName"),
    getSessionName: () => {
      refused("getSessionName");
      return undefined;
    },
    setLabel: () => refused("setLabel"),
    // Hit by mcp-servers.ts under a profile with an MCP layer; pi reports an unhandled registration
    // too, never throws.
    registerMcpServer: (name: string) => refused("registerMcpServer", name),
    unregisterMcpServer: (name: string) => refused("unregisterMcpServer", name),
    getMcpServers: () => {
      refused("getMcpServers");
      return [];
    },
    exec: () => {
      throw new NotInThisShell("exec");
    },
    registerProvider: () => {
      throw new NotInThisShell("registerProvider");
    },
    unregisterProvider: () => {
      throw new NotInThisShell("unregisterProvider");
    },
    registerVirtualModel: () => {
      throw new NotInThisShell("registerVirtualModel");
    },
    unregisterVirtualModel: () => {
      throw new NotInThisShell("unregisterVirtualModel");
    },
    get events() {
      refused("events");
      // A bus nobody else is on; the type is pi's.
      return { on: () => () => {}, off: () => {}, emit: () => {} } as unknown as EventBus;
    },
  };

  // ── the pi-durable extension ───────────────────────────────────────────────────────────────

  function otherConversation(api: HookApi) {
    if (bound && api.conversationId === bound.conversation.id) return false;
    if (bound && !otherConversationNoted) {
      otherConversationNoted = true;
      refused("hook for another conversation", String(api.conversationId));
    }
    return bound !== undefined;
  }

  /**
   * Wait until the event stream has reported `id` started. agent_end comes from the stream, the
   * next run's before_agent_start from the section render on the scheduler's side; the stream
   * delivers run_end before run_start, so waiting here pins agent_end before before_agent_start
   * instead of leaving it to timing. Bounded, so a stream that never says so (an overflow the
   * snapshot case below did not cover) costs a note rather than a hang.
   */
  async function runStarted(b: Bound, id: SubmissionId, signal: AbortSignal | undefined) {
    if (b.lastStarted === id || bound !== b) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const seen = new Promise<boolean>((resolve) => {
      const list = b.starts.get(id) ?? [];
      list.push(() => resolve(true));
      b.starts.set(id, list);
      timer = setTimeout(() => resolve(false), RUN_START_WAIT_MS);
      signal?.addEventListener("abort", () => resolve(false), { once: true });
    });
    const ok = await seen;
    clearTimeout(timer);
    b.starts.delete(id);
    if (!ok && !signal?.aborted)
      handlerError("run_start", new Error(`run ${String(id)} not reported started`));
  }

  async function render(input: PromptInput, chord: Chord) {
    lastOffered = input.agent.tools.map((t) => t.name);
    const id = (await input.read.snapshot(LiveDoc, input.conversationId, chord))?.run?.inputs[0];
    if (id !== run.id) {
      const b = bound;
      if (b && id !== undefined) await runStarted(b, id, chord.abortSignal);
      if (b && id !== undefined && b.continuing === id) {
        // Queued follow-ups: the same pi run goes on, with no new agent_start.
        b.continuing = undefined;
        run.id = id;
      } else {
        run = freshRun(id);
        await emitBeforeAgentStart(lastPrompt, chord.abortSignal);
        await emit("agent_start", {}, chord.abortSignal);
      }
    }
    if (!run.turnOpen) {
      run.turnOpen = true;
      await emit("turn_start", { turnIndex: run.turn, timestamp: Date.now() }, chord.abortSignal);
    }
    lastSystemPrompt = run.systemPrompt ?? "";
    return run.systemPrompt;
  }

  async function turnEnd(
    answer: AssistantMessage | undefined,
    entryId: string,
    resultIds: readonly string[],
    chord: Chord,
  ) {
    const ctx = makeCtx(chord.abortSignal);
    const event = {
      type: "turn_end",
      turnIndex: run.turn,
      message: run.assistant ?? answer,
      toolResults: run.toolResults,
      messageEntryId: entryId,
      toolResultEntryIds: [...resultIds],
      entries: [],
      continue: false,
      context: {},
      outcome: "completed",
    };
    for (const handler of handlersOf("turn_end")) {
      try {
        const r = (await handler(event, ctx)) as
          { entries?: unknown; continue?: unknown } | undefined;
        if (r?.entries !== undefined || r?.continue !== undefined) refused("turn_end.entries");
      } catch (error) {
        handlerError("turn_end", error);
      }
    }
    run.turn += 1;
    run.turnOpen = false;
    run.toolResults = [];
  }

  const toSessionEntries = (entries: readonly EntryRecord[]): SessionMessageEntry[] => {
    let parentId: string | null = null;
    return entries.flatMap((e) =>
      (e.model ?? []).map((message) => {
        const entry: SessionMessageEntry = {
          type: "message",
          id: String(e.id),
          parentId,
          timestamp: new Date().toISOString(),
          message,
        };
        parentId = entry.id;
        return entry;
      }),
    );
  };

  async function executionEnd(
    call: { id: string; name: string; arguments: Record<string, unknown> },
    result: { content: ToolResultMessage["content"]; details: unknown; isError: boolean },
    durationMs: number | undefined,
    chord: Chord,
  ) {
    if (!run.started.has(call.id)) {
      // A call that never reached beforeTool (unoffered or invalid) still gets pi's start event.
      run.started.add(call.id);
      await emit(
        "tool_execution_start",
        { toolCallId: call.id, toolName: call.name, args: call.arguments },
        chord.abortSignal,
      );
    }
    await emit(
      "tool_execution_end",
      {
        toolCallId: call.id,
        toolName: call.name,
        result: { content: result.content, details: result.details },
        isError: result.isError,
        ...(durationMs === undefined ? {} : { durationMs }),
      },
      chord.abortSignal,
    );
    const message = {
      role: "toolResult" as const,
      toolCallId: call.id,
      toolName: call.name,
      content: result.content,
      details: result.details,
      isError: result.isError,
      ...(durationMs === undefined ? {} : { durationMs }),
      timestamp: Date.now(),
    };
    const replaced = await emitMessageEnd(message, chord.abortSignal);
    const final = (replaced ?? message) as ToolResultMessage;
    run.toolResults.push(final);
    return replaced;
  }

  function seal(): Extension {
    sealed = true;
    for (const [event, list] of handlers) {
      if (!(EMITTED_EVENTS as readonly string[]).includes(event) && list.length) {
        note({ kind: "silent", event, handlers: list.length });
      }
    }
    return defineExtension({
      name: options.name,
      tools: [...tools.values()].map(wrap),
      sections: [section(options.name, render, { tag: false })],
      hooks: [
        hook(GenerationTask, {
          beforeRequest: async (request, api, chord) => {
            if (otherConversation(api)) return undefined;
            return { messages: await emitContext(request.messages, chord.abortSignal) };
          },
          afterResponse: async (message, api, chord) => {
            if (otherConversation(api)) return;
            run.assistant = message;
            const replaced = await emitMessageEnd(message, chord.abortSignal);
            if (replaced)
              handlerError(
                "message_end",
                new Error("read-only seam: assistant message replacement is not applied"),
              );
          },
          onYield: async (answer, api, chord) => {
            if (otherConversation(api)) return undefined;
            await turnEnd(answer, "", [], chord);
            return undefined;
          },
          afterTools: async (assistant, results, api, chord) => {
            if (otherConversation(api)) return;
            await turnEnd(undefined, String(assistant), results.map(String), chord);
          },
        }),
        hook(ToolTask, {
          beforeTool: async (call, api, chord) => {
            if (otherConversation(api)) return undefined;
            run.started.add(call.id);
            await emit(
              "tool_execution_start",
              { toolCallId: call.id, toolName: call.name, args: call.arguments },
              chord.abortSignal,
            );
            const before = JSON.stringify(call.arguments);
            const event = {
              type: "tool_call" as const,
              toolName: call.name,
              toolCallId: call.id,
              input: call.arguments as Record<string, unknown>,
            };
            const r = await emitToolCall(event, chord.abortSignal);
            run.args.set(call.id, event.input);
            if (r?.block) {
              const reason = r.reason ?? "Tool execution was blocked";
              run.blocked.set(call.id, reason);
              return { block: reason };
            }
            if (JSON.stringify(event.input) !== before)
              return { arguments: event.input as JsonObject };
            return undefined;
          },
          afterTool: async (call, result, api, chord) => {
            if (otherConversation(api)) return undefined;
            const code = codeOf(result);
            const startedAt = run.startedAt.get(call.id);
            const durationMs = startedAt === undefined ? undefined : Date.now() - startedAt;
            if (code === "blocked" || code === "tool_unavailable" || code === "invalid_arguments") {
              const diagnostic = result.diagnostics?.find((d) => d.code === code)?.message ?? "";
              const reason =
                code === "tool_unavailable"
                  ? `Tool ${call.name} not found`
                  : (run.blocked.get(call.id) ?? diagnostic.replace(/^Tool call blocked: /, ""));
              const content = [{ type: "text" as const, text: reason }];
              await executionEnd(call, { content, details: {}, isError: true }, undefined, chord);
              if (code !== "blocked") return undefined;
              return {
                ...result,
                output: content,
                isError: true,
                diagnostics: (result.diagnostics ?? []).filter((d) => d.severity !== "error"),
              };
            }
            const merged = await emitToolResult(
              {
                type: "tool_result",
                toolName: call.name,
                toolCallId: call.id,
                // pi-durable hands afterTool the call as the model wrote it; pi's tool_result
                // carries the validated arguments tool_call saw.
                input: run.args.get(call.id) ?? (call.arguments as Record<string, unknown>),
                content: result.output ?? [],
                details: result.details,
                isError: result.isError === true,
                usage: result.usage,
              },
              chord.abortSignal,
            );
            let out: ToolExecutionResult = merged
              ? {
                  ...result,
                  output: merged.content,
                  details: json(merged.details) as JsonValue,
                  isError: merged.isError,
                  ...(merged.usage === undefined
                    ? {}
                    : { usage: merged.usage as ToolExecutionResult["usage"] }),
                }
              : result;
            const replaced = await executionEnd(
              call,
              { content: out.output ?? [], details: out.details, isError: out.isError === true },
              durationMs,
              chord,
            );
            if (replaced) {
              out = { ...out, output: replaced.content, isError: replaced.isError === true };
            }
            return out === result ? undefined : out;
          },
        }),
        hook(CompactionTask, {
          beforeCompact: async (compaction, api, chord) => {
            if (otherConversation(api)) return undefined;
            const ctx = makeCtx(chord.abortSignal);
            const event = {
              type: "session_before_compact",
              reason: compaction.reason,
              branchEntries: toSessionEntries(compaction.entries),
              customInstructions: compaction.instructions,
              preparation: {} as any,
              willRetry: false,
              signal: chord.abortSignal,
            };
            let decision: { decline: true } | { summary: string } | undefined;
            for (const handler of handlersOf("session_before_compact")) {
              try {
                const r = (await handler(event, ctx)) as
                  { cancel?: boolean; compaction?: { summary?: string } } | undefined;
                if (r?.cancel) return { decline: true };
                if (typeof r?.compaction?.summary === "string")
                  decision = { summary: r.compaction.summary };
              } catch (error) {
                handlerError("session_before_compact", error);
              }
            }
            return decision;
          },
        }),
      ],
    });
  }

  // ── host-driven seams ──────────────────────────────────────────────────────────────────────

  const branchOf = async (b: Pick<Bound, "conversation" | "context">) => {
    const view = await b.conversation.context(b.context);
    let parentId: string | null = null;
    return view.entries.flatMap((e, i) =>
      view.contributions[i].map((message) => {
        const entry: SessionMessageEntry = {
          type: "message",
          id: String(e.id),
          parentId,
          timestamp: new Date().toISOString(),
          message,
        };
        parentId = entry.id;
        return entry;
      }),
    );
  };

  const started = (b: Bound, id: SubmissionId | undefined) => {
    if (id === undefined) return;
    b.lastStarted = id;
    for (const resolve of b.starts.get(id) ?? []) resolve();
  };

  async function onEvents(events: readonly AgentEvent[]) {
    const b = bound;
    if (!b) return;
    let landed = false;
    for (const [i, event] of events.entries()) {
      switch (event.type) {
        case "snapshot": {
          // Overflow: pi-durable replaced the undelivered batches with one snapshot, so the run
          // boundaries in between are gone; catch up on what the snapshot says.
          b.busy = event.run !== undefined;
          b.inbox = event.inbox.length;
          b.agentModel = event.agent.model;
          started(b, event.run?.inputs[0]);
          landed = true;
          break;
        }
        case "message_end": {
          // pi emits message_end for a user message when it enters the agent loop; here that is
          // the commit that placed its entry, for the first input and queued follow-ups alike.
          const message = event.entry.model?.[0];
          if (message?.role === "user") await emitMessageEnd(message);
          landed = true;
          break;
        }
        case "run_start": {
          b.busy = true;
          if (b.continuing !== event.inputs[0]) {
            const messages = (await b.conversation.context(b.context)).messages;
            // The input that started the run is already appended; agent_end reports from it on.
            const lastUser = messages.findLastIndex((m) => m.role === "user");
            b.contextLenAtRunStart = lastUser < 0 ? messages.length : lastUser;
          }
          started(b, event.inputs[0]);
          break;
        }
        case "run_end": {
          const later = events.slice(i + 1);
          const aborted = later.some(
            (e) =>
              e.type === "submission" &&
              event.inputs.includes(e.record.id) &&
              e.record.status === "unanswered" &&
              e.record.reason === "aborted",
          );
          const next = later.find((e) => e.type === "run_start");
          if (next?.type === "run_start" && !aborted) {
            // Ended and restarted in one commit: pi-durable's way of placing queued follow-ups,
            // which pi delivers inside the same run. One agent_end, at the end of the chain.
            b.continuing = next.inputs[0];
            break;
          }
          b.busy = false;
          const messages = [
            ...(await b.conversation.context(b.context)).messages.slice(b.contextLenAtRunStart),
          ];
          // pi's agent_end always carries the run's assistant message; a run stopped before one
          // was committed gets the empty aborted message pi-agent-core would have ended with.
          if (aborted && !messages.some((m) => m.role === "assistant")) {
            messages.push(abortedAssistant(b.agentModel));
          }
          b.branch = await branchOf(b);
          landed = false;
          await emit("agent_end", { messages });
          const inbox = later.findLast((e) => e.type === "inbox_update");
          const pending = inbox && inbox.type === "inbox_update" ? inbox.items.length : b.inbox;
          if (next === undefined && pending === 0) {
            const last = messages.findLast((m) => m.role === "assistant") as
              AssistantMessage | undefined;
            await emit("agent_settled", { aborted: aborted || last?.stopReason === "aborted" });
          }
          break;
        }
        case "inbox_update":
          b.inbox = event.items.length;
          break;
        case "agent_changed": {
          const next = event.agent.model;
          const prev = b.agentModel;
          if (next?.provider !== prev?.provider || next?.modelId !== prev?.modelId) {
            b.agentModel = next;
            await emit("model_select", {
              model: modelOf(next),
              previousModel: modelOf(prev),
              source: "set",
            });
          }
          break;
        }
        case "entry_appended":
          landed = true;
          break;
        default:
          break;
      }
    }
    if (landed && bound === b) b.branch = await branchOf(b);
  }

  async function attach(harness: Harness, conversation: Conversation, context: Chord) {
    const stream = await watchEvents(harness, conversation.id, context);
    const snapshot = stream.snapshot;
    const b: Bound = {
      harness,
      conversation,
      context,
      stream,
      busy: snapshot.run !== undefined,
      inbox: snapshot.inbox.length,
      agentModel: snapshot.agent.model,
      branch: [],
      contextLenAtRunStart: 0,
      starts: new Map(),
    };
    // A run kept across attach (a resume) will never be reported started; it already has.
    started(b, snapshot.run?.inputs[0]);
    b.branch = await branchOf(b);
    bound = b;
    stream.start(async (events) => onEvents(events));
  }

  async function start(reason: SessionReason) {
    if (!bound) throw new Error("pi-host: attach() before start()");
    bound.branch = await branchOf(bound);
    await emit("session_start", { reason });
  }

  async function submit(
    text: string,
    opts: { source?: InputSource; deliverAs?: "steer" | "followUp" } = {},
  ): Promise<Submission | undefined> {
    const b = bound;
    if (!b) throw new Error("pi-host: attach() before submit()");
    const { source = "rpc", deliverAs } = opts;
    const input = await emitInput(text, source, deliverAs);
    if (input.handled) return undefined;
    lastPrompt = input.text;
    // message_end(user) comes from the event stream once the entry lands, not from here: a
    // rejected or queued submission has not entered the loop, and Orbit's follow-up delivery
    // reads that event as the receipt.
    try {
      return await b.conversation.submit(
        { type: "input", content: input.text, whenBusy: deliverAs ?? "reject" },
        b.context,
      );
    } catch (error) {
      if (error instanceof ConversationBusy) {
        note({ kind: "busy", member: "sendUserMessage", phase: phase() });
        return undefined;
      }
      throw error;
    }
  }

  async function command(name: string, args: string) {
    const registered = commands.get(name);
    if (!registered) return false;
    try {
      await registered.handler(args, makeCommandCtx());
    } catch (error) {
      handlerError(`command:${name}`, error);
    }
    return true;
  }

  async function shutdown(reason: ShutdownReason) {
    await emit("session_shutdown", { reason });
    stale = STALE_CTX_MESSAGE;
    const b = bound;
    bound = undefined;
    if (b) await b.stream.stop();
  }

  return {
    api,
    seal,
    attach,
    start,
    submit,
    command,
    shutdown,
    get handlers() {
      return new Map([...handlers].map(([event, list]) => [event, list.length]));
    },
    get tools() {
      return [...tools.keys()];
    },
    get commands() {
      return new Map([...commands].map(([name, c]) => [name, { description: c.description }]));
    },
    get notes() {
      return notes;
    },
  };
}

/** Where pi would say a registration came from; this host has one source, and it is not a file. */
const SOURCE: SourceInfo = {
  path: "pi-host",
  source: "pi-host",
  scope: "temporary",
  origin: "top-level",
};
