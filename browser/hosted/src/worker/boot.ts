/**
 * One conversation's worker: Orbit's brain on pi-host over the conversation's Postgres store, in a
 * worker_thread the host starts with an empty environment (brief H4). Everything the worker needs
 * arrives in workerData or over its port; it reads no files and no environment of its own.
 *
 * The order matters. The environment and the fence go in before Orbit registers, the seams are set
 * before `loom()` reads them, and the guards are registered ahead of Orbit's own tool_call handlers.
 */
import { parentPort, workerData } from "node:worker_threads";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, watchEvents } from "@earendil-works/pi-durable";
import * as orbit from "orbit-brain";
import * as vendor from "orbit-vendor-skills";

import { agentModels } from "../../../core/src/agent/model";
import { createPiHost, type AskAnswer } from "../../../core/src/agent/pi-host";
import { resolve as resolveTarget } from "../../../core/src/agent/providers";
import { createPool } from "../db/pool";
import { LeaseFence } from "../lease/lease-fence";
import { LeaseLostError, PostgresStorage } from "../storage/postgres-storage";
import { fencedFetch } from "./fenced-fetch";
import { hostedGalaxyFetch, TokenUnavailable } from "./galaxy-fetch";
import { registerSurfaceGate, registerToolCallCap, WITHHELD_TOOLS } from "./guards";
import { SESSION_POISONED_EXIT_CODE, type FromWorker, type TokenAnswer, type ToWorker, type WorkerData } from "./protocol";
import { installTripwire } from "./tripwire";

const data = workerData as WorkerData;
const port = parentPort!;
const post = (message: FromWorker) => port.postMessage(message);
/**
 * pi-durable poisons a session whose commit failed after storage took it (a connection dropped
 * mid-commit) and refuses everything after, asking for a reopen. A fresh worker is that reopen.
 */
const reopenIfPoisoned = (error: unknown) => {
  if (error instanceof Error && error.message.startsWith("Session is poisoned")) process.exit(SESSION_POISONED_EXIT_CODE);
};
const ctx = BACKGROUND_CONTEXT;
const reopen = data.conversationId !== undefined;

if (data.traceReaches) installTripwire((api) => post({ type: "reach", api }));

// 1. The environment: the model key for the redactor, and ORBIT_FRESH_SESSION, which skips Orbit's
// startup greeting. Hosted conversations start with the user's message instead: a greeting would be
// a model turn nobody asked for, on every new conversation.
process.env.ORBIT_ACTIVE_LLM_API_KEY = data.model.apiKey;
process.env.ORBIT_FRESH_SESSION = "1";

// 2. Storage and the fence. A lost lease exits the thread with 75 (LeaseFence's default here), and
// from then on nothing leaves the worker: not a commit, not a Galaxy write, not a model call.
// Two connections: commits are serialized per store anyway, and every live worker holds a pool.
const pool = createPool({ connectionString: data.database, max: 2 }, (message) => post({ type: "report", message }));
const fence = new LeaseFence({ storeId: data.storeId, leaseGen: data.leaseGen, db: pool });
const storage = fence.storage(await PostgresStorage.open(pool, data.storeId, { leaseGen: data.leaseGen }));
const network = globalThis.fetch;
globalThis.fetch = fencedFetch(fence, network);

