import { contextBridge, ipcRenderer } from "electron";

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

export interface UiRequest {
  type: "extension_ui_request";
  id: string;
  method: string;
  [key: string]: unknown;
}

export interface ReplayTool {
  id: string;
  name: string;
  resultText?: string;
  isError?: boolean;
}

export interface ReplaySegment {
  role: "user" | "assistant";
  text: string;
  tools?: ReplayTool[];
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  pcpu: number;
  pmem: number;
  rss: number;
  etime: string;
  nlwp: number;
  command: string;
}

export interface OrbitAPI {
  prompt(message: string): Promise<void>;
  abort(): Promise<void>;
  newSession(): Promise<{ cancelled: boolean }>;
  getState(): Promise<unknown>;
  getCwd(): Promise<string>;
  openFile(filePath: string): Promise<{ opened: boolean; error?: string }>;
  getConfig(): Promise<Record<string, unknown>>;
  saveConfig(config: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
  validateApiKey(provider: string, key: string): Promise<{ valid: boolean; error?: string }>;
  respondToUiRequest(id: string, response: Record<string, unknown>): void;
  restartAgent(): Promise<void>;
  resetSession(): Promise<void>;
  selectDirectory(): Promise<string | null>;
  browseDirectory(): Promise<string | null>;
  onAgentEvent(callback: (event: AgentEvent) => void): () => void;
  onUiRequest(callback: (request: UiRequest) => void): () => void;
  onAgentStatus(
    callback: (status: "running" | "stopped" | "error", msg?: string) => void
  ): () => void;
  onCwdChanged(callback: (dir: string) => void): () => void;
  onOpenPreferences(callback: () => void): () => void;
  onProcUpdate(callback: (procs: ProcInfo[]) => void): () => void;
  onSessionHistory(callback: (history: ReplaySegment[]) => void): () => void;
}

const api: OrbitAPI = {
  prompt: (message) => ipcRenderer.invoke("agent:prompt", message),
  abort: () => ipcRenderer.invoke("agent:abort"),
  newSession: () => ipcRenderer.invoke("agent:new-session"),
  getState: () => ipcRenderer.invoke("agent:get-state"),
  getCwd: () => ipcRenderer.invoke("agent:get-cwd"),
  openFile: (filePath) => ipcRenderer.invoke("file:open", filePath),
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  validateApiKey: (provider, key) => ipcRenderer.invoke("apiKey:validate", provider, key),

  respondToUiRequest: (id, response) => {
    ipcRenderer.send("agent:ui-response", {
      type: "extension_ui_response",
      id,
      ...response,
    });
  },

  restartAgent: () => ipcRenderer.invoke("agent:restart"),
  resetSession: () => ipcRenderer.invoke("agent:reset-session"),
  selectDirectory: () => ipcRenderer.invoke("dialog:select-directory"),
  browseDirectory: () => ipcRenderer.invoke("dialog:browse-directory"),

  onAgentEvent: (callback) => {
    const handler = (_e: unknown, event: AgentEvent) => callback(event);
    ipcRenderer.on("agent:event", handler);
    return () => ipcRenderer.removeListener("agent:event", handler);
  },

  onUiRequest: (callback) => {
    const handler = (_e: unknown, request: UiRequest) => callback(request);
    ipcRenderer.on("agent:ui-request", handler);
    return () => ipcRenderer.removeListener("agent:ui-request", handler);
  },

  onAgentStatus: (callback) => {
    const handler = (
      _e: unknown,
      status: "running" | "stopped" | "error",
      msg?: string
    ) => callback(status, msg);
    ipcRenderer.on("agent:status", handler);
    return () => ipcRenderer.removeListener("agent:status", handler);
  },

  onCwdChanged: (callback) => {
    const handler = (_e: unknown, dir: string) => callback(dir);
    ipcRenderer.on("agent:cwd-changed", handler);
    return () => ipcRenderer.removeListener("agent:cwd-changed", handler);
  },

  onOpenPreferences: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("menu:open-preferences", handler);
    return () => ipcRenderer.removeListener("menu:open-preferences", handler);
  },

  onProcUpdate: (callback) => {
    const handler = (_e: unknown, procs: ProcInfo[]) => callback(procs);
    ipcRenderer.on("proc:update", handler);
    return () => ipcRenderer.removeListener("proc:update", handler);
  },

  onSessionHistory: (callback) => {
    const handler = (_e: unknown, history: ReplaySegment[]) => callback(history);
    ipcRenderer.on("agent:session-history", handler);
    return () => ipcRenderer.removeListener("agent:session-history", handler);
  },
};

contextBridge.exposeInMainWorld("orbit", api);
