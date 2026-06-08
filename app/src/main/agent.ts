import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { app, type BrowserWindow } from "electron";
import { loadConfig } from "./config.js";
import { resolveLlmApiKey, resolveGalaxyApiKey } from "./secure-config.js";
import { loadSessionHistory, newestSessionFile } from "./session-replay.js";
import { collectDescendantsOf } from "./proc-monitor.js";
import { TurnWatchdog } from "./turn-watchdog.js";
import { formatWindowTitle } from "./window-title.js";

/**
 * How long the brain may stay completely silent mid-turn before Orbit treats the
 * turn as stalled and recovers the UI (#185). Generous on purpose: tool runs and
 * UI modals are excluded by the watchdog, so the only window this guards is
 * "waiting on the model", where multi-minute silence is unambiguously a failure.
 */
export const TURN_SILENCE_TIMEOUT_MS = 120_000;

const PROVIDER_ENV_MAP: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  xai: "XAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

/** Providers that authenticate via OAuth (~/.pi/agent/auth.json), not env vars. */
const OAUTH_PROVIDERS: ReadonlySet<string> = new Set(["openai-codex"]);

/** Build the secret env vars injected into the brain subprocess. */
function buildSecretEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const cfg = loadConfig();

  const provider = cfg.llm?.active || "anthropic";
  const isCustom = Boolean(cfg.llm?.providers?.[provider]?.baseUrl);
  // OAuth providers ignore env-var keys -- the brain reads ~/.pi/agent/auth.json.
  // If the user switched away from an API-key provider the old key is still in
  // config.json (preserved on purpose so they can switch back); don't leak it
  // into the env under a misrouted variable name.
  if (!OAUTH_PROVIDERS.has(provider)) {
    // Custom OpenAI-compatible endpoints route through pi's --api-key via
    // LOOM_ACTIVE_LLM_API_KEY; built-in providers use their own env var.
    const targetVar = isCustom
      ? "LOOM_ACTIVE_LLM_API_KEY"
      : PROVIDER_ENV_MAP[provider] || "AI_GATEWAY_API_KEY";
    // Config key wins; otherwise fall back to a key exported into Orbit's own
    // env (`export ANTHROPIC_API_KEY=...; npm start`). In dev with safeStorage
    // off this is the only key path; in prod it's a handy CI/power-user override.
    const llmKey = resolveLlmApiKey(cfg) ?? process.env[targetVar];
    if (llmKey) env[targetVar] = llmKey;
  }

  // Galaxy key: config wins, else an exported GALAXY_API_KEY.
  const galaxyKey = resolveGalaxyApiKey(cfg) ?? process.env.GALAXY_API_KEY;
  if (galaxyKey) {
    env.GALAXY_API_KEY = galaxyKey;
  }

  return env;
}

// Resolve the loom entry point. In dev (`electron-forge start`), Loom lives at
// the repo root next to app/. In packaged builds, the prePackage hook stages
// Loom into Resources/loom/ via electron-packager's extraResource so the brain
// runs out of an installed bundle, not a path that walks up out of the .app.
// `app` is undefined when this module is imported outside an Electron runtime
// (e.g. vitest), so optional-chain through `app.isPackaged` to fall back to dev.
function resolveLoomBin(): string {
  if (app?.isPackaged) {
    return path.join(process.resourcesPath, "loom", "bin", "loom.js");
  }
  return path.resolve(__dirname, "../../../bin/loom.js");
}

// Resolve the Node binary the brain runs under. Dev assumes Node 20+ on PATH.
// Packaged Orbit ships its own Node next to Loom (Resources/node/) so users
// don't need to have Node installed; this also keeps native module ABI in sync
// with whatever Node ran `npm ci` during prePackage staging.
function resolveNodeBin(): string {
  if (app?.isPackaged) {
    const nodeName = process.platform === "win32" ? "node.exe" : path.join("bin", "node");
    return path.join(process.resourcesPath, "node", nodeName);
  }
  return "node";
}

// Bundled uv directory (contains uv + uvx). When packaged, prepend this to
// the brain's PATH so `command: "uvx"` in mcp.json resolves the shipped
// binary rather than depending on the user's system uv install.
function resolveUvDir(): string | null {
  if (app?.isPackaged) {
    return path.join(process.resourcesPath, "uv");
  }
  return null;
}

