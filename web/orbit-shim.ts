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

function emit(event: string, ...args: unknown[]): void {
  listeners[event]?.forEach((cb) => cb(...args));
}

function on(event: string, cb: Callback<unknown[]>): () => void {
  if (!listeners[event]) listeners[event] = new Set();
  listeners[event].add(cb);
  return () => listeners[event].delete(cb);
}

function send(msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const id = `web_${++idCounter}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ id, channel, args });
  });
}

function connect(): void {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("[orbit-web] connected");
    emit("ws:open");
  };

  ws.onclose = () => {
    console.log("[orbit-web] disconnected, reconnecting in 2s...");
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

// Expose the same OrbitAPI shape the renderer expects.
(window as Record<string, unknown>).orbit = {
  prompt: (message: string) => invoke("agent:prompt", message),
  abort: () => invoke("agent:abort"),
  newSession: () => invoke("agent:new-session"),
  getState: () => invoke("agent:get-state"),
  getCwd: () => invoke("agent:get-cwd"),
  openFile: (filePath: string) => {
    // In a browser, open via the server's file-serving endpoint
    window.open(`/file?path=${encodeURIComponent(filePath)}`, "_blank");
    return Promise.resolve({ opened: true });
  },
  getConfig: () => invoke("config:get"),
  saveConfig: (config: unknown) => invoke("config:save", config),
  respondToUiRequest: (id: string, response: Record<string, unknown>) => {
    send({ channel: "agent:ui-response", args: [{ type: "extension_ui_response", id, ...response }] });
  },
  restartAgent: () => invoke("agent:restart"),
  resetSession: () => invoke("agent:reset-session"),
  selectDirectory: async () => {
    // No native file picker in browsers -- prompt for a path
    const path = window.prompt("Enter working directory path:");
    if (path) {
      await invoke("agent:set-cwd", path);
    }
    return path || null;
  },
  browseDirectory: async () => {
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
