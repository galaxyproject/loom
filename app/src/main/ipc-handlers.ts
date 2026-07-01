import { ipcMain, dialog, BrowserWindow, shell, app, autoUpdater } from "electron";
import { createIdempotentIpc } from "./ipc-registry.js";
import type { AgentManager } from "./agent.js";
import { startFilesWatcher, resolveWithin } from "./files-handler.js";
import { loadSessionHistory } from "./session-replay.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { loadConfig, saveConfig, type LoomConfig } from "./config.js";
import {
  encryptSecret,
  isAvailable as safeStorageAvailable,
  resolveGalaxyApiKey,
} from "./secure-config.js";
import {
  resolveGalaxyStatus,
  resolveGalaxyServerUrl,
  resolveGalaxyHistoryOpenUrl,
} from "./galaxy-status.js";
import { fetchGalaxyCurrentUser, type GalaxyUserStatus } from "./galaxy-user.js";
import { normalizeGalaxyUrl, validateGalaxyUrl } from "./galaxy-url.js";
import { getProviders, getModels } from "@earendil-works/pi-ai";
import { isDeprecatedModelId } from "./model-catalog.js";
import { checkLatestVersion } from "./version-check.js";
import { resolveReleasePageUrl } from "./release-page.js";
import { postFeedback } from "./feedback.js";
import type { FeedbackPayload } from "../../../shared/feedback-contract.js";
import {
  getOAuthStatus,
  isOAuthProvider,
  signInOpenAICodex,
  signOutOAuth,
} from "./oauth-handler.js";
import { isLocalShellAvailable } from "./local-shell.js";

/**
 * Sentinel the renderer sends back in a secret field when the user did NOT
 * change it. Main preserves whatever is already on disk in that case.
 */
export const UNCHANGED_SECRET = "__loom_unchanged_secret__";

/** Masked shape returned to the renderer — never carries plaintext secrets. */
interface MaskedLoomConfig extends Omit<LoomConfig, "llm" | "galaxy"> {
  llm?: {
    active: string;
    providers: Record<string, { model?: string; baseUrl?: string; hasApiKey: boolean }>;
  };
  galaxy?: {
    active: string | null;
    profiles: Record<string, { url: string; hasApiKey: boolean }>;
  };
  localShellAvailable?: boolean;
}

function maskConfig(cfg: LoomConfig): MaskedLoomConfig {
  const { llm: _llm, galaxy: _galaxy, ...rest } = cfg;
  const masked: MaskedLoomConfig = { ...rest };
  if (cfg.llm) {
    masked.llm = {
      active: cfg.llm.active,
      providers: Object.fromEntries(
        Object.entries(cfg.llm.providers ?? {}).map(([k, v]) => [
          k,
          {
            model: v.model,
            baseUrl: v.baseUrl,
            // OAuth providers authenticate via ~/.pi/agent/auth.json -- an
            // orphan apiKey on the entry (manual edit, or the legacy-shape
            // migrator) is dead weight, not a real credential. Don't surface
            // it to the renderer or it'll mis-render "Key stored" UI for
            // an account that actually authenticates by sign-in.
            hasApiKey: isOAuthProvider(k) ? false : Boolean(v.apiKey || v.apiKeyEncrypted),
          },
        ]),
      ),
    };
  }
  if (cfg.galaxy) {
    masked.galaxy = {
      active: cfg.galaxy.active,
      profiles: Object.fromEntries(
        Object.entries(cfg.galaxy.profiles).map(([k, v]) => [
          k,
          { url: v.url, hasApiKey: Boolean(v.apiKey || v.apiKeyEncrypted) },
        ]),
      ),
    };
  }
  return masked;
}

/**
 * Reconcile the renderer-supplied config against what's on disk, encrypting
 * any newly-supplied plaintext secrets and preserving unchanged ones.
 */
