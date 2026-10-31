/**
 * One conversation's worker for the stale-lease experiment: Orbit's brain on pi-host over a
 * PostgresStorage fenced on lease generation `leaseGen`, booted the way pi-host.orbit.test.ts
 * boots it, with the model and Galaxy scripted. The parent can hold one Galaxy request open, bump
 * the store's lease generation as another host would, then let the request go and watch what the
 * next commit does. The hold sits either outside the fence (the generation check runs after the
 * bump) or inside it (the request has passed the check and Galaxy is slow to answer). With `fatal`
 * the worker runs behind LeaseFence and exits on the first lost lease; without it, the parent sees
 * what pi-durable and Orbit do on their own.
 */
import fs from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, type Storage } from "@earendil-works/pi-durable";
import { Type } from "@sinclair/typebox";
import * as orbit from "orbit-brain";
import pg from "pg";

import { json, text, toolCall } from "../../../core/src/agent/fake-model";
import { agentModels } from "../../../core/src/agent/model";
import { createPiHost } from "../../../core/src/agent/pi-host";
import { resolve as resolveTarget } from "../../../core/src/agent/providers";
import { LEASE_LOST_EXIT_CODE, LeaseFence } from "./lease-fence";
import {
  PROMPTS,
  type ErrorView,
  type FromWorker,
  type HoldAt,
  type Inspection,
  type LeaseWorkerData,
  type ToWorker,
} from "./lease-fence-protocol";
import { PostgresStorage } from "../storage/postgres-storage";

const data = workerData as LeaseWorkerData;
const port = parentPort!;
const post = (message: FromWorker) => port.postMessage(message);
const ctx = BACKGROUND_CONTEXT;
const LLM = "http://llm.test/v1";

const view = (error: unknown): ErrorView => {
  const chain: string[] = [];
  for (let e = error, i = 0; e && i < 8; i++, e = (e as { cause?: unknown }).cause) {
    chain.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  }
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    chain,
  };
};

process.on("unhandledRejection", (error) => post({ type: "unhandled", error: view(error) }));

const textOf = (content: unknown) =>
  typeof content === "string"
    ? content
    : (content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : new Request(String(input), init);
  if (request.url === "https://iwc.galaxyproject.org/workflow_manifest.json") return json([]);
  if (!request.url.startsWith(LLM)) return json({});
  const body = JSON.parse(await request.text()) as {
    messages: Array<{ role: string; content: unknown }>;
  };
  const last = body.messages.at(-1)!;
  post({ type: "model", lastRole: last.role, at: Date.now() });
  if (last.role === "user") {
    const said = textOf(last.content);
    if (said.includes("READ_H1")) {
      return toolCall("get_history_details", { history_id: "h1" }, PROMPTS.read.callId);
    }
    if (said.includes("RENAME_H1")) {
      return toolCall(
        "update_history",
        { history_id: "h1", name: "renamed" },
        PROMPTS.rename.callId,
      );
    }
  }
  return text("ok");
};

// ── storage: instrumented, then (in the fatal profile) fenced ───────────────────────────────────

const pool = new pg.Pool({
  host: "/tmp",
  port: 5432,
  database: data.database,
  user: data.user,
  max: 20,
});
const postgres = await PostgresStorage.open(pool, data.storeId, { leaseGen: data.leaseGen });

/** Every commit outcome posted, with the stack that called commit() when one is refused. */
const instrumented = new Proxy(postgres, {
  get(target, prop) {
    const value = Reflect.get(target, prop, target) as unknown;
    if (typeof value !== "function") return value;
    if (prop !== "commit") return value.bind(target);
    return async (...args: unknown[]) => {
      const caller = (new Error().stack ?? "")
        .split("\n")
        .slice(2, 12)
        .map((l) => l.trim());
      try {
        const seq = await (value as (...a: unknown[]) => Promise<number>).apply(target, args);
        post({ type: "commit", seq });
        return seq;
      } catch (error) {
        post({ type: "commit-rejected", error: view(error), caller });
        throw error;
      }
    };
  },
}) as unknown as Storage;

