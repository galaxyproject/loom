import { app, BrowserWindow, Menu, dialog, powerMonitor, nativeImage, protocol, net, shell } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { registerIpcHandlers, confirmCwdChange } from "./ipc-handlers.js";
import { AgentManager } from "./agent.js";
import { registerFilesIpc, startFilesWatcher, stopFilesWatcher } from "./files-handler.js";
import { ProcMonitor } from "./proc-monitor.js";

// Workaround for systems where chrome-sandbox isn't suid root
app.commandLine.appendSwitch("no-sandbox");

// Custom scheme for serving files out of the current analysis cwd. The renderer
// rewrites relative <img src> in notebook.md to orbit-artifact://cwd/<path>, and
// the handler below resolves that against agentManager.getCwd() at request time.
// Registered BEFORE app is ready so the privilege flags take effect.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "orbit-artifact",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

// Orbit-specific shell state lives in ~/.orbit/ so multiple Loom shells can
// coexist without stepping on each other. Brain config remains at ~/.loom/.
const ORBIT_DIR = path.join(os.homedir(), ".orbit");
const LOOM_DIR = path.join(os.homedir(), ".loom");
const WINDOW_STATE_FILE = path.join(ORBIT_DIR, "window-state.json");
const DEFAULT_CWD = path.join(LOOM_DIR, "analyses");

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

function log(...args: unknown[]): void {
  console.log("[main]", ...args);
}

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

function loadWindowState(): WindowState {
  try {
    const data = readFileSync(WINDOW_STATE_FILE, "utf-8");
    const state = JSON.parse(data) as WindowState;
    if (state.width > 0 && state.height > 0) return state;
  } catch {}
  return { width: 1400, height: 900 };
}

function saveWindowState(win: BrowserWindow): void {
  try {
    mkdirSync(ORBIT_DIR, { recursive: true });
    const bounds = win.getBounds();
    writeFileSync(WINDOW_STATE_FILE, JSON.stringify(bounds));
  } catch {}
}

let mainWindow: BrowserWindow | null = null;
let agentManager: AgentManager | null = null;
let procMonitor: ProcMonitor | null = null;

