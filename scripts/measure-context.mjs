#!/usr/bin/env node
// Measure the fixed context Loom sends on every turn: the assembled system
// prompt plus every tool schema. Boots `bin/loom.js --mode rpc` against a
// throwaway HOME whose only provider is a local mock Anthropic endpoint,
// captures the first /v1/messages request, and reports what's in it.
//
// Usage:
//   npm run measure:context                 # without and with Galaxy
//   npm run measure:context -- --no-galaxy  # skip the Galaxy run
//   npm run measure:context -- --galaxy-only
//   npm run measure:context -- --json       # machine-readable
//   npm run measure:context -- --save DIR   # also keep the raw request bodies
//   LOOM_GALAXY_TOOLS=bare npm run measure:context  # in-process Galaxy tools
//
// The prompt is held until every MCP server reports connected, because the
// adapter only exposes a server's tools once it has listed them -- a cold
// galaxy-mcp start would otherwise race the first request and vanish from it.
// pi counts only the servers that were registered, and under bare that is
// brc-analytics alone (the Galaxy tools are in-process and need no wait), so
// the same check serves both flag values.
//
// Token counts are chars/4 estimates -- good for before/after comparisons,
// not for billing. The Galaxy run registers galaxy-mcp against usegalaxy.org
// with a dummy key, so it needs network access but never authenticates.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { allOperations } from "@galaxyproject/galaxy-ops";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TIMEOUT_MS = 120_000;
const MCP_READY_TIMEOUT_MS = 60_000;
const SECTION_MIN_TOKENS = 150;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const saveIdx = args.indexOf("--save");
const saveDir = saveIdx >= 0 ? args[saveIdx + 1] : null;
const json = flag("--json");

const runs = [];
if (!flag("--galaxy-only")) runs.push({ name: "no-galaxy", galaxy: false });
if (!flag("--no-galaxy")) runs.push({ name: "galaxy", galaxy: true });

const tok = (s) => Math.round(s.length / 4);

// The in-process Galaxy tools' bare names: galaxy-ops' operations plus the
// ones Loom adds beside them.
const GALAXY_OPS_NAMES = new Set([
  ...allOperations.map((op) => op.name),
  "list_jobs",
  "get_job_logs",
  "galaxy_read_output",
]);

// Buckets are checked in order; first match wins. Empty ones are not printed.
const TOOL_GROUPS = [
  ["pi builtins", (n) => /^(read|write|edit|bash|grep|find|ls)$/.test(n)],
  ["mcp gateway", (n) => /^mcp($|_)|^mcpScript$/.test(n)],
  ["brc-analytics", (n) => n.startsWith("brc-analytics_")],
  [
    "web + gtn",
    (n) => /^(web_search|fetch_content|get_search_content|source_check|code_search)$|^gtn_/.test(n),
  ],
  ["skills", (n) => n.startsWith("skills_")],
  ["galaxy-ops", (n) => GALAXY_OPS_NAMES.has(n)],
  ["galaxy-mcp", (n) => n.startsWith("galaxy_")],
  ["loom", () => true],
];

function captureFirstRequest() {
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
        if (req.url?.includes("/messages")) server.emit("captured", body);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function measure(run) {
  const server = await captureFirstRequest();
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

  // Keep the developer's own pi/loom config out of the measurement.
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of ["PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "GALAXY_URL", "GALAXY_API_KEY"])
    delete env[k];

  const child = spawn(process.execPath, [join(REPO_ROOT, "bin", "loom.js"), "--mode", "rpc"], {
    cwd: ws,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));

  let prompted = false;
  let mcpReady = false;
  const sendPrompt = () => {
    if (prompted) return;
    prompted = true;
    child.stdin.write(JSON.stringify({ type: "prompt", message: "hello", id: "1" }) + "\n");
  };
  const mcpTimer = setTimeout(sendPrompt, MCP_READY_TIMEOUT_MS);
  let stdoutBuf = "";
  child.stdout.on("data", (c) => {
    stdoutBuf += c;
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop();
    for (const line of lines) {
      if (!line.includes('"statusKey":"mcp"')) continue;
      const m = /(\d+) servers? enabled \((\d+) connected\)/.exec(line);
      if (m && m[1] === m[2]) {
        mcpReady = true;
        clearTimeout(mcpTimer);
        sendPrompt();
      }
    }
  });

  try {
    const body = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out after ${TIMEOUT_MS / 1000}s`)),
        TIMEOUT_MS,
      );
      server.once("captured", (b) => {
        clearTimeout(timer);
        resolve(b);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`loom exited (${code}) before sending a request`));
      });
    });
    if (!mcpReady)
      process.stderr.write(
        `[measure] ${run.name}: not every MCP server connected; its tools may be missing\n`,
      );
    if (saveDir) {
      mkdirSync(saveDir, { recursive: true });
      writeFileSync(join(saveDir, `${run.name}.json`), body);
    }
    return { mcpReady, ...analyze(JSON.parse(body)) };
  } catch (err) {
    err.message += `\n--- loom stderr (tail) ---\n${stderr.split("\n").slice(-15).join("\n")}`;
    throw err;
  } finally {
    clearTimeout(mcpTimer);
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

function analyze(req) {
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
    const [group] = TOOL_GROUPS.find(([, match]) => match(t.name));
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

const results = {};
for (const run of runs) {
  if (!json) process.stderr.write(`[measure] ${run.name}...\n`);
  results[run.name] = await measure(run);
}

if (json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const [name, r] of Object.entries(results)) print(name, r);
}
