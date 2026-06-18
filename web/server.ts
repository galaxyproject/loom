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

import { buildBrainEnv } from "../shared/brain-env.js";
import { evaluateBind, authorizeWsUpgrade } from "./auth.js";
import { isForwardableUiResponse } from "./rpc-guard.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOOM_BIN = resolve(__dirname, "../bin/loom.js");
const LOOM_CONFIG_DIR = join(homedir(), ".loom");
const LOOM_CONFIG_PATH = join(LOOM_CONFIG_DIR, "config.json");
const DEFAULT_CWD = join(LOOM_CONFIG_DIR, "analyses");

const PORT = parseInt(process.env.PORT || "3000", 10);
// Bind loopback by default; the WS is an authenticated-agent surface, so an
// exposed bind requires a token (clients pass ?token=) or an explicit opt-out.
const HOST = process.env.LOOM_WEB_HOST ?? "127.0.0.1";
const WEB_TOKEN = process.env.LOOM_WEB_TOKEN;
const ALLOW_INSECURE = process.env.LOOM_WEB_ALLOW_INSECURE === "1";

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
  const provider = process.env.LOOM_LLM_PROVIDER ?? "anthropic";
  // Mirror the nested masked shape the desktop renderer expects (active +
  // providers / active + profiles) so the first-run welcome overlay stays
  // suppressed and the Galaxy status dot reads "connected" from the env-injected
  // creds. Creds are server-owned: only hasApiKey booleans ever cross to the
  // renderer, never the key values themselves.
  return {
    _mode: "remote",
    executionMode: "cloud",
    galaxy: {
      active: "remote",
      profiles: {
        remote: {
          url: process.env.GALAXY_URL ?? null,
          hasApiKey: Boolean(process.env.GALAXY_API_KEY),
        },
      },
    },
    llm: {
      active: provider,
      providers: {
        [provider]: {
          model: process.env.LOOM_LLM_MODEL ?? null,
          hasApiKey: true,
        },
      },
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
  // Curated env via shared/brain-env. Web mode -- remote or local dev --
  // is env-authenticated by default (remote: operator injects at container
  // launch; local: dev exports keys in their shell), so provider keys are
  // forwarded unconditionally. The helper only forwards named provider
  // keys, so AWS / Git / etc. still drop at this boundary.
  const env: NodeJS.ProcessEnv = buildBrainEnv(process.env, {
    includeProviderKeys: true,
  });
  // Both web modes serve the Orbit renderer, so the brain must treat this as
  // an Orbit shell: skips the CLI-style whats-new/cli-update notices and the
  // detached update-check ping at startup (a network call a restricted-network
  // container shouldn't make).
  env.LOOM_SHELL_KIND = "orbit";

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
    // No local execution surface in the container: the web-mode-gate is the
    // sole tool_call authority, so tell the brain to skip its local-exec guard
    // (whose headless approval prompts would otherwise hang). See
    // extensions/loom/index.ts.
    env.LOOM_LOCAL_EXEC = "off";
    // Deterministic notebook -> Galaxy Page persistence: resume on launch,
    // debounce-push on change, flush on shutdown. Brain-side, env-gated.
    env.LOOM_GALAXY_PAGE_SYNC = "auto";
  } else {
    // The local dev server DOES have a local execution surface, so pin the
    // guard on authoritatively (same as agent.ts and bin/loom.js) -- the
    // helper forwards LOOM_* wholesale, so an ambient LOOM_LOCAL_EXEC=off
    // left in the dev's shell would otherwise silently disable exec-guard.
    env.LOOM_LOCAL_EXEC = "on";
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

/**
 * SIGTERM the brain and wait for it to exit so its session_shutdown hook can
 * flush the notebook to Galaxy. SIGKILL backstop after timeoutMs (kept under
 * the container orchestrator's grace window).
 */
function stopLoomGracefully(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const proc = loomProcess;
    if (!proc) return resolve();
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve();
    }, timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      proc.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
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
const wss = new WebSocketServer({
  server: httpServer,
  path: "/ws",
  verifyClient: (info, done) => {
    const auth = authorizeWsUpgrade(
      { origin: info.origin, host: info.req.headers.host, url: info.req.url },
      WEB_TOKEN,
    );
    if (auth.ok) {
      done(true);
    } else {
      log("rejected WebSocket upgrade:", auth.reason);
      done(false, 401, auth.reason ?? "unauthorized");
    }
  },
});

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
      // The brain trusts its stdin and dispatches by command.type, so only a
      // genuine extension UI response may cross. See isForwardableUiResponse --
      // this is what stops a client smuggling {type:"bash"} past the gate.
      if (isForwardableUiResponse(args[0])) {
        sendToLoom(args[0]);
      } else {
        log("dropped non-ui-response payload on agent:ui-response channel");
      }
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

const bind = evaluateBind(HOST, WEB_TOKEN, ALLOW_INSECURE);
if (!bind.ok) {
  console.error("[server]", bind.error);
  process.exit(1);
}

await setupRenderer();

httpServer.listen(PORT, HOST, () => {
  log(`Orbit Web running at http://${HOST}:${PORT}`);
  log(`Working directory: ${cwd}`);
  if (WEB_TOKEN) log("WebSocket auth: shared token required (?token=)");
  else if (!isLoopbackBind()) log("WebSocket auth: DISABLED (insecure opt-out)");
});

function isLoopbackBind(): boolean {
  return HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";
}

let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("received", signal, "-- draining");
  try {
    wss.close();
    httpServer.close();
  } catch {
    /* */
  }
  await stopLoomGracefully(parseInt(process.env.LOOM_SHUTDOWN_GRACE_MS ?? "8000", 10));
  process.exit(0);
}
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
