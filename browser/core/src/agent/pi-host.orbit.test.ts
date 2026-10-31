// @vitest-environment node
/**
 * The conformance run: Orbit's whole brain (extensions/orbit) booted on pi-host under the browser's
 * capability profile, with a tripwire on every Node reach. The run is pinned as a file snapshot
 * (pi-host.orbit.golden.json): every fs/child_process/chokidar/better-sqlite3 call site Orbit makes,
 * by phase, plus the shim's own notes. Slices 1 and 2 shrink that list; a change that grows it fails
 * here.
 */
import cp from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { Type } from "@sinclair/typebox";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { json, text, toolCall } from "./fake-model";
import { sources, specifiers, withoutTypeImports } from "../flavor-boundary";
import { agentModels } from "./model";
import { createPiHost, type AskRequest, type HostNote, type PiHost } from "./pi-host";
import { resolve as resolveTarget } from "./providers";
import { LOOP } from "./runtime";
import type { CapabilityProfile } from "../../../../shared/capability-profile.js";
import { pageContentProblem } from "../../../../shared/galaxy-page-cells.js";

// ── tripwire ─────────────────────────────────────────────────────────────────────────────────────

const tripwire = vi.hoisted(() => {
  const ledger = {
    phase: "import",
    hits: new Map<string, { count: number }>(),
  };
  const FRAME = /\/(extensions\/loom|shared|lessons)\/([^\s):]+)/;
  /** Node's own frames: the module loader resolving an import, or fs calling fs (writeFileSync -> openSync). */
  const NODE = /\(node:|^\s*at node:/;
  /** The runner's frames: vite transforming a source is not Orbit reading a file. */
  const RUNNER = /\/(vite|vitest|vite-node|@vitest)\//;
  const PACKAGE = /node_modules\/((?:@[^/]+\/)?[^/]+)/;
  /**
   * Count a reach against the Orbit, shared or lessons source that made it. The immediate caller
   * past the spy decides whether it is Orbit's reach at all: Node's own internals and the runner
   * are not; a package Orbit called is, on Orbit's behalf, and is tagged `via` the package. A
   * Node frame between that package and Orbit means the call is Node's own (graceful-fs patches
   * fs.closeSync, so writeFileSync's close shows up under its frame), not the package's.
   */
  function record(label: string, api: string) {
    const frames = (new Error().stack ?? "")
      .split("\n")
      .slice(1)
      .filter((line) => !line.includes("pi-host.orbit.test.ts") && !line.includes("/@vitest/spy/"));
    const caller = frames[0];
    if (caller === undefined || NODE.test(caller) || RUNNER.test(caller)) return;
    const at = frames.findIndex((line) => !line.includes("/node_modules/") && FRAME.test(line));
    if (at < 0 || frames.slice(1, at).some((line) => NODE.test(line))) return;
    const owner = frames[at];
    const m = FRAME.exec(owner);
    if (!m) return;
    const via = caller === owner ? "" : ` via ${PACKAGE.exec(caller)?.[1] ?? "?"}`;
    const file = `${m[1]}/${m[2]}${via}`;
    const key = `${ledger.phase} | ${label}.${api} @ ${file}`;
    const hit = ledger.hits.get(key) ?? { count: 0 };
    hit.count += 1;
    ledger.hits.set(key, hit);
  }
  /** A module that records every member reached and answers with more of itself. */
  function recordingProxy(label: string, path = ""): any {
    const target = function () {};
    return new Proxy(target, {
      get(_t, prop) {
        if (typeof prop === "symbol" || prop === "then") return undefined;
        if (prop === "__esModule") return true;
        return recordingProxy(label, path ? `${path}.${String(prop)}` : String(prop));
      },
      apply(_t, _this, _args) {
        record(label, path || "call");
        return recordingProxy(label, path);
      },
      construct() {
        record(label, path ? `new ${path}` : "new");
        return recordingProxy(label, path);
      },
    });
  }
  return { ledger, record, recordingProxy };
});

// The root galaxy-ops package's own two entries, by resolved path. From browser/core the bare
// specifier resolves to the fork in browser/node_modules, and vitest keys a mock by the id it
// resolves, so the mock names the root Node entry that extensions/orbit resolves to and serves the
// root browser entry in its place -- what the worker's bundler does with the "browser" condition.
// Kept to this file: ops.ts and parity.test.ts need the fork, so no global alias.
const galaxyOps = vi.hoisted(() => {
  const dist = decodeURIComponent(
    new URL("../../../../node_modules/@galaxyproject/galaxy-ops/dist/", import.meta.url).pathname,
  );
  return { node: `${dist}index.js`, browser: `${dist}index.browser.js` };
});
vi.mock(galaxyOps.node, () => import(galaxyOps.browser));

vi.mock("chokidar", () => {
  const chokidar = tripwire.recordingProxy("chokidar");
  return { default: chokidar, watch: chokidar.watch };
});
vi.mock("better-sqlite3", () => ({ default: tripwire.recordingProxy("better-sqlite3") }));

const { ledger, record } = tripwire;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

/** Record every call of the module's functions, then run the real one. */
function spyAll(mod: object, label: string) {
  for (const key of Object.keys(mod)) {
    const original = (mod as Record<string, unknown>)[key];
    if (typeof original !== "function") continue;
    try {
      vi.spyOn(mod as Record<string, AnyFn>, key).mockImplementation(function (
        this: unknown,
        ...a: unknown[]
      ) {
        record(label, key);
        return (original as AnyFn).apply(this, a);
      });
    } catch {
      // A non-configurable member; it is not one Orbit calls.
    }
  }
}

