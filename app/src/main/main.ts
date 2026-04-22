import { app, BrowserWindow, Menu, dialog, powerMonitor, nativeImage } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { registerIpcHandlers, confirmCwdChange } from "./ipc-handlers.js";
import { AgentManager } from "./agent.js";
import { ProcMonitor } from "./proc-monitor.js";

// Workaround for systems where chrome-sandbox isn't suid root
app.commandLine.appendSwitch("no-sandbox");

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
 * Open an external URL in a new BrowserWindow. Used for things like IGV.js
 * viewers served on localhost, HTML reports, external docs — anything that
 * would otherwise navigate the main window away from the Orbit renderer.
 */
function openExternalUrlWindow(url: string): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: url,
    webPreferences: {
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(true);
  win.loadURL(url).catch((err) => {
    log("failed to load external url:", url, err);
  });
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

  // Keep the main window on the renderer; external URLs open in new windows.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const devUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL;
    if (devUrl && url.startsWith(devUrl)) return;
    if (url.startsWith("file://")) return;
    event.preventDefault();
    log("intercepted external navigation → new window:", url);
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

  procMonitor = new ProcMonitor(mainWindow, () => agentManager?.getPid() ?? null);

  mainWindow.webContents.once("did-finish-load", () => {
    log("renderer loaded, starting agent");
    agentManager!.start();
    procMonitor!.start();
  });

  // Diagnostic listeners (macOS display-sleep UI-wipe bug tracking)
  const wc = mainWindow.webContents;
  wc.on("render-process-gone", (_e, details) =>
    log("[diag] render-process-gone:", details.reason, "exitCode:", details.exitCode));
  wc.on("unresponsive", () => log("[diag] webContents unresponsive"));
  wc.on("responsive", () => log("[diag] webContents responsive"));

  mainWindow.on("close", () => {
    if (mainWindow) saveWindowState(mainWindow);
  });

  mainWindow.on("closed", () => {
    log("window closed");
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
