/**
 * The boot path of pi-host.orbit.test.ts, without vitest: the browser capability profile, the
 * seams installed as objects, pi-host, extensions/orbit, and a pi-durable harness on MemoryStorage.
 * Everything Orbit needs is a static import here, so importing this module is the "module load"
 * phase and boot() is everything after it.
 */
import fs from "node:fs";
import { join } from "node:path";
import v8 from "node:v8";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { Type } from "@sinclair/typebox";

import { agentModels } from "../../core/src/agent/model";
import { createPiHost, type HostNote } from "../../core/src/agent/pi-host";
import { resolve as resolveTarget } from "../../core/src/agent/providers";
import { LOOP } from "../../core/src/agent/runtime";
import orbit from "../../../extensions/orbit/index";
import { setGalaxyTransport } from "../../../extensions/orbit/galaxy-api";
import { createGalaxyOpsToolSource } from "../../../extensions/orbit/galaxy-ops-tools";
import { setGalaxyToolSource } from "../../../extensions/orbit/galaxy-tool-source";
import { setRecordStore } from "../../../extensions/orbit/record-store";
import { createPageRecordStore } from "../../../extensions/orbit/record-store-page";
import { setInstructionSource } from "../../../extensions/orbit/user-instructions";
import { setVendorSkillsSource } from "../../../extensions/orbit/vendor-skills";
import { setCapabilityProfile } from "../../../shared/capability-profile.js";
import { setConfigSource } from "../../../shared/config-source.js";

import { now, type Mem, type Marks } from "./clock";

export interface BootOptions {
  /** The repository root, for the vendored skills tree; import.meta.url moves when bundled. */
  repo: string;
  /** This worker's own directory: the host's cwd and the record key's parent. */
  dir: string;
  /** The stub model endpoint, e.g. http://127.0.0.1:1234/v1. */
  llm: string;
  /** Sent as the model key, so the stub can tell the workers apart. */
  key: string;
  /** The one user message, sent once the greeting run has settled. */
  message: string;
  /**
   * Collect garbage before each memory sample (the worker runs with --expose-gc), so heapUsed is
   * the live heap rather than an upper bound. It stalls the sampled request, so timings from a
   * gc run are not comparable.
   */
  gc?: boolean;
}

export interface BootResult {
  marks: Marks;
  /** This isolate's memory when its first model request left, and when the user's message did. */
  mem: { first?: Mem; user?: Mem; end: Mem };
  requests: number;
  /** pi-host's notes and the harness's onReport faults, by kind: a boot error would show here. */
  notes: Record<string, number>;
  /** The first few handler errors, so a failing build shows why. */
  errors: string[];
  submitted: boolean;
}

