/**
 * Orbit Web -- local dev server.
 *
 * Serves the Orbit renderer via Vite and bridges a WebSocket to a
 * loom subprocess (bin/loom.js --mode rpc). Single user, single
 * subprocess, same ~/.loom/config.json as the CLI and Electron app.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import express from "express";
import { WebSocketServer, WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOOM_BIN = resolve(__dirname, "../bin/loom.js");
const LOOM_CONFIG_DIR = join(homedir(), ".loom");
const LOOM_CONFIG_PATH = join(LOOM_CONFIG_DIR, "config.json");
const DEFAULT_CWD = join(LOOM_CONFIG_DIR, "analyses");

const PORT = parseInt(process.env.PORT || "3000", 10);

const IS_REMOTE_MODE = process.env.LOOM_MODE === "remote";
const REMOTE_SESSION_CWD = "/tmp/loom-session";

function log(...args: unknown[]): void {
  console.log("[server]", ...args);
}

// ── Config helpers ───────────────────────────────────────────────────────────

function loadConfig(): Record<string, unknown> {
  if (existsSync(LOOM_CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(readFileSync(LOOM_CONFIG_PATH, "utf-8"));
      return { ...cfg, _mode: "desktop" };
    } catch {
      /* */
    }
  }
  return { _mode: "desktop" };
}

function saveConfig(config: Record<string, unknown>): void {
  mkdirSync(LOOM_CONFIG_DIR, { recursive: true });
  writeFileSync(LOOM_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

function synthesizedRemoteConfig(): Record<string, unknown> {
  return {
    _mode: "remote",
    executionMode: "cloud",
    galaxy: {
      url: process.env.GALAXY_URL ?? null,
      // apiKey deliberately omitted -- never serialize to renderer
    },
    llm: {
      provider: process.env.LOOM_LLM_PROVIDER ?? "anthropic",
      model: process.env.LOOM_LLM_MODEL ?? null,
    },
  };
}

function getCwd(): string {
  if (IS_REMOTE_MODE) {
    mkdirSync(REMOTE_SESSION_CWD, { recursive: true });
    return REMOTE_SESSION_CWD;
  }
  const cfg = loadConfig();
  let cwd = (cfg.defaultCwd as string) || DEFAULT_CWD;
  if (cwd.startsWith("~")) cwd = join(homedir(), cwd.slice(1));
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

// ── Loom subprocess ──────────────────────────────────────────────────────────

let loomProcess: ChildProcess | null = null;
let activeSocket: WebSocket | null = null;
let cwd = getCwd();

function startLoom(): void {
  if (loomProcess) stopLoom();

  const args: string[] = [LOOM_BIN, "--mode", "rpc"];
  const env: NodeJS.ProcessEnv = { ...process.env };

  if (IS_REMOTE_MODE) {
    const gatePath = resolve(__dirname, "extensions/web-mode-gate.ts");
    args.push("--extension", gatePath);
    if (process.env.LOOM_LLM_PROVIDER) {
      args.push("--provider", process.env.LOOM_LLM_PROVIDER);
    }
    if (process.env.LOOM_LLM_MODEL) {
      args.push("--model", process.env.LOOM_LLM_MODEL);
    }
    env.LOOM_NOTEBOOK_ALLOWLIST = join(cwd, "notebook.md");
  }

  log("starting loom subprocess", { bin: LOOM_BIN, cwd, remote: IS_REMOTE_MODE });

  loomProcess = spawn("node", args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env,
  });

  const rl = createInterface({ input: loomProcess.stdout!, terminal: false });

  rl.on("line", (line) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line);
    } catch {
      return;
    }

    const type = data.type as string;

    // Route extension UI requests
    if (type === "extension_ui_request") {
      sendEvent("agent:ui-request", data);
      return;
    }

    // Everything else is an agent event
    sendEvent("agent:event", data);
  });

  loomProcess.stderr?.on("data", (chunk: Buffer) => {
    log("loom stderr:", chunk.toString().trimEnd());
  });

  loomProcess.on("exit", (code, signal) => {
    log("loom exited", { code, signal });
    loomProcess = null;
    sendEvent("agent:status", "stopped");
  });

  loomProcess.on("error", (err) => {
    log("loom error:", err.message);
    loomProcess = null;
    sendEvent("agent:status", "error", err.message);
  });

  sendEvent("agent:status", "running");
}

function stopLoom(): void {
  if (loomProcess) {
    log("stopping loom");
    loomProcess.removeAllListeners();
    loomProcess.stdout?.removeAllListeners();
    loomProcess.stderr?.removeAllListeners();
    loomProcess.kill("SIGTERM");
    loomProcess = null;
  }
}

function sendToLoom(obj: Record<string, unknown>): void {
  if (!loomProcess?.stdin?.writable) return;
  loomProcess.stdin.write(JSON.stringify(obj) + "\n");
}

function sendEvent(event: string, ...payload: unknown[]): void {
  if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) return;
  activeSocket.send(
    JSON.stringify({
      _event: event,
      _payload: payload.length === 1 ? payload[0] : payload,
    }),
  );
}