// 3-7. Orbit's seams.
orbit.setCapabilityProfile({
  shell: false,
  files: false,
  notebook: "page",
  network: true,
  mcpServers: false,
  ui: "worker",
});
orbit.setConfigSource({
  load: () => ({
    lessons: { enabled: false },
    observations: { mode: "off" },
    experiments: { autoResume: false, teamDispatch: false },
  }),
  // The redactor reads these as well as the environment.
  secrets: () => [data.model.apiKey, ...recentTokens],
});
orbit.setInstructionSource({ files: () => [] });
orbit.setVendorSkillsSource({
  catalog: vendor.catalog,
  manifest: vendor.manifest,
  read: (target) => vendor.files[target] ?? null,
});
// Galaxy requests go out as the user: the host hands over their access token one request at a time
// (brief H5), and never to a worker whose lease has moved on, which this worker then treats as lost.
// Set by the host's close: asks are withdrawn by rejecting, and token waits fail.
let closing = false;
let nextToken = 0;
const tokenWaits = new Map<number, (answer: TokenAnswer) => void>();
// Closing joins every running tool call, so one parked on a token the host will no longer send must
// fail instead, or close never returns.
const CLOSED: TokenAnswer = { failure: { kind: "outage", message: "The conversation is closing." } };
// The last few access tokens handed out, so a Galaxy error that echoes one back is masked too.
const recentTokens: string[] = [];
const token = async (): Promise<string> => {
  const answer = closing
    ? CLOSED
    : await new Promise<TokenAnswer>((resolve) => {
        const id = ++nextToken;
        tokenWaits.set(id, resolve);
        post({ type: "token", id });
      });
  if ("token" in answer) {
    if (!recentTokens.includes(answer.token)) recentTokens.unshift(answer.token);
    recentTokens.length = Math.min(recentTokens.length, 4);
    return answer.token;
  }
  if (answer.failure.kind === "lease") {
    const lost = new LeaseLostError(data.storeId, data.leaseGen, -1);
    fence.check(lost);
    throw lost;
  }
  throw new TokenUnavailable(answer.failure);
};
// The placeholder key, which the fetch replaces with the token, is under the redactor's
// 8-character minimum, so it never masks real text.
orbit.setGalaxyTransport({
  fetch: hostedGalaxyFetch({ fence, token, network }),
  credentials: () => ({ url: data.galaxyUrl, apiKey: "hosted" }),
});
// A path-shaped key under no real directory: the page store keeps its side stores in memory.
orbit.setRecordStore(
  orbit.createPageRecordStore({ key: `/conversations/${data.storeId}/notebook.md`, pageId: data.pageId }),
);
const ops = orbit.createGalaxyOpsToolSource({ extras: [] });
orbit.setGalaxyToolSource({ ...ops, tools: () => ops.tools().filter((t) => !WITHHELD_TOOLS.has(t.name)) });
orbit.setGalaxyOutputStore(orbit.createMemoryOutputStore({ entries: 32, bytes: data.limits.outputBytes }));

// 8. The host, the guards, Orbit, and the conversation.
let nextAsk = 0;
const pending = new Map<number, (answer: AskAnswer) => void>();
const host = createPiHost({
  name: "orbit",
  cwd: "/",
  model: () => ({ provider: "custom", id: data.model.id }),
  ui: {
    notify: (text, level) => post({ type: "notify", text, level }),
    ask: (request, _conversationId, signal) =>
      new Promise<AskAnswer>((resolve, reject) => {
        // The run was stopped or closed (H1 passes the turn's signal) before or while the user was
        // asked. A close rejects, so the interrupted call is asked again on resume (the gate pause
        // contract); a Stop answers nothing, and the gate doesn't run the call.
        const withdraw = () => {
          if (closing) reject(signal?.reason ?? new Error("The conversation closed while asking."));
          else resolve(undefined);
        };
        if (signal?.aborted) return withdraw();
        const id = ++nextAsk;
        pending.set(id, resolve);
        post({ type: "ask", id, request });
        signal?.addEventListener(
          "abort",
          () => {
            if (!pending.delete(id)) return;
            post({ type: "ask-withdrawn", id });
            withdraw();
          },
          { once: true },
        );
      }),
  },
});
const on = host.api.on as unknown as Parameters<typeof registerSurfaceGate>[0];
registerSurfaceGate(on);
registerToolCallCap(on, data.limits.maxToolCalls);
(host.api.on as unknown as (event: string, handler: (e: { aborted: boolean }) => void) => void)(
  "agent_settled",
  (e) => post({ type: "settled", aborted: e.aborted }),
);
// Withheld tools are never registered, so the model isn't offered them; the gate refuses them anyway.
const api = Object.create(host.api) as typeof host.api;
api.registerTool = (def) => {
  if (!WITHHELD_TOOLS.has(def.name)) host.api.registerTool(def);
};
orbit.loom(api);
const registry = createRegistry();
registry.install(host.seal());
const connected = await agentModels().connect(
  resolveTarget({ ai_base_url: data.model.baseUrl, ai_model: data.model.id, ai_api_key: data.model.apiKey }),
);
const { model } = connected;
// Every worker shares the service key; the request's `user` is what tells the endpoint whose usage it is.
type Options = Parameters<typeof connected.models.streamSimple>[2];
const tagged = (options: Options): Options => ({
  ...options,
  onPayload: async (payload, m) => {
    const next = (await options?.onPayload?.(payload, m)) ?? payload;
    return { ...(next as object), user: data.model.user };
  },
});
const models = {
  ...connected.models,
  streamSimple: (m, context, options) => connected.models.streamSimple(m, context, tagged(options)),
  completeSimple: (m, context, options) => connected.models.completeSimple(m, context, tagged(options)),
} as typeof connected.models;
const harness = await Harness.open(
  storage,
  {
    models,
    registry,
    // runtime.ts's LOOP, inlined: importing runtime.ts drags the browser runtime into the bundle.
    settings: {
      toolExecution: "sequential",
      followUpMode: "all",
      promptPlacement: "lead",
      maxTurns: data.limits.maxTurns,
    },
    onReport: (error) => {
      fence.check(error);
      post({ type: "report", message: error instanceof Error ? error.message : String(error) });
      reopenIfPoisoned(error);
    },
  },
  ctx,
);
const conversation = reopen
  ? await harness.conversation(data.conversationId as never, ctx)
  : await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, ctx);