/** Record, never spawn: a unit test must not shell out. Orbit only uses execFileSync. */
function stubAll(mod: typeof cp, label: string) {
  // The answers pick which branch git.ts takes: a fresh temp dir is not a repo, so Orbit's init,
  // config and commit path runs, and from then on the repo reports itself as loom-managed.
  let initialised = false;
  const answers: Record<string, (...a: unknown[]) => unknown> = {
    execFileSync: (file, args) => {
      const line = [file, ...(Array.isArray(args) ? args : [])].join(" ");
      if (line === "git rev-parse --is-inside-work-tree" && !initialised) {
        throw new Error("fatal: not a git repository");
      }
      if (line === "git init") initialised = true;
      if (line === "git config --bool loom.managed") return initialised ? "true" : "";
      return "";
    },
    execSync: () => "",
    spawnSync: () => ({ status: 0, stdout: "", stderr: "", signal: null, pid: 0, output: [] }),
  };
  for (const key of [
    "execFileSync",
    "execSync",
    "spawnSync",
    "exec",
    "execFile",
    "spawn",
    "fork",
  ]) {
    vi.spyOn(mod as unknown as Record<string, AnyFn>, key).mockImplementation((...a: unknown[]) => {
      record(label, key);
      const answer = answers[key];
      if (answer) return answer(...a);
      throw new Error(`child_process.${key} stubbed by pi-host.orbit.test.ts: ${String(a[0])}`);
    });
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..", "..");
const LOOM = join(REPO, "extensions", "orbit");
const SHARED = join(REPO, "shared");
// shared/lesson-rules.js imports lessons/validate.mjs, so the validator's top level runs under Orbit.
const LESSONS = join(REPO, "lessons");
// The vendored skills tree, read whole before the spies go on and before Orbit is on the stack:
// record() drops this file's own frames, so a lazy read from inside skills_fetch would be charged
// to vendor-skills.ts. A shell that bundles the tree hands over exactly this.
const VENDOR = join(LOOM, "vendor", "skills");
const vendorCatalog: unknown = JSON.parse(fs.readFileSync(join(VENDOR, "_catalog.json"), "utf8"));
const vendorManifest = JSON.parse(fs.readFileSync(join(VENDOR, "_manifest.json"), "utf8")) as {
  files: Array<{ target: string }>;
};
const vendorFiles = new Map<string, string>(
  vendorManifest.files.map((f) => [f.target, fs.readFileSync(join(VENDOR, f.target), "utf8")]),
);

spyAll(fs, "fs");
spyAll(fsp, "fs/promises");
spyAll(os, "os");
spyAll(zlib, "zlib");
spyAll(crypto, "crypto");
stubAll(cp, "child_process");
syncBuiltinESMExports();

// ── the browser profile: installed objects, not env ─────────────────────────────────────────────

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_ENV = { ...process.env };

/** What the worker will install: no shell, no files, the notebook in a page, Galaxy tools in-process. */
const PROFILE: CapabilityProfile = {
  shell: false,
  files: false,
  notebook: "page",
  network: true,
  mcpServers: false,
  ui: "worker",
};

/** What today's env switches said; everything else is the config's own default. */
const CONFIG = { lessons: { enabled: false }, experiments: { autoResume: false } };
/** The standing instruction the shell hands over in place of an ORBIT.md on disk. */
const INSTRUCTION = "Always answer in haiku.";
/** Reset every seam the run installs, in afterAll. */
const seams: Array<() => void> = [];

const tmp = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "one-brain-")));
// The worker has no env, so the run has none of Orbit's: every switch env used to set here is
// now the installed profile or the config source, and a stray eval seam cannot reach the run.
for (const key of Object.keys(process.env)) {
  if (/^(ORBIT|LOOM)_/.test(key)) delete process.env[key];
}
delete process.env.GALAXY_URL;
delete process.env.GALAXY_API_KEY;
Object.assign(process.env, {
  HOME: tmp,
  USERPROFILE: tmp,
  PI_CODING_AGENT_DIR: join(tmp, ".pi", "agent"),
});
// state.ts, registry.ts and activity.ts write beside process.cwd(); the forks pool allows the move.
process.chdir(tmp);

// ── the run ──────────────────────────────────────────────────────────────────────────────────────

const LLM = "http://llm.test/v1";
const ctx = BACKGROUND_CONTEXT;

