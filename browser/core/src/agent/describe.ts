import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve as absolute } from "node:path";
import * as galaxyOps from "@galaxyproject/galaxy-ops/browser";

import { DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";

import { MAX_AUTO_FOLLOW_UPS } from "./documents";
import { MAX_STEPS } from "./extension";
import { connect, keyVariable } from "./model";
import { starter } from "./notebook";
import { LOOP } from "./runtime";
import { opsTools } from "./ops";
import { defaultEndpoint, PROVIDERS, resolve } from "./providers";
import { GUARDS } from "./tool";
import { agentTools, type AgentFlavor } from "./tools";
import { flavoredSkills } from "./skills";
import { DEFAULT_BRAND, type Brand } from "./brand";

const SCHEMA = 1;
const SOURCE = "src/agent";
const SKIPPED = ["skills/"];

/**
 * Where the flavor's pieces sit on disk. The core finds its own (its sources, prompt, skills
 * corpus and lock) through the flavor's dependency on it, so a flavor names only its own paths.
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

/** The galaxy-ops entry the agent imports, keyed as a module beside the agent's own. */
const GALAXY_OPS = "@galaxyproject/galaxy-ops/browser";

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
  // What the agent links against in galaxy-ops, so a seam can name where moved behaviour lives now.
  out[GALAXY_OPS] = Object.keys(galaxyOps).sort();
  return out;
}

/** The shared modules a prompt module imports, which hold blocks it builds its constants from. */
function sharedPromptModules(prompt: string, text: string): string[] {
  return [...text.matchAll(/^import [^;]*? from "(\.[^"]*\/shared\/[^"]+\.js)";$/gm)]
    .map((m) => absolute(dirname(prompt), m[1]))
    .filter(existsSync);
}

/** The blocks each package's `src/agent/prompt.ts` defines, so a flavor's sections are named too. */
function promptBlocks(sources: string[]): string[] {
  const prompts = sources
    .map((source) => join(source, SOURCE, "prompt.ts"))
    .filter(existsSync)
    .map((prompt) => ({ prompt, text: readFileSync(prompt, "utf8") }));
  const shared = new Set(prompts.flatMap(({ prompt, text }) => sharedPromptModules(prompt, text)));
  const text = [
    ...prompts.map((p) => p.text),
    ...[...shared].map((m) => readFileSync(m, "utf8")),
  ].join("\n");
  const blocks = [...text.matchAll(/^export const ([A-Z][A-Z_0-9]{2,}) = (?:`|\w+\()/gm)].map(
    (m) => m[1],
  );
  // A builder is the flavor's when its prompt module exports it; the shared modules' builders
  // only show through the constants built from them.
  const own = prompts.map((p) => p.text).join("\n");
  const builders = [...own.matchAll(/^export function (\w+Block)\(/gm)].map((m) => m[1]);
  return [...new Set([...blocks, ...builders])].sort();
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

function tools(flavor: AgentFlavor, brand: Brand) {
  const delegated = new Set(opsTools().map((t) => t.name));
  const out: Record<string, unknown> = {};
  for (const tool of agentTools(flavoredSkills(flavor), flavor)) {
    const params = tool.parameters as { properties?: Record<string, any>; required?: string[] };
    const properties = params.properties ?? {};
    const required = new Set(params.required ?? []);
    const names = Object.keys(properties).sort();
    out[tool.name] = {
      capability: tool.capability ?? null,
      runner: delegated.has(tool.name) ? "galaxy-ops" : brand.id,
      signature: fingerprint(`${tool.description}|${names.join(",")}`),
      params: Object.fromEntries(
        names.map((n) => [n, typeOf(properties[n]) + (required.has(n) ? "!" : "")]),
      ),
      prose: fingerprint(
        [tool.description, ...names.map((n) => `${n}:${properties[n].description ?? ""}`)].join(
          "\n",
        ),
      ),
    };
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
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
    max_steps: MAX_STEPS,
    reserve_tokens: DEFAULT_COMPACTION_POLICY.reserveTokens,
    tool_execution: LOOP.toolExecution,
  };
}

/** The follow-up contract every driver shares: the runtime delivers them, up to a cap. */
function followUps() {
  return { max_auto_follow_ups: MAX_AUTO_FOLLOW_UPS, settled_by: "runtime" };
}

function skills(base: string, lockFile: string) {
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
  const lock = JSON.parse(readFileSync(lockFile, "utf8"));
  return {
    vendored: Object.keys(files).length > 0,
    files,
    repo: lock.repo,
    ref: lock.ref,
    sha: lock.sha,
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
  const core = sources[0];
  return {
    schema: SCHEMA,
    agent: brand.id,
    identity_prompt: identityPrompt(layout.identityPrompt),
    symbols: symbols(sources),
    prompt_blocks: promptBlocks(sources),
    tools: tools(flavor, brand),
    policy: { llm_request: await llmRequest(), loop: loop(), guards: [...GUARDS] },
    providers: await providers(),
    follow_ups: followUps(),
    skills: skills(join(core, SOURCE, "skills", "galaxy-skills"), join(core, "skills.lock.json")),
    record: { starter: starter(brand), resume_tool: "notebook_resume" },
  };
}
