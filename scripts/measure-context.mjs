#!/usr/bin/env node
// Measure the fixed context Orbit sends on every turn: the assembled system
// prompt plus every tool schema. Boots `bin/orbit.js --mode rpc` against a
// throwaway HOME whose only provider is a local mock Anthropic endpoint,
// captures its /v1/messages requests, and reports what's in a settled one.
//
// Usage:
//   npm run measure:context                 # without and with Galaxy
//   npm run measure:context -- --no-galaxy  # skip the Galaxy run
//   npm run measure:context -- --galaxy-only
//   npm run measure:context -- --json       # machine-readable
//   npm run measure:context -- --save DIR   # also keep the raw request bodies
//
// The session greeting is the first request, and it can go out before
// brc-analytics has listed its tools (the Galaxy tools are in-process and need
// no wait), so the script spawns with ORBIT_FRESH_SESSION=1 (no greeting),
// records every request, and re-prompts until one carries brc-analytics' MCP
// prefix, then analyzes that one.
//
// Token counts are chars/4 estimates -- good for before/after comparisons,
// not for billing. The Galaxy run points the in-process tools at usegalaxy.org
// with a dummy key, so it needs network access but never authenticates.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { allOperations } from "@galaxyproject/galaxy-ops";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TIMEOUT_MS = 120_000;
const MCP_READY_TIMEOUT_MS = 60_000;
const SECTION_MIN_TOKENS = 150;

const MCP_RETRY_MS = 2_000;
const tok = (s) => Math.round(s.length / 4);

// The in-process Galaxy tools' bare names: galaxy-ops' operations plus the
// ones Orbit adds beside them.
const GALAXY_OPS_NAMES = new Set([
  ...allOperations.map((op) => op.name),
  "list_jobs",
  "get_job_logs",
  "galaxy_read_output",
]);

// Buckets are checked in order; first match wins. Empty ones are not printed.
const TOOL_GROUPS = [
  ["pi builtins", (n) => /^(read|write|edit|bash|grep|find|ls)$/.test(n)],
  ["mcp__brc_analytics__*", (n) => n.startsWith("mcp__brc_analytics__")],
  [
    "mcp gateway",
    (n) =>
      /^(mcp|list_mcp_resources|list_mcp_resource_templates|read_mcp_resource|mcpScript)$/.test(
        n,
      ) || n.startsWith("mcp_"),
  ],
  [
    "web + gtn",
    (n) => /^(web_search|fetch_content|get_search_content|source_check|code_search)$|^gtn_/.test(n),
  ],
  ["skills", (n) => n.startsWith("skills_")],
  ["galaxy-ops", (n) => GALAXY_OPS_NAMES.has(n)],
  ["galaxy (loom)", (n) => n.startsWith("galaxy_")],
  ["loom", () => true],
];

export function toolGroup(name) {
  return TOOL_GROUPS.find(([, match]) => match(name))[0];
}

/** The MCP tool prefixes a request must carry before it shows the whole surface. */
export const EXPECTED_PREFIXES = ["mcp__brc_analytics__"];

export function isSettled(req, prefixes) {
  const names = (req.tools ?? []).map((t) => t.name);
  return prefixes.every((p) => names.some((n) => n.startsWith(p)));
}