// ── Express + WebSocket ──────────────────────────────────────────────────────

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

// Vite dev middleware (serves the renderer with HMR)
async function setupVite(): Promise<void> {
  const { createServer: createViteServer } = await import("vite");
  const rendererRoot = resolve(__dirname, "../app/src/renderer");
  const webDir = resolve(__dirname);
  const vite = await createViteServer({
    root: rendererRoot,
    appType: "custom",
    server: {
      middlewareMode: true,
      hmr: { server: httpServer },
      fs: { allow: [rendererRoot, webDir, resolve(__dirname, "..")] },
    },
    plugins: [(await import("@vitejs/plugin-react")).default()],
    resolve: {
      alias: {
        "../preload/preload.js": resolve(__dirname, "orbit-types.ts"),
        "/orbit-shim.ts": resolve(__dirname, "orbit-shim.ts"),
      },
    },
  });

  app.use(vite.middlewares);

  // Serve index.html with orbit-shim injected before app.ts
  app.get("/", async (req, res, next) => {
    try {
      const indexPath = resolve(rendererRoot, "index.html");
      let html = readFileSync(indexPath, "utf-8");
      html = html.replace(
        '<script type="module" src="./app.ts"></script>',
        '<script type="module" src="/orbit-shim.ts"></script>\n  <script type="module" src="./app.ts"></script>',
      );
      html = await vite.transformIndexHtml(req.originalUrl, html);
      res.status(200).set({ "Content-Type": "text/html" }).end(html);
    } catch (e) {
      next(e);
    }
  });
}

// Handle WebSocket messages from the browser
wss.on("connection", (socket) => {
  log("browser connected");
  activeSocket = socket;

  if (!loomProcess) startLoom();

  socket.on("message", (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const id = msg.id as string | undefined;
    const channel = msg.channel as string;
    const args = (msg.args as unknown[]) || [];

    // Channels that the server handles directly (not forwarded to loom)
    if (channel === "config:get") {
      respond(id, IS_REMOTE_MODE ? synthesizedRemoteConfig() : loadConfig());
      return;
    }
    if (channel === "config:save") {
      if (IS_REMOTE_MODE) {
        respond(id, { success: false, error: "config is read-only in remote mode" });
        return;
      }
      saveConfig(args[0] as Record<string, unknown>);
      stopLoom();
      startLoom();
      respond(id, { success: true });
      return;
    }
    if (channel === "agent:get-cwd") {
      respond(id, cwd);
      return;
    }
    if (channel === "agent:set-cwd") {
      if (IS_REMOTE_MODE) {
        respond(id, { error: "cwd is fixed in remote mode" });
        return;
      }
      cwd = args[0] as string;
      mkdirSync(cwd, { recursive: true });
      stopLoom();
      startLoom();
      sendEvent("agent:cwd-changed", cwd);
      respond(id, cwd);
      return;
    }
    if (channel === "agent:restart") {
      stopLoom();
      startLoom();
      respond(id, null);
      return;
    }
    if (channel === "agent:reset-session") {
      stopLoom();
      // Fresh start — tell loom not to auto-load notebook
      const origEnv = process.env.LOOM_FRESH_SESSION;
      process.env.LOOM_FRESH_SESSION = "1";
      startLoom();
      if (origEnv === undefined) delete process.env.LOOM_FRESH_SESSION;
      else process.env.LOOM_FRESH_SESSION = origEnv;
      respond(id, null);
      return;
    }
    if (channel === "agent:new-session") {
      sendToLoom({ type: "new_session", id });
      return;
    }
    if (channel === "agent:get-state") {
      sendToLoom({ type: "get_state", id });
      return;
    }

    // Everything else forwards to loom subprocess
    if (channel === "agent:prompt") {
      sendToLoom({ type: "prompt", message: args[0] });
      if (id) respond(id, null);
      return;
    }
    if (channel === "agent:abort") {
      sendToLoom({ type: "abort" });
      if (id) respond(id, null);
      return;
    }
    if (channel === "agent:ui-response") {
      sendToLoom(args[0] as Record<string, unknown>);
      return;
    }

    log("unhandled channel:", channel);
    if (id) respond(id, null);
  });

  socket.on("close", () => {
    log("browser disconnected");
    activeSocket = null;
  });

  function respond(id: string | undefined, result: unknown): void {
    if (!id) return;
    socket.send(JSON.stringify({ _response: true, _id: id, _result: result }));
  }
});

async function setupRenderer(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    const distDir = resolve(__dirname, "dist");
    log("serving static renderer from", distDir);
    app.use(express.static(distDir));
    app.get("/", (_req, res) => res.sendFile(resolve(distDir, "index.html")));
    return;
  }
  await setupVite();
}

// ── Start ────────────────────────────────────────────────────────────────────

await setupRenderer();

httpServer.listen(PORT, () => {
  log(`Orbit Web running at http://localhost:${PORT}`);
  log(`Working directory: ${cwd}`);
});