function getDefaultCwd(): string {
  // Priority: env var > brain config.defaultCwd > hardcoded default
  let cwd = process.env.LOOM_CWD;
  if (!cwd) {
    try {
      const configPath = path.join(LOOM_DIR, "config.json");
      if (fs.existsSync(configPath)) {
        const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        if (cfg.defaultCwd) cwd = cfg.defaultCwd;
      }
    } catch {}
  }
  cwd = cwd || DEFAULT_CWD;
  if (cwd.startsWith("~")) cwd = path.join(os.homedir(), cwd.slice(1));
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

/**
 * Decide what to do with a URL the renderer asked to open.
 *
 * - http(s) on localhost / 127.* / ::1 → open in our own BrowserWindow
 *   (this is how IGV.js viewers, local report servers, etc. work).
 * - https:// elsewhere → hand off to the OS browser via shell.openExternal
 *   so the user's normal trust UI (cert warnings, password manager) applies.
 * - http:// elsewhere, mailto:, tel:, file:, javascript:, anything else →
 *   hand off to shell.openExternal, which will refuse javascript:/file:
 *   on every platform.
 *
 * Previously this opened ANY URL in a privileged BrowserWindow with
 * `sandbox: false`, meaning a notebook link to javascript:foo() or a
 * malicious http page could run code in a renderer that shares the
 * orbit-artifact protocol privileges.
 */
function openExternalUrlWindow(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    log("openExternalUrlWindow rejected — not a valid URL:", url);
    return;
  }
  const proto = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === "localhost" || host.startsWith("127.") || host === "::1";

  if ((proto === "http:" || proto === "https:") && isLoopback) {
    const win = new BrowserWindow({
      width: 1400,
      height: 900,
      title: parsed.host,
      webPreferences: {
        // Match the main window's sandbox stance — flip to true once
        // chrome-sandbox SUID is set up (C2b).
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    win.setMenuBarVisibility(true);
    win.loadURL(url).catch((err) => log("failed to load loopback url:", url, err));
    return;
  }

  if (proto === "https:") {
    shell.openExternal(url).catch((err) => log("openExternal failed:", url, err));
    return;
  }

  // http://non-loopback, mailto:, tel:, file:, javascript:, etc. — defer to
  // the OS so its own policies kick in (mailto opens the mail client, etc.).
  // shell.openExternal refuses javascript: and file: as a hard rule.
  log("openExternalUrlWindow → shell.openExternal:", url);
  shell.openExternal(url).catch((err) => log("openExternal refused:", url, err));
}

function createWindow(cwd: string): void {
  log("creating window, cwd:", cwd);
  const saved = loadWindowState();

  const iconPath = path.join(__dirname, "../../src/renderer/assets/icons/icon-512.png");
  const appIcon = nativeImage.createFromPath(iconPath);
  log("icon path:", iconPath, "empty:", appIcon.isEmpty(), "size:", appIcon.getSize());

  mainWindow = new BrowserWindow({
    ...saved,
    minWidth: 800,
    minHeight: 600,
    title: "Orbit",
    icon: appIcon,
    show: true,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.platform === "darwin" && !appIcon.isEmpty()) {
    app.dock?.setIcon(appIcon);
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  // Keep the main window on the renderer; external URLs (including file://
  // links from the notebook — IGV viewers, reports, etc.) open in new
  // Orbit-managed windows so the main app never navigates away.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const devUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL;
    // In dev, allow the Vite server URL (hot-reload / in-app routes).
    if (devUrl && url.startsWith(devUrl)) return;
    // In prod, allow self-refresh of the loaded bundle index.
    const currentUrl = mainWindow?.webContents.getURL() || "";
    if (currentUrl && url === currentUrl) return;
    event.preventDefault();
    log("intercepted navigation → new window:", url);
    openExternalUrlWindow(url);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    log("window open handler → new window:", url);
    openExternalUrlWindow(url);
    return { action: "deny" };
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
  }

  agentManager = new AgentManager(mainWindow, cwd);
  registerIpcHandlers(agentManager);
  registerFilesIpc(() => agentManager?.getCwd() ?? cwd);
  startFilesWatcher(mainWindow, cwd);

  procMonitor = new ProcMonitor(mainWindow, () => agentManager?.getPid() ?? null);

  mainWindow.webContents.once("did-finish-load", () => {
    log("renderer loaded, starting agent");
    agentManager!.start();
    procMonitor!.start();
  });

  // Diagnostic listeners (macOS display-sleep UI-wipe bug tracking)
  const wc = mainWindow.webContents;
  let renderReloadDone = false;
  wc.on("render-process-gone", (_e, details) => {
    log("[diag] render-process-gone:", details.reason, "exitCode:", details.exitCode);
    // Recover from a one-off renderer crash by reloading once. Multiple
    // crashes leave the blank window so the user notices something is
    // wrong rather than seeing infinite reload churn.
    if (renderReloadDone) {
      log("renderer already reloaded once this session; not retrying");
      return;
    }
    renderReloadDone = true;
    if (details.reason === "killed" || details.reason === "clean-exit") return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      log("auto-reloading renderer after crash");
      mainWindow.reload();
    }
  });
  wc.on("unresponsive", () => log("[diag] webContents unresponsive"));
  wc.on("responsive", () => log("[diag] webContents responsive"));

  mainWindow.on("close", () => {
    if (mainWindow) saveWindowState(mainWindow);
  });

  mainWindow.on("closed", () => {
    log("window closed");
    // Tear down everything tied to this window. Without these, on macOS
    // (where windows can close without quitting the app), a follow-up
    // `activate` would create a new AgentManager while the previous brain
    // subprocess kept running — leaking processes and keeping stale FS
    // watchers / proc-monitor timers alive.
    try { agentManager?.stop(); } catch (err) { log("agentManager.stop on close failed:", err); }
    agentManager = null;
    try { procMonitor?.stop(); } catch (err) { log("procMonitor.stop on close failed:", err); }
    procMonitor = null;
    try { stopFilesWatcher(); } catch (err) { log("stopFilesWatcher on close failed:", err); }
    mainWindow = null;
  });
}

function openPreferences(): void {
  if (mainWindow) mainWindow.webContents.send("menu:open-preferences");
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Orbit",
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Preferences...",
          accelerator: "CmdOrCtrl+,",
          click: openPreferences,
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "Open Analysis Directory...",
          accelerator: "CmdOrCtrl+O",
          click: async () => {
            if (!agentManager || !mainWindow) return;
            if (!(await confirmCwdChange(mainWindow))) return;
            const result = await dialog.showOpenDialog({
              title: "Choose analysis directory",
              defaultPath: agentManager.getCwd(),
              properties: ["openDirectory", "createDirectory"],
            });
            if (result.canceled || result.filePaths.length === 0) return;
            const dir = result.filePaths[0];
            if (agentManager.switchCwd(dir)) {
              log("switched cwd to:", dir);
              mainWindow.webContents.send("agent:cwd-changed", dir);
              startFilesWatcher(mainWindow, dir);
            }
          },
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "toggleDevTools" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Slash Commands",
          click: () => {
            if (mainWindow) mainWindow.webContents.send("menu:show-slash-commands");
          },
        },
        { type: "separator" },
        {
          label: "Orbit Documentation",
          click: () => {
            import("electron").then(({ shell }) => {
              shell.openExternal("https://github.com/dannon/loom");
            });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.setName("Orbit");

app.whenReady().then(() => {
  log("app ready");

  // Serve files from the current analysis cwd over orbit-artifact://. Relative
  // image srcs in notebook.md (e.g. 10_figures/foo.png) are rewritten by the
  // renderer to orbit-artifact://cwd/10_figures/foo.png and land here.
  protocol.handle("orbit-artifact", async (req) => {
    try {
      const cwd = agentManager?.getCwd();
      if (!cwd) return new Response(null, { status: 404 });
      const url = new URL(req.url);
      const rel = decodeURIComponent(url.pathname.replace(/^\//, ""));
      if (!rel) return new Response(null, { status: 400 });
      const abs = path.resolve(cwd, rel);
      let cwdReal: string;
      let absReal: string;
      try {
        cwdReal = fs.realpathSync(cwd);
        absReal = fs.realpathSync(abs);
      } catch {
        return new Response(null, { status: 404 });
      }
      // Refuse anything that escapes the cwd via .. or symlinks.
      if (absReal !== cwdReal && !absReal.startsWith(cwdReal + path.sep)) {
        return new Response(null, { status: 403 });
      }
      return net.fetch(pathToFileURL(absReal).toString());
    } catch {
      return new Response(null, { status: 500 });
    }
  });

  buildMenu();
  const cwd = getDefaultCwd();
  log("cwd:", cwd);
  createWindow(cwd);

  powerMonitor.on("suspend", () => log("[diag] powerMonitor suspend"));
  powerMonitor.on("resume", () => log("[diag] powerMonitor resume"));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(cwd);
    }
  });
});

app.on("window-all-closed", () => {
  log("all windows closed");
  agentManager?.stop();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  log("before-quit");
  agentManager?.stop();
});
