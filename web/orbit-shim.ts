/**
 * Web transport for the Orbit API. Replaces Electron's contextBridge
 * preload with a WebSocket connection to the local server.
 *
 * The server bridges WebSocket messages to the loom subprocess's
 * JSON-lines stdin/stdout -- same RPC protocol, different pipe.
 */

import { decodeEventPayload } from "./event-payload.js";
import { decodeListResponse, decodeReadResponse, transportRefusal } from "./files-wire.js";

type Callback<T extends unknown[]> = (...args: T) => void;

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
}

// Carry a ?token=... from the page URL onto the socket so an exposed server
// (LOOM_WEB_TOKEN set) accepts us; wss when the page is served over https.
const WS_PROTO = window.location.protocol === "https:" ? "wss" : "ws";
const WS_TOKEN = new URLSearchParams(window.location.search).get("token");
const WS_URL =
  `${WS_PROTO}://${window.location.host}/ws` +
  (WS_TOKEN ? `?token=${encodeURIComponent(WS_TOKEN)}` : "");
let ws: WebSocket;
let idCounter = 0;
const pending = new Map<string, PendingRequest>();
const listeners: Record<string, Set<Callback<unknown[]>>> = {};
// Buffer for messages produced before the WS reaches OPEN. The renderer issues
// `window.orbit.getConfig()` synchronously at startup, before this socket's
// async handshake completes -- dropping that message would hang the promise
// forever and leave `body.remote-mode` unset.
const outbox: string[] = [];

function emit(event: string, ...args: unknown[]): void {
  listeners[event]?.forEach((cb) => cb(...args));
}

function on<T extends unknown[]>(event: string, cb: Callback<T>): () => void {
  const listener = cb as Callback<unknown[]>;
  if (!listeners[event]) listeners[event] = new Set();
  listeners[event].add(listener);
  return () => listeners[event].delete(listener);
}