if (!conversation) throw new Error(`No conversation ${data.conversationId} in store ${data.storeId}`);
await host.attach(harness, conversation, ctx);
// Read before the session starts, when the only unfinished tasks are ones an earlier worker left.
const tasks = (await harness.inspect(ctx)).tasks as unknown as Array<{ record: { state: { status: string } } }>;
const resuming = tasks.some((t) => t.record.state.status !== "terminal");

// The conversation's events from a snapshot on, as the browser worker streams them (worker.ts
// attach), so the shell's ChatView draws a hosted conversation the way it draws its own.
let events = await watchEvents(harness, conversation.id, ctx);
post({ type: "events", events: [events.snapshot] });
events.start(async (batch) => post({ type: "events", events: batch }));
/**
 * A browser (re)connected: everything it should show, from the top. The old stream stops first, so
 * nothing it held back can land after the fresh snapshot; what commits in between is in the snapshot.
 */
async function restream(): Promise<void> {
  await events.stop();
  events = await watchEvents(harness, conversation!.id, ctx);
  post({ type: "events", events: [events.snapshot] });
  events.start(async (batch) => post({ type: "events", events: batch }));
}

/** What went wrong, for the host's log; never the error's own object, which can carry request data. */
const report = (error: unknown) => {
  post({ type: "report", message: error instanceof Error ? error.message : String(error) });
  reopenIfPoisoned(error);
};

port.on("message", (message: ToWorker) => {
  switch (message.cmd) {
    case "submit":
      // A busy conversation (an Orbit follow-up running) refuses the input; the host keeps it.
      host.submit(message.text).then(
        (admitted) => post({ type: "submitted", admitted: admitted !== undefined }),
        (error: unknown) => {
          report(error);
          post({ type: "submitted", admitted: false });
        },
      );
      return;
    case "token": {
      const resolve = tokenWaits.get(message.id);
      tokenWaits.delete(message.id);
      resolve?.(message);
      return;
    }
    case "answer": {
      // An ask already withdrawn has no entry, so a late answer does nothing.
      const resolve = pending.get(message.id);
      pending.delete(message.id);
      resolve?.(message.value);
      return;
    }
    case "stop":
      conversation.abort(ctx).catch(report);
      return;
    case "snapshot":
      if (!closing) restream().catch(report);
      return;
    case "close":
      close();
      return;
    case "release":
      quiet().then(
        (yes) => {
          if (closing) return;
          if (yes) close();
          else post({ type: "not-quiet" });
        },
        (error: unknown) => {
          report(error);
          post({ type: "not-quiet" });
        },
      );
      return;
  }
});

/**
 * Close the harness first: sealing aborts every invocation, so a pending ask is rejected into an
 * aborted runtime and its call asks again on resume (the gate pause contract), rather than denied.
 */
function close(): void {
  if (closing) return;
  closing = true;
  void events.stop().catch(() => undefined);
  for (const resolve of tokenWaits.values()) resolve(CLOSED);
  tokenWaits.clear();
  harness
    .close(ctx)
    .then(
      () => post({ type: "closed" }),
      (error: unknown) => post({ type: "closed", error: error instanceof Error ? error.message : String(error) }),
    )
    // With the pool and the port closed the thread has nothing left and exits by itself.
    .finally(() => pool.end().catch(() => undefined).finally(() => port.close()));
}

/** A quiet point: nobody is being asked, no Galaxy request waits on a token, and every task is done. */
async function quiet(): Promise<boolean> {
  if (pending.size > 0 || tokenWaits.size > 0) return false;
  const { tasks } = (await harness.inspect(ctx)) as unknown as { tasks: Array<{ record: { state: { status: string } } }> };
  return pending.size === 0 && tasks.every((t) => t.record.state.status === "terminal");
}

await host.start(reopen ? "resume" : "new");
harness.resume();
post({
  type: "ready",
  conversationId: String(conversation.id),
  resuming,
  tools: host.api.getAllTools().map((t) => t.name),
  env: Object.keys(process.env),
});
