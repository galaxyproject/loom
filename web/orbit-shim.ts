/**
 * Web transport for the Orbit API. Replaces Electron's contextBridge
 * preload with a WebSocket connection to the local server.
 *
 * The server bridges WebSocket messages to the loom subprocess's
 * JSON-lines stdin/stdout -- same RPC protocol, different pipe.
 */

type Callback<T extends unknown[]> = (...args: T) => void;

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
}

const WS_URL = `ws://${window.location.host}/ws`;
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
      emit(type, data._payload);
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
};