const until = async (done: () => boolean) => {
  for (let i = 0; i < 500 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(done()).toBe(true);
};

const textOf = (content: unknown) =>
  typeof content === "string"
    ? content
    : (content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");

type Seen = { event: string; toolCallId?: string; toolName?: string };

/** The wrapper's facts on a tool result, as the shim kept them. */
const detailsOf = (m: unknown) =>
  (m as { details?: { galaxy?: Record<string, unknown> } } | undefined)?.details;

const script: Array<() => Response | Promise<Response>> = [];
const requests: Array<Record<string, any>> = [];
const seen: Seen[] = [];
const notices: Array<[string, string]> = [];
/** What the brain asked the person, and the confirm answers the next asks get, in order. */
const asked: AskRequest[] = [];
const confirms: boolean[] = [];
const notes: HostNote[] = [];
/** Calls the page record store made for its page, so the run can prove the record came from it. */
const pageCalls = { GET: 0, PUT: 0 };
/** The record page as Galaxy holds it. */
let page1 = "";
/** The second conversation's record page, for the switch. */
let page2 = "";
/** Writes to history h1, which the destructive turn asks to delete. */
let historyWrites = 0;
/** GETs of the unfinished job behind d2, which the poll-guard turn reads twice. */
let jobGets = 0;
let host: PiHost;
let harness: Harness;
let conversation: Awaited<ReturnType<Harness["createConversation"]>>;
const runs = { started: 0, ended: 0, settled: 0 };

const idle = () => runs.started === runs.ended;

/** My own recorders, registered before Orbit so they see every event first. */
function recorders(api: ExtensionAPI) {
  // pi's on() is an overload per event name; one loose signature serves a loop over names.
  const on = api.on as unknown as (
    event: string,
    handler: (e: { toolCallId: string; toolName: string }) => void,
  ) => () => void;
  api.on("agent_start", () => void (runs.started += 1));
  api.on("agent_end", () => void (runs.ended += 1));
  api.on("agent_settled", () => void (runs.settled += 1));
  for (const event of [
    "tool_execution_start",
    "tool_call",
    "tool_result",
    "tool_execution_end",
  ] as const) {
    on(event, (e) => void seen.push({ event, toolCallId: e.toolCallId, toolName: e.toolName }));
  }
}

/**
 * The browser shell's three extras -- the operations only galaxy-ops' Node entry has -- as stubs:
 * the run is about Orbit's own source, not the shell's replacements.
 */
const EXTRAS = ["download_dataset", "upload_file", "recommend_biocontainer"];
const stub = (name: string) => ({
  name,
  label: name,
  description: `stub ${name}`,
  parameters: Type.Object({}, { additionalProperties: true }),
  annotations: { readOnlyHint: name !== "upload_file" },
  execute: async () => ({ content: [{ type: "text" as const, text: "{}" }], details: {} }),
});

/** A history big enough that its contents spill past the 20 KiB cap into the memory ring. */
const BIG_HISTORY = Array.from({ length: 120 }, (_, i) => ({
  id: `${(i + 1).toString(16).padStart(16, "0")}`,
  hid: i + 1,
  name: `dataset ${i + 1} with a name long enough to take up room.txt`,
  history_content_type: "dataset",
  state: "ok",
  extension: "txt",
  deleted: false,
  visible: true,
  purged: false,
}));

const probe = {
  name: "probe",
  label: "Probe",
  description: "pins how a @sinclair/typebox schema is validated on this runtime",
  parameters: Type.Object({ n: Type.Number() }),
  execute: async (_id: string, params: { n: number }) => ({
    content: [{ type: "text" as const, text: `probe ${params.n}` }],
    details: {},
  }),
};

beforeAll(async () => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    // The IWC operations read the public manifest through the global fetch, not the transport.
    if (request.url === "https://iwc.galaxyproject.org/workflow_manifest.json") return json([]);
    if (!request.url.startsWith(LLM)) return json({});
    requests.push(JSON.parse(await request.text()));
    return (script.shift() ?? (() => text("ok")))();
  });

  ledger.phase = "import";
  const { installOrbitSeams, registerOrbit, workerUi } = await import("./orbit/boot");
  const { createMemoryLedger } = await import("../../../../extensions/orbit/submission-ledger");
  const galaxyFetch = async (url: string, init: RequestInit): Promise<Response> => {
    const method = init.method ?? "GET";
    const path = new URL(url).pathname;
    if (path === "/api/pages/p1") {
      pageCalls[method === "PUT" ? "PUT" : "GET"]++;
      if (method === "PUT") {
        const body = JSON.parse(String(init.body)) as { content: string };
        // Galaxy refuses a page with a fence it has no cell for, as the e2e stub does.
        const problem = pageContentProblem(body.content);
        if (problem) return json({ err_msg: problem }, 400);
        page1 = body.content;
      }
      return json({ id: "p1", content: page1, content_editor: page1 });
    }
    if (path === "/api/pages/p2") {
      if (method === "PUT") page2 = (JSON.parse(String(init.body)) as { content: string }).content;
      return json({ id: "p2", content: page2, content_editor: page2 });
    }
    if (path === "/api/histories/h1" && method === "PUT") {
      historyWrites++;
      return json({ id: "h1", name: "one brain", deleted: true });
    }
    if (path === "/api/histories") {
      return json(
        method === "POST" ? { id: "h1", name: "one brain" } : [{ id: "h1", name: "one brain" }],
      );
    }
    // The history guard's lookup: d1 lives in another history than the one a run names.
    if (path === "/api/datasets/d1") {
      return json({ id: "d1", name: "d1.txt", history_id: "elsewhere", state: "ok" });
    }
    if (path === "/api/histories/hbig/contents") return json(BIG_HISTORY);
    // A dataset whose creating job is still running, for the poll guard.
    if (path === "/api/datasets/d2") {
      return json({
        id: "d2",
        name: "d2.txt",
        history_id: "h1",
        state: "running",
        creating_job: "j2",
      });
    }
    if (path === "/api/jobs/j2") {
      jobGets++;
      return json({ id: "j2", state: "running", tool_id: "cat1" });
    }
    // Everything else, /api/version included: an unknown version refuses nothing and costs no wait.
    return json({});
  };
  // The worker's own seams, as orbit/boot.ts installs them, with a full grant.
  installOrbitSeams({
    capabilities: ["llm", "local", "read", "write"],
    galaxy: { fetch: galaxyFetch as unknown as typeof fetch, url: "http://galaxy.test", key: "k" },
    ledger: createMemoryLedger(),
    secrets: () => [],
    extras: EXTRAS.map(stub) as never,
  });
  const { setCapabilityProfile } = await import("../../../../shared/capability-profile.js");
  seams.push(() => setCapabilityProfile(null));
  const { setConfigSource } = await import("../../../../shared/config-source.js");
  seams.push(() => setConfigSource(null));
  const { setSubmissionLedger } = await import("../../../../extensions/orbit/submission-ledger");
  seams.push(() => setSubmissionLedger(null));
  const { setPollWake } = await import("../../../../extensions/orbit/galaxy-reconcile");
  seams.push(() => setPollWake(null));
  const { setGalaxyToolSource } = await import("../../../../extensions/orbit/galaxy-tool-source");
  seams.push(() => setGalaxyToolSource(null));
  // Two seams Node has to fill differently: the worker hands over no standing instructions yet
  // (one here proves the seam carries it), and fetches skill bodies by URL, where this reads the
  // vendored tree from disk.
  const { setInstructionSource } = await import("../../../../extensions/orbit/user-instructions");
  setInstructionSource({
    files: () => [
      { scope: "global", path: "shell://instructions", content: INSTRUCTION, truncated: false },
    ],
  });
  seams.push(() => setInstructionSource(null));
  const { setVendorSkillsSource } = await import("../../../../extensions/orbit/vendor-skills");
  setVendorSkillsSource({
    catalog: vendorCatalog,
    manifest: vendorManifest,
    read: (target) => vendorFiles.get(target) ?? null,
  });
  seams.push(() => setVendorSkillsSource(null));
  // The record is a Galaxy page, not a file. The key stays under the temp dir so the side stores
  // keyed by its dirname (activity log, template replay) land where they did.
  const { setRecordStore } = await import("../../../../extensions/orbit/record-store");
  const { createPageRecordStore } = await import("../../../../extensions/orbit/record-store-page");
  setRecordStore(createPageRecordStore({ key: join(tmp, "notebook.md"), pageId: "p1" }));

  ledger.phase = "register";
  host = createPiHost({
    name: "orbit",
    cwd: tmp,
    phase: () => ledger.phase,
    model: () => ({ provider: "custom", id: "m" }),
    // The worker's confirm-only bridge, answered from `confirms`; hasUI is true, as in the worker.
    ui: workerUi({
      notify: (t, l) => void notices.push([l, t]),
      ask: async (request) => {
        asked.push(request);
        return request.kind === "confirm" ? (confirms.shift() ?? false) : undefined;
      },
    }),
    onNote: (n) => void notes.push(n),
  });
  recorders(host.api);
  registerOrbit(host, {});
  host.api.registerTool(probe as never);

  ledger.phase = "seal";
  const extension = host.seal();

  ledger.phase = "open";
  const registry = createRegistry();
  registry.install(extension);
  const { models, model } = await agentModels().connect(
    resolveTarget({ ai_base_url: LLM, ai_model: "m", ai_api_key: "k" }),
  );
  harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      settings: { ...LOOP, maxTurns: 6 },
      onReport: (e) =>
        notes.push({ kind: "handler-error", event: "report", error: e, phase: ledger.phase }),
    },
    ctx,
  );
  conversation = await harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { model } },
    ctx,
  );
  await host.attach(harness, conversation, ctx);
});

