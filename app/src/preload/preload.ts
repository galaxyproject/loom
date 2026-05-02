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
  command: string;
}

export interface FileNode {
  name: string;
  relPath: string;
  type: "file" | "directory";
  size?: number;
  children?: FileNode[];
}

export interface OrbitAPI {
  prompt(message: string): Promise<void>;
  abort(): Promise<void>;
  newSession(): Promise<{ cancelled: boolean }>;
  getState(): Promise<unknown>;
  getCwd(): Promise<string>;
  openFile(filePath: string): Promise<{ opened: boolean; error?: string }>;
  listFiles(opts?: { includeHidden?: boolean }): Promise<
    | { ok: true; root: FileNode; cwd: string }
    | { ok: false; error: string }
  >;
  readFile(relPath: string): Promise<
    | { ok: true; size: number; bytes: Uint8Array }
    | { ok: false; error: string; size?: number }
  >;
  writeFile(relPath: string, content: string): Promise<{ ok: true } | { ok: false; error: string }>;
  onFilesChanged(callback: () => void): () => void;
  getConfig(): Promise<Record<string, unknown>>;
  saveConfig(config: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
  validateApiKey(provider: string, key: string): Promise<{ valid: boolean; error?: string }>;
  respondToUiRequest(id: string, response: Record<string, unknown>): void;
  restartAgent(): Promise<void>;
  resetSession(): Promise<void>;
  selectDirectory(): Promise<string | null>;
  browseDirectory(): Promise<string | null>;
  notebookStatus(): Promise<{ exists: boolean; hasContent: boolean }>;
  clearNotebookArtifacts(): Promise<{ cleared: boolean; error?: string }>;
  onAgentEvent(callback: (event: AgentEvent) => void): () => void;
  onUiRequest(callback: (request: UiRequest) => void): () => void;
  onAgentStatus(
    callback: (status: "running" | "stopped" | "error", msg?: string) => void
  ): () => void;
  getAgentStatus(): Promise<{ status: "running" | "stopped" | "error"; message?: string }>;
  onCwdChanged(callback: (dir: string) => void): () => void;
  onOpenPreferences(callback: () => void): () => void;
  onShowSlashCommands(callback: () => void): () => void;
  onProcUpdate(callback: (procs: ProcInfo[]) => void): () => void;
  onSessionHistory(callback: (history: ReplaySegment[]) => void): () => void;
  replayChat(): Promise<{ ok: true; segments: number } | { ok: false; error: string }>;
  getReportSysinfo(): Promise<{
    appVersion: string;
    electronVersion: string;
    nodeVersion: string;
    chromeVersion: string;
    platform: string;
    arch: string;
  }>;
  openIssueReport(payload: { title: string; body: string }): Promise<{ opened: boolean }>;
  listAllModels(): Promise<
    | { ok: true; providers: Record<string, Array<{
        id: string;
        label: string;
        pricing: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
      }>> }
    | { ok: false; error: string }
  >;
}

const api: OrbitAPI = {
  prompt: (message) => ipcRenderer.invoke("agent:prompt", message),
  abort: () => ipcRenderer.invoke("agent:abort"),
  newSession: () => ipcRenderer.invoke("agent:new-session"),
  getState: () => ipcRenderer.invoke("agent:get-state"),
  getCwd: () => ipcRenderer.invoke("agent:get-cwd"),
  openFile: (filePath) => ipcRenderer.invoke("file:open", filePath),
  listFiles: (opts) => ipcRenderer.invoke("files:list", opts),
  readFile: (relPath) => ipcRenderer.invoke("files:read", relPath),
  writeFile: (relPath, content) => ipcRenderer.invoke("files:write", relPath, content),
  onFilesChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("files:changed", handler);
    return () => ipcRenderer.removeListener("files:changed", handler);
  },
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
  notebookStatus: () => ipcRenderer.invoke("notebook:status"),
  clearNotebookArtifacts: () => ipcRenderer.invoke("notebook:clear-artifacts"),

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

  getAgentStatus: () => ipcRenderer.invoke("agent:get-status"),

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

  onShowSlashCommands: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("menu:show-slash-commands", handler);
    return () => ipcRenderer.removeListener("menu:show-slash-commands", handler);
  },

  onProcUpdate: (callback) => {
    const handler = (_e: unknown, procs: ProcInfo[]) => callback(procs);
    ipcRenderer.on("proc:update", handler);
    return () => ipcRenderer.removeListener("proc:update", handler);
  },

  replayChat: () => ipcRenderer.invoke("chat:replay"),

  getReportSysinfo: () => ipcRenderer.invoke("report:sysinfo"),
  openIssueReport: (payload) => ipcRenderer.invoke("report:open-issue", payload),

  listAllModels: () => ipcRenderer.invoke("models:list-all"),
  onSessionHistory: (callback) => {
    const handler = (_e: unknown, history: ReplaySegment[]) => callback(history);
    ipcRenderer.on("agent:session-history", handler);
    return () => ipcRenderer.removeListener("agent:session-history", handler);
  },
};

contextBridge.exposeInMainWorld("orbit", api);