const LOOM_BIN = resolveLoomBin();
const NODE_BIN = resolveNodeBin();
const UV_DIR = resolveUvDir();

export type AgentStatus = "running" | "stopped" | "error";

interface PendingResponse {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
}

function log(...args: unknown[]): void {
  console.log("[agent]", ...args);
}

/**
 * Variables explicitly forwarded from Orbit's launch env to the brain
 * subprocess. Forwarding `process.env` wholesale would leak unrelated
 * secrets (AWS_*, GITHUB_TOKEN, GOOGLE_APPLICATION_CREDENTIALS, etc.)
 * to every spawned MCP subprocess too; the brain only needs the small
 * set below plus its own LOOM_ / GALAXY_ / PI_ prefix vars (forwarded
 * by prefix in buildBrainEnv).
 */
const BRAIN_ENV_PASSTHROUGH = new Set<string>([
  // Process basics
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TERM",
  "PWD",
  // Locale
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  // Display (rarely needed by the brain itself but tools spawned by
  // the brain — e.g. matplotlib via the bash tool — sometimes need it)
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  // Node
  "NODE_OPTIONS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  // Conda / mamba (per-analysis env activation in tools)
  "CONDA_EXE",
  "CONDA_PREFIX",
  "CONDA_DEFAULT_ENV",
  "MAMBA_EXE",
  "MAMBA_ROOT_PREFIX",
  // CA bundles (corporate proxies)
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
]);

function buildBrainEnv(fresh: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of BRAIN_ENV_PASSTHROUGH) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  // Forward any LOOM_*/GALAXY_*/PI_* vars by prefix — these are the brain's
  // own knobs (provider keys, MCP config dir, feature flags).
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith("LOOM_") || k.startsWith("GALAXY_") || k.startsWith("PI_")) {
      env[k] = v;
    }
  }
  // Set the shell-kind marker the extension reads, plus the optional
  // fresh-session sentinel for /new flows.
  env.LOOM_SHELL_KIND = "orbit";
  if (fresh) env.LOOM_FRESH_SESSION = "1";
  // Prepend the bundled uv directory to PATH when packaged so MCP servers
  // configured with `command: "uvx"` (Galaxy MCP) find the shipped binary.
  if (UV_DIR) {
    const sep = process.platform === "win32" ? ";" : ":";
    env.PATH = `${UV_DIR}${sep}${env.PATH ?? ""}`;
  }
  return env;
}

export class AgentManager {
  private process: ChildProcess | null = null;
  private window: BrowserWindow;
  private status: AgentStatus = "stopped";
  private statusMessage: string | undefined;
  // `status` only tracks process aliveness; `turnActive` tracks whether the
  // brain is mid-response. Toggled by parsing agent_start / agent_end events
  // on stdout so the renderer can re-sync after a reload (display-sleep
  // recovery) without conflating process-running with turn-running.
  private turnActive = false;
  private stderr = "";
  private pendingResponses = new Map<string, PendingResponse>();
  private idCounter = 0;
  private cwd: string;
  private hasStartedBefore = false; // → use --continue on restart to preserve chat history
  private nextStartSkipContinue = false; // → restart in a new cwd without resuming old chat
  private nextStartIsFresh = false; // → tells extension to skip notebook auto-load on next start
  // --continue: pinned eagerly to newestSessionFile(cwd) -- pi's own picker
  // will resume the same file under normal use.
  // fresh start: pinned null; start() unlinks any stale cwd/session.jsonl
  // before spawn, and getReplaySessionFile lazily adopts the new link the
  // brain creates in session_start. Avoids racing the old child's post-
  // SIGTERM session_shutdown writes (which only append to the *old* .jsonl,
  // not the symlink).
  private pinnedSessionFile: string | null = null;
  private mcpBootstrapRestartDone = false; // → guard: only auto-restart once per app lifetime
  private silentRestarting = false; // → suppresses status flicker during MCP bootstrap restart