afterAll(async () => {
  await harness?.close(ctx).catch(() => {});
  for (const reset of seams.splice(0)) reset();
  vi.unstubAllGlobals();
  process.chdir(ORIGINAL_CWD);
  for (const key of Object.keys(process.env)) if (!(key in ORIGINAL_ENV)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── what the run reports ─────────────────────────────────────────────────────────────────────────

const ASSERTED = /^(fs|fs\/promises|child_process|chokidar|better-sqlite3)\./;
const INFORMATIONAL = /^(os|zlib|crypto)\./;
// Node built-ins the worker cannot have, and the npm packages that are Node-only themselves:
// pi's own runtime and TUI, the sandbox, and the tus client's file reader.
const EDGE_ASSERTED =
  /^(node:)?(fs|fs\/promises|child_process|zlib)$|^(chokidar|better-sqlite3|@earendil-works\/pi-coding-agent|@earendil-works\/pi-tui|@anthropic-ai\/sandbox-runtime|tus-js-client)(\/|$)/;

const unique = (items: string[]) => [...new Set(items)].sort();

/**
 * Every reach as `api @ file`, without phase or line: the phase of Orbit's un-awaited work (the
 * poller's first tick, reconcile's follow-through) is a race against the test's own progress,
 * and lines move on every Orbit edit.
 */
const reaches = (filter: RegExp) =>
  unique(
    [...ledger.hits.keys()].map((key) => key.split(" | ")[1]).filter((rest) => filter.test(rest)),
  );

/** The static import graph: every Orbit, shared or lessons source naming a Node-only module. */
function edges() {
  const files = [
    ...sources(LOOM, ["vendor"]),
    ...sources(SHARED),
    ...sources(LESSONS, [], /\.(ts|js|mjs)$/),
  ].filter((file) => !/\.test\.ts$/.test(file));
  const asserted: string[] = [];
  for (const file of files) {
    for (const spec of specifiers(withoutTypeImports(fs.readFileSync(file, "utf8")))) {
      if (EDGE_ASSERTED.test(spec)) asserted.push(`${relative(REPO, file)} -> ${spec}`);
    }
  }
  return unique(asserted);
}

function noteKey(n: HostNote): string {
  switch (n.kind) {
    case "silent":
      return `seal | silent ${n.event} (${n.handlers})`;
    case "refused":
      return `${n.phase} | refused ${n.member}${n.detail ? ` ${n.detail}` : ""}`;
    case "dropped":
      return `${n.phase} | dropped ${n.member}`;
    case "busy":
      return `${n.phase} | busy ${n.member}`;
    case "handler-error":
      return `${n.phase} | handler-error ${n.event}: ${(n.error as Error)?.message ?? n.error}`;
  }
}

/**
 * What the model is offered under a profile: each declared tool's name, description, parameter
 * names and annotations, and the system prompt's section headings. The recorded tool list slice 4
 * compares the old brain against; a model-visible change shows up as a diff of it.
 */
function surface(api: ExtensionAPI, systemPrompt?: string) {
  const tools = api
    .getAllTools()
    // The test's own probe tool isn't the brain's.
    .filter((t) => t.exposure !== "hidden" && t.name !== "probe")
    .map((t) => ({
      name: t.name,
      description: t.description,
      parameters: Object.keys(
        (t.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {},
      ).sort(),
      annotations: (t as { annotations?: unknown }).annotations ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const sections = systemPrompt
    ? [...systemPrompt.matchAll(/^#{1,3} (.+)$/gm)].map((m) => m[1].trim())
    : undefined;
  return JSON.stringify({ tools, ...(sections ? { sections } : {}) }, null, 2) + "\n";
}

const golden = () => ({
  reaches: reaches(ASSERTED),
  informational: reaches(INFORMATIONAL),
  edges: edges(),
  notes: unique(notes.map(noteKey)),
  // What the person saw outside a turn, now that the host has a UI.
  // The temp directory is a different path every run.
  notices: unique(notices.map(([level, text]) => `${level} | ${text.replaceAll(tmp, "<tmp>")}`)),
});

// ── assertions ───────────────────────────────────────────────────────────────────────────────────

describe("Orbit on pi-host", () => {
  it("registers through the shim without reaching Node", () => {
    const total = [...host.handlers.values()].reduce((a, b) => a + b, 0);
    expect({ on: total, tools: host.tools.length, commands: host.commands.size }).toEqual({
      // The MCP output recovery (three handlers) is not registered: this shell has no MCP layer.
      // The capture follow-through (session_start; it has no connect trigger) is, over the memory
      // provenance fs. The Galaxy tools add the destructive confirm (tool_call), the page
      // policy's shown-page reset (session_start) and the Galaxy version capture (session_start,
      // tool_result), which is where observations get the Galaxy version. The empty-completion
      // check adds three (session_start, input, agent_end).
      on: 71 + 7 + 1 + 2 + 3,
      // Orbit's own tools (ena_runs among them) less the five page-sync tools, which a page
      // record has no use for; the Galaxy family (the browser entry's 42 operations, the shell's
      // three extras, and Orbit's list_jobs and get_job_logs bridges); galaxy_read_output beside
      // it; and the probe. mcp_read_output is MCP-only.
      tools: 16 - 5 + 47 + 1 + 1,
      // The real /reconcile, in the stub's place; /sync goes with the page-sync tools, and
      // /connect and /profiles with the profiles a page-signed worker has none of.
      commands: 21 - 3,
    });
    // No MCP server is registered under bare Galaxy tools, so nothing is refused.
    expect(notes.filter((n) => n.kind !== "silent" && n.phase === "register")).toEqual([]);
    expect([...ledger.hits.keys()].filter((k) => k.startsWith("register |"))).toEqual([]);
    // Nothing at import either: lessons/validate.mjs (pulled in by shared/lesson-rules.js) now
    // reads import.meta.main for its CLI check instead of realpathSync(argv[1]).
    expect([...ledger.hits.keys()].filter((k) => k.startsWith("import |"))).toEqual([]);
  });

  it("loads galaxy-ops' browser entry, which reaches nothing Node-only", async () => {
    const { galaxyOpsEntry } = await import("../../../../extensions/orbit/galaxy-ops-tools");
    // 45 here would mean the Node entry loaded: it pushes its three operations into the array both
    // entries share, so the count is the tripwire for the mock above.
    const entry = galaxyOpsEntry();
    expect(entry.operations).toHaveLength(42);
    expect(entry.hasUploadFile).toBe(false);
    const { registeredGalaxyTools } =
      await import("../../../../extensions/orbit/galaxy-tool-source");
    const names = registeredGalaxyTools().map((t) => t.name);
    // The 47-name family, and galaxy_read_output registered beside it.
    expect(names).toHaveLength(47 + 1);
    for (const name of [
      ...entry.operations,
      ...EXTRAS,
      "list_jobs",
      "get_job_logs",
      "galaxy_read_output",
    ]) {
      expect(names, name).toContain(name);
    }

    // The entry and every chunk it pulls in, followed through relative imports and re-exports.
    const seen = new Set<string>();
    const queue = [galaxyOps.browser];
    const named = new Set<string>();
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of specifiers(fs.readFileSync(file, "utf8"))) {
        if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec));
        else named.add(spec);
      }
    }
    expect(seen.size).toBeGreaterThan(1);
    expect([...named].sort()).toEqual(["openapi-fetch", "zod"]);
    // Orbit's brain resolves the repo root's galaxy-ops, not the browser's fork: a bare import
    // from extensions/orbit walks up from there, so nothing on that path may hold its own copy.
    expect(fs.existsSync(join(REPO, "node_modules", "@galaxyproject", "galaxy-ops"))).toBe(true);
    for (const dir of [join(LOOM, "node_modules"), join(REPO, "extensions", "node_modules")]) {
      expect(fs.existsSync(dir), dir).toBe(false);
    }
  });

  it("names the handlers no seam fires", () => {
    const silent = Object.fromEntries(
      notes.flatMap((n) => (n.kind === "silent" ? [[n.event, n.handlers]] : [])),
    );
    expect(silent).toEqual({ session_tree: 3 });
  });

  /**
   * Under the worker nothing polls on its own: no interval, no tick at session_start, and no
   * reconcile there either. Drive one tick the way the durable watch will, wait for its
   * enrichment (and reconcile, when asked), then for anything still queued, so the reaches land
   * in the phase that started them.
   */
  async function drain(options: { reconcile?: boolean } = {}) {
    const { pollGalaxyNow } = await import("../../../../extensions/orbit/galaxy-poller");
    const { galaxyBackgroundIdle } = await import("../../../../extensions/orbit/galaxy-reconcile");
    const result = await pollGalaxyNow({ awaitEnrichment: true, ...options });
    await galaxyBackgroundIdle();
    // Nothing was submitted, so the tick has nothing to report or keep watching.
    expect(result).toMatchObject({
      transitions: [],
      inProgress: 0,
      pendingEnrichment: 0,
      openSubmissions: 0,
    });
    return result;
  }

  it("starts the session with no greeting run", async () => {
    ledger.phase = "session_start";
    // pi's session_start precedes any run; only then does the scheduler start.
    await host.start("startup");
    harness.resume();
    // Galaxy credentials are configured, which on the desktop makes the greeting a model turn.
    // The worker opens a session on every panel open and reload, so it sends none.
    await harness.waitForIdle(ctx);
    expect(runs.started).toBe(0);
    expect(requests).toHaveLength(0);
    // No reconcile ran at session_start: the first tick after an attach is where it runs.
    const { readReconcileState } = await import("../../../../extensions/orbit/galaxy-provenance");
    expect(await readReconcileState(tmp)).toBeNull();
    await drain({ reconcile: true });
    // The record was served by the page store, not by a file store that happened to resolve
    // from a different key: the absence of record-store-file.ts reaches in the golden is the
    // other half of this.
    expect(pageCalls.GET).toBeGreaterThan(0);
    // That tick's reconcile ran over the memory provenance fs: it wrote its cursor beside the
    // record key without a .loom directory appearing on disk.
    expect(await readReconcileState(tmp)).toMatchObject({ schema: 1 });
    expect(fs.existsSync(join(tmp, ".loom"))).toBe(false);
  });

  it("runs a tool turn: prompt from before_agent_start, notebook from context, pi's tool events", async () => {
    ledger.phase = "turn";
    const before = requests.length;
    script.push(
      () =>
        toolCall("skills_fetch", {
          repo: "galaxy-skills",
          path: "skills/collection-manipulation/SKILL.md",
        }),
      () => text("done"),
    );
    const s = await host.submit("fetch the collection skill");
    await s!.wait(ctx);
    await until(() => runs.settled >= 1);
    const request = requests[before];
    expect(request.messages[0].role).toBe("system");
    // A sentence shared/prompt-blocks.js owns, so the section text is Orbit's whole prompt.
    expect(request.messages[0].content).toContain("Compaction (shrinking the");
    // The instruction source serves the standing-instructions block, not just the walk going quiet.
    expect(request.messages[0].content).toContain(INSTRUCTION);
    // The skills router rendered from the vendor source (the heading shared/skills-router.js owns).
    expect(request.messages[0].content).toContain("## Skills repositories (operational know-how)");
    // No file surface: the upload tool is not registered, so the prompt must not name it.
    expect(request.messages[0].content).not.toContain("galaxy_upload_local_file");
    // Galaxy tools are named bare, and the MCP transport's steers are gone with the server.
    expect(request.messages[0].content).not.toContain("mcp__galaxy__");
    expect(request.messages[0].content).not.toContain("/mcp reconnect galaxy");
    expect(request.messages[0].content).not.toContain("mcp_read_output");
    expect(request.messages[0].content).toContain("`recommend_iwc_workflows`");
    expect(request.messages[0].content).toContain("### Slow Galaxy requests");
    const roles = request.messages.map((m: { role: string; content: unknown }) => ({
      role: m.role,
      text: textOf(m.content),
    }));
    const lastUser = roles.findLastIndex(
      (m: { text: string }) => m.text === "fetch the collection skill",
    );
    expect(lastUser).toBeGreaterThan(0);
    expect(roles[lastUser - 1].role).toBe("user");
    expect(roles[lastUser - 1].text).toContain("## Notebook (project log)");
    expect(seen.filter((e) => e.toolCallId === "call_1").map((e) => e.event)).toEqual([
      "tool_execution_start",
      "tool_call",
      "tool_result",
      "tool_execution_end",
    ]);
    // The vendor source served the file: the bundled branch of skills_fetch, never the network.
    const results = (await conversation.context(ctx)).messages.filter(
      (m) => m.role === "toolResult",
    );
    const last = results.at(-1)!;
    expect(last.toolName).toBe("skills_fetch");
    expect(last.isError).toBeFalsy();
    const fetched = textOf(last.content);
    expect(fetched.startsWith("Error:")).toBe(false);
    expect(fetched).toContain("collection");
  });

  it("records the surface the model is offered under the worker profile", async () => {
    // The tool turn above made the first request; its system prompt is Orbit's whole prompt.
    const prompt = requests.find((r) => r.messages?.[0]?.role === "system")?.messages[0].content;
    expect(typeof prompt).toBe("string");
    await expect(surface(host.api, prompt)).toMatchFileSnapshot("./__surface__/orbit/tools.json");
  });

  it("validates a @sinclair/typebox schema strictly, as Orbit does today", async () => {
    // Orbit's 0.34 schema carries Symbol.for("TypeBox.Kind"), so pi-ai skips its own JSON-schema
    // coercion: "2" stays a string and fails Type.Number(). Making the browser lenient here is a
    // slice 2 decision, not a side effect of the shim.
    script.push(
      () => toolCall("probe", { n: "2" }),
      () => text("ok"),
    );
    const s = await host.submit("probe it");
    await s!.wait(ctx);
    await until(() => runs.settled >= 2);
    const results = (await conversation.context(ctx)).messages.filter(
      (m) => m.role === "toolResult",
    );
    const last = results.at(-1)!;
    expect(last.toolName).toBe("probe");
    expect(last.isError).toBe(true);
    expect(JSON.stringify(last)).toMatch(/number/i);
  });

  it("routes the bare family to the guards and runs the shell's tools", async () => {
    const mark = seen.length;
    script.push(
      () => toolCall("create_history", { history_name: "one brain" }, "g1"),
      () => toolCall("recommend_iwc_workflows", { intent: "qc" }, "g2"),
      () => toolCall("get_dataset_details", { dataset_id: "d1" }, "g3"),
      () => text("done"),
    );
    const first = await host.submit("make a history and look around");
    await first!.wait(ctx);
    await until(() => runs.settled >= 3);
    // index.ts captures the new history id off the real create_history's POST.
    const { getState } = await import("../../../../extensions/orbit/state");
    expect(getState().currentHistoryId).toBe("h1");
    const results = () =>
      conversation.context(ctx).then((c) => c.messages.filter((m) => m.role === "toolResult"));
    let last = await results();
    const recommend = last.find((m) => m.toolName === "recommend_iwc_workflows")!;
    // The skill trigger's IWC hint, in bare spelling, appended through message_end.
    expect(textOf(recommend.content)).toContain("`get_iwc_workflow_details`");
    expect(textOf(recommend.content)).not.toContain("mcp__galaxy__");
    const details = last.find((m) => m.toolName === "get_dataset_details")!;
    expect(details.isError).toBeFalsy();
    // galaxy-ops' envelope, through the wrapper; its details.galaxy survives the shim's json().
    expect(JSON.parse(textOf(details.content)).data.dataset.state).toBe("ok");
    expect(detailsOf(details)?.galaxy?.tool).toBe("get_dataset_details");
    expect(
      seen
        .slice(mark)
        .filter((e) => e.toolCallId === "g3")
        .map((e) => e.event),
    ).toEqual(["tool_execution_start", "tool_call", "tool_result", "tool_execution_end"]);

    script.push(
      () => toolCall("search_tools_by_keywords", { keywords: ["fastp"] }, "g4"),
      () =>
        toolCall(
          "run_tool",
          { history_id: "h1", tool_id: "cat1", inputs: { input1: { src: "hda", id: "d1" } } },
          "g5",
        ),
      () => text("done"),
    );
    const second = await host.submit("find fastp and run it");
    await second!.wait(ctx);
    await until(() => runs.settled >= 4);
    last = await results();
    // galaxy-recovery's keywords refusal.
    const keywords = last.find((m) => m.toolName === "search_tools_by_keywords")!;
    expect(keywords.isError).toBe(true);
    expect(textOf(keywords.content)).toContain("Use search_tools_by_name with a specific name");
    expect(textOf(keywords.content)).toContain("one request per tool");
    expect(textOf(keywords.content)).not.toContain("MCP budget");
    // The history guard looked d1 up over the transport and refused the foreign input.
    const run = last.find((m) => m.toolName === "run_tool")!;
    expect(run.isError).toBe(true);
    expect(textOf(run.content)).toContain("Refused: these inputs are in another history");
    // index.ts clears the galaxy-tool status three seconds after a Galaxy tool ends; waiting it
    // out keeps that dropped note in this phase rather than whichever one the test reaches next.
    await new Promise((r) => setTimeout(r, 3_100));
  });

  it("coerces string arguments, spills a large result and reads it back, all through the shim", async () => {
    const results = () =>
      conversation.context(ctx).then((c) => c.messages.filter((m) => m.role === "toolResult"));
    script.push(
      // A plain JSON schema with prepareArguments, not TypeBox: pi-durable coerces "5" as it does
      // for MCP tools, where Orbit's own TypeBox tools stay strict (the probe above).
      () => toolCall("get_histories", { limit: "5" }, "s1"),
      () => toolCall("get_history_contents", { history_id: "hbig" }, "s2"),
      // The id the model would copy out of the preview, read where the shim kept it.
      async () => {
        const spilled = (await results()).findLast((m) => m.toolName === "get_history_contents");
        const outputId = detailsOf(spilled)?.galaxy?.outputId;
        return toolCall("galaxy_read_output", { outputId, pointer: "/data/contents/0" }, "s3");
      },
      () => text("done"),
    );
    const s = await host.submit("list my histories, then look inside the big one");
    await s!.wait(ctx);
    await until(() => runs.settled >= 5);
    const last = await results();
    const histories = last.find((m) => m.toolName === "get_histories")!;
    expect(histories.isError, textOf(histories.content)).toBeFalsy();
    const contents = last.find((m) => m.toolName === "get_history_contents")!;
    expect(contents.isError, textOf(contents.content)).toBeFalsy();
    expect(textOf(contents.content)).toContain("[loom Galaxy output]");
    expect(textOf(contents.content)).not.toContain("MCP");
    const outputId = detailsOf(contents)?.galaxy?.outputId;
    expect(outputId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const read = last.find((m) => m.toolName === "galaxy_read_output")!;
    expect(read.isError, textOf(read.content)).toBeFalsy();
    expect(textOf(read.content)).toContain(BIG_HISTORY[0].name);
    // As in the guard turn: let the galaxy-tool status clear inside this phase.
    await new Promise((r) => setTimeout(r, 3_100));
  }, 15_000);

  it("refuses a repeated status read of an unfinished job at once, with no Galaxy request", async () => {
    const results = () =>
      conversation.context(ctx).then((c) => c.messages.filter((m) => m.role === "toolResult"));
    const noticesBefore = notices.length;
    script.push(
      () => toolCall("get_job_details", { dataset_id: "d2" }, "w1"),
      () => toolCall("get_job_details", { dataset_id: "d2" }, "w2"),
      () => text("done"),
    );
    const started = Date.now();
    const s = await host.submit("is the cat job done yet?");
    await s!.wait(ctx);
    await until(() => runs.settled >= 6);
    // No two-minute wait in the brain: the watch is the worker's only clock.
    expect(Date.now() - started).toBeLessThan(1_000);
    const last = await results();
    const first = last.find((m) => m.toolCallId === "w1")!;
    expect(first.isError, textOf(first.content)).toBeFalsy();
    expect(textOf(first.content)).toContain("the background monitor checks it without model calls");
    const repeat = last.find((m) => m.toolCallId === "w2")!;
    expect(repeat.isError).toBe(true);
    expect(textOf(repeat.content)).toContain("No Galaxy request was sent");
    expect(textOf(repeat.content)).not.toContain("Status wait interrupted");
    expect(jobGets).toBe(1);
    // With a UI the turn's progress line still shows; the guard itself says nothing to the user.
    expect(notices.slice(noticesBefore)).toEqual([
      ["info", "Progress: checking Galaxy data and job status."],
    ]);
    // As in the guard turn: let the galaxy-tool status clear inside this phase.
    await new Promise((r) => setTimeout(r, 3_100));
  }, 15_000);

  it("asks before a destructive Galaxy call, through the confirm bridge, and honours both answers", async () => {
    ledger.phase = "turn";
    const before = runs.settled;
    const remove = () => toolCall("update_history", { history_id: "h1", deleted: true });
    confirms.push(false, true);
    script.push(
      remove,
      () => text("kept it"),
      remove,
      () => text("deleted it"),
    );
    await (await host.submit("delete the history"))!.wait(ctx);
    await until(() => runs.settled >= before + 1);
    expect(historyWrites).toBe(0);
    await (await host.submit("yes, really delete it"))!.wait(ctx);
    await until(() => runs.settled >= before + 2);
    expect(historyWrites).toBe(1);
    const confirmsAsked = asked.filter((a) => a.kind === "confirm");
    expect(confirmsAsked).toHaveLength(2);
    expect(confirmsAsked[0]).toMatchObject({ title: "Confirm destructive Galaxy operation" });
    const results = (await conversation.context(ctx)).messages.filter(
      (m) => m.role === "toolResult",
    );
    expect(textOf(results.at(-2)?.content)).toBe("Destructive Galaxy operation cancelled by user.");
  });

  it("switches to a second conversation with its own page and back, through quiesce and settle", async () => {
    ledger.phase = "switch";
    const { setRecordStore } = await import("../../../../extensions/orbit/record-store");
    const { createPageRecordStore } =
      await import("../../../../extensions/orbit/record-store-page");
    const { galaxyBackgroundIdle } = await import("../../../../extensions/orbit/galaxy-reconcile");
    const { getNotebookPath } = await import("../../../../extensions/orbit/state");
    const first = conversation;
    const leave = async () => {
      host.quiesce(conversation.id);
      expect(await host.settle(conversation.id, 5_000)).toEqual({ settled: true, late: [] });
      await galaxyBackgroundIdle();
      await host.shutdown("new");
    };
    await leave();
    const secondKey = join(tmp, "second", "notebook.md");
    fs.mkdirSync(dirname(secondKey), { recursive: true });
    setRecordStore(createPageRecordStore({ key: secondKey, pageId: "p2" }));
    const { models: _models, model } = await agentModels().connect(
      resolveTarget({ ai_base_url: LLM, ai_model: "m", ai_api_key: "k" }),
    );
    conversation = await harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { model } },
      ctx,
    );
    await host.attach(harness, conversation, ctx);
    await host.start("new");
    expect(getNotebookPath()).toBe(secondKey);
    // And back: the first conversation resumes on its own page.
    await leave();
    setRecordStore(createPageRecordStore({ key: join(tmp, "notebook.md"), pageId: "p1" }));
    conversation = first;
    await host.attach(harness, conversation, ctx);
    await host.start("resume");
    expect(getNotebookPath()).toBe(join(tmp, "notebook.md"));
  });

  it("runs commands and shuts down", async () => {
    ledger.phase = "command";
    expect(await host.command("notebook", "")).toBe(true);
    expect(await host.command("status", "")).toBe(true);
    // Reads the writer registry the session opened over the in-memory fs. The command answers
    // without a registry too, so the mode is checked outright, and a fallback to read-only would
    // have reached the page as a warning.
    const { getSessionRegistry } = await import("../../../../extensions/orbit/registry-runtime");
    expect(getSessionRegistry()?.store.mode).toBe("writer");
    expect(notices.filter(([level]) => level === "warning")).toEqual([]);
    expect(await host.command("pending", "")).toBe(true);
    // The real reconcile: it reads the record through the page store (hasUI is false, so its
    // notice is not asserted; the worker's notify bridge is slice 3).
    const before = pageCalls.GET;
    expect(await host.command("reconcile", "")).toBe(true);
    await drain();
    expect(pageCalls.GET).toBeGreaterThan(before);
    expect(host.commands.get("reconcile")?.description).toContain("record runs no block claims");
    ledger.phase = "shutdown";
    await host.shutdown("quit");
    // The shutdown summary went up as a carrier Galaxy accepts, and reads back as the fence.
    expect(page1).toMatch(/^\[orbit-session:v1\]: #orbit "/m);
    const { galaxyMarkdownToOrbit } =
      await import("../../../../extensions/orbit/galaxy-markdown-adapter");
    expect(galaxyMarkdownToOrbit(page1)).toContain("```orbit-session");
  });

  it("ran every handler without a missing ctx member", () => {
    expect(notes.filter((n) => n.kind === "handler-error")).toEqual([]);
  });

  it("matches the pinned reach list", async () => {
    await expect(JSON.stringify(golden(), null, 2) + "\n").toMatchFileSnapshot(
      "./pi-host.orbit.golden.json",
    );
  });
});

// Last, on its own host: it swaps the profile and the registered family, and puts both back.
describe("Orbit on pi-host under a read-only grant", () => {
  it("registers the 33 read-only Galaxy tools and none of Orbit's writers", async () => {
    const loom = await import("../../../../extensions/orbit/index");
    const { setCapabilityProfile } = await import("../../../../shared/capability-profile.js");
    const source = await import("../../../../extensions/orbit/galaxy-tool-source");
    const { createGalaxyOpsToolSource } =
      await import("../../../../extensions/orbit/galaxy-ops-tools");
    const { ORBIT_WRITING_TOOLS } = await import("../../../../extensions/orbit/galaxy-grant");
    const install = () =>
      source.setGalaxyToolSource(createGalaxyOpsToolSource({ extras: EXTRAS.map(stub) }));
    setCapabilityProfile({ ...PROFILE, galaxy: "read" });
    install();
    try {
      const readHost = createPiHost({ name: "orbit-read", cwd: tmp, ui: { notify: () => {} } });
      loom.default(readHost.api);
      const galaxy = source.registeredGalaxyTools();
      for (const tool of galaxy) expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      // 29 read ops of the browser entry's 42, download_dataset and recommend_biocontainer
      // (upload_file is a write extra), and the two job bridges; galaxy_read_output beside them.
      expect(galaxy.map((t) => t.name).filter((n) => n !== "galaxy_read_output")).toHaveLength(33);
      expect(galaxy.map((t) => t.name)).toContain("galaxy_read_output");
      // Orbit's own 11 under write and a page record, less the record writers: the two
      // invocation checks, both record tools and loom_propose.
      const family = new Set(galaxy.map((t) => t.name));
      const own = readHost.tools.filter((n) => !family.has(n));
      expect(own).toHaveLength(16 - 5 - 5);
      for (const name of ORBIT_WRITING_TOOLS) expect(own, name).not.toContain(name);
      await expect(surface(readHost.api)).toMatchFileSnapshot(
        "./__surface__/orbit/tools.read.json",
      );
    } finally {
      setCapabilityProfile(PROFILE);
      install();
      source.registerGalaxyTools({ registerTool: () => undefined } as never);
    }
  });
});