const memory = (collect = false): Mem => {
  if (collect) (globalThis as { gc?: () => void }).gc?.();
  const m = process.memoryUsage();
  const c = v8.getHeapCodeStatistics();
  return {
    rss: m.rss,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    external: m.external,
    arrayBuffers: m.arrayBuffers,
    code: {
      bytecode: c.bytecode_and_metadata_size,
      code: c.code_and_metadata_size,
      source: c.external_script_source_size,
    },
    spaces: Object.fromEntries(
      v8.getHeapSpaceStatistics().map((sp) => [sp.space_name, sp.space_used_size]),
    ),
  };
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const EXTRAS = ["download_dataset", "upload_file", "recommend_biocontainer"];
const stub = (name: string) => ({
  name,
  label: name,
  description: `stub ${name}`,
  parameters: Type.Object({}, { additionalProperties: true }),
  execute: async () => ({ content: [{ type: "text" as const, text: "{}" }], details: {} }),
});

export async function boot(options: BootOptions, marks: Marks): Promise<BootResult> {
  const ctx = BACKGROUND_CONTEXT;
  const mem: BootResult["mem"] = { end: memory() };
  let requests = 0;
  const notes: HostNote[] = [];
  const runs = { started: 0, settled: 0 };

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://iwc.galaxyproject.org/workflow_manifest.json") return json([]);
    if (!url.startsWith(options.llm)) return json({});
    requests += 1;
    if (marks.firstRequest === undefined) {
      marks.firstRequest = now();
      mem.first = memory(options.gc);
    } else if (marks.userRequest === undefined && marks.submit !== undefined) {
      marks.userRequest = now();
      mem.user = memory(options.gc);
    }
    return realFetch(input, init);
  };

  // The seams, read the way the test hands them over: installed objects, never env or disk walks.
  setCapabilityProfile({
    shell: false,
    files: false,
    notebook: "page",
    network: true,
    mcpServers: false,
    ui: "worker",
  });
  setConfigSource({
    load: () => ({ lessons: { enabled: false }, experiments: { autoResume: false } }),
  });
  setInstructionSource({
    files: () => [
      { scope: "global", path: "shell://instructions", content: "Be brief.", truncated: false },
    ],
  });
  const vendor = join(options.repo, "extensions", "orbit", "vendor", "skills");
  const manifest = JSON.parse(fs.readFileSync(join(vendor, "_manifest.json"), "utf8")) as {
    files: Array<{ target: string }>;
  };
  const files = new Map<string, string>(
    manifest.files.map((f) => [f.target, fs.readFileSync(join(vendor, f.target), "utf8")]),
  );
  setVendorSkillsSource({
    catalog: JSON.parse(fs.readFileSync(join(vendor, "_catalog.json"), "utf8")),
    manifest: manifest as never,
    read: (target) => files.get(target) ?? null,
  });
  setGalaxyTransport({
    fetch: async (url, init) => {
      const method = init.method ?? "GET";
      const path = new URL(url).pathname;
      if (path === "/api/histories") {
        return json(
          method === "POST" ? { id: "h1", name: "bench" } : [{ id: "h1", name: "bench" }],
        );
      }
      return json({});
    },
    credentials: () => ({ url: "http://galaxy.test", apiKey: "k" }),
  });
  setRecordStore(createPageRecordStore({ key: join(options.dir, "notebook.md"), pageId: "p1" }));
  setGalaxyToolSource(createGalaxyOpsToolSource({ extras: EXTRAS.map(stub) as never }));
  marks.seams = now();

  const host = createPiHost({
    name: "orbit",
    cwd: options.dir,
    model: () => ({ provider: "custom", id: "m" }),
    ui: { notify: () => {} },
    onNote: (n) => void notes.push(n),
  });
  const api: ExtensionAPI = host.api;
  api.on("agent_start", () => void (runs.started += 1));
  api.on("agent_settled", () => void (runs.settled += 1));
  orbit(api);
  const extension = host.seal();
  marks.registered = now();

  const registry = createRegistry();
  registry.install(extension);
  const { models, model } = await agentModels().connect(
    resolveTarget({ ai_base_url: options.llm, ai_model: "m", ai_api_key: options.key }),
  );
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      settings: { ...LOOP, maxTurns: 6 },
      // As the conformance test does, so a harness-level fault lands in the notes summary.
      onReport: (e) =>
        void notes.push({ kind: "handler-error", event: "report", error: e, phase: "harness" }),
    },
    ctx,
  );
  const conversation = await harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { model } },
    ctx,
  );
  await host.attach(harness, conversation, ctx);
  marks.opened = now();

  // pi's session_start, then the scheduler: with Galaxy credentials present the greeting is a
  // model turn, so this is what sends the first request.
  await host.start("startup");
  harness.resume();
  marks.started = now();

  const until = async (done: () => boolean, ms = 30_000) => {
    const deadline = now() + ms;
    while (!done()) {
      if (now() > deadline) throw new Error("timed out waiting on the run");
      await new Promise((r) => setTimeout(r, 2));
    }
  };
  await until(() => runs.started >= 1);
  await harness.waitForIdle(ctx);
  await until(() => runs.settled >= 1);
  marks.greeted = now();

  marks.submit = now();
  const submission = await host.submit(options.message);
  if (submission) await submission.wait(ctx);
  marks.answered = now();
  mem.end = memory(options.gc);

  await harness.close(ctx).catch(() => {});
  const kinds: Record<string, number> = {};
  for (const n of notes) kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
  const errors = notes.flatMap((n) =>
    n.kind === "handler-error" ? [`${n.event}: ${String(n.error).slice(0, 300)}`] : [],
  );
  return {
    marks,
    mem,
    requests,
    notes: kinds,
    errors: errors.slice(0, 3),
    submitted: submission !== undefined,
  };
}