function reconcileIncomingConfig(incoming: Record<string, unknown>): LoomConfig {
  const current = loadConfig();
  const canEncrypt = safeStorageAvailable();
  const out: LoomConfig = { ...current, ...(incoming as LoomConfig) };

  // Guardian: only the sandbox toggle comes from the renderer; merge it onto the
  // stored block so toggling it never drops dangerouslyBypassPermissions / trustedWorkspaces.
  const incomingGuardian = (incoming as { guardian?: { sandbox?: boolean } }).guardian;
  if (incomingGuardian) {
    out.guardian = { ...current.guardian, sandbox: incomingGuardian.sandbox === true };
  }

  // LLM multi-provider reconciliation. The renderer sends:
  //   { active, providers: { [name]: { apiKey?, model? } } }
  // where apiKey may be UNCHANGED_SECRET (preserve), "" (clear), or a new value.
  type IncomingProvider = { apiKey?: string; model?: string; baseUrl?: string };
  type IncomingLlm = { active?: string; providers?: Record<string, IncomingProvider> };
  const incomingLlm = (incoming as { llm?: IncomingLlm }).llm;
  if (incomingLlm) {
    // Seed from disk so a partial payload (e.g. /model switching just one
    // provider's model) preserves every other provider's encrypted blob.
    const mergedProviders: NonNullable<LoomConfig["llm"]>["providers"] = {
      ...(current.llm?.providers ?? {}),
    };
    for (const [name, p] of Object.entries(incomingLlm.providers ?? {})) {
      const existing = current.llm?.providers?.[name];
      const rawKey = p.apiKey;
      const entry: { apiKey?: string; apiKeyEncrypted?: string; model?: string; baseUrl?: string } =
        {};
      // Preserve existing model if the incoming entry doesn't carry one --
      // a partial save (e.g. rotate-just-the-key) shouldn't wipe the model.
      if (p.model !== undefined) entry.model = p.model;
      else if (existing?.model) entry.model = existing.model;
      if (p.baseUrl !== undefined) entry.baseUrl = p.baseUrl;
      else if (existing?.baseUrl) entry.baseUrl = existing.baseUrl;
      if (rawKey === UNCHANGED_SECRET || rawKey === undefined) {
        if (existing?.apiKeyEncrypted) entry.apiKeyEncrypted = existing.apiKeyEncrypted;
        else if (existing?.apiKey) entry.apiKey = existing.apiKey;
      } else if (rawKey !== "") {
        if (canEncrypt) entry.apiKeyEncrypted = encryptSecret(rawKey);
        else entry.apiKey = rawKey;
      }
      // empty rawKey ("") = explicit clear — neither field set
      mergedProviders[name] = entry;
    }
    out.llm = {
      active: incomingLlm.active ?? current.llm?.active ?? "anthropic",
      providers: mergedProviders,
    };
  }

  // Galaxy profile reconciliation (per profile)
  type GalaxyConfig = NonNullable<LoomConfig["galaxy"]>;
  const incomingGalaxy = (incoming as { galaxy?: GalaxyConfig }).galaxy;
  if (incomingGalaxy) {
    const mergedProfiles: GalaxyConfig["profiles"] = {};
    for (const [name, p] of Object.entries(incomingGalaxy.profiles || {})) {
      const existing = current.galaxy?.profiles?.[name];
      const rawKey = p.apiKey;
      // Normalize + validate before the decrypted key is ever sent here -- the
      // main process is the trust boundary, so a compromised renderer that
      // reaches config:save still can't repoint the key at an http/attacker URL.
      const url = p.url ? normalizeGalaxyUrl(p.url) : p.url;
      if (url) {
        const v = validateGalaxyUrl(url);
        if (!v.ok) throw new Error(`Galaxy profile "${name}": ${v.reason}`);
      }
      const profile: (typeof mergedProfiles)[string] = { url };
      if (rawKey === UNCHANGED_SECRET || rawKey === undefined) {
        if (existing?.apiKeyEncrypted) profile.apiKeyEncrypted = existing.apiKeyEncrypted;
        if (existing?.apiKey) profile.apiKey = existing.apiKey;
      } else if (rawKey === "") {
        // Explicit clear — drop both fields.
      } else if (canEncrypt) {
        profile.apiKeyEncrypted = encryptSecret(rawKey);
      } else {
        profile.apiKey = rawKey;
      }
      mergedProfiles[name] = profile;
    }
    out.galaxy = { active: incomingGalaxy.active, profiles: mergedProfiles };
  }

  return out;
}