const fence = !data.fatal
  ? undefined
  : data.defaultOnLost
    ? new LeaseFence({ storeId: data.storeId, leaseGen: data.leaseGen, db: pool })
    : new LeaseFence({
        storeId: data.storeId,
        leaseGen: data.leaseGen,
        db: pool,
        onLost: (lost) => {
          post({
            type: "lease-lost",
            storeId: lost.storeId,
            expectedGen: lost.expectedGen,
            currentGen: lost.currentGen,
          });
          // No close, no retry, no awaiting the pool: anything that runs after this is a chance for
          // the stale worker to act. The host owns recovery.
          process.exit(LEASE_LOST_EXIT_CODE);
        },
      });
const storage = fence ? fence.storage(instrumented) : instrumented;

// ── Orbit's seams, as pi-host.orbit.test.ts installs them ───────────────────────────────────────

const VENDOR = join(data.repo, "extensions", "orbit", "vendor", "skills");
const vendorCatalog: unknown = JSON.parse(fs.readFileSync(join(VENDOR, "_catalog.json"), "utf8"));
const vendorManifest = JSON.parse(fs.readFileSync(join(VENDOR, "_manifest.json"), "utf8")) as {
  files: Array<{ target: string }>;
};
const vendorFiles = new Map<string, string>(
  vendorManifest.files.map((f) => [f.target, fs.readFileSync(join(VENDOR, f.target), "utf8")]),
);

orbit.setCapabilityProfile({
  shell: false,
  files: false,
  notebook: "page",
  network: true,
  mcpServers: false,
  ui: "worker",
});
orbit.setConfigSource({
  load: () => ({ lessons: { enabled: false }, experiments: { autoResume: false } }),
});
orbit.setInstructionSource({ files: () => [] });
orbit.setVendorSkillsSource({
  catalog: vendorCatalog,
  manifest: vendorManifest,
  read: (target) => vendorFiles.get(target) ?? null,
});

let hold: { method: string; path: string; at: HoldAt } | undefined;
let release: (() => void) | undefined;

async function holdIfAsked(url: string, init: RequestInit, at: HoldAt) {
  const method = init.method ?? "GET";
  const path = new URL(url).pathname;
  if (hold && hold.at === at && hold.method === method && hold.path === path) {
    hold = undefined;
    post({ type: "held", method, path, at });
    await new Promise<void>((r) => (release = r));
  }
}

/**
 * The recording transport: what reaches it is what Galaxy would have received. The `inside` hold
 * waits in front of it, past the fence's check, so the bump happens while Galaxy "answers".
 */
const recording = async (url: string, init: RequestInit) => {
  await holdIfAsked(url, init, "inside");
  const method = init.method ?? "GET";
  const path = new URL(url).pathname;
  post({ type: "galaxy", method, path, at: Date.now() });
  if (path === "/api/histories") {
    return json(
      method === "POST" ? { id: "h1", name: "one brain" } : [{ id: "h1", name: "one brain" }],
    );
  }
  if (path === "/api/histories/h1") return json({ id: "h1", name: "one brain" });
  return json({});
};
const guarded = fence ? fence.fetch(recording) : recording;

orbit.setGalaxyTransport({
  // The `outside` hold parks the tool's request before the fence sees it, so the generation check
  // runs after the bump: the ordering the fence can catch.
  fetch: async (url, init) => {
    const method = init.method ?? "GET";
    const path = new URL(url).pathname;
    await holdIfAsked(url, init, "outside");
    try {
      return await guarded(url, init);
    } catch (error) {
      post({ type: "galaxy-refused", method, path, error: view(error) });
      throw error;
    }
  },
  credentials: () => ({ url: "http://galaxy.test", apiKey: "k" }),
});
orbit.setRecordStore(
  orbit.createPageRecordStore({ key: join(data.dir, "notebook.md"), pageId: "p1" }),
);
const stub = (name: string) => ({
  name,
  label: name,
  description: `stub ${name}`,
  parameters: Type.Object({}, { additionalProperties: true }),
  execute: async () => ({ content: [{ type: "text" as const, text: "{}" }], details: {} }),
});
orbit.setGalaxyToolSource(
  orbit.createGalaxyOpsToolSource({
    extras: ["download_dataset", "upload_file", "recommend_biocontainer"].map(stub),
  }),
);

