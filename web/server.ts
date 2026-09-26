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
import { join, resolve, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import express from "express";
import { WebSocketServer, WebSocket } from "ws";

import { buildBrainEnv } from "../shared/brain-env.js";
import { summarizeStartupFailure, appendStderr } from "../shared/brain-exit.js";
import { encodeEventPayload } from "./event-payload.js";
import { evaluateBind, authorizeWsUpgrade } from "./auth.js";
import { isForwardableUiResponse } from "./rpc-guard.js";
import { ACTIVE_LLM_API_KEY_ENV, isCustomProvider } from "../shared/custom-provider.js";
import { hasProviderKey, llmKeyEnvVar } from "./llm-key-routing.js";
import { resolveShutdownGraceMs } from "./shutdown-grace.js";
import { DASHBOARD_FILENAME, DASHBOARD_MAX_BYTES } from "../shared/dashboard-contract.js";
import { casWriteLayoutFile, readLayoutFile } from "../shared/dashboard-layout-store.js";
import { listFilesForWeb, readFileForWeb, readNotebookForWeb } from "./files-surface.js";
import {
  DESKTOP_SHELL_KIND,
  envNames,
  mirrorToLegacyEnv,
  readEnv,
  writeEnv,
} from "../shared/orbit-env.js";
import { resolveConfigPath, resolveDefaultAnalysesDir } from "../shared/state-dir.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// In dev this file runs from web/; the container bundles it to web/build/ and
// runs that. Anchor all repo-relative asset paths (the brain binary, the gate
// extension, the built renderer) at the web dir so they resolve either way --
// otherwise the bundled server looks one level too deep (web/build/...) and
// the brain, the lockdown gate, and the static bundle all silently go missing.
const WEB_ROOT = basename(__dirname) === "build" ? resolve(__dirname, "..") : __dirname;
const LOOM_BIN = resolve(WEB_ROOT, "../bin/loom.js");

// A container may be handed only ORBIT_ACTIVE_LLM_API_KEY; the BYO-key check
// and pi both look up the LOOM_ name, so give it one before anything reads it.
mirrorToLegacyEnv(process.env, "ACTIVE_LLM_API_KEY");

const PORT = parseInt(process.env.PORT || "3000", 10);
// Bind loopback by default; the WS is an authenticated-agent surface, so an
// exposed bind requires a token (clients pass ?token=) or an explicit opt-out.
const HOST = readEnv("WEB_HOST") ?? "127.0.0.1";
const WEB_TOKEN = readEnv("WEB_TOKEN");
const ALLOW_INSECURE = readEnv("WEB_ALLOW_INSECURE") === "1";

// Fail closed on a conflict: the image pins remote, and an inherited twin
// saying anything else must not reopen the local surfaces.
const IS_REMOTE_MODE = envNames("MODE").some(
  (n) => process.env[n]?.trim().toLowerCase() === "remote",
);
const REMOTE_SESSION_CWD = "/tmp/loom-session";

function log(...args: unknown[]): void {
  console.log("[server]", ...args);
}

// ── Config helpers ───────────────────────────────────────────────────────────

function loadConfig(): Record<string, unknown> {
  const configPath = resolveConfigPath();
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      return { ...cfg, _mode: "desktop" };
    } catch {
      /* */
    }
  }
  return { _mode: "desktop" };
}