function log(...args: unknown[]): void {
  console.log("[ipc]", ...args);
}

interface AgentPromptOptions {
  streamingBehavior?: "steer" | "followUp";
}

function promptPayload(message: string, options?: AgentPromptOptions): Record<string, unknown> {
  const payload: Record<string, unknown> = { type: "prompt", message };
  const streamingBehavior = options?.streamingBehavior;
  if (streamingBehavior === "steer" || streamingBehavior === "followUp") {
    payload.streamingBehavior = streamingBehavior;
  }
  return payload;
}

/**
 * Ask the user to confirm that switching analysis directories will start
 * a fresh agent session and clear the current chat/plan/notebook view.
 * Returns true if the user confirmed.
 */
export async function confirmCwdChange(
  window?: BrowserWindow,
  targetCwd?: string,
): Promise<boolean> {
  const consequence =
    "The current chat, plan, and notebook view will be cleared from this window. The previous session remains on disk and can be resumed by opening that directory again.";
  const result = await dialog.showMessageBox(window!, {
    type: "warning",
    buttons: ["Cancel", "Continue"],
    defaultId: 0,
    cancelId: 0,
    title: "Change analysis directory?",
    message: "Changing the analysis directory will start a new agent session.",
    // When the target is known up front (e.g. a `--cwd` hand-off from another
    // process), show WHERE -- otherwise the user is approving a blind switch.
    detail: targetCwd ? `New directory:\n${targetCwd}\n\n${consequence}` : consequence,
  });
  return result.response === 1;
}

