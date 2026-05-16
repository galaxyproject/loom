import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { app, type BrowserWindow } from "electron";
import { loadConfig } from "./config.js";
import { resolveLlmApiKey, resolveGalaxyApiKey } from "./secure-config.js";
import { loadSessionHistory } from "./session-replay.js";
import { collectDescendantsOf } from "./proc-monitor.js";
import { buildBrainEnv as buildBaseBrainEnv } from "../../../shared/brain-env.js";

const PROVIDER_ENV_MAP: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  xai: "XAI_API_KEY",
};

/** Build the secret env vars injected into the brain subprocess. */
function buildSecretEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const cfg = loadConfig();

  const llmKey = resolveLlmApiKey(cfg);
  if (llmKey) {
    const provider = cfg.llm?.provider || "anthropic";
    const envVar = PROVIDER_ENV_MAP[provider] || "AI_GATEWAY_API_KEY";
    env[envVar] = llmKey;
  }

  const galaxyKey = resolveGalaxyApiKey(cfg);
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

function buildBrainEnv(fresh: boolean): NodeJS.ProcessEnv {
  // Base curation (named passthrough + LOOM_/GALAXY_/PI_ prefixes) lives in
  // shared/brain-env.js so web/server.ts uses the same allowlist. Provider
  // keys come from the OS keychain via buildSecretEnv on desktop, so we don't
  // ask the base helper to forward them from shell env.
  const env = buildBaseBrainEnv();
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
  private stderr = "";
  private pendingResponses = new Map<string, PendingResponse>();
  private idCounter = 0;
  private cwd: string;
  private hasStartedBefore = false; // → use --continue on restart to preserve chat history
  private nextStartSkipContinue = false; // → restart in a new cwd without resuming old chat
  private nextStartIsFresh = false; // → tells extension to skip notebook auto-load on next start
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

  constructor(window: BrowserWindow, cwd: string) {
    this.window = window;
    this.cwd = cwd;
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
    log("cwd set to", cwd);
  }

  switchCwd(cwd: string): boolean {
    if (cwd === this.cwd) return false;
    this.cwd = cwd;
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
    if (wantsContinue && !this.silentRestarting && !this.window.isDestroyed()) {
      try {
        const history = loadSessionHistory(this.cwd);
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

  getStatusSnapshot(): { status: AgentStatus; message?: string } {
    return { status: this.status, message: this.statusMessage };
  }

  getStderr(): string {
    return this.stderr;
  }

  private setStatus(status: AgentStatus, message?: string): void {
    this.status = status;
    this.statusMessage = message;
    log("status:", status, message || "");
    // During a silent restart we suppress the transient stopped→running flicker;
    // the renderer keeps showing "running" the whole time.
    if (this.silentRestarting && (status === "stopped" || status === "running")) return;
    if (!this.window.isDestroyed()) {
      this.window.webContents.send("agent:status", status, message);
    }
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