function send(msg: Record<string, unknown>): boolean {
  const serialized = JSON.stringify(msg);
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(serialized);
    return true;
  }
  if (ws.readyState === WebSocket.CONNECTING) {
    outbox.push(serialized);
    return true;
  }
  // CLOSING / CLOSED: caller (invoke) rejects the promise so a call made
  // during the reconnect window doesn't hang waiting for a response that
  // will never come.
  return false;
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const id = `web_${++idCounter}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    if (!send({ id, channel, args })) {
      pending.delete(id);
      reject(new Error("WebSocket disconnected"));
    }
  });
}

function connect(): void {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("[orbit-web] connected");
    while (outbox.length) ws.send(outbox.shift()!);
    emit("ws:open");
  };

  ws.onclose = () => {
    console.log("[orbit-web] disconnected, reconnecting in 2s...");
    // Anything queued during CONNECTING was tied to the now-dead brain; drop
    // it. Reject every in-flight invoke so callers don't hang on a response
    // that will never arrive.
    outbox.length = 0;
    const err = new Error("WebSocket disconnected");
    for (const req of pending.values()) req.reject(err);
    pending.clear();
    emit("ws:close");
    setTimeout(connect, 2000);
  };

  ws.onmessage = (ev) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(ev.data as string);
    } catch {
      return;
    }

    // Response to an invoke() call
    if (data._response && data._id) {
      const p = pending.get(data._id as string);
      if (p) {
        pending.delete(data._id as string);
        if (data._error) p.reject(new Error(data._error as string));
        else p.resolve(data._result);
      }
      return;
    }

    // Agent event forwarded from server
    const type = data._event as string | undefined;
    if (type) {
      emit(type, ...decodeEventPayload(data._payload));
      return;
    }
  };
}

connect();

let cachedMode: "remote" | "desktop" | undefined;

async function fetchMode(): Promise<"remote" | "desktop"> {
  if (cachedMode) return cachedMode;
  const cfg = (await invoke("config:get")) as { _mode?: string } | null;
  cachedMode = cfg?._mode === "remote" ? "remote" : "desktop";
  return cachedMode;
}

// Expose the same OrbitAPI shape the renderer expects.
(window as unknown as Record<string, unknown>).orbit = {
  prompt: (message: string) => invoke("agent:prompt", message),
  abort: () => invoke("agent:abort"),
  newSession: () => invoke("agent:new-session"),
  getState: () => invoke("agent:get-state"),
  getCwd: () => invoke("agent:get-cwd"),
  openFile: async (filePath: string) => {
    if ((await fetchMode()) === "remote") return { opened: false };
    window.open(`/file?path=${encodeURIComponent(filePath)}`, "_blank");
    return { opened: true };
  },
  getConfig: () => invoke("config:get"),
  saveConfig: (config: unknown) => invoke("config:save", config),
  provideLlmKey: (provider: string, key: string) =>
    invoke("agent:provide-llm-key", { provider, key }),
  respondToUiRequest: (id: string, response: Record<string, unknown>) => {
    send({
      channel: "agent:ui-response",
      args: [{ type: "extension_ui_response", id, ...response }],
    });
  },
  restartAgent: () => invoke("agent:restart"),
  resetSession: () => invoke("agent:reset-session"),
  selectDirectory: async () => {
    if ((await fetchMode()) === "remote") return null;
    // No native file picker in browsers -- prompt for a path
    const path = window.prompt("Enter working directory path:");
    if (path) {
      await invoke("agent:set-cwd", path);
    }
    return path || null;
  },
  browseDirectory: async () => {
    if ((await fetchMode()) === "remote") return null;
    const path = window.prompt("Enter directory path:");
    return path || null;
  },
  onAgentEvent: (cb: Callback<[unknown]>) => on("agent:event", cb),
  onUiRequest: (cb: Callback<[unknown]>) => on("agent:ui-request", cb),
  onAgentStatus: (cb: Callback<[string, string | undefined]>) => on("agent:status", cb),
  onCwdChanged: (cb: Callback<[string]>) => on("agent:cwd-changed", cb),
  onOpenPreferences: (cb: Callback<[]>) => on("menu:open-preferences", cb),
  onProcUpdate: (cb: Callback<[unknown[]]>) => on("proc:update", cb),

  // --- Stubs for OrbitAPI methods with no web/remote transport. The renderer is
  // built against the full desktop OrbitAPI; methods main added after this
  // shell's branch point (session restore, model catalog, update checks, OAuth,
  // key validation, feedback) would be `undefined` here and throw when the
  // renderer wires them at startup. The remote UI hides the controls that drive
  // most of these (body.remote-mode); these no-ops return the shapes consumers
  // expect so a stray call degrades gracefully instead of crashing.
  onFilesChanged: (cb: Callback<[]>) => on("agent:files-changed", cb),
  onDisplayResume: (cb: Callback<[]>) => on("agent:display-resume", cb),
  onShowSlashCommands: (cb: Callback<[]>) => on("menu:show-slash-commands", cb),
  onSessionHistory: (cb: Callback<[unknown]>) => on("agent:session-history", cb),
  onUpdateDownloaded: (cb: Callback<[unknown]>) => {
    on("update:downloaded", cb);
  },
  onUpdateError: (cb: Callback<[unknown]>) => {
    on("update:error", cb);
  },
  getAgentStatus: () => Promise.resolve({ status: "stopped", turnActive: false }),
  notebookStatus: () => Promise.resolve({ exists: false, hasContent: false }),
  clearNotebookArtifacts: () => Promise.resolve({ cleared: false }),
  replayChat: () =>
    Promise.resolve({ ok: false, error: "session restore is unavailable in remote mode" }),
  listAllModels: () =>
    Promise.resolve({ ok: false, error: "model catalog is unavailable in remote mode" }),
  // Empty map, not undefined: app.ts calls this at module load and three UI
  // paths await the result, so a missing stub is a TypeError that takes the
  // whole renderer down. Empty leaves the shared seed in place.
  oauthProviders: () => Promise.resolve({}),
  oauthStatus: () => Promise.resolve({ signedIn: false }),
  oauthSignIn: () => Promise.resolve({ ok: false, error: "OAuth is unavailable in remote mode" }),
  oauthSignOut: () => Promise.resolve({ ok: true }),
  validateApiKey: () => Promise.resolve({ valid: false, error: "unavailable in remote mode" }),
  discoverModels: () =>
    Promise.resolve({ ok: false, error: "model discovery is unavailable in remote mode" }),
  setBypassPermissions: () => Promise.resolve({ ok: false, enabled: false }),
  getReportSysinfo: () =>
    Promise.resolve({
      appVersion: "",
      electronVersion: "",
      nodeVersion: "",
      chromeVersion: "",
      platform: "web",
      arch: "",
      // The browser shell has no host to inspect; platform:"web" already says
      // this isn't a real Linux box.
      wsl: false,
    }),
  openIssueReport: () => Promise.resolve({ opened: false }),
  submitFeedback: () =>
    Promise.resolve({ ok: false, error: "feedback is unavailable in remote mode" }),
  // Read-only file surface, served by the web server out of the session cwd
  // and jailed to it (web/files-surface.ts). Bytes arrive base64-encoded
  // because the transport is JSON; files-wire rebuilds the Uint8Array the
  // renderer is typed against, and turns an older server's null for an
  // unknown channel into a refusal it can draw.
  listFiles: (opts?: { includeHidden?: boolean }) =>
    invoke("files:list", opts).then(decodeListResponse, (err) =>
      transportRefusal(err, "the files could not be listed"),
    ),
  readFile: (relPath: string, opts?: { tail?: boolean }) =>
    invoke("files:read", relPath, opts).then(decodeReadResponse, (err) =>
      transportRefusal(err, "the file could not be read"),
    ),
  // Read-only means read-only, and the file viewer's Save button is now
  // reachable here for the first time. Without this it would report
  // "window.orbit.writeFile is not a function" at the user.
  writeFile: () =>
    Promise.resolve({ ok: false as const, error: "the web shell opens files read-only" }),
  // These three are served by the web server out of the session cwd, so they
  // behave the same here as on the desktop: the notebook the brain is writing,
  // and the dashboard layout that sits beside it.
  loadNotebook: () => invoke("notebook:load"),
  loadDashboard: () => invoke("dashboard:load"),
  saveDashboard: (raw: string, baseRevision?: string | null) =>
    invoke("dashboard:save", raw, baseRevision),
  checkVersion: () => Promise.resolve(null),
  checkRepoMoved: () => Promise.resolve(null),
  openReleasePage: () => Promise.resolve({ opened: false }),
  restartToUpdate: () => Promise.resolve({ restarting: false }),
  platform: "web",
};