export function registerIpcHandlers(agent: AgentManager): void {
  // Register through idempotent wrappers so a reopen-after-close on macOS
  // (which re-runs this for a fresh window) can't double-register and crash (#311).
  const ipc = createIdempotentIpc(ipcMain);

  ipc.handle("agent:prompt", async (_e, message: string, options?: AgentPromptOptions) => {
    log("prompt:", message.slice(0, 80));
    agent.send(promptPayload(message, options));
  });

  ipc.handle("agent:abort", async () => {
    log("abort");
    await agent.abort();
  });

  ipc.handle("agent:new-session", async () => {
    log("new-session");
    return agent.sendCommand({ type: "new_session" });
  });

  ipc.handle("agent:get-state", async () => {
    return agent.sendCommand({ type: "get_state" });
  });

  ipc.handle("agent:get-status", () => {
    return agent.getStatusSnapshot();
  });

  ipc.on("agent:ui-response", (_e, response: Record<string, unknown>) => {
    log("ui-response:", JSON.stringify(response).slice(0, 120));
    agent.send(response);
  });

  ipc.handle("agent:restart", async () => {
    log("restart");
    agent.stop();
    agent.start();
  });

  ipc.handle("agent:reset-session", async () => {
    log("reset session — fresh start, no --continue");
    agent.stop();
    agent.resetSession();
    agent.start();
  });

  ipc.handle("agent:get-cwd", () => {
    return agent.getCwd();
  });

  // Replay the current session's chat transcript into the renderer. Used
  // by /chat and by display:resume after wake-from-sleep. Reads only from
  // the pinned session file, so a fresh /new start (pinned = null) returns
  // empty instead of surfacing stale per-cwd history.
  ipc.handle("chat:replay", async (e) => {
    const window = BrowserWindow.fromWebContents(e.sender);
    if (!window || window.isDestroyed()) return { ok: false, error: "no window" };
    const file = agent.getReplaySessionFile();
    if (!file) {
      window.webContents.send("agent:session-history", []);
      return { ok: true, segments: 0 };
    }
    try {
      const history = loadSessionHistory(file);
      window.webContents.send("agent:session-history", history);
      return { ok: true, segments: history.length };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipc.handle("dialog:browse-directory", async () => {
    const result = await dialog.showOpenDialog({
      title: "Choose directory",
      defaultPath: agent.getCwd(),
      properties: ["openDirectory", "createDirectory"],
    });
    return result.filePaths[0] ?? null;
  });

  ipc.handle("dialog:select-directory", async (e) => {
    const window = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    if (!(await confirmCwdChange(window))) return null;
    const result = await dialog.showOpenDialog({
      title: "Choose working directory",
      defaultPath: agent.getCwd(),
      properties: ["openDirectory", "createDirectory"],
    });
    const dir = result.filePaths[0] ?? null;
    if (dir && agent.switchCwd(dir)) {
      log("directory changed to:", dir);
      // Mirror the File > Open Analysis Directory path so the renderer
      // resets its UI when the cwd changes via the top-bar "change" button.
      window?.webContents.send("agent:cwd-changed", dir);
      if (window) startFilesWatcher(window, dir);
    }
    return dir;
  });

  ipc.handle("config:get", () => {
    // Distinct from web's `_mode:"remote"` (which strips all config and skips
    // first-run): the desktop keeps real Galaxy/LLM config + cwd and only hides
    // the local-exec-only UI when there's no shell.
    return { ...maskConfig(loadConfig()), localShellAvailable: isLocalShellAvailable() };
  });

  // Effective Galaxy connection for the footer dot -- reflects the brain's own
  // GALAXY_URL/GALAXY_API_KEY view (profile or exported env), not just the
  // masked config, so env-driven sessions read connected (#284).
  ipc.handle("galaxy:status", () => {
    return resolveGalaxyStatus(loadConfig(), process.env, resolveGalaxyApiKey);
  });

  // Who does the active Galaxy key authenticate as? The renderer can't ask
  // Galaxy itself -- it never sees the plaintext key (config:get is masked) --
  // so main resolves the active profile's url + decrypted key and asks Galaxy.
  // Used to show the connected account in the status tooltip. Registered via the
  // idempotent ipc wrapper (#327) so reopen doesn't throw on a duplicate handler.
  ipc.handle("galaxy:current-user", async (): Promise<GalaxyUserStatus> => {
    const cfg = loadConfig();
    const active = cfg.galaxy?.active;
    const profile = active ? cfg.galaxy?.profiles?.[active] : undefined;
    const url = profile?.url;
    const key = resolveGalaxyApiKey(cfg);
    if (!url || !key) return { ok: false, authFailed: false };
    return fetchGalaxyCurrentUser(url, key);
  });

  ipc.handle(
    "apiKey:validate",
    async (
      _e,
      provider: string,
      key: string,
      baseUrl?: string,
    ): Promise<{ valid: boolean; error?: string; models?: string[] }> => {
      return validateApiKey(provider, key, baseUrl);
    },
  );

  // Top-level config keys the renderer is allowed to set. Anything else
  // submitted via config:save is dropped before saveConfig() runs — the
  // renderer is the smaller trust boundary, so a markdown XSS that
  // managed to call window.orbit.saveConfig should not be able to plant
  // arbitrary keys (which would be picked up after the brain restart at
  // the bottom of this handler).
  const ALLOWED_CONFIG_KEYS: ReadonlySet<string> = new Set([
    "llm",
    "galaxy",
    "executionMode",
    "defaultCwd",
    "skills",
    "condaBin",
    "experiments",
    "guardian",
    "updateCheck",
  ]);

  function sanitizeConfig(input: unknown): LoomConfig {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("config:save expects an object payload");
    }
    const out: Record<string, unknown> = {};
    const dropped: string[] = [];
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (ALLOWED_CONFIG_KEYS.has(k)) {
        out[k] = v;
      } else {
        dropped.push(k);
      }
    }
    if (dropped.length > 0) {
      log("config:save dropped unknown keys:", dropped);
    }
    // guardian: the renderer may only set the sandbox toggle. dangerouslyBypassPermissions
    // is intentionally stripped here -- it has its own native-confirm IPC, so a renderer
    // XSS that reached config:save still can't enable the bypass.
    if (out.guardian && typeof out.guardian === "object" && !Array.isArray(out.guardian)) {
      out.guardian = { sandbox: (out.guardian as Record<string, unknown>).sandbox === true };
    }
    return out as LoomConfig;
  }

  ipc.handle("config:save", async (_e, config: LoomConfig) => {
    try {
      const safe = sanitizeConfig(config);
      const reconciled = reconcileIncomingConfig(safe as Record<string, unknown>);
      saveConfig(reconciled);
      log("config saved");
      // Restart agent subprocess to pick up new provider/model/API key
      agent.stop();
      agent.start();
      return { success: true };
    } catch (err) {
      log("config:save failed:", err);
      return { success: false, error: String(err) };
    }
  });

  ipc.handle("skills:refresh", async () => {
    try {
      // Don't yank the agent out from under an in-flight turn -- stop()/start()
      // would silently kill active work. Make the user stop the turn first.
      if (agent.getStatusSnapshot().turnActive) {
        return {
          ok: false,
          error: "The agent is mid-task -- stop the current turn before refreshing skills.",
        };
      }
      const config = loadConfig();
      const repos = (config.skills?.repos ?? []) as Array<{
        name?: string;
        url?: string;
        branch?: string;
      }>;
      const base = path.join(os.homedir(), ".loom", "cache", "skills");
      for (const r of repos) {
        // Skills code only ever uses filesystem-safe names; validate here too
        // since this builds a path and deletes files (defense in depth).
        if (!r?.name || !/^[A-Za-z0-9._-]+$/.test(r.name)) continue;
        // Clear the whole resolved cache dir (catalog + per-file frontmatter) so the
        // restarted agent re-walks AND re-fetches fresh, not just the tree listing.
        try {
          for (const dir of fs.readdirSync(base)) {
            if (dir.startsWith(`${r.name}@`)) {
              fs.rmSync(path.join(base, dir), { recursive: true, force: true });
            }
          }
        } catch {
          // base dir may not exist yet -- nothing to clear
        }
      }
      agent.stop();
      agent.start();
      log("skills cache cleared; agent restarted");
      return { ok: true };
    } catch (err) {
      log("skills:refresh failed:", err);
      return { ok: false, error: String(err) };
    }
  });

  // Local-execution bypass toggle. Deliberately NOT routed through config:save
  // (whose allowlist blocks renderer-planted keys, ipc-handlers.ts ALLOWED_CONFIG_KEYS).
  // Enabling bypass requires a NATIVE confirm dialog in the main process, which
  // renderer-side injection (e.g. a markdown XSS) cannot auto-dismiss. The brain
  // reads guardian config live per tool call, so no agent restart is needed.
  ipc.handle("guardian:set-bypass", async (e, enabled: unknown) => {
    const turnOn = enabled === true;
    if (turnOn) {
      const window = BrowserWindow.fromWebContents(e.sender) ?? undefined;
      const opts = {
        type: "warning" as const,
        buttons: ["Cancel", "Enable bypass"],
        defaultId: 0,
        cancelId: 0,
        title: "Bypass all command permissions?",
        message: "Let the AI run any command without asking?",
        detail:
          "This disables the safety gate: the AI can run any shell command and read or write " +
          "any file on your computer, with no per-action approval. Only do this in an " +
          "environment you fully control.",
      };
      const result = window
        ? await dialog.showMessageBox(window, opts)
        : await dialog.showMessageBox(opts);
      if (result.response !== 1) {
        return { ok: true, enabled: false, cancelled: true };
      }
    }
    const cfg = loadConfig();
    cfg.guardian = { ...(cfg.guardian ?? {}), dangerouslyBypassPermissions: turnOn };
    saveConfig(cfg);
    log(`guardian bypass ${turnOn ? "ENABLED" : "disabled"}`);
    return { ok: true, enabled: turnOn };
  });

  ipc.handle("oauth:status", (_e, provider: string) => {
    if (!isOAuthProvider(provider)) {
      return { signedIn: false };
    }
    return getOAuthStatus(provider);
  });

  ipc.handle("oauth:sign-in", async (_e, provider: string) => {
    if (provider !== "openai-codex") {
      return { ok: false as const, error: `Unknown OAuth provider: ${provider}` };
    }
    try {
      const status = await signInOpenAICodex();
      // Restart the brain so it picks up the new credential on next prompt.
      agent.stop();
      agent.start();
      return { ok: true as const, status };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipc.handle("oauth:sign-out", async (_e, provider: string) => {
    if (!isOAuthProvider(provider)) {
      return { ok: false as const, error: `Unknown OAuth provider: ${provider}` };
    }
    try {
      signOutOAuth(provider);
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
    agent.stop();
    agent.start();
    return { ok: true as const };
  });

  ipc.handle("notebook:status", (): { exists: boolean; hasContent: boolean } => {
    const notebookPath = path.join(agent.getCwd(), "notebook.md");
    if (!fs.existsSync(notebookPath)) return { exists: false, hasContent: false };
    try {
      const stat = fs.statSync(notebookPath);
      return { exists: true, hasContent: stat.size > 0 };
    } catch {
      return { exists: true, hasContent: false };
    }
  });

  ipc.handle(
    "notebook:clear-artifacts",
    async (): Promise<{ cleared: boolean; error?: string }> => {
      const cwd = agent.getCwd();
      const targets = ["notebook.md", "activity.jsonl", "session.jsonl"];
      const removed: string[] = [];
      try {
        for (const name of targets) {
          const p = path.join(cwd, name);
          try {
            const stat = fs.lstatSync(p);
            if (stat.isSymbolicLink() || stat.isFile()) {
              fs.rmSync(p);
              removed.push(name);
            }
          } catch {
            // file didn't exist -- skip
          }
        }
        if (removed.length > 0) {
          try {
            execSync(`git add -A ${removed.map((n) => `"${n}"`).join(" ")}`, {
              cwd,
              stdio: "ignore",
            });
            execSync('git commit -m "Cleared previous analysis"', { cwd, stdio: "ignore" });
          } catch {
            // git not available or nothing to commit -- best effort
          }
        }
        return { cleared: true };
      } catch (err) {
        log("notebook:clear-artifacts failed:", err);
        return { cleared: false, error: String(err) };
      }
    },
  );

  ipc.handle("notebook:load", async () => {
    const nbPath = path.join(agent.getCwd(), "notebook.md");
    try {
      const content = fs.readFileSync(nbPath, "utf-8");
      return { ok: true, content, path: nbPath };
    } catch {
      return { ok: false, content: null, path: nbPath };
    }
  });

  ipc.handle("file:open", async (_e, filePath: string) => {
    log("open file:", filePath);

    // Path clamp: the renderer can pass any string here, including paths
    // outside the analysis cwd. Always go through resolveWithin so a
    // markdown link or compromised renderer can't ask us to open
    // /etc/passwd or a privileged HTML file in a new BrowserWindow.
    let absPath: string;
    try {
      absPath = resolveWithin(agent.getCwd(), filePath);
    } catch (err) {
      log("file:open rejected — escapes cwd:", filePath);
      return { opened: false, error: String(err) };
    }
    const ext = path.extname(absPath).toLowerCase();

    // HTML files → new Electron window (so user can view reports)
    if (ext === ".html" || ext === ".htm") {
      const win = new BrowserWindow({
        width: 1200,
        height: 900,
        title: path.basename(absPath),
        webPreferences: {
          // Hardened: no preload bridge, no Node, sandbox on, web
          // security on, isolated context. The opened HTML is treated
          // like any untrusted web page.
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      });
      win.webContents.on("before-input-event", (event, input) => {
        if (input.type === "keyDown" && input.key === "Escape" && !win.isDestroyed()) {
          event.preventDefault();
          win.close();
        }
      });
      await win.loadFile(absPath);
      return { opened: true };
    }
    // Everything else → system default app
    const err = await shell.openPath(absPath);
    if (err) return { opened: false, error: err };
    return { opened: true };
  });

  // Issue reporter: returns sysinfo for the renderer to bundle into the
  // report body. No secrets — just versions + platform + arch.
  ipc.handle("report:sysinfo", () => ({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
  }));

  // Version checker: surfaces a "new release available" banner in the
  // renderer. No auto-install (unsigned macOS builds can't be patched by
  // Squirrel.Mac); a packaged build user manually downloads the new DMG.
  // Renderer is rate-limited to one call per session — checkLatestVersion
  // itself caches the GitHub response for 24h on disk.
  ipc.handle("version:check", async () => {
    return await checkLatestVersion();
  });

  // Running app version + packaged flag for the what's-new banner. Unlike
  // version:check this never hits the network and ignores updateCheck -- the
  // what's-new surface is local and must work even with update checks off.
  ipc.handle("version:current", () => ({
    version: app.getVersion(),
    isPackaged: app.isPackaged,
  }));

  // Opens the GitHub releases page in the user's default browser when they
  // click the "update available" banner. The destination is pinned in
  // resolveReleasePageUrl -- the renderer never gets a generic openExternal
  // capability. Report the *real* outcome (and log failures): shell.openExternal
  // can reject or no-op where there's no default browser / no xdg-open (WSLg,
  // #368), and the old always-"opened:true" hid that from the caller, which
  // then had no way to offer a copy-the-link fallback.
  ipc.handle("version:open-release", async (_e, url: unknown) => {
    const target = resolveReleasePageUrl(url);
    try {
      await shell.openExternal(target);
      return { opened: true, url: target };
    } catch (err) {
      log("version:open-release -- shell.openExternal failed:", target, err);
      return { opened: false, url: target };
    }
  });

  // Opens the bound Galaxy history in the user's default browser when the user
  // clicks the link in the Activity tab. The renderer never gets a generic
  // openExternal capability. resolveGalaxyHistoryOpenUrl pins the destination to
  // the *effective* Galaxy server (active profile URL or exported GALAXY_URL --
  // an env-driven session has no saved profile, so pinning to the profile alone
  // left history links dead, #290) and enforces the http(s) + /histories/view
  // checks. It returns the normalized URL to open, or null to reject.
  ipc.handle("galaxy:open-history", async (_e, url: unknown) => {
    const serverUrl = resolveGalaxyServerUrl(loadConfig(), process.env);
    const target = resolveGalaxyHistoryOpenUrl(url, serverUrl);
    if (!target) return { opened: false };
    await shell.openExternal(target);
    return { opened: true };
  });

  // Apply a downloaded macOS update + relaunch. autoUpdater.quitAndInstall is a
  // no-op unless an update was actually downloaded, so this is safe to call.
  ipc.handle("update:restart", () => {
    autoUpdater.quitAndInstall();
    return { restarting: true };
  });

  // Issue reporter: opens a pre-filled GitHub "new issue" URL in the user's
  // browser. The renderer never gets a generic openExternal capability —
  // we hard-code the repo here so a compromised renderer can't redirect.
  ipc.handle("report:open-issue", async (_e, payload: { title?: unknown; body?: unknown }) => {
    const title = typeof payload?.title === "string" ? payload.title : "";
    const body = typeof payload?.body === "string" ? payload.body : "";
    const params = new URLSearchParams({ title, body });
    const url = `https://github.com/galaxyproject/loom/issues/new?${params.toString()}`;
    await shell.openExternal(url);
    return { opened: true };
  });

  // Feedback capture: POST the payload to the orbit-feedback worker. The
  // endpoint URL (and any shared secret) live in main only -- see feedback.ts --
  // so a compromised renderer can't redirect it. Returns {ok,...} so the
  // renderer can fall back to the GitHub-issue flow when the POST fails.
  ipc.handle("feedback:submit", async (_e, payload: FeedbackPayload) => {
    // Stamp the opaque tester code from config in main (authoritative; the
    // renderer never sets it). Non-secret; lets the team attribute the report.
    const testerId = loadConfig().testerId || process.env.LOOM_TESTER_ID;
    return await postFeedback(testerId ? { ...payload, testerId } : payload);
  });

  // Model registry — pulls from pi-ai's bundled list so the dropdown stays
  // current with the brain's actual capabilities. Replaces the hand-edited
  // MODELS_BY_PROVIDER + PRICING constants in the renderer (they're kept as
  // a fallback if this IPC fails for any reason).
  //
  // Filtered to user-facing direct providers (no Bedrock/regional aliases).
  ipc.handle("models:list-all", () => {
    const USER_FACING_PROVIDERS: ReadonlySet<string> = new Set([
      "anthropic",
      "openai",
      "openai-codex",
      "google",
      "ollama",
      "openrouter",
      "groq",
      "mistral",
      "xai",
      "deepseek",
    ]);
    type Pricing = { input: number; output: number; cacheRead?: number; cacheWrite?: number };
    type Entry = { id: string; label: string; pricing: Pricing; contextWindow?: number };
    const out: Record<string, Entry[]> = {};
    try {
      for (const provider of getProviders()) {
        if (!USER_FACING_PROVIDERS.has(provider)) continue;
        // Drop generations the provider's live API has retired -- pi's registry
        // still lists them but they 404 on use, so they shouldn't reach the picker (#221).
        const models = getModels(provider).filter((m) => !isDeprecatedModelId(provider, m.id));
        if (!models.length) continue;
        out[provider] = models.map((m) => {
          const cleanName = m.name.replace(/^Claude\s+/i, "");
          const priceTag = `$${m.cost.input}/$${m.cost.output}`;
          return {
            id: m.id,
            label: `${cleanName} — ${priceTag}`,
            pricing: {
              input: m.cost.input,
              output: m.cost.output,
              cacheRead: m.cost.cacheRead,
              cacheWrite: m.cost.cacheWrite,
            },
            // Model's max context window (tokens). Powers the renderer's
            // context-fill indicator. May be undefined for some providers.
            contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : undefined,
          };
        });
      }
      return { ok: true as const, providers: out };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/**
 * Live API key validation. Makes a minimal request against the provider's
 * auth-gated endpoint and maps the response to a pass/fail result.
 *
 * We trade speed for correctness: format checks alone can't distinguish a
 * revoked key from a valid one, so for providers whose format collisions
 * matter (anthropic, openai) we actually hit the network. 5s timeout.
 */
async function validateApiKey(
  provider: string,
  key: string,
  baseUrl?: string,
): Promise<{ valid: boolean; error?: string; models?: string[] }> {
  const trimmed = key.trim();
  if (!trimmed) return { valid: false, error: "Key is empty" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    if (baseUrl) {
      const trimmedBase = baseUrl.trim().replace(/\/+$/, "");
      if (!/^https?:\/\//.test(trimmedBase)) {
        return { valid: false, error: "Base URL must start with http(s)://" };
      }
      const res = await fetch(`${trimmedBase}/models`, {
        headers: { authorization: `Bearer ${trimmed}` },
        signal: controller.signal,
      });
      if (res.status === 401) return { valid: false, error: "Invalid API key (401)" };
      if (!res.ok) return { valid: false, error: `Unexpected response: HTTP ${res.status}` };
      try {
        const body = (await res.json()) as { data?: unknown };
        const raw = body.data;
        const models = Array.isArray(raw)
          ? raw
              .map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : undefined))
              .filter((id): id is string => typeof id === "string")
          : [];
        return { valid: true, models };
      } catch {
        return { valid: true };
      }
    }
    if (provider === "anthropic") {
      if (!trimmed.startsWith("sk-ant-")) {
        return { valid: false, error: "Anthropic keys start with sk-ant-" };
      }
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": trimmed,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: controller.signal,
      });
      if (res.status === 401) return { valid: false, error: "Invalid API key (401)" };
      if (res.ok || res.status === 400) return { valid: true };
      return { valid: false, error: `Unexpected response: HTTP ${res.status}` };
    }
    if (provider === "openai") {
      if (!trimmed.startsWith("sk-")) {
        return { valid: false, error: "OpenAI keys start with sk-" };
      }
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { authorization: `Bearer ${trimmed}` },
        signal: controller.signal,
      });
      if (res.status === 401) return { valid: false, error: "Invalid API key (401)" };
      if (res.ok) return { valid: true };
      return { valid: false, error: `Unexpected response: HTTP ${res.status}` };
    }
    // For providers we don't live-check, just sanity-check length so at least
    // paste-of-garbage (e.g. terminal output) gets caught.
    if (trimmed.length < 16 || trimmed.length > 400 || /\s/.test(trimmed)) {
      return { valid: false, error: "Key looks malformed" };
    }
    return { valid: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort")) return { valid: false, error: "Validation timed out" };
    return { valid: false, error: `Network error: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}
