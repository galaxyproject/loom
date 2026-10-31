import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve as absolute } from "node:path";
// The browser entry: the Node entry adds its Node-only operations to the array both share.
import { allOperations } from "@galaxyproject/galaxy-ops/browser";

import { DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";

import { registeredGalaxyTools } from "../../../../extensions/orbit/galaxy-tool-source";
import { MAX_AUTO_FOLLOW_UPS } from "./documents";
import { galaxyTools } from "./galaxy-extras";
import { Headless } from "./headless";
import { connect, keyVariable } from "./model";
import { processTools } from "./processes";
import { pythonTool } from "./python";
import { LOOP, MAX_TURNS } from "./runtime";
import { defaultEndpoint, PROVIDERS, resolve } from "./providers";
import type { AgentTool, Capability, Python } from "./tool";
import type { AgentFlavor } from "./tools";
import { DEFAULT_BRAND, type Brand } from "./brand";

const SCHEMA = 1;
const SOURCE = "src/agent";
const SKIPPED = ["skills/"];

/**
 * Where the flavor's pieces sit on disk. The core finds its own sources through the flavor's
 * dependency on it, and Orbit's skills beside the core, so a flavor names only its own paths.
 */
export interface DescribeLayout {
  /** The flavor's package root; its `src/agent` modules are described beside the core's. */
  flavor: string;
  /** The prompt a page seeds a conversation with, as the flavor states it (Olit's olit.xml). */
  identityPrompt?: string;
}

/** The core package this flavor resolves, wherever it is installed. */
function corePackage(flavor: string): string {
  const pkg = createRequire(absolute(flavor, "package.json")).resolve(
    "@galaxyproject/orbit-browser/package.json",
  );
  return dirname(pkg);
}

/**
 * Each package root whose `src/agent` modules are keyed as `src/agent/<path>`, whichever package
 * holds them, so the description reads the same however the agent is split.
 */
export function agentSources(layout: DescribeLayout): string[] {
  return [corePackage(layout.flavor), layout.flavor];
}

/** Whitespace-normalised hash: reflowing a paragraph is not a semantic change. */
export const fingerprint = (text: string) =>
  createHash("sha256")
    .update((text ?? "").split(/\s+/).filter(Boolean).join(" "))
    .digest("hex")
    .slice(0, 16);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** Every name a module exports, by module. */
function symbols(sources: string[]): Record<string, string[]> {
  const found = new Map<string, Set<string>>();
  for (const source of sources) {
    const base = join(source, SOURCE);
    for (const file of walk(base)) {
      const rel = relative(base, file);
      if (
        !file.endsWith(".ts") ||
        file.endsWith(".test.ts") ||
        SKIPPED.some((s) => rel.startsWith(s))
      ) {
        continue;
      }
      const names = [
        ...readFileSync(file, "utf8").matchAll(
          /^export (?:async )?(?:const|function|class|interface|type) (\w+)/gm,
        ),
      ];
      if (names.length) {
        const known = found.get(rel) ?? new Set<string>();
        names.forEach((m) => known.add(m[1]));
        found.set(rel, known);
      }
    }
  }
  const out: Record<string, string[]> = {};
  for (const rel of [...found.keys()].sort()) {
    out[`${SOURCE}/${rel}`] = [...found.get(rel)!].sort();
  }
  return out;
}

/** The sections of the system prompt Orbit's brain sends, by heading, in order. */
function promptBlocks(system: string): string[] {
  return [...new Set([...system.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim()))];
}

function identityPrompt(text: string | undefined) {
  // The text too: a harness seeds a run with the prompt the page seeds a conversation with.
  return text !== undefined ? { fingerprint: fingerprint(text), text: text.trim() } : {};
}

function typeOf(spec: Record<string, any>): string {
  // zod writes a nullable field with constraints on it as anyOf rather than a type list.
  const kind = Array.isArray(spec.anyOf)
    ? spec.anyOf.map((branch: Record<string, any>) => typeOf(branch)).join("|")
    : Array.isArray(spec.type)
      ? spec.type.join("|")
      : spec.type || "any";
  const enumerated = spec.enum ? `(${spec.enum.join("|")})` : "";
  const fallback = "default" in spec ? `=${spec.default}` : "";
  return kind + enumerated + fallback;
}

/** Where describe's boots send what they would send to Galaxy and the model: answered here. */
const GALAXY = "http://describe.invalid/";
const LLM = "http://describe.invalid/llm/v1";

const inertPython: Python = {
  run: async () => "",
  write: async () => {},
  read: async () => undefined,
};

interface RequestTool {
  function: { name: string; description: string; parameters: Record<string, any> };
}

/**
 * The first request a launch under `capabilities` sends, read off a boot of Orbit's brain against
 * nothing real, and the tools the brain registered as Galaxy's.
 */
async function surface(flavor: AgentFlavor, capabilities?: Capability[]) {
  const requests: Array<{
    messages: Array<{ role: string; content: unknown }>;
    tools?: RequestTool[];
  }> = [];
  let galaxy: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (request.url.startsWith(LLM)) {
      requests.push(await request.json());
      const done = { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] };
      return new Response(`data: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (request.url.startsWith(GALAXY)) {
      const version = new URL(request.url).pathname.endsWith("/api/version");
      return new Response(JSON.stringify(version ? { version_major: "26.1" } : {}), {
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const session = await Headless.open(
      {
        galaxy_root: GALAXY,
        ai_base_url: LLM,
        ai_model: "describe",
        ai_api_key: "describe",
        ...(capabilities ? { capabilities } : {}),
      },
      { python: inertPython, flavor },
    );
    try {
      await session.turn("hi");
      galaxy = registeredGalaxyTools().map((t) => t.name);
    } finally {
      await session.close();
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  const first = requests[0];
  if (!first) throw new Error("describe: the brain sent the model nothing");
  const system = first.messages.find((m) => m.role === "system")?.content;
  return { tools: first.tools ?? [], system: typeof system === "string" ? system : "", galaxy };
}

async function tools(flavor: AgentFlavor, brand: Brand) {
  // One after the other: a Headless session holds the process.
  const full = await surface(flavor);
  const read = await surface(flavor, ["llm", "read"]);
  const readNames = new Set(read.tools.map((t) => t.function.name));
  // The shell's own tools carry their capability; the brain's are read when a read-only grant
  // still offers them.
  const shell = new Map<string, AgentTool>(
    [pythonTool(brand.name), ...processTools(), ...(flavor.tools?.() ?? [])].map((t) => [
      t.name,
      t,
    ]),
  );
  const extras = new Set(galaxyTools().map((t) => t.name));
  const galaxy = new Set(full.galaxy);
  // Only an operation that declares one has it (galaxy-ops 0.3.1 declares none); the key stays.
  const declared = new Map(
    allOperations.map((op) => [op.name, (op as { result?: unknown }).result ?? null]),
  );
  const out: Record<string, unknown> = {};
  for (const { function: tool } of full.tools) {
    const params = tool.parameters as { properties?: Record<string, any>; required?: string[] };
    const properties = params.properties ?? {};
    const required = new Set(params.required ?? []);
    const names = Object.keys(properties).sort();
    const own = shell.get(tool.name);
    out[tool.name] = {
      capability: own ? (own.capability ?? null) : readNames.has(tool.name) ? "read" : "write",
      runner:
        own || extras.has(tool.name) ? brand.id : galaxy.has(tool.name) ? "galaxy-ops" : "orbit",
      signature: fingerprint(`${tool.description}|${names.join(",")}`),
      params: Object.fromEntries(
        names.map((n) => [n, typeOf(properties[n]) + (required.has(n) ? "!" : "")]),
      ),
      prose: fingerprint(
        [tool.description, ...names.map((n) => `${n}:${properties[n].description ?? ""}`)].join(
          "\n",
        ),
      ),
      result: declared.get(tool.name) ?? null,
    };
  }
  return {
    tools: Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b))),
    system: full.system,
  };
}

/** What an unconfigured request carries, with and without tools, read off the real request. */
async function llmRequest() {
  const { models, model } = await connect(resolve({ ai_base_url: "http://x/v1", ai_model: "m" }));
  const capture = async (tools: unknown[]) => {
    let body: Record<string, unknown> = {};
    const stream = models.streamSimple(
      models.getModel(model.provider as never, model.modelId)!,
      { messages: [{ role: "user", content: "hi", timestamp: 0 }], tools } as never,
      {
        fetch: async () =>
          new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }),
        onPayload: (payload: unknown) => {
          body = payload as Record<string, unknown>;
        },
      } as never,
    );
    await stream.result();
    return body;
  };
  const bare = await capture([]);
  const withTools = await capture([
    { name: "finish", description: "", parameters: { type: "object" } },
  ]);
  return {
    body_keys: Object.keys(bare)
      .filter((k) => k !== "messages")
      .sort(),
    sampling: Object.fromEntries(
      ["max_tokens", "temperature", "tool_choice", "top_p"].map((k) => [k, bare[k] ?? null]),
    ),
    with_tools: { tool_choice: withTools.tool_choice ?? null },
  };
}

function loop() {
  return {
    keep_recent_tokens: DEFAULT_COMPACTION_POLICY.keepRecentTokens,
    max_steps: MAX_TURNS,
    reserve_tokens: DEFAULT_COMPACTION_POLICY.reserveTokens,
    tool_execution: LOOP.toolExecution,
  };
}

/** The follow-up contract every driver shares: the watch hands them over, up to a cap. */
function followUps() {
  return { max_auto_follow_ups: MAX_AUTO_FOLLOW_UPS, settled_by: "watch" };
}

/** Orbit's vendored skills, as the repo pins them: hashed, with the commit they came from. */
function skills(base: string, manifestFile: string) {
  const files = existsSync(base)
    ? Object.fromEntries(
        walk(base)
          .filter((f) => f.endsWith(".md"))
          .sort()
          .map((f) => [
            relative(base, f),
            createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 16),
          ]),
      )
    : {};
  const manifest = existsSync(manifestFile)
    ? (JSON.parse(readFileSync(manifestFile, "utf8")) as {
        repo?: string;
        tag?: string | null;
        commit?: string;
      })
    : {};
  return {
    vendored: Object.keys(files).length > 0,
    files,
    repo: manifest.repo ?? null,
    ref: manifest.tag ?? null,
    sha: manifest.commit ?? null,
  };
}

/** Where each named provider's requests go and which variable holds its key, for a harness
 * that records completions or supplies credentials without resolving them a second way. */
async function providers() {
  return Object.fromEntries(
    await Promise.all(
      PROVIDERS.map(async (p) => [
        p.id,
        { base_url: (await defaultEndpoint(p)) ?? null, auth_env: (await keyVariable(p)) ?? null },
      ]),
    ),
  );
}

/** The surface the agent exposes, as data, for an evaluator that does not read its source. */
export async function describe(layout: DescribeLayout, flavor: AgentFlavor) {
  const brand = flavor.brand ?? DEFAULT_BRAND;
  const sources = agentSources(layout);
  const repo = join(sources[0], "..", "..");
  const offered = await tools(flavor, brand);
  return {
    schema: SCHEMA,
    agent: brand.id,
    identity_prompt: identityPrompt(layout.identityPrompt),
    symbols: symbols(sources),
    prompt_blocks: promptBlocks(offered.system),
    tools: offered.tools,
    // Orbit's brain keeps no inventory of the guards that refuse a call.
    policy: { llm_request: await llmRequest(), loop: loop(), guards: [] as string[] },
    providers: await providers(),
    follow_ups: followUps(),
    skills: skills(
      join(repo, "extensions", "orbit", "vendor", "skills"),
      join(repo, "scripts", "skills.manifest.json"),
    ),
    // The record is a Galaxy page made on its first write; there is no tool to open it.
    record: { starter: "", resume_tool: null },
  };
}