  /**
   * Crash-restart bookkeeping. We allow up to MAX_RESTARTS_PER_WINDOW
   * silent retries inside RESTART_WINDOW_MS — anything past that is a
   * persistent failure and we surface it to the user via chat error +
   * sticky status badge.
   */
  private crashRestartTimes: number[] = [];
  private static readonly MAX_RESTARTS_PER_WINDOW = 3;
  private static readonly RESTART_WINDOW_MS = 60_000;

  // Breaks the "stuck on thinking" hang (#185): fires when a turn goes silent
  // long enough that the provider call must have failed or stalled.
  private readonly watchdog: TurnWatchdog;

  constructor(window: BrowserWindow, cwd: string) {
    this.window = window;
    this.cwd = cwd;
    this.watchdog = new TurnWatchdog({
      timeoutMs: TURN_SILENCE_TIMEOUT_MS,
      onTimeout: () => this.handleTurnStalled(),
    });
    this.refreshWindowTitle();
  }

  /**
   * Reflect the active analysis directory in the window title so the context
   * is glanceable across multiple open project windows (#190). Main owns the
   * title; see createWindow() where page-title-updated is suppressed.
   */
  private refreshWindowTitle(): void {
    if (this.window.isDestroyed()) return;
    this.window.setTitle(formatWindowTitle(this.cwd, os.homedir()));
  }

  /** Reset session continuity (e.g. when switching to a new analysis directory). */
  resetSession(): void {
    this.hasStartedBefore = false;
    this.nextStartSkipContinue = false;
    this.nextStartIsFresh = true;
  }

  setCwd(cwd: string): void {
    if (cwd !== this.cwd) {
      // New analysis directory → fresh session, no --continue
      this.hasStartedBefore = false;
    }
    this.cwd = cwd;
    this.refreshWindowTitle();
    log("cwd set to", cwd);
  }

  switchCwd(cwd: string): boolean {
    if (cwd === this.cwd) return false;
    this.cwd = cwd;
    this.refreshWindowTitle();
    this.hasStartedBefore = false;
    // Don't force-skip --continue: let start()'s hasExistingSession() check
    // decide. If the target cwd has a Pi session on disk, we want to resume
    // it (history replay, prompt numbering preserved). Use /new afterwards
    // to start fresh in an existing dir.
    this.nextStartSkipContinue = false;
    this.nextStartIsFresh = false;
    log("switching cwd to", cwd);
    if (this.process) {
      this.stop();
      this.start();
    }
    return true;
  }

  getCwd(): string {
    return this.cwd;
  }

  getPid(): number | null {
    return this.process?.pid ?? null;
  }

  /**
   * The session file /chat should replay. Returns the pinned file when set
   * (--continue path), otherwise lazily adopts via cwd/session.jsonl -- the
   * symlink Loom's session-lifecycle creates on session_start. Returns null
   * if neither applies; /chat then sends an empty history rather than
   * surfacing a stale prior-run session.
   */
  getReplaySessionFile(): string | null {
    if (this.pinnedSessionFile) return this.pinnedSessionFile;
    const linkPath = path.join(this.cwd, "session.jsonl");
    try {
      const stat = fs.lstatSync(linkPath);
      if (!stat.isSymbolicLink()) return null;
      const target = fs.readlinkSync(linkPath);
      const absTarget = path.isAbsolute(target) ? target : path.join(this.cwd, target);
      if (!fs.existsSync(absTarget)) return null;
      this.pinnedSessionFile = absTarget;
      return absTarget;
    } catch {
      return null;
    }
  }