function saveConfig(config: Record<string, unknown>): void {
  const configPath = resolveConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

function synthesizedRemoteConfig(): Record<string, unknown> {
  const provider = activeProvider();
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
          model: readEnv("LLM_MODEL") ?? null,
          hasApiKey: llmKeyPresent(),
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
  let cwd = (cfg.defaultCwd as string) || resolveDefaultAnalysesDir();
  if (cwd.startsWith("~")) cwd = join(homedir(), cwd.slice(1));
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

// ── Loom subprocess ──────────────────────────────────────────────────────────

let loomProcess: ChildProcess | null = null;
let activeSocket: WebSocket | null = null;
let cwd = getCwd();

// BYO-key: a provider key supplied by the user at runtime (held in memory for
// the process lifetime only -- never persisted, logged, or sent to the renderer).
let providedLlmKey: string | null = null;
let providedProvider: string | null = null;

function activeProvider(): string {
  if (providedProvider) return providedProvider;
  const envProvider = readEnv("LLM_PROVIDER");
  if (envProvider) return envProvider;
  // Fall back to the container's own config.json, which is what the brain reads.
  // A custom-endpoint image (gxit/README.md) names its provider only there, so
  // defaulting straight to "anthropic" made the server disagree with the brain
  // about which provider is even active.
  const active = (loadConfig().llm as { active?: unknown } | undefined)?.active;
  if (typeof active === "string" && active.length > 0) return active;
  return "anthropic";
}

/**
 * Does the container's config.json describe this provider as an OpenAI-compatible
 * custom endpoint? That baseUrl is what makes the brain authenticate the provider
 * from LOOM_ACTIVE_LLM_API_KEY instead of a named var, so it's also what decides
 * where a key may go -- guessing from the provider's name instead would either
 * strand a configured container behind the BYO overlay or let a stale key vouch
 * for a provider that can't use it.
 */
function isCustomProviderName(provider: string): boolean {
  const providers = (loadConfig().llm as { providers?: Record<string, unknown> } | undefined)
    ?.providers;
  return isCustomProvider(providers?.[provider] as never);
}

function llmKeyPresent(): boolean {
  const provider = activeProvider();
  return hasProviderKey({
    env: process.env,
    provider,
    providedKey: providedLlmKey,
    isCustom: isCustomProviderName(provider),
  });
}

function startLoom(opts: { fresh?: boolean } = {}): void {
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
  writeEnv(env, "SHELL_KIND", DESKTOP_SHELL_KIND);
  if (opts.fresh) writeEnv(env, "FRESH_SESSION", "1");

  if (IS_REMOTE_MODE) {
    const gatePath = resolve(WEB_ROOT, "extensions/web-mode-gate.ts");
    args.push("--extension", gatePath);
    const prov = activeProvider();
    if (providedProvider || readEnv("LLM_PROVIDER")) {
      args.push("--provider", prov);
    }
    const envModel = readEnv("LLM_MODEL");
    if (envModel) {
      args.push("--model", envModel);
    }
    // BYO-key: inject the user-supplied key into the brain's env (env var name
    // per the active provider; custom endpoints go to LOOM_ACTIVE_LLM_API_KEY).
    // Never logged. The provide-llm-key handler rejects keys it can't route, so
    // by here a non-null var is expected -- but don't spawn a brain that silently
    // drops the credential if that ever stops being true.
    if (providedLlmKey) {
      const keyVar = llmKeyEnvVar(prov, { isCustom: isCustomProviderName(prov) });
      // Both spellings, so a stale ambient ORBIT_ twin can't outrank the user's key.
      if (keyVar === ACTIVE_LLM_API_KEY_ENV) writeEnv(env, "ACTIVE_LLM_API_KEY", providedLlmKey);
      else if (keyVar) env[keyVar] = providedLlmKey;
      else log("refusing to inject a key for unroutable provider:", prov);
    }
    writeEnv(env, "NOTEBOOK_ALLOWLIST", join(cwd, "notebook.md"));
    // No local execution surface in the container: the web-mode-gate is the
    // sole tool_call authority, so tell the brain to skip its local-exec guard
    // (whose headless approval prompts would otherwise hang). See
    // extensions/loom/index.ts.
    writeEnv(env, "LOCAL_EXEC", "off");
    // Deterministic notebook -> Galaxy Page persistence: resume on launch,
    // debounce-push on change, flush on shutdown. Brain-side, env-gated.
    writeEnv(env, "GALAXY_PAGE_SYNC", "auto");
  } else {
    // The local dev server DOES have a local execution surface, so pin the
    // guard on authoritatively (same as agent.ts and bin/loom.js) -- the
    // helper forwards LOOM_* wholesale, so an ambient LOOM_LOCAL_EXEC=off
    // left in the dev's shell would otherwise silently disable exec-guard.
    writeEnv(env, "LOCAL_EXEC", "on");
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

  // Kept, not just logged: when the brain dies during startup its stderr is the
  // only account of why, and the browser has no terminal to read it in (#439).
  let stderr = "";
  loomProcess.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderr = appendStderr(stderr, text);
    log("loom stderr:", text.trimEnd());
  });

  loomProcess.on("exit", (code, signal) => {
    log("loom exited", { code, signal });
    loomProcess = null;
    // A nonzero exit used to report a bare "stopped", which is indistinguishable
    // from someone closing the session deliberately.
    if (code !== 0 && code !== null) {
      const { summary, detail } = summarizeStartupFailure(code, stderr);
      // Chat first: the renderer's error handler resets the badge to a bare
      // "error", so the summary has to be the later of the two writes.
      sendEvent("agent:event", { type: "error", message: detail });
      sendEvent("agent:status", "error", summary);
      return;
    }
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

// A restart/reset now drains the outgoing brain before spawning its replacement,
// which opens a window where loomProcess is a brain under SIGTERM. Writing to it
// would look like it worked -- the pipe is still writable -- and the message would
// die with the process, leaving the UI waiting on a turn nobody is running. Hold
// messages instead and hand them to the replacement once it's up.
let draining = false;
const drainQueue: Record<string, unknown>[] = [];

function sendToLoom(obj: Record<string, unknown>): void {
  if (draining) {
    drainQueue.push(obj);
    return;
  }
  if (!loomProcess?.stdin?.writable) return;
  loomProcess.stdin.write(JSON.stringify(obj) + "\n");
}

function flushDrainQueue(): void {
  const queued = drainQueue.splice(0, drainQueue.length);
  for (const obj of queued) sendToLoom(obj);
}

/**
 * Run a brain swap with nothing else swapping underneath it. Two restarts landing
 * together used to await the same dying process and then both spawn, so the
 * second startLoom would SIGKILL the first replacement through the non-graceful
 * path -- and a reset racing a restart could lose its fresh-session semantics
 * entirely.
 */
let swapChain: Promise<void> = Promise.resolve();
function serializeSwap(fn: () => Promise<void>): Promise<void> {
  const next = swapChain.then(fn, fn);
  // Keep the chain alive regardless of outcome; errors surface via the handler.
  swapChain = next.catch(() => {});
  return next;
}

/** Drain the current brain, then spawn its replacement (startLoom by default). */
async function respawnBrain(spawnReplacement: () => void = startLoom): Promise<void> {
  draining = true;
  try {
    await stopLoomGracefully(resolveShutdownGraceMs(process.env));
    spawnReplacement();
  } finally {
    draining = false;
  }
  flushDrainQueue();
}

function sendEvent(event: string, ...payload: unknown[]): void {
  if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) return;
  activeSocket.send(
    JSON.stringify({
      _event: event,
      _payload: encodeEventPayload(payload),
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
      // Remote mode with no token (the GxIT shape: gx-it-proxy is the trust
      // boundary, and a Galaxy-issued entry-point URL can't carry a token) has
      // no other check left, so demand the Origin browsers always send. Local
      // dev and token deployments keep accepting non-browser clients.
      { requireOrigin: IS_REMOTE_MODE && !WEB_TOKEN },
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

  // In remote mode with no resolvable provider key, hold off spawning: the
  // renderer's key-entry screen drives agent:provide-llm-key, which spawns.
  // Non-remote (desktop/dev) is unchanged -- the brain reads its own
  // ~/.loom/config.json key, which never reaches this env-only check.
  if (!loomProcess && (!IS_REMOTE_MODE || llmKeyPresent())) startLoom();

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
      // Preferences sends only the keys it edits. Replacing the file would drop
      // everything else -- including an explicit experiments.autoResume:false,
      // which then silently reverts to on. Merge like Orbit's config:save does.
      const { _mode: _ignored, ...current } = loadConfig();
      saveConfig({ ...current, ...(args[0] as Record<string, unknown>) });
      stopLoom();
      startLoom();
      respond(id, { success: true });
      return;
    }
    if (channel === "agent:provide-llm-key") {
      const payload = (args[0] ?? {}) as { provider?: unknown; key?: unknown };
      if (typeof payload.key !== "string" || payload.key.length === 0) {
        respond(id, { ok: false, error: "missing provider key" });
        return;
      }
      const provider =
        typeof payload.provider === "string" && payload.provider.length > 0
          ? payload.provider
          : activeProvider();
      // Refuse a key we have nowhere to put. The overlay offers
      // "openai-compatible", but a custom endpoint also needs a baseUrl, and
      // remote mode's config is read-only -- so unless this image was built with
      // that provider in its config.json, there's no endpoint to talk to. Saying
      // so beats accepting the key, reporting success, and leaving the user with
      // an agent that can't authenticate and no way back to this prompt.
      if (!llmKeyEnvVar(provider, { isCustom: isCustomProviderName(provider) })) {
        respond(id, {
          ok: false,
          error: `Can't use a key for "${provider}" here: this deployment has no endpoint configured for it. Pick a built-in provider, or ask your admin to bake the endpoint into the image.`,
        });
        return;
      }
      providedLlmKey = payload.key; // never logged
      providedProvider = provider;
      if (!loomProcess) startLoom();
      respond(id, { ok: true });
      return;
    }
    if (channel === "agent:get-cwd") {
      respond(id, cwd);
      return;
    }
    // notebook.md is in the session cwd and the server already owns that path.
    // Without this the web shell shows an empty Notebook tab -- and an empty
    // dashboard -- until the brain happens to push a widget mid-turn, even
    // though the file is right there. Same response shape as the Electron
    // handler so the renderer cannot tell the two apart.
    if (channel === "notebook:load") {
      // Through the same jail the file surface uses: the filename is fixed, but
      // the name itself can be a symlink and following one handed the browser
      // whatever it pointed at. Still answered in remote mode -- notebook.md is
      // the one file that mode is built around; see readNotebookForWeb.
      const notebookPath = join(cwd, "notebook.md");
      void readNotebookForWeb(cwd, { remote: IS_REMOTE_MODE }).then(
        (res) =>
          respond(
            id,
            res.ok
              ? { ok: true, content: res.content, path: res.path }
              : { ok: false, content: null, path: notebookPath },
          ),
        () => respond(id, { ok: false, content: null, path: notebookPath }),
      );
      return;
    }
    // Dashboard layout: one fixed filename in the session cwd, alongside
    // notebook.md. Allowed in remote mode -- it is pane layout, not config, and
    // the renderer is the only thing that reads it. No path argument, so there
    // is nothing to traverse with.
    if (channel === "dashboard:load") {
      void readLayoutFile(join(cwd, DASHBOARD_FILENAME), DASHBOARD_MAX_BYTES).then(
        (result) => respond(id, result),
        (err) =>
          respond(id, { ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
      return;
    }
    if (channel === "dashboard:save") {
      const baseRevision = args.length > 1 ? (args[1] as string | null) : undefined;
      void casWriteLayoutFile(
        join(cwd, DASHBOARD_FILENAME),
        args[0] as string,
        baseRevision,
        DASHBOARD_MAX_BYTES,
      ).then(
        (result) => respond(id, result),
        (err) =>
          respond(id, { ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
      return;
    }
    // The read-only file surface. The desktop answers these from the main
    // process; here they are a network surface onto the analysis directory, so
    // the jail lives in files-surface.ts and is tested on its own. It is
    // anchored on the same `cwd` the brain is spawned in, which `agent:set-cwd`
    // moves -- so the surface is exactly as wide as the directory this session
    // is pointed at, and no wider.
    if (channel === "files:list") {
      void listFilesForWeb(cwd, { remote: IS_REMOTE_MODE }).then(
        (result) => respond(id, result),
        // Neither of these should reject, but a channel that answers nothing
        // leaves the caller's promise pending for the life of the socket.
        () => respond(id, { ok: false, error: "the files could not be listed" }),
      );
      return;
    }
    if (channel === "files:read") {
      const opts = (args[1] ?? undefined) as { tail?: boolean } | undefined;
      void readFileForWeb(cwd, args[0], opts, { remote: IS_REMOTE_MODE }).then(
        (result) => respond(id, result),
        () => respond(id, { ok: false, error: "the file could not be read" }),
      );
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
    // Restart/reset drain the old brain before spawning the new one. A bare
    // SIGTERM-and-respawn let the outgoing brain's shutdown-hook page push
    // overlap the incoming brain's resume/push: the new brain could resume a
    // page the old one hadn't finished writing, or the two pushes could land
    // last-writer-wins. Draining first makes the handoff ordered.
    if (channel === "agent:restart") {
      void serializeSwap(async () => {
        await respawnBrain();
        respond(id, null);
      });
      return;
    }
    if (channel === "agent:reset-session") {
      void serializeSwap(async () => {
        // Fresh start -- tell loom not to auto-load notebook.
        await respawnBrain(() => startLoom({ fresh: true }));
        respond(id, null);
      });
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
    const distDir = resolve(WEB_ROOT, "dist");
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
  await stopLoomGracefully(resolveShutdownGraceMs(process.env));
  process.exit(0);
}
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
