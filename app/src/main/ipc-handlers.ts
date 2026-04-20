import { ipcMain, dialog, BrowserWindow, shell } from "electron";
import type { AgentManager } from "./agent.js";
import path from "node:path";
import { loadConfig, saveConfig, type LoomConfig } from "./config.js";

function log(...args: unknown[]): void {
  console.log("[ipc]", ...args);
}

/**
 * Ask the user to confirm that switching analysis directories will start
 * a fresh agent session and clear the current chat/plan/notebook view.
 * Returns true if the user confirmed.
 */
export async function confirmCwdChange(window?: BrowserWindow): Promise<boolean> {
  const result = await dialog.showMessageBox(window!, {
    type: "warning",
    buttons: ["Cancel", "Continue"],
    defaultId: 0,
    cancelId: 0,
    title: "Change analysis directory?",
    message: "Changing the analysis directory will start a new agent session.",
    detail:
      "The current chat, plan, and notebook view will be cleared from this window. The previous session remains on disk and can be resumed by opening that directory again.",
  });
  return result.response === 1;
}

export function registerIpcHandlers(agent: AgentManager): void {
  ipcMain.handle("agent:prompt", async (_e, message: string) => {
    log("prompt:", message.slice(0, 80));
    agent.send({ type: "prompt", message });
  });

  ipcMain.handle("agent:abort", async () => {
    log("abort");
    agent.send({ type: "abort" });
  });

  ipcMain.handle("agent:new-session", async () => {
    log("new-session");
    return agent.sendCommand({ type: "new_session" });
  });

  ipcMain.handle("agent:get-state", async () => {
    return agent.sendCommand({ type: "get_state" });
  });

  ipcMain.on("agent:ui-response", (_e, response: Record<string, unknown>) => {
    log("ui-response:", JSON.stringify(response).slice(0, 120));
    agent.send(response);
  });

  ipcMain.handle("agent:restart", async () => {
    log("restart");
    agent.stop();
    agent.start();
  });

  ipcMain.handle("agent:reset-session", async () => {
    log("reset session — fresh start, no --continue");
    agent.stop();
    agent.resetSession();
    agent.start();
  });

  ipcMain.handle("agent:get-cwd", () => {
    return agent.getCwd();
  });

  ipcMain.handle("dialog:browse-directory", async () => {
    const result = await dialog.showOpenDialog({
      title: "Choose directory",
      defaultPath: agent.getCwd(),
      properties: ["openDirectory", "createDirectory"],
    });
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle("dialog:select-directory", async (e) => {
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
    }
    return dir;
  });

  ipcMain.handle("config:get", () => {
    return loadConfig();
  });

  ipcMain.handle(
    "apiKey:validate",
    async (_e, provider: string, key: string): Promise<{ valid: boolean; error?: string }> => {
      return validateApiKey(provider, key);
    },
  );

  ipcMain.handle("config:save", async (_e, config: LoomConfig) => {
    try {
      saveConfig(config);
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

  ipcMain.handle("file:open", async (_e, filePath: string) => {
    log("open file:", filePath);
    const ext = path.extname(filePath).toLowerCase();
    // HTML files → new Electron window (so user can view reports)
    if (ext === ".html" || ext === ".htm") {
      const win = new BrowserWindow({
        width: 1200,
        height: 900,
        title: path.basename(filePath),
        webPreferences: { sandbox: true },
      });
      await win.loadURL("file://" + filePath);
      return { opened: true };
    }
    // Everything else → system default app
    const err = await shell.openPath(filePath);
    if (err) return { opened: false, error: err };
    return { opened: true };
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
): Promise<{ valid: boolean; error?: string }> {
  const trimmed = key.trim();
  if (!trimmed) return { valid: false, error: "Key is empty" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
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