  /**
   * Check if Pi.dev has any saved sessions for the current cwd.
   * Pi stores sessions in ~/.pi/agent/sessions/<encoded-cwd>/ as .jsonl files.
   * Used on first launch to decide whether to pass --continue for a soft resume.
   */
  private hasExistingSession(): boolean {
    try {
      // Match pi-coding-agent's encoding (session-manager.js:213): strip leading
      // slash, then replace remaining separators with `-`.
      const encoded = `--${this.cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
      const sessionsDir = path.join(os.homedir(), ".pi", "agent", "sessions", encoded);
      if (!fs.existsSync(sessionsDir)) return false;
      const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
      return files.length > 0;
    } catch {
      return false;
    }
  }

  start(): void {
    if (this.process) this.stop();
    this.stderr = "";

    // Pass --continue to resume the previous session and preserve chat history:
    // - Always on restart within the same app run (model switch, prefs save)
    // - On first launch (!hasStartedBefore), only if a Pi session exists for this cwd
    // Fresh /new sessions bypass this (nextStartIsFresh → no --continue).
    const wantsContinue =
      !this.nextStartSkipContinue &&
      !this.nextStartIsFresh &&
      (this.hasStartedBefore || this.hasExistingSession());
    const args = [LOOM_BIN, "--mode", "rpc"];
    if (wantsContinue) {
      args.push("--continue");
    }
    this.hasStartedBefore = true;
    this.nextStartSkipContinue = false;

    // Pin matches pi's --continue choice in normal use. Cleared in stop().
    this.pinnedSessionFile = wantsContinue ? newestSessionFile(this.cwd) : null;
    if (!wantsContinue) {
      // Drop any stale cwd/session.jsonl symlink so a link appearing later
      // is necessarily from this spawn's session_start, not the prior run.
      const linkPath = path.join(this.cwd, "session.jsonl");
      try {
        const stat = fs.lstatSync(linkPath);
        if (stat.isSymbolicLink()) fs.unlinkSync(linkPath);
      } catch {
        // No link / not accessible -- nothing to do
      }
    }

    const fresh = this.nextStartIsFresh;
    this.nextStartIsFresh = false;
    log("starting agent", {
      node: NODE_BIN,
      bin: LOOM_BIN,
      cwd: this.cwd,
      continue: args.includes("--continue"),
      fresh,
    });

    try {
      // Decrypted API keys flow to the brain via env so the child never reads
      // plaintext from disk. buildSecretEnv re-reads config each spawn so
      // key rotation in the settings UI takes effect on restart without
      // needing to plumb explicit invalidation.
      this.process = spawn(NODE_BIN, args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: this.cwd,
        env: {
          ...buildBrainEnv(fresh),
          ...buildSecretEnv(),
        },
      });
    } catch (err) {
      log("spawn failed:", err);
      this.setStatus("error", `Failed to spawn agent: ${err}`);
      return;
    }

    log("agent spawned, pid:", this.process.pid);
    this.setStatus("running");

    // When resuming with --continue, the agent reloads its in-memory context
    // from the on-disk session but the renderer has no way to see prior turns.
    // Replay them into the chat pane so the UI reflects what the model remembers.
    if (
      wantsContinue &&
      this.pinnedSessionFile &&
      !this.silentRestarting &&
      !this.window.isDestroyed()
    ) {
      try {
        const history = loadSessionHistory(this.pinnedSessionFile);
        if (history.length > 0) {
          this.window.webContents.send("agent:session-history", history);
        }
      } catch (err) {
        log("session-history load failed:", err);
      }
    }

    const rl = createInterface({
      input: this.process.stdout!,
      terminal: false,
    });

    rl.on("line", (line) => this.handleLine(line));

    this.process.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      this.stderr += text;
      log("stderr:", text.trimEnd());
    });

    // Capture the spawned process so the exit handler doesn't clobber a newer one
    // (race: stop() spawns a new process, then the OLD process's exit fires later
    // and wipes this.process to null even though the new one is alive).
    const spawnedProcess = this.process;

    spawnedProcess.on("exit", (code, signal) => {
      log("agent exited, code:", code, "signal:", signal, "pid:", spawnedProcess.pid);
      if (this.process !== spawnedProcess) {
        log("(stale exit — newer agent already running, ignoring)");
        return;
      }
      this.process = null;

      // Clean exit (intentional stop, or normal termination).
      if (code === 0 || code === null) {
        this.setStatus("stopped");
        return;
      }

      // Crash. Try a bounded silent restart before surfacing to the user.
      if (this.shouldAutoRestart()) {
        const attempt = this.crashRestartTimes.length;
        log(
          `agent crashed (code ${code}); silent restart ${attempt}/${AgentManager.MAX_RESTARTS_PER_WINDOW}`,
        );
        this.appendShellNote(
          `[orbit] brain exited with code ${code}; restarting (attempt ${attempt}/${AgentManager.MAX_RESTARTS_PER_WINDOW})`,
        );
        // Defer to next tick so listeners fully unwind before we spawn.
        setTimeout(() => this.start(), 100);
        return;
      }
      log(`agent crashed (code ${code}) and exhausted restart budget`);
      this.appendShellNote(
        `[orbit] brain has crashed too many times in 60s; auto-restart disabled`,
      );
      this.setStatus(
        "error",
        `Agent crashed repeatedly (code ${code}). Click status badge to open Preferences.`,
      );
    });

    spawnedProcess.on("error", (err) => {
      log("agent process error:", err.message, "pid:", spawnedProcess.pid);
      if (this.process === spawnedProcess) {
        this.process = null;
        this.setStatus("error", err.message);
      }
    });
  }

  /**
   * Returns true if we have budget to silently restart. Records the
   * current timestamp into the rolling window before deciding.
   */
  private shouldAutoRestart(): boolean {
    const now = Date.now();
    this.crashRestartTimes = this.crashRestartTimes.filter(
      (t) => now - t < AgentManager.RESTART_WINDOW_MS,
    );
    if (this.crashRestartTimes.length >= AgentManager.MAX_RESTARTS_PER_WINDOW) {
      return false;
    }
    this.crashRestartTimes.push(now);
    return true;
  }

  /**
   * Push a one-line note into the activity-shell stream so power users
   * can see what happened without seeing chat clutter for every retry.
   * The renderer's onAgentShell handler already paints these.
   */
  private appendShellNote(text: string): void {
    if (this.window.isDestroyed()) return;
    this.window.webContents.send("agent:shell", { kind: "info", text });
  }

  stop(): void {
    if (this.process) {
      log("stopping agent, pid:", this.process.pid);
      // Detach all listeners so any delayed exit/error events from THIS process
      // can't fire after start() spawns a replacement.
      this.process.removeAllListeners();
      this.process.stdout?.removeAllListeners();
      this.process.stderr?.removeAllListeners();
      this.process.kill("SIGTERM");
      this.process = null;
    }
    this.pinnedSessionFile = null;
    this.setStatus("stopped");
    for (const [id, pending] of this.pendingResponses) {
      log("rejecting pending response:", id);
      pending.reject(new Error("Agent stopped"));
    }
    this.pendingResponses.clear();
  }

  send(obj: Record<string, unknown>): void {
    if (!this.process?.stdin?.writable) {
      log("send failed: stdin not writable");
      return;
    }
    const json = JSON.stringify(obj);
    log("→ stdin:", json.slice(0, 200));
    this.process.stdin.write(json + "\n");
    // A prompt (including streamed steer/followUp) starts a turn we must watch
    // for a silent stall. Other commands (abort, set_model, ...) don't.
    if (obj.type === "prompt") {
      this.watchdog.promptSent();
    }
  }

  /**
   * Stop button handler — signals the brain AND kills its tool subprocess
   * descendants. pi-coding-agent's abort flag only fires at the next agent
   * loop tick, which means a long bash → fastp keeps running until natural
   * exit (#64). Walk the brain's process tree and SIGTERM everything,
   * with a 3s grace before SIGKILL.
   */
  async abort(): Promise<void> {
    this.send({ type: "abort" });
    const brainPid = this.process?.pid;
    if (!brainPid) return;
    try {
      const descendants = await collectDescendantsOf(brainPid);
      if (descendants.length === 0) return;
      log(`abort: SIGTERM ${descendants.length} descendant(s)`);
      for (const p of descendants) {
        try {
          process.kill(p.pid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
      // After 3s, SIGKILL anything still alive.
      setTimeout(() => {
        for (const p of descendants) {
          try {
            process.kill(p.pid, 0); // probe
            log(`abort: SIGKILL stuck pid ${p.pid}`);
            try {
              process.kill(p.pid, "SIGKILL");
            } catch {
              /* gone now */
            }
          } catch {
            /* already exited */
          }
        }
      }, 3000);
    } catch (err) {
      log("abort: failed to walk descendants:", err);
    }
  }

  sendCommand(obj: Record<string, unknown>): Promise<unknown> {
    const id = `cmd_${++this.idCounter}`;
    return new Promise((resolve, reject) => {
      this.pendingResponses.set(id, { resolve, reject });
      this.send({ ...obj, id });
    });
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  getStatusSnapshot(): { status: AgentStatus; message?: string; turnActive: boolean } {
    return { status: this.status, message: this.statusMessage, turnActive: this.turnActive };
  }

  getStderr(): string {
    return this.stderr;
  }

  private setStatus(status: AgentStatus, message?: string): void {
    this.status = status;
    this.statusMessage = message;
    // Process death (clean or otherwise) ends any in-flight turn.
    if (status === "stopped" || status === "error") {
      this.turnActive = false;
      // The process is gone; never let a pending watchdog fire against it.
      this.watchdog.stop();
    }
    log("status:", status, message || "");
    // During a silent restart we suppress the transient stopped→running flicker;
    // the renderer keeps showing "running" the whole time.
    if (this.silentRestarting && (status === "stopped" || status === "running")) return;
    if (!this.window.isDestroyed()) {
      this.window.webContents.send("agent:status", status, message);
    }
  }

  /**
   * The brain went silent mid-turn (#185): a provider call failed or stalled
   * without emitting a terminal event, so the renderer is pinned on "thinking".
   * Surface a recoverable error through the existing `error` event path, mark the
   * turn done, and best-effort tell the brain to abort so its streaming state
   * clears and the next prompt isn't queued behind a dead turn.
   */
  private handleTurnStalled(): void {
    log("turn stalled: no brain activity for", TURN_SILENCE_TIMEOUT_MS, "ms");
    this.turnActive = false;
    if (!this.window.isDestroyed()) {
      this.window.webContents.send("agent:event", {
        type: "error",
        message:
          "The assistant stopped responding. The request may have failed or " +
          "been blocked -- please try again.",
      });
    }
    // Best-effort: unstick pi's streaming state so the next prompt runs. If the
    // brain is wedged on a dead socket this may not land, but the UI is already
    // recovered either way.
    this.send({ type: "abort" });
  }

  private handleLine(line: string): void {
    if (this.window.isDestroyed()) return;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line);
    } catch {
      log("non-JSON stdout:", line.slice(0, 200));
      return;
    }

    const type = data.type as string;
    const noisy = type === "message_update" || type === "tool_execution_update";
    log("← event:", type, noisy ? "" : JSON.stringify(data).slice(0, 150));

    // Any line from the brain is a sign of life: reset/pause/disarm the stall
    // watchdog before we act on (or early-return from) this event.
    this.watchdog.observe(type);

    if (type === "response" && data.id) {
      const pending = this.pendingResponses.get(data.id as string);
      if (pending) {
        this.pendingResponses.delete(data.id as string);
        if (data.success === false) {
          pending.reject(new Error(data.error as string));
        } else {
          pending.resolve(data.data ?? data);
        }
        return;
      }
    }

    if (type === "extension_ui_request") {
      log("  ui request:", (data as { method?: string }).method, (data as { id?: string }).id);
      // First-run MCP bootstrap emits a notify telling the user to restart so
      // newly-cached tool metadata loads as direct tools. Swallow it and do the
      // restart silently instead — users shouldn't have to care.
      if (this.shouldSwallowMcpBootstrapNotify(data)) {
        log("swallowing MCP bootstrap notify → scheduling silent restart");
        this.mcpBootstrapRestartDone = true;
        setTimeout(() => this.silentRestart(), 0);
        return;
      }
      this.window.webContents.send("agent:ui-request", data);
      return;
    }

    if (type === "agent_start") {
      this.turnActive = true;
    } else if (type === "agent_end" || type === "error") {
      this.turnActive = false;
    }

    this.window.webContents.send("agent:event", data);
  }

  private shouldSwallowMcpBootstrapNotify(data: Record<string, unknown>): boolean {
    if (this.mcpBootstrapRestartDone) return false;
    if ((data as { method?: string }).method !== "notify") return false;
    const message = (data as { message?: string }).message;
    return typeof message === "string" && message.includes("will be available after restart");
  }

  private silentRestart(): void {
    log("silent restart (MCP bootstrap)");
    // Preserve chat continuity across the restart so the user sees no turn break.
    this.hasStartedBefore = true;
    this.nextStartSkipContinue = false;
    this.nextStartIsFresh = false;
    this.silentRestarting = true;
    try {
      this.stop();
      this.start();
    } finally {
      this.silentRestarting = false;
    }
  }
}
