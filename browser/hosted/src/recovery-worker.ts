/**
 * One conversation's worker for the recovery experiments: Orbit's brain on pi-host over a
 * file-backed pi-durable store, booted the way pi-host.orbit.test.ts boots it, with the model and
 * Galaxy scripted and every ask, Galaxy request and tool event posted to the parent. The parent
 * answers asks, closes the harness, or terminate()s the thread to stand in for a crash.
 */
import fs from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "@sinclair/typebox";
import * as orbit from "orbit-brain";

import { json, text, toolCall } from "../../core/src/agent/fake-model";
import { agentModels } from "../../core/src/agent/model";
import { createPiHost, type AskAnswer } from "../../core/src/agent/pi-host";
import { resolve as resolveTarget } from "../../core/src/agent/providers";
import {
  DELETE_CALL_ID,
  type FromWorker,
  type Inspection,
  type RecoveryWorkerData,
  type ToWorker,
} from "./recovery-protocol";

const data = workerData as RecoveryWorkerData;
const port = parentPort!;
const post = (message: FromWorker) => port.postMessage(message);
const ctx = BACKGROUND_CONTEXT;
const LLM = "http://llm.test/v1";

const textOf = (content: unknown) =>
  typeof content === "string"
    ? content
    : (content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");

// The model calls the destructive tool for the delete prompt and answers in words otherwise, so
// the greeting and the follow-up after the tool result need no script of their own.
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : new Request(String(input), init);
  if (request.url === "https://iwc.galaxyproject.org/workflow_manifest.json") return json([]);
  if (!request.url.startsWith(LLM)) return json({});
  const body = JSON.parse(await request.text()) as {
    messages: Array<{ role: string; content: unknown }>;
  };
  const last = body.messages.at(-1)!;
  post({ type: "model", lastRole: last.role, lastText: textOf(last.content).slice(0, 120) });
  if (last.role === "user" && textOf(last.content).includes("DELETE_H1")) {
    return toolCall("update_history", { history_id: "h1", deleted: true }, DELETE_CALL_ID);
  }
  return text("ok");
};

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
// galaxy-ops hands the transport an ArrayBuffer (it reads the Request's body back out), so a
// string-only recorder would see every write as bodiless.
const bodyText = (body: unknown) =>
  typeof body === "string"
    ? body
    : body instanceof ArrayBuffer || ArrayBuffer.isView(body)
      ? new TextDecoder().decode(body)
      : undefined;

orbit.setGalaxyTransport({
  fetch: async (url, init) => {
    const method = init.method ?? "GET";
    const path = new URL(url).pathname;
    const body = bodyText(init.body);
    post({ type: "galaxy", method, path, body });
    if (path === "/api/histories") {
      return json(
        method === "POST" ? { id: "h1", name: "one brain" } : [{ id: "h1", name: "one brain" }],
      );
    }
    if (path === "/api/histories/h1") {
      // Echo what the request asked for, so a "deleted" result comes from the call, not the mock.
      const asked = body ? (JSON.parse(body) as { deleted?: boolean }) : {};
      return json({ id: "h1", name: "one brain", deleted: asked.deleted === true });
    }
    return json({});
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

// ── the asks: a person on the other end of a port ───────────────────────────────────────────────

let nextAsk = 0;
const pending = new Map<number, { resolve: (a: AskAnswer) => void; reject: (e: Error) => void }>();

const host = createPiHost({
  name: "orbit",
  cwd: data.dir,
  model: () => ({ provider: "custom", id: "m" }),
  ui: {
    notify: () => {},
    // Wired, so hasUI is true and the gate asks rather than denies (plan decision 21).
    ask: (request, _conversationId, signal) => {
      const id = ++nextAsk;
      post({ type: "ask", id, request, hasSignal: signal !== undefined });
      signal?.addEventListener("abort", () => post({ type: "ask-withdrawn", id }), { once: true });
      return new Promise<AskAnswer>((resolve, reject) => pending.set(id, { resolve, reject }));
    },
  },
  onNote: (n) =>
    post({
      type: "note",
      note: `${n.kind} ${"member" in n ? n.member : "event" in n ? n.event : ""}${
        n.kind === "handler-error" ? `: ${(n.error as Error)?.message ?? String(n.error)}` : ""
      }`,
    }),
});

// Registered before Orbit, so these run ahead of the gate on every tool_call.
const on = host.api.on as unknown as (
  event: string,
  handler: (
    e: { toolCallId: string; toolName: string },
    c: { signal: AbortSignal | undefined },
  ) => void,
) => void;
for (const event of ["tool_execution_start", "tool_call", "tool_result", "tool_execution_end"]) {
  on(event, (e, c) => {
    post({ type: "event", event, toolCallId: e.toolCallId, toolName: e.toolName });
    if (event !== "tool_call") return;
    const signal = c.signal;
    post({
      type: "call-signal",
      toolCallId: e.toolCallId,
      present: signal !== undefined,
      aborted: signal?.aborted ?? false,
    });
    signal?.addEventListener(
      "abort",
      () => post({ type: "call-signal-aborted", toolCallId: e.toolCallId }),
      { once: true },
    );
  });
}
orbit.loom(host.api);
const extension = host.seal();
const registry = createRegistry();
registry.install(extension);
const { models, model } = await agentModels().connect(
  resolveTarget({ ai_base_url: LLM, ai_model: "m", ai_api_key: "k" }),
);
const harness = await Harness.open(
  await openNodeSqliteStorage(data.store),
  {
    models,
    registry,
    // runtime.ts's LOOP, inlined: importing runtime.ts drags the browser runtime into the bundle.
    settings: {
      toolExecution: "sequential",
      followUpMode: "all",
      promptPlacement: "lead",
      maxTurns: 6,
    },
    onReport: (e) => post({ type: "report", message: (e as Error)?.message ?? String(e) }),
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
harness.resume();

async function inspect(): Promise<Inspection> {
  const view = await harness.inspect(ctx);
  const messages = (await conversation!.context(ctx)).messages;
  return {
    scheduling: view.scheduling,
    tasks: view.tasks.map((t) => {
      const record = t.record as unknown as {
        kind: string;
        state: { status: string; checkpoint?: { phase?: string } };
      };
      return {
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
        toolName: m.toolName,
        isError: m.isError === true,
        text: textOf(m.content),
      })),
  };
}

port.on("message", (message: ToWorker) => {
  switch (message.cmd) {
    case "submit":
      void host.submit(message.text);
      return;
    case "answer": {
      const ask = pending.get(message.id);
      pending.delete(message.id);
      if (message.outcome === "resolve") ask?.resolve(message.value);
      else ask?.reject(new Error(message.message));
      return;
    }
    case "close":
      // Not awaited: close joins every invocation, and the one parked in the gate's confirm only
      // returns once the parent settles the ask.
      harness.close(ctx).then(
        () => post({ type: "closed" }),
        (e: unknown) => post({ type: "closed", error: (e as Error)?.message ?? String(e) }),
      );
      post({ type: "close-called" });
      return;
    case "idle":
      void harness
        .waitForIdle(ctx)
        .then(() => post({ type: "rpc", rpc: message.rpc, value: true }));
      return;
    case "inspect":
      void inspect().then(
        (value) => post({ type: "rpc", rpc: message.rpc, value }),
        (e: unknown) =>
          post({ type: "rpc", rpc: message.rpc, value: { error: (e as Error)?.message } }),
      );
      return;
  }
});

post({ type: "ready", conversationId: String(conversation.id) });