function captureRequests() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const ev = (type, data) =>
          res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        ev("message_start", {
          message: {
            id: "m1",
            type: "message",
            role: "assistant",
            model: "mock",
            content: [],
            stop_reason: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        });
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } });
        ev("content_block_stop", { index: 0 });
        ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
        ev("message_stop", {});
        res.end();
        if (req.url?.includes("/messages")) server.emit("captured", JSON.parse(body), body);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function measure(run, saveDir) {
  const server = await captureRequests();
  const { port } = server.address();
  const home = mkdtempSync(join(tmpdir(), "loom-measure-"));
  const ws = join(home, "ws");
  mkdirSync(join(home, ".loom"), { recursive: true });
  mkdirSync(ws);

  const config = {
    llm: {
      active: "mock",
      providers: {
        mock: {
          baseUrl: `http://127.0.0.1:${port}`,
          api: "anthropic-messages",
          model: "mock-model",
          apiKey: "x",
        },
      },
    },
  };
  if (run.galaxy) {
    config.galaxy = {
      active: "default",
      profiles: {
        default: { url: "https://usegalaxy.org", apiKey: "0123456789abcdef0123456789abcdef" },
      },
    };
  }
  writeFileSync(join(home, ".loom", "config.json"), JSON.stringify(config, null, 2));

  // Keep the developer's own pi/loom config out of the measurement, and the greeting out of
  // the requests.
  const env = { ...process.env, HOME: home, USERPROFILE: home, ORBIT_FRESH_SESSION: "1" };
  for (const k of ["PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "GALAXY_URL", "GALAXY_API_KEY"])
    delete env[k];
  const prefixes = EXPECTED_PREFIXES;

  const child = spawn(process.execPath, [join(REPO_ROOT, "bin", "orbit.js"), "--mode", "rpc"], {
    cwd: ws,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  child.stdout.resume();
  // EPIPE from a child that already exited; the exit handler below reports that.
  child.stdin.on("error", () => {});
  let prompts = 0;
  let retry;
  // A retry can come due after the run has ended and stdin is closed; writing then would crash
  // the script with EPIPE and hide the real outcome.
  const prompt = () => {
    if (!child.stdin.writable) return;
    child.stdin.write(
      JSON.stringify({ type: "prompt", message: "hello", id: String(++prompts) }) + "\n",
    );
  };

  try {
    const started = Date.now();
    const { req, body, settled } = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out after ${TIMEOUT_MS / 1000}s`)),
        TIMEOUT_MS,
      );
      server.on("captured", (req, body) => {
        const settled = isSettled(req, prefixes);
        if (settled || Date.now() - started >= MCP_READY_TIMEOUT_MS) {
          clearTimeout(timer);
          resolve({ req, body, settled });
        } else {
          clearTimeout(retry);
          retry = setTimeout(prompt, MCP_RETRY_MS);
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`loom exited (${code}) before sending a request`));
      });
      prompt();
    });
    if (!settled)
      process.stderr.write(
        `[measure] ${run.name}: no request carried ${prefixes.join(" and ")} tools; the count may be short\n`,
      );
    if (saveDir) {
      mkdirSync(saveDir, { recursive: true });
      writeFileSync(join(saveDir, `${run.name}.json`), body);
    }
    return { settled, ...analyze(req) };
  } catch (err) {
    err.message += `\n--- loom stderr (tail) ---\n${stderr.split("\n").slice(-15).join("\n")}`;
    throw err;
  } finally {
    clearTimeout(retry);
    child.stdin.end();
    if (child.exitCode === null) {
      const exited = new Promise((r) => child.once("exit", r));
      child.kill();
      await exited;
    }
    server.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
}

// Split on markdown headings, ignoring `#` lines inside code fences (shell
// comments in examples would otherwise read as headings).
function splitSections(text) {
  const parts = [];
  let current = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) inFence = !inFence;
    if (!inFence && /^#{1,3} /.test(line) && current.length) {
      parts.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  parts.push(current.join("\n"));
  return parts;
}

export function analyze(req) {
  const system = Array.isArray(req.system)
    ? req.system.map((b) => b.text).join("\n")
    : (req.system ?? "");
  const tools = req.tools ?? [];

  const sections = splitSections(system)
    .map((p) => ({ heading: p.split("\n")[0].slice(0, 80), tokens: tok(p) }))
    .filter((s) => s.tokens >= SECTION_MIN_TOKENS)
    .sort((a, b) => b.tokens - a.tokens);

  const groups = {};
  const toolSizes = tools.map((t) => ({ name: t.name, tokens: tok(JSON.stringify(t)) }));
  for (const t of toolSizes) {
    const group = toolGroup(t.name);
    groups[group] ??= { count: 0, tokens: 0 };
    groups[group].count++;
    groups[group].tokens += t.tokens;
  }

  const systemTokens = tok(system);
  const toolTokens = tok(JSON.stringify(tools));
  return {
    systemTokens,
    toolCount: tools.length,
    toolTokens,
    totalTokens: systemTokens + toolTokens,
    sections,
    groups,
    tools: toolSizes.sort((a, b) => b.tokens - a.tokens),
  };
}

function print(name, r) {
  const pad = (n) => String(n).padStart(6);
  console.log(
    `\n== ${name}: ~${r.totalTokens} tok  (system ~${r.systemTokens}, ${r.toolCount} tools ~${r.toolTokens})`,
  );
  console.log(`\n  system sections >= ${SECTION_MIN_TOKENS} tok:`);
  for (const s of r.sections) console.log(`  ${pad(s.tokens)}  ${s.heading}`);
  console.log("\n  tools by group:");
  for (const [g, v] of Object.entries(r.groups).sort((a, b) => b[1].tokens - a[1].tokens)) {
    console.log(`  ${pad(v.tokens)}  ${g} (${v.count})`);
  }
  console.log("\n  largest tools:");
  for (const t of r.tools.slice(0, 10)) console.log(`  ${pad(t.tokens)}  ${t.name}`);
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const saveIdx = args.indexOf("--save");
  const saveDir = saveIdx >= 0 ? args[saveIdx + 1] : null;
  const json = flag("--json");
  const runs = [];
  if (!flag("--galaxy-only")) runs.push({ name: "no-galaxy", galaxy: false });
  if (!flag("--no-galaxy")) runs.push({ name: "galaxy", galaxy: true });

  const results = {};
  for (const run of runs) {
    if (!json) process.stderr.write(`[measure] ${run.name}...\n`);
    results[run.name] = await measure(run, saveDir);
  }
  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const [name, r] of Object.entries(results)) print(name, r);
  }
}

// Importable for its tests; runs only as a script.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