const host = createPiHost({
  name: "orbit",
  cwd: data.dir,
  model: () => ({ provider: "custom", id: "m" }),
  ui: { notify: () => {} },
});
const on = host.api.on as unknown as (
  event: string,
  handler: (e: { toolCallId: string; toolName: string }) => void,
) => void;
for (const event of ["tool_execution_start", "tool_result", "tool_execution_end"]) {
  on(event, (e) => post({ type: "event", event, toolCallId: e.toolCallId, toolName: e.toolName }));
}
orbit.loom(host.api);
const registry = createRegistry();
registry.install(host.seal());
const { models, model } = await agentModels().connect(
  resolveTarget({ ai_base_url: LLM, ai_model: "m", ai_api_key: "k" }),
);
const harness = await Harness.open(
  storage,
  {
    models,
    registry,
    // runtime.ts's LOOP, inlined as recovery-worker.ts does: runtime.ts drags in the browser runtime.
    settings: {
      toolExecution: "sequential",
      followUpMode: "all",
      promptPlacement: "lead",
      maxTurns: 6,
    },
    onReport: (error) => {
      post({ type: "report", error: view(error) });
      fence?.check(error);
    },
  },
  ctx,
);
const conversation =
  data.conversationId === undefined
    ? await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, ctx)
    : await harness.conversation(data.conversationId as never, ctx);
if (!conversation) throw new Error(`no conversation ${data.conversationId}`);
await host.attach(harness, conversation, ctx);
await host.start(data.conversationId === undefined ? "startup" : "resume");

async function inspect(): Promise<Inspection> {
  try {
    const state = await harness.inspect(ctx);
    const messages = (await conversation!.context(ctx)).messages;
    return {
      ok: true,
      scheduling: state.scheduling,
      tasks: state.tasks.map((t) => {
        const record = t.record as unknown as {
          id: unknown;
          kind: string;
          state: { status: string; checkpoint?: { phase?: string } };
        };
        return {
          id: String(record.id),
          kind: record.kind,
          status: record.state.status,
          phase: record.state.checkpoint?.phase,
          scheduler: t.state.kind,
        };
      }),
      toolResults: messages
        .filter((m) => m.role === "toolResult")
        .map((m) => ({
          toolCallId: m.toolCallId,
          isError: m.isError === true,
          text: textOf(m.content),
        })),
    };
  } catch (error) {
    return { ok: false, error: view(error) };
  }
}

port.on("message", (message: ToWorker) => {
  switch (message.cmd) {
    case "submit":
      host.submit(message.text).then(
        (admitted) => post({ type: "submit-settled", ok: true, admitted: admitted !== undefined }),
        (error: unknown) => post({ type: "submit-settled", ok: false, error: view(error) }),
      );
      return;
    case "hold":
      hold = { method: message.method, path: message.path, at: message.at };
      return;
    case "release":
      release?.();
      release = undefined;
      return;
    case "resume":
      harness.resume();
      return;
    case "close":
      harness.close(ctx).then(
        () => post({ type: "closed" }),
        (error: unknown) => post({ type: "closed", error: view(error) }),
      );
      return;
    case "idle":
      void harness
        .waitForIdle(ctx)
        .then(() => post({ type: "rpc", rpc: message.rpc, value: true }));
      return;
    case "inspect":
      void inspect().then((value) => post({ type: "rpc", rpc: message.rpc, value }));
      return;
  }
});

if (data.deferResume) {
  post({ type: "ready", conversationId: String(conversation.id), beforeResume: await inspect() });
} else {
  harness.resume();
  post({ type: "ready", conversationId: String(conversation.id) });
}
