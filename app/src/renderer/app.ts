import { ChatPanel } from "./chat/chat-panel.js";
import { ShellPanel } from "./chat/shell-panel.js";
import { ArtifactPanel } from "./artifacts/artifact-panel.js";
import { FilesPanel } from "./files/files-panel.js";
import { FileViewer } from "./files/file-viewer.js";
import { refreshGalaxyInvocations } from "./galaxy-invocations.js";
import {
  LoomWidgetKey,
  decodeMarkdownWidget,
} from "../../../shared/loom-shell-contract.js";
import {
  ALLOWED_SKILLS_PREFIX,
  isAllowedSkillUrl,
} from "../../../shared/loom-config.js";

declare global {
  interface Window {
    orbit: import("../preload/preload.js").OrbitAPI;
  }
}

// ── Components ────────────────────────────────────────────────────────────────

const messagesEl = document.getElementById("messages")!;
const inputEl = document.getElementById("input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send-btn")!;
const abortBtn = document.getElementById("abort-btn")!;
const statusBadge = document.getElementById("agent-status")!;

const cwdPathEl = document.getElementById("cwd-path")!;
const cwdChangeBtn = document.getElementById("cwd-change")!;
const usageTokensEl = document.getElementById("usage-tokens")!;
const usageCostEl = document.getElementById("usage-cost")!;
const modelIndicatorEl = document.getElementById("model-indicator")!;
const modelIndicatorNameEl = document.getElementById("model-indicator-name")!;

const chat = new ChatPanel(messagesEl);
const artifacts = new ArtifactPanel();
const shell = new ShellPanel(document.getElementById("agent-shell-body")!);

// File tree sidebar + file viewer (wired up further below).
const filesPanel = new FilesPanel(
  document.getElementById("files-tree")!,
  (relPath: string) => void openFileFromTree(relPath),
);
const fileViewer = new FileViewer(artifacts.getFileViewContainer());

// File tab × → tear down the viewer and forget the file.
artifacts.onFileTabClose = () => {
  fileViewer.close();
  filesPanel.setSelected(null);
};

async function openFileFromTree(relPath: string): Promise<void> {
  const res = await window.orbit.readFile(relPath);
  if (!res.ok) {
    const sizeHint = typeof res.size === "number" ? ` (${res.size} bytes)` : "";
    chat.addErrorMessage(`Failed to open ${relPath}${sizeHint}: ${res.error}`);
    return;
  }
  const proceed = fileViewer.open(relPath, res.bytes, res.size);
  if (proceed) {
    artifacts.showFileTab();
    setArtifactCollapsed(false);
    filesPanel.setSelected(relPath);
  }
}

let streaming = false;

// ── Usage Tracking ────────────────────────────────────────────────────────────

// Per-1M-token pricing (USD). null = unknown → cost hidden.
// Fallback only — populateDynamicModelData() at startup overwrites this from
// pi-ai's bundled registry (via main IPC) so new models like Opus 4.7 don't
// require a hand-edit. Update as providers change pricing or add models.
let PRICING: Record<string, { in: number; out: number; cacheRead?: number; cacheWrite?: number }> = {
  // Anthropic
  "claude-opus-4-7":      { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-opus-4-6":      { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-opus-4-5":      { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-4-6":    { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-5":    { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5":     { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  // OpenAI
  "gpt-4o":               { in: 2.5, out: 10, cacheRead: 1.25 },
  "gpt-4o-mini":          { in: 0.15, out: 0.6, cacheRead: 0.075 },
  "gpt-4-turbo":          { in: 10, out: 30 },
  "o1":                   { in: 15, out: 60, cacheRead: 7.5 },
  "o1-mini":              { in: 3, out: 12, cacheRead: 1.5 },
  // Google
  "gemini-2.5-pro":       { in: 1.25, out: 10 },
  "gemini-2.5-flash":     { in: 0.15, out: 0.6 },
  // Ollama (local) — free
  "qwen3-coder:30b":      { in: 0, out: 0 },
  "qwen3:8b":             { in: 0, out: 0 },
};

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const sessionUsage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const turnUsage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
// Per-model cumulative usage so /cost can attribute tokens to the model that
// produced them (the user can switch models mid-session).
const perModelUsage = new Map<string, Usage>();
let currentModel: string | null = null;

// Pi's AssistantMessage.usage carries a `cost` object calculated upstream
// from its authoritative rate table (`calculateCost` in pi-ai/models.js).
// We accumulate that directly so the footer is immune to rate drift in the
// local PRICING map. `null` until we've seen at least one Pi-reported cost;
// after that, it's the source of truth for the footer cost string.
let sessionCostFromPi: number | null = null;
let turnCostFromPi: number = 0;

/** Match a model ID against the pricing table (handles date suffixes). */
function findPricing(model: string): { in: number; out: number; cacheRead?: number; cacheWrite?: number } | null {
  // Exact match first
  if (PRICING[model]) return PRICING[model];
  // Strip date suffix (e.g. claude-opus-4-6-20250514)
  const stripped = model.replace(/-\d{8}$/, "");
  if (PRICING[stripped]) return PRICING[stripped];
  // Prefix match
  for (const key of Object.keys(PRICING)) {
    if (model.startsWith(key)) return PRICING[key];
  }
  return null;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function computeCost(u: Usage, model: string | null): number | null {
  if (!model) return null;
  const p = findPricing(model);
  if (!p) return null;
  const cost =
    (u.input * p.in) / 1_000_000 +
    (u.output * p.out) / 1_000_000 +
    (u.cacheRead * (p.cacheRead ?? p.in)) / 1_000_000 +
    (u.cacheWrite * (p.cacheWrite ?? p.in)) / 1_000_000;
  return cost;
}

function renderUsage(): void {
  const total = sessionUsage.input + sessionUsage.output + sessionUsage.cacheRead + sessionUsage.cacheWrite;
  usageTokensEl.textContent = `${formatTokens(total)} tok`;
  usageTokensEl.title =
    `Session usage:\n` +
    `  input: ${sessionUsage.input.toLocaleString()}\n` +
    `  output: ${sessionUsage.output.toLocaleString()}\n` +
    `  cache read: ${sessionUsage.cacheRead.toLocaleString()}\n` +
    `  cache write: ${sessionUsage.cacheWrite.toLocaleString()}` +
    (currentModel ? `\nmodel: ${currentModel}` : "");

  // Prefer Pi's upstream-calculated cost over the renderer's local PRICING
  // map — eliminates rate-drift as a failure mode. Fall back to local
  // computation for models Pi doesn't price (e.g., local Ollama models).
  const cost = sessionCostFromPi ?? computeCost(sessionUsage, currentModel);
  if (cost !== null) {
    usageCostEl.textContent = cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
    const localCost = computeCost(sessionUsage, currentModel);
    const source = sessionCostFromPi !== null ? "pi-ai" : "local PRICING";
    usageCostEl.title =
      `Session cost: $${cost.toFixed(4)}\n` +
      `Source: ${source}\n` +
      (sessionCostFromPi !== null && localCost !== null
        ? `Local fallback would be $${localCost.toFixed(4)}`
        : "");
    usageCostEl.classList.remove("hidden");
  } else {
    usageCostEl.textContent = "";
    usageCostEl.classList.add("hidden");
  }
}

/** Format a long model id into a short display label, e.g. claude-sonnet-4-6 → "Sonnet 4.6". */
function shortModelLabel(model: string): string {
  // Strip date suffix (claude-opus-4-6-20250514 → claude-opus-4-6)
  const id = model.replace(/-\d{8}$/, "");
  // Anthropic
  const cm = id.match(/^claude-(opus|sonnet|haiku)-(\d+(?:-\d+)?)/);
  if (cm) {
    const family = cm[1].charAt(0).toUpperCase() + cm[1].slice(1);
    const ver = cm[2].replace(/-/g, ".");
    return `${family} ${ver}`;
  }
  // OpenAI
  if (id.startsWith("gpt-")) return id.toUpperCase().replace("GPT-", "GPT-");
  if (id === "o1") return "o1";
  if (id === "o1-mini") return "o1 mini";
  // Google
  if (id.startsWith("gemini-")) return id.replace("gemini-", "Gemini ").replace(/-/g, " ");
  // Ollama / local Qwen models — display as "Qwen3-Coder 30B (local)" etc.
  const qm = id.match(/^qwen(\d+)(-coder)?:(\d+\w*)$/);
  if (qm) {
    const family = `Qwen${qm[1]}${qm[2] ? "-Coder" : ""}`;
    return `${family} ${qm[3].toUpperCase()} (local)`;
  }
  // Default: return as-is
  return id;
}

function renderModelIndicator(): void {
  if (currentModel) {
    modelIndicatorNameEl.textContent = shortModelLabel(currentModel);
    modelIndicatorEl.title = `Model: ${currentModel}\nClick to change in Preferences`;
    modelIndicatorEl.classList.remove("hidden");
  } else {
    modelIndicatorEl.classList.add("hidden");
  }
}

modelIndicatorEl.addEventListener("click", () => {
  void openPreferences();
});

// ── Artifact pane collapse/expand ────────────────────────────────────────────

const ARTIFACT_COLLAPSED_KEY = "orbit.artifactCollapsed";
const artifactToggleBtn = document.getElementById("artifact-toggle")!;

// Apply visual state without persisting; used by responsive auto-collapse.
function applyArtifactCollapsed(collapsed: boolean): void {
  document.body.classList.toggle("artifact-collapsed", collapsed);
}
// User-initiated toggle; persists to localStorage.
function setArtifactCollapsed(collapsed: boolean): void {
  applyArtifactCollapsed(collapsed);
  localStorage.setItem(ARTIFACT_COLLAPSED_KEY, collapsed ? "1" : "0");
}

// Default: collapsed (single-pane chat). Auto-reveals on first plan event.
const savedCollapsed = localStorage.getItem(ARTIFACT_COLLAPSED_KEY);
setArtifactCollapsed(savedCollapsed === null ? true : savedCollapsed === "1");

artifactToggleBtn.addEventListener("click", () => {
  setArtifactCollapsed(!document.body.classList.contains("artifact-collapsed"));
});

// Cmd/Ctrl+\ keyboard shortcut
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "\\") {
    e.preventDefault();
    setArtifactCollapsed(!document.body.classList.contains("artifact-collapsed"));
  }
});

// ── Files sidebar collapse/expand ────────────────────────────────────────────

const FILES_COLLAPSED_KEY = "orbit.filesCollapsed";
const FILES_WIDTH_KEY = "orbit.filesPaneWidth";
const filesToggleBtn = document.getElementById("files-toggle")!;
const filesPaneEl = document.getElementById("files-pane")!;
const filesDivider = document.getElementById("files-divider")!;
const filesRefreshBtn = document.getElementById("files-refresh")!;
const filesShowHiddenBtn = document.getElementById("files-show-hidden")!;

function applyFilesCollapsed(collapsed: boolean): void {
  document.body.classList.toggle("files-collapsed", collapsed);
}
function setFilesCollapsed(collapsed: boolean): void {
  applyFilesCollapsed(collapsed);
  localStorage.setItem(FILES_COLLAPSED_KEY, collapsed ? "1" : "0");
}

// Restore persisted pane width.
const savedFilesWidth = parseInt(localStorage.getItem(FILES_WIDTH_KEY) ?? "", 10);
if (Number.isFinite(savedFilesWidth) && savedFilesWidth >= 160 && savedFilesWidth <= 480) {
  filesPaneEl.style.flex = `0 0 ${savedFilesWidth}px`;
}

// Default: visible (users came here to see files).
const savedFilesCollapsed = localStorage.getItem(FILES_COLLAPSED_KEY);
setFilesCollapsed(savedFilesCollapsed === "1");

filesToggleBtn.addEventListener("click", () => {
  setFilesCollapsed(!document.body.classList.contains("files-collapsed"));
});

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "b" || e.key === "B")) {
    // Allow native Ctrl+B (bold) inside any editable text field — only
    // intercept when focus is outside inputs/textareas/contenteditable.
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
      return;
    }
    e.preventDefault();
    setFilesCollapsed(!document.body.classList.contains("files-collapsed"));
  }
});

// ── Responsive auto-collapse ────────────────────────────────────────────────
//
// Pane min-widths sum to ~748 px; below that the layout would force a
// horizontal scrollbar. Auto-collapse on tier crossings (not every resize),
// and use the apply* (non-persisting) helpers so the user's saved
// preference is restored when the window widens again.
const FILES_BREAKPOINT = 900;
const ARTIFACT_BREAKPOINT = 700;
let lastFilesNarrow = window.innerWidth < FILES_BREAKPOINT;
let lastArtifactNarrow = window.innerWidth < ARTIFACT_BREAKPOINT;

function applyResponsiveLayout(): void {
  const w = window.innerWidth;
  const filesNarrow = w < FILES_BREAKPOINT;
  const artifactNarrow = w < ARTIFACT_BREAKPOINT;

  if (filesNarrow !== lastFilesNarrow) {
    if (filesNarrow) {
      applyFilesCollapsed(true);
    } else {
      const saved = localStorage.getItem(FILES_COLLAPSED_KEY);
      applyFilesCollapsed(saved === "1");
    }
    lastFilesNarrow = filesNarrow;
  }

  if (artifactNarrow !== lastArtifactNarrow) {
    if (artifactNarrow) {
      applyArtifactCollapsed(true);
    } else {
      const saved = localStorage.getItem(ARTIFACT_COLLAPSED_KEY);
      applyArtifactCollapsed(saved === null ? true : saved === "1");
    }
    lastArtifactNarrow = artifactNarrow;
  }
}

// Apply current viewport on first render (covers cold start in a small window).
if (lastFilesNarrow) applyFilesCollapsed(true);
if (lastArtifactNarrow) applyArtifactCollapsed(true);
window.addEventListener("resize", applyResponsiveLayout);

filesRefreshBtn.addEventListener("click", () => {
  void filesPanel.refresh();
});

filesShowHiddenBtn.addEventListener("click", () => {
  const next = !filesPanel.isShowingHidden();
  filesPanel.setShowHidden(next);
  filesShowHiddenBtn.classList.toggle("active", next);
  filesShowHiddenBtn.setAttribute("aria-pressed", next ? "true" : "false");
});

// Files divider (resize) — mirrors the chat/artifact divider logic.
let filesDragging = false;
filesDivider.addEventListener("mousedown", (e) => {
  e.preventDefault();
  filesDragging = true;
  filesDivider.classList.add("dragging");
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
});
document.addEventListener("mousemove", (e) => {
  if (!filesDragging) return;
  const rect = filesPaneEl.getBoundingClientRect();
  const width = Math.max(160, Math.min(480, e.clientX - rect.left));
  filesPaneEl.style.flex = `0 0 ${width}px`;
});
document.addEventListener("mouseup", () => {
  if (!filesDragging) return;
  filesDragging = false;
  filesDivider.classList.remove("dragging");
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  const basis = filesPaneEl.style.flex.match(/(\d+(?:\.\d+)?)px/);
  if (basis) localStorage.setItem(FILES_WIDTH_KEY, String(Math.round(parseFloat(basis[1]))));
});

// Initial tree population + live updates from the main-process watcher.
void filesPanel.refresh();
void refreshGalaxyInvocations(window.orbit);
window.orbit.onFilesChanged(() => {
  void filesPanel.refresh();
  void fileViewer.refreshFromDisk();
  void refreshGalaxyInvocations(window.orbit);
});

// ── Galaxy connection indicator ──────────────────────────────────────────────

const galaxyStatus = document.getElementById("galaxy-status")!;

async function refreshGalaxyStatus(): Promise<void> {
  const cfg = (await window.orbit.getConfig()) as Record<string, unknown>;
  // getConfig returns the *masked* config — Galaxy profiles carry
  // `hasApiKey: boolean`, never the plaintext apiKey. Checking
  // `profile.apiKey` here used to make the dot stay red even when a key
  // was set, because the field is undefined in the masked shape.
  const galaxy = cfg.galaxy as { active?: string; profiles?: Record<string, { url?: string; hasApiKey?: boolean }> } | undefined;
  const active = galaxy?.active;
  const profile = active ? galaxy?.profiles?.[active] : undefined;
  const connected = !!(profile?.url && profile?.hasApiKey);

  if (connected) {
    galaxyStatus.classList.add("status-dot-connected");
    galaxyStatus.classList.remove("status-dot-disconnected");
    galaxyStatus.title = `Galaxy: ${profile.url}`;
  } else {
    galaxyStatus.classList.add("status-dot-disconnected");
    galaxyStatus.classList.remove("status-dot-connected");
    galaxyStatus.title = "Galaxy: not configured (open Preferences to add a profile)";
  }
}

void refreshGalaxyStatus();

galaxyStatus.addEventListener("click", () => {
  void openPreferences();
});

// ── Execution mode toggle (Local | Cloud) ───────────────────────────────────
//
// Local sandboxes the project to local-only execution even if Galaxy is
// configured. Cloud (default) lets the agent decide per-plan whether each
// step routes locally or to Galaxy. The gate is prompt-level guidance from
// the brain (see extensions/loom/context.ts), not enforced by
// unregistering Galaxy MCP — flipping the toggle restarts the agent so the
// new mode reaches the prompt.

const execLocalBtn = document.getElementById("exec-mode-local") as HTMLButtonElement;
const execCloudBtn = document.getElementById("exec-mode-cloud") as HTMLButtonElement;

function applyExecModeUi(mode: "local" | "cloud"): void {
  for (const [btn, btnMode] of [[execLocalBtn, "local"], [execCloudBtn, "cloud"]] as const) {
    const active = btnMode === mode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-checked", active ? "true" : "false");
  }
}

async function loadExecMode(): Promise<void> {
  const cfg = (await window.orbit.getConfig()) as { executionMode?: string };
  const mode: "local" | "cloud" = cfg.executionMode === "local" ? "local" : "cloud";
  applyExecModeUi(mode);
}

async function setExecMode(mode: "local" | "cloud"): Promise<void> {
  applyExecModeUi(mode);
  const cfg = (await window.orbit.getConfig()) as Record<string, unknown>;
  cfg.executionMode = mode;
  const result = await window.orbit.saveConfig(cfg);
  if (!result.success) {
    chat.addErrorMessage(`Failed to save execution mode: ${result.error}`);
    return;
  }
  chat.addInfoMessage(
    mode === "local"
      ? "<i>Execution mode set to <strong>Local</strong> — Galaxy steps disabled this session. Agent restarted.</i>"
      : "<i>Execution mode set to <strong>Cloud</strong> — agent may route steps to Galaxy. Agent restarted.</i>",
  );
}

execLocalBtn.addEventListener("click", () => void setExecMode("local"));
execCloudBtn.addEventListener("click", () => void setExecMode("cloud"));
void loadExecMode();

// ── First-run welcome screen ─────────────────────────────────────────────────

const welcomeOverlay = document.getElementById("welcome-overlay")!;
const welcomeProvider = document.getElementById("welcome-provider") as HTMLSelectElement;
const welcomeModel = document.getElementById("welcome-model") as HTMLSelectElement;
const welcomeApiKey = document.getElementById("welcome-api-key") as HTMLInputElement;
const welcomeApiKeyStatus = document.getElementById("welcome-api-key-status")!;
const welcomeGalaxyUrl = document.getElementById("welcome-galaxy-url") as HTMLInputElement;
const welcomeGalaxyKey = document.getElementById("welcome-galaxy-key") as HTMLInputElement;
const welcomeCwd = document.getElementById("welcome-cwd") as HTMLInputElement;
const welcomeBrowseCwd = document.getElementById("welcome-browse-cwd")!;
const welcomeSave = document.getElementById("welcome-save")!;
const welcomeError = document.getElementById("welcome-error")!;

// Wire a provider-dropdown / API-key-input / status-label triple to do
// debounced live validation (see main/ipc-handlers.ts validateApiKey).
// Same helper used from both the Welcome screen and Preferences.
function wireApiKeyValidation(
  providerEl: HTMLSelectElement,
  keyEl: HTMLInputElement,
  statusEl: HTMLElement,
): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;
  const setStatus = (cls: "" | "checking" | "valid" | "invalid", text: string) => {
    statusEl.className = `api-key-status${cls ? " " + cls : ""}`;
    statusEl.textContent = text;
  };
  const validateNow = async () => {
    const provider = providerEl.value;
    const key = keyEl.value.trim();
    if (!key) { setStatus("", ""); return; }
    const mySeq = ++seq;
    setStatus("checking", "Checking…");
    try {
      const res = await window.orbit.validateApiKey(provider, key);
      if (mySeq !== seq) return;  // a newer request superseded this one
      if (res.valid) setStatus("valid", "\u2713 Valid");
      else setStatus("invalid", `\u2717 ${res.error || "Invalid"}`);
    } catch (err) {
      if (mySeq !== seq) return;
      setStatus("invalid", `\u2717 ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(validateNow, 600);
  };
  keyEl.addEventListener("input", schedule);
  providerEl.addEventListener("change", schedule);
}

function populateWelcomeModels(provider: string): void {
  welcomeModel.innerHTML = "";
  const models = MODELS_BY_PROVIDER[provider] || [];
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    welcomeModel.appendChild(opt);
  }
}
welcomeProvider.addEventListener("change", () => populateWelcomeModels(welcomeProvider.value));
wireApiKeyValidation(welcomeProvider, welcomeApiKey, welcomeApiKeyStatus);

welcomeBrowseCwd.addEventListener("click", async () => {
  const dir = await window.orbit.selectDirectory();
  if (dir) welcomeCwd.value = dir;
});

welcomeSave.addEventListener("click", async () => {
  welcomeError.textContent = "";
  const apiKey = welcomeApiKey.value.trim();
  if (!apiKey) {
    welcomeError.textContent = "API key is required";
    return;
  }

  // Galaxy: both-or-neither. The Preferences modal enforces the same
  // rule (see savePreferences below). Refusing to ship a half-filled
  // profile prevents a silent persistence trap where the renderer
  // shows "connected" while the brain rejects the credentials.
  const galaxyUrl = welcomeGalaxyUrl.value.trim();
  const galaxyKey = welcomeGalaxyKey.value.trim();
  if (Boolean(galaxyUrl) !== Boolean(galaxyKey)) {
    welcomeError.textContent =
      "Galaxy: provide both URL and API key, or leave both blank.";
    return;
  }

  const cfg: Record<string, unknown> = {
    llm: {
      provider: welcomeProvider.value,
      model: welcomeModel.value,
      apiKey,
    },
  };

  if (galaxyUrl && galaxyKey) {
    cfg.galaxy = {
      active: "default",
      profiles: { default: { url: galaxyUrl, apiKey: galaxyKey } },
    };
  }

  const cwd = welcomeCwd.value.trim();
  if (cwd) cfg.defaultCwd = cwd;

  await window.orbit.saveConfig(cfg);
  welcomeOverlay.classList.add("hidden");
  await refreshGalaxyStatus();
});

// Skip the welcome screen — close the overlay without configuring a
// provider so the user can browse the UI / read docs first. Tells them
// in chat where to come back when they're ready.
const welcomeSkip = document.getElementById("welcome-skip")!;
welcomeSkip.addEventListener("click", () => {
  welcomeOverlay.classList.add("hidden");
  chat.addInfoMessage(
    `<i>No LLM provider configured yet. Open <code>Preferences</code> ` +
    `(Cmd/Ctrl+,) when you're ready to add an API key.</i>`,
  );
});

// Esc dismisses the welcome overlay (same affordance as prefs Esc handler).
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !welcomeOverlay.classList.contains("hidden")) {
    welcomeSkip.click();
  }
});

async function checkFirstRun(): Promise<void> {
  const cfg = (await window.orbit.getConfig()) as { llm?: { hasApiKey?: boolean } };
  if (!cfg.llm?.hasApiKey) {
    populateWelcomeModels(welcomeProvider.value);
    welcomeOverlay.classList.remove("hidden");
  }
}
void checkFirstRun();

// Pull the model catalog from pi-ai's bundled registry (via main IPC) and
// overwrite the hardcoded MODELS_BY_PROVIDER + PRICING. The hardcoded
// values stay as a fallback if the IPC fails (e.g. main bundling regression).
async function populateDynamicModelData(): Promise<void> {
  try {
    const res = await window.orbit.listAllModels();
    if (!res.ok) return;
    const newModels: Record<string, ModelChoice[]> = {};
    const newPricing: typeof PRICING = {};
    for (const [provider, entries] of Object.entries(res.providers)) {
      newModels[provider] = entries.map((e) => ({ id: e.id, label: e.label }));
      for (const e of entries) {
        newPricing[e.id] = {
          in: e.pricing.input,
          out: e.pricing.output,
          cacheRead: e.pricing.cacheRead,
          cacheWrite: e.pricing.cacheWrite,
        };
      }
    }
    if (Object.keys(newModels).length === 0) return;  // never replace with empty
    MODELS_BY_PROVIDER = newModels;
    PRICING = newPricing;
  } catch { /* keep hardcoded fallback */ }
}
void populateDynamicModelData();

function captureUsage(event: Record<string, unknown>): void {
  // message_start carries model info; message updates carry rolling usage
  const msg = event.message as Record<string, unknown> | undefined;
  if (!msg) return;

  if (msg.model && typeof msg.model === "string" && msg.model !== currentModel) {
    currentModel = msg.model;
    renderModelIndicator();
  }

  const u = msg.usage as (Partial<Usage> & { cost?: { total?: number } }) | undefined;
  if (!u) return;

  // turnUsage tracks the in-progress turn's cumulative values
  turnUsage.input = u.input ?? turnUsage.input;
  turnUsage.output = u.output ?? turnUsage.output;
  turnUsage.cacheRead = u.cacheRead ?? turnUsage.cacheRead;
  turnUsage.cacheWrite = u.cacheWrite ?? turnUsage.cacheWrite;
  // Pi's rolling cost for this message (authoritative, computed in pi-ai).
  if (typeof u.cost?.total === "number") {
    turnCostFromPi = u.cost.total;
  }
}

function commitTurnUsage(): void {
  sessionUsage.input += turnUsage.input;
  sessionUsage.output += turnUsage.output;
  sessionUsage.cacheRead += turnUsage.cacheRead;
  sessionUsage.cacheWrite += turnUsage.cacheWrite;
  if (currentModel) {
    const m = perModelUsage.get(currentModel) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    m.input += turnUsage.input;
    m.output += turnUsage.output;
    m.cacheRead += turnUsage.cacheRead;
    m.cacheWrite += turnUsage.cacheWrite;
    perModelUsage.set(currentModel, m);
  }
  if (turnCostFromPi > 0) {
    sessionCostFromPi = (sessionCostFromPi ?? 0) + turnCostFromPi;
  }
  // Diagnostic: log per-message usage + both cost paths so the user can
  // paper-trail against the provider console to verify accuracy.
  const localCost = computeCost(turnUsage, currentModel);
  const sessionLocalCost = computeCost(sessionUsage, currentModel);
  console.log("[usage]", {
    model: currentModel,
    message: { ...turnUsage, cost_pi: turnCostFromPi, cost_local: localCost },
    session: {
      ...sessionUsage,
      cost_pi: sessionCostFromPi,
      cost_local: sessionLocalCost,
    },
  });
  turnUsage.input = 0;
  turnUsage.output = 0;
  turnUsage.cacheRead = 0;
  turnUsage.cacheWrite = 0;
  turnCostFromPi = 0;
  renderUsage();
}

renderUsage();

// Populate model indicator from config at startup so it shows before the first message
void (async () => {
  try {
    const cfg = await window.orbit.getConfig() as { llm?: { model?: string } };
    if (cfg.llm?.model) {
      currentModel = cfg.llm.model;
      renderModelIndicator();
    }
  } catch { /* getConfig may not be available yet */ }
})();

// ── CWD Display ──────────────────────────────────────────────────────────────

async function refreshCwd(): Promise<void> {
  try {
    const cwd = await window.orbit.getCwd();
    cwdPathEl.textContent = cwd;
    cwdPathEl.title = cwd;
    chat.setCwd(cwd);
  } catch { /* getCwd not available yet */ }
}

function resetUiForFreshContext(): void {
  chat.clear();
  artifacts.clear();
  clearPendingMessage();
  sessionUsage.input = 0;
  sessionUsage.output = 0;
  sessionUsage.cacheRead = 0;
  sessionUsage.cacheWrite = 0;
  turnUsage.input = 0;
  turnUsage.output = 0;
  turnUsage.cacheRead = 0;
  turnUsage.cacheWrite = 0;
  perModelUsage.clear();
  renderUsage();
  streaming = false;
  sendBtn.classList.remove("hidden");
  abortBtn.classList.add("hidden");
  setStatusBadge("");
  setArtifactCollapsed(false);
}

function applyCwdChange(dir: string): void {
  resetUiForFreshContext();
  chat.setCwd(dir);
  cwdPathEl.textContent = dir;
  cwdPathEl.title = dir;
  chat.addInfoMessage(`<i>Switched analysis directory to <code>${dir.replace(/</g, "&lt;")}</code>.</i>`);
  hasShownStartupWelcome = false;
  // Re-root the file tree, close any open viewer, hide the File tab — the
  // old relPath is meaningless in the new cwd.
  fileViewer.close();
  artifacts.hideFileTab();
  filesPanel.reset();
  void filesPanel.refresh();
  void refreshGalaxyInvocations(window.orbit);
}

cwdChangeBtn.addEventListener("click", async () => {
  await window.orbit.selectDirectory();
});

// File > Open Analysis Directory menu triggers this
window.orbit.onCwdChanged((dir) => {
  applyCwdChange(dir);
});

// Main sends this after spawning the agent with --continue. The model's context
// is restored, but the chat panel is empty because it's renderer-only state.
// Replay prior turns only if the chat is currently blank — otherwise the user
// is mid-flow (e.g. prefs-save restart) and replay would clobber live UI.
window.orbit.onSessionHistory((history) => {
  if (history.length === 0) return;
  if (chat.hasContent()) return;
  chat.addInfoMessage("<i>— Resumed previous session —</i>");
  let replayNum = 0;
  for (const seg of history) {
    if (seg.role === "user") {
      chat.addReplayUserMessage(seg.text, ++replayNum);
      continue;
    }
    chat.startAssistantMessage();
    if (seg.text) chat.appendDelta(seg.text);
    if (seg.tools) {
      // Mirror the live-streaming policy: skip per-tool chat cards on
      // replay. Only team_dispatch keeps its rich collapsible card.
      for (const t of seg.tools) {
        if (t.name !== "team_dispatch") continue;
        chat.addToolCard(t.id, t.name);
        chat.updateToolCard(t.id, t.isError ? "error" : "done", t.resultText);
      }
    }
    chat.finishAssistantMessage();
  }
});

refreshCwd();

// ── Chat Input ────────────────────────────────────────────────────────────────

/** Queued message — stashed when user submits while agent is streaming. */
let pendingMessage: string | null = null;

function updateQueuedIndicator(): void {
  const indicator = document.getElementById("queued-indicator");
  if (!indicator) return;
  if (pendingMessage) {
    indicator.classList.remove("hidden");
    indicator.title = `Queued: ${pendingMessage.slice(0, 100)}${pendingMessage.length > 100 ? "…" : ""} (click to cancel)`;
  } else {
    indicator.classList.add("hidden");
  }
}

/** Clear any queued message without sending it. */
function clearPendingMessage(): void {
  pendingMessage = null;
  updateQueuedIndicator();
}

// Click the indicator to cancel the queued message
document.getElementById("queued-indicator")?.addEventListener("click", () => {
  clearPendingMessage();
});

function submit(): void {
  const text = inputEl.value.trim();
  if (!text) return;

  appendHistoryEntry(text);

  // Slash commands — handled locally, no LLM round-trip (allowed even while streaming)
  if (text.startsWith("/")) {
    if (handleSlashCommand(text)) {
      inputEl.value = "";
      inputEl.style.height = "auto";
      return;
    }
  }

  // If the agent is mid-turn, queue the message and flush when agent_end fires.
  if (streaming) {
    pendingMessage = text;
    inputEl.value = "";
    inputEl.style.height = "auto";
    updateQueuedIndicator();
    return;
  }

  chat.addUserMessage(text);
  chat.showThinking();
  setStatusBadge("thinking", "thinking...");
  window.orbit.prompt(text);
  inputEl.value = "";
  inputEl.style.height = "auto";
}

// Plan draft actions from chat cards — forward approve/reject as user messages,
// pre-fill the input for edit so the researcher can revise before re-sending.
messagesEl.addEventListener("plan-draft-action", (e) => {
  const { action, body } = (e as CustomEvent<{ action: string; body: string }>).detail;
  if (action === "approve") {
    inputEl.value =
      "I approve the plan above. Show the full parameter table for review before writing anything to notebook.md.";
    submit();
  } else if (action === "reject") {
    inputEl.value = "Reject the plan above — let's rethink it.";
    submit();
  } else if (action === "edit") {
    inputEl.value =
      "Here is the plan with my edits — please revise your draft accordingly:\n\n" +
      "```plan\n" + body + "\n```";
    inputEl.focus();
    inputEl.dispatchEvent(new Event("input"));
  }
});

/** Flush any queued message after the current turn ends. */
function flushPendingMessage(): void {
  if (!pendingMessage) return;
  const text = pendingMessage;
  pendingMessage = null;
  updateQueuedIndicator();
  // Use requestAnimationFrame so the UI updates before we start the next turn
  requestAnimationFrame(() => {
    chat.addUserMessage(text);
    chat.showThinking();
    setStatusBadge("thinking", "thinking...");
    window.orbit.prompt(text);
  });
}

/**
 * Handle slash commands. Returns true if handled (no need to send to agent).
 *
 * Supported:
 *   /model <name>   — switch LLM model (e.g. /model sonnet, /model claude-opus-4-6)
 *   /help           — list slash commands
 */
function formatArgsPreview(args: Record<string, unknown> | undefined): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const cmd = (args as { command?: unknown }).command;
  if (typeof cmd === "string" && cmd.length > 0) return `$ ${cmd}`;
  const path = (args as { path?: unknown; file_path?: unknown }).path ?? (args as { file_path?: unknown }).file_path;
  if (typeof path === "string") return path;
  try {
    return JSON.stringify(args);
  } catch {
    return undefined;
  }
}

interface SlashCommand {
  name: string;
  usage?: string;
  description: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: "model",     usage: "/model <name>",         description: "switch LLM model" },
  { name: "new",       description: "start a fresh session" },
  { name: "resume",    description: "restart agent and replay prior session" },
  { name: "chat",      description: "restore the chat pane from the session transcript (no agent restart)" },
  { name: "plan",      description: "show current plan summary" },
  { name: "status",    description: "show Galaxy connection status" },
  { name: "notebook",  description: "show notebook info" },
  { name: "summarize", usage: "/summarize [N [M]]",    description: "summarize prompts N–M into the notebook" },
  { name: "cost",      description: "append session token/cost breakdown to the notebook" },
  { name: "decisions", description: "show decision log" },
  { name: "connect",   description: "open Galaxy connection settings" },
  { name: "help",      description: "show this help" },
];

function escapeHtmlBasic(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function slashCommandsHtml(): string {
  const items = SLASH_COMMANDS.map((c) => {
    const label = c.usage ?? `/${c.name}`;
    return `<li><code>${escapeHtmlBasic(label)}</code> — ${escapeHtmlBasic(c.description)}</li>`;
  }).join("");
  return `<h3>Slash commands</h3><ul>${items}</ul>`;
}

function handleSlashCommand(text: string): boolean {
  const [cmd, ...rest] = text.slice(1).split(/\s+/);

  if (cmd === "model") {
    const arg = rest.join(" ").trim().toLowerCase();
    if (!arg) {
      chat.addUserMessage(text);
      chat.addErrorMessage(
        "Usage: /model <name>. Examples: /model sonnet, /model haiku, /model opus, " +
        "or /model claude-sonnet-4-6 for an exact id."
      );
      return true;
    }
    void switchModelByAlias(text, arg);
    return true;
  }

  if (cmd === "new" || cmd === "reset" || cmd === "clear") {
    void confirmAndResetSession();
    return true;
  }

  if (cmd === "resume" || cmd === "continue") {
    chat.addUserMessage(text);
    chat.addInfoMessage("<i>Restarting agent with prior session…</i>");
    void window.orbit.restartAgent();
    return true;
  }

  if (cmd === "chat") {
    // Replay the current session's chat transcript from session.jsonl —
    // recovers chat after a window blank-out without touching the agent.
    // onSessionHistory bails out if the chat already has content, so we
    // must not add any info/status message before the replay fires.
    chat.clear();
    void window.orbit.replayChat().then((res) => {
      if (!res.ok) {
        chat.addErrorMessage(`/chat: ${res.error}`);
      } else if (res.segments === 0) {
        chat.addInfoMessage("<i>No prior turns to replay in this session.</i>");
      }
    });
    return true;
  }

  // pi-galaxy-analyst commands — pass through to agent
  if (cmd === "plan" || cmd === "status" || cmd === "notebook" || cmd === "decisions" || cmd === "profiles") {
    chat.addUserMessage(text);
    window.orbit.prompt(`/${cmd}`);
    return true;
  }

  if (cmd === "summarize" || cmd === "summary") {
    handleSummarize(text, rest.join(" "));
    return true;
  }

  if (cmd === "cost") {
    handleCost(text);
    return true;
  }

  if (cmd === "connect") {
    void openPreferences();
    return true;
  }

  if (cmd === "help") {
    chat.addUserMessage(text);
    chat.addInfoMessage(slashCommandsHtml());
    return true;
  }

  return false; // not a recognized slash command — let it through
}

/**
 * /summarize [N [M]] — summarize the chat between prompts N..M into the notebook.
 *
 * Accepted forms (numbers extracted in order):
 *   /summarize              → all prompts so far
 *   /summarize 3            → just prompt 3
 *   /summarize 1 3          → prompts 1..3
 *   /summarize 1-3, 1 to 3, between 1 and 3 → same
 */
function handleSummarize(raw: string, argStr: string): void {
  const total = chat.getPromptCount();
  if (total === 0) {
    chat.addUserMessage(raw);
    chat.addErrorMessage("No prompts yet to summarize.");
    return;
  }

  const nums = (argStr.match(/\d+/g) ?? []).map(Number);
  let from: number, to: number;
  if (nums.length === 0) { from = 1; to = total; }
  else if (nums.length === 1) { from = to = nums[0]; }
  else { from = Math.min(nums[0], nums[1]); to = Math.max(nums[0], nums[1]); }

  if (from < 1 || to > total) {
    chat.addUserMessage(raw);
    chat.addErrorMessage(`Out of range. Valid prompts: 1..${total}.`);
    return;
  }

  const transcript = chat.getTranscript(from, to);
  if (!transcript.trim()) {
    chat.addUserMessage(raw);
    chat.addErrorMessage(`No content found for prompts ${from}..${to}.`);
    return;
  }

  const label = from === to ? `prompt ${from}` : `prompts ${from}–${to}`;
  const heading = `## Summary — ${label}`;
  const prompt =
    `Append a concise summary of the conversation covering ${label} to the ` +
    `notebook file (notebook.md) in the current working directory. Use Edit or Write ` +
    `to append — do NOT regenerate or rewrite existing content.\n\n` +
    `Use exactly this heading (H2, verbatim) on its own line, followed by a blank line, then the body:\n` +
    `    ${heading}\n\n` +
    `Body format: bullet points only, no prose paragraphs. Focus on decisions, findings, ` +
    `Galaxy references, and open questions. Keep it tight — one line per bullet when possible.\n\n` +
    `--- Chat transcript (${label}) ---\n` +
    transcript +
    `\n--- end transcript ---`;

  chat.addUserMessage(raw);
  chat.addInfoMessage(
    `<i>Asking the agent to append a summary of ${label} to <code>notebook.md</code>…</i>`,
  );
  chat.showThinking();
  setStatusBadge("thinking", "thinking...");
  window.orbit.prompt(prompt);
}

/**
 * /cost — snapshot session token usage per model, price it against the renderer's
 * pricing table, and ask the agent to append the breakdown to notebook.md.
 * The renderer is the authoritative source for usage numbers; the agent just
 * writes them out.
 */
function handleCost(raw: string): void {
  if (perModelUsage.size === 0) {
    chat.addUserMessage(raw);
    chat.addErrorMessage("No billable assistant turns recorded yet in this renderer session.");
    return;
  }

  const rows: string[] = [];
  let totalCostKnown = true;
  let grandCost = 0;
  const totals: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  for (const [model, u] of perModelUsage) {
    totals.input += u.input;
    totals.output += u.output;
    totals.cacheRead += u.cacheRead;
    totals.cacheWrite += u.cacheWrite;
    const cost = computeCost(u, model);
    const costStr = cost === null ? "unknown (no pricing entry)" : `$${cost.toFixed(4)}`;
    if (cost === null) totalCostKnown = false; else grandCost += cost;
    rows.push(
      `| \`${model}\` | ${u.input.toLocaleString()} | ${u.output.toLocaleString()} | ` +
      `${u.cacheRead.toLocaleString()} | ${u.cacheWrite.toLocaleString()} | ${costStr} |`
    );
  }

  const totalCostStr = totalCostKnown ? `$${grandCost.toFixed(4)}` : `≥$${grandCost.toFixed(4)} (some models unpriced)`;
  rows.push(
    `| **Total** | **${totals.input.toLocaleString()}** | **${totals.output.toLocaleString()}** | ` +
    `**${totals.cacheRead.toLocaleString()}** | **${totals.cacheWrite.toLocaleString()}** | **${totalCostStr}** |`
  );

  const table =
    `| Model | Input tokens | Output tokens | Cache read | Cache write | Cost (USD) |\n` +
    `|-------|-------------:|--------------:|-----------:|------------:|-----------:|\n` +
    rows.join("\n");

  const heading = "## Session cost";
  const prompt =
    `Append the following session cost breakdown verbatim to the notebook file ` +
    `(notebook.md) in the current working directory. Use Edit or Write to append — ` +
    `do NOT regenerate, reformat, or wrap the table. The numbers below are authoritative ` +
    `(captured from the renderer's usage counters, same source as the masthead), so ` +
    `use them as-is.\n\n` +
    `Use exactly this heading (H2, verbatim) on its own line, followed by a blank line, ` +
    `then the table:\n` +
    `    ${heading}\n\n` +
    `--- Cost table ---\n` +
    table +
    `\n--- end table ---`;

  chat.addUserMessage(raw);
  chat.addInfoMessage(
    `<i>Asking the agent to append the session cost breakdown to ` +
    `<code>notebook.md</code>…</i>`,
  );
  chat.showThinking();
  setStatusBadge("thinking", "thinking...");
  window.orbit.prompt(prompt);
}

/**
 * Ask for confirmation, then wipe both panes + restart agent.
 *
 * If the cwd already has a non-empty notebook.md, show a 3-way modal so the
 * user can pick between keeping the existing notebook (continue adding) or
 * wiping the slate (delete notebook.md + activity.jsonl, commit the deletion
 * so it's recoverable from git). No-op notebook → plain confirm.
 */
async function confirmAndResetSession(): Promise<void> {
  let status: { exists: boolean; hasContent: boolean } = { exists: false, hasContent: false };
  try {
    status = await window.orbit.notebookStatus();
  } catch {
    // IPC unavailable -- fall through to plain confirm.
  }

  if (!status.hasContent) {
    const ok = confirm("Start a fresh session? This will erase the current chat and notebook view.");
    if (!ok) return;
    await resetSession();
    return;
  }

  const choice = await showNewSessionModal();
  if (choice === "cancel") return;

  if (choice === "fresh") {
    try {
      await window.orbit.clearNotebookArtifacts();
    } catch (err) {
      chat.addErrorMessage(`Failed to clear notebook artifacts: ${err}`);
      return;
    }
  }

  await resetSession();
}

type NewSessionChoice = "keep" | "fresh" | "cancel";

function showNewSessionModal(): Promise<NewSessionChoice> {
  return new Promise((resolve) => {
    const overlay = document.getElementById("new-session-overlay");
    const keepBtn = document.getElementById("new-session-keep") as HTMLButtonElement | null;
    const freshBtn = document.getElementById("new-session-fresh") as HTMLButtonElement | null;
    const cancelBtn = document.getElementById("new-session-cancel") as HTMLButtonElement | null;
    if (!overlay || !keepBtn || !freshBtn || !cancelBtn) {
      resolve("cancel");
      return;
    }

    overlay.classList.remove("hidden");

    const cleanup = (choice: NewSessionChoice) => {
      overlay.classList.add("hidden");
      keepBtn.removeEventListener("click", onKeep);
      freshBtn.removeEventListener("click", onFresh);
      cancelBtn.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey);
      resolve(choice);
    };
    const onKeep = () => cleanup("keep");
    const onFresh = () => cleanup("fresh");
    const onCancel = () => cleanup("cancel");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cleanup("cancel");
    };

    keepBtn.addEventListener("click", onKeep);
    freshBtn.addEventListener("click", onFresh);
    cancelBtn.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey);
  });
}

async function showCwdWelcome(prefix?: string): Promise<void> {
  let cwd = "~";
  try {
    cwd = await window.orbit.getCwd();
  } catch { /* getCwd unavailable */ }
  // Optional prefix lets callers (e.g. resetSession) merge their own
  // "Started fresh session" line into the same info card so the user
  // doesn't see a stack of three near-identical messages on /new.
  const prefixHtml = prefix ? `<i>${prefix}</i><br>` : "";
  chat.addInfoMessage(
    prefixHtml +
    `<b>Current working directory:</b> <code>${cwd.replace(/</g, "&lt;")}</code><br>` +
    // Class instead of id so multiple cwd-welcome cards don't all share
    // an id, and so the delegated listener wired once below works on
    // every link regardless of how many welcomes have been shown.
    `For a new project you may want to <a href="#" class="switch-dir-link">switch to a new directory</a> to keep everything clean.`
  );
}

// Single delegated listener for every "switch to a new directory" link
// rendered by showCwdWelcome. Avoids per-call addEventListener stacking.
messagesEl.addEventListener("click", (e) => {
  const target = e.target as HTMLElement | null;
  if (!target?.classList.contains("switch-dir-link")) return;
  e.preventDefault();
  (document.getElementById("cwd-change") as HTMLButtonElement | null)?.click();
});

async function resetSession(): Promise<void> {
  chat.resetCounter();
  resetUiForFreshContext();

  await window.orbit.resetSession();

  // Reset startup-welcome flag so the onAgentStatus handler re-runs
  // the cwd welcome when the new agent reports "running".
  hasShownStartupWelcome = false;

  // Merge the "fresh session started" line with the cwd welcome so the
  // user sees one info card, not two.
  await showCwdWelcome("Started fresh session.");
}

/** Resolve a model alias across ALL providers and switch + restart agent. */
async function switchModelByAlias(originalText: string, alias: string): Promise<void> {
  chat.addUserMessage(originalText);

  const cfg = await window.orbit.getConfig() as { llm?: { provider?: string } };
  const currentProvider = cfg.llm?.provider || "anthropic";

  // Search strategy: prefer current provider, then search all providers.
  // Within each provider: exact id match → id substring → label substring.
  let chosen: { provider: string; model: ModelChoice } | undefined;

  const search = (p: string): ModelChoice | undefined => {
    const cat = MODELS_BY_PROVIDER[p] || [];
    return (
      cat.find(m => m.id === alias) ||
      cat.find(m => m.id.toLowerCase().includes(alias)) ||
      cat.find(m => m.label.toLowerCase().includes(alias))
    );
  };

  // 1. Try current provider first (preserves user's existing setup)
  const inCurrent = search(currentProvider);
  if (inCurrent) {
    chosen = { provider: currentProvider, model: inCurrent };
  } else {
    // 2. Fall back to searching every provider
    for (const p of Object.keys(MODELS_BY_PROVIDER)) {
      if (p === currentProvider) continue;
      const m = search(p);
      if (m) { chosen = { provider: p, model: m }; break; }
    }
  }

  if (!chosen) {
    const all = Object.entries(MODELS_BY_PROVIDER)
      .map(([p, models]) => `  ${p}: ${models.map(m => m.id).join(", ")}`)
      .join("\n");
    chat.addErrorMessage(
      `No model matches "${alias}". Available models:\n${all}`
    );
    return;
  }

  // Save updated config
  const current = await window.orbit.getConfig() as Record<string, unknown>;
  const llm = ((current.llm as Record<string, unknown> | undefined) || {}) as Record<string, unknown>;

  const switchingProvider = chosen.provider !== currentProvider;
  if (switchingProvider) {
    llm.provider = chosen.provider;
    // Don't clobber the existing API key — if the user has none for the new provider,
    // the agent restart will fail with a clear error and they can set it in Preferences.
  }
  llm.model = chosen.model.id;
  current.llm = llm;

  const result = await window.orbit.saveConfig(current);
  if (!result.success) {
    chat.addErrorMessage(`Failed to save config: ${result.error}`);
    return;
  }

  currentModel = chosen.model.id;
  renderModelIndicator();

  if (switchingProvider) {
    chat.addErrorMessage(
      `Switched to ${chosen.provider} / ${chosen.model.id}. Agent restarting… ` +
      `(if you don't have a ${chosen.provider} API key set in Preferences, the agent will fail to start)`
    );
  } else {
    chat.addErrorMessage(`Model switched to ${chosen.model.id}. Agent restarting…`);
  }
}

// ─── Prompt history (↑ / ↓ to recall previous submissions) ──────────────────

const HISTORY_KEY = "loom.promptHistory";
const HISTORY_MAX = 100;

function loadPromptHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function savePromptHistory(): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(promptHistory));
  } catch { /* ignore quota errors */ }
}

const promptHistory: string[] = loadPromptHistory();
let historyCursor: number = promptHistory.length;  // index of NEXT slot
let historyDraft: string = "";  // user's pre-recall buffer

function appendHistoryEntry(text: string): void {
  if (!text.trim()) return;
  // Skip exact-duplicate of last entry to keep navigation useful.
  if (promptHistory[promptHistory.length - 1] === text) {
    historyCursor = promptHistory.length;
    return;
  }
  promptHistory.push(text);
  if (promptHistory.length > HISTORY_MAX) {
    promptHistory.splice(0, promptHistory.length - HISTORY_MAX);
  }
  historyCursor = promptHistory.length;
  historyDraft = "";
  savePromptHistory();
}

/** Should ↑/↓ recall instead of moving the caret? Yes when input is empty
 *  or the caret is on the first/last visual line, mirroring shell semantics. */
function shouldRecallOnArrow(direction: "up" | "down"): boolean {
  if (inputEl.value === "") return true;
  const pos = inputEl.selectionStart ?? 0;
  if (direction === "up") {
    // First line iff there's no \n before the caret.
    return inputEl.value.lastIndexOf("\n", pos - 1) === -1;
  }
  // Last line iff there's no \n at or after the caret.
  return inputEl.value.indexOf("\n", pos) === -1;
}

function recallHistory(direction: "up" | "down"): void {
  if (direction === "up") {
    if (historyCursor <= 0) return;
    if (historyCursor === promptHistory.length) {
      // Stash the in-progress draft so ↓ past the end restores it.
      historyDraft = inputEl.value;
    }
    historyCursor -= 1;
  } else {
    if (historyCursor >= promptHistory.length) return;
    historyCursor += 1;
  }
  inputEl.value =
    historyCursor === promptHistory.length ? historyDraft : promptHistory[historyCursor];
  inputEl.dispatchEvent(new Event("input"));
  // Caret to end so the next ↑/↓ continues navigating cleanly.
  const end = inputEl.value.length;
  inputEl.setSelectionRange(end, end);
}

// ─── Slash-command autocomplete popup ────────────────────────────────────────

const slashPopup = document.getElementById("slash-popup")!;
let slashPopupItems: SlashCommand[] = [];
let slashPopupActive = -1;

function isSlashPopupOpen(): boolean {
  return !slashPopup.classList.contains("hidden");
}

function closeSlashPopup(): void {
  slashPopup.classList.add("hidden");
  slashPopup.innerHTML = "";
  slashPopupItems = [];
  slashPopupActive = -1;
  inputEl.removeAttribute("aria-activedescendant");
  inputEl.setAttribute("aria-expanded", "false");
}

function slashRowId(i: number): string {
  return `slash-popup-item-${i}`;
}

function maybeOpenSlashPopup(): void {
  const v = inputEl.value;
  // Only open when the input begins with `/` and has no space yet (i.e.
  // the user is still typing the command name, not its arguments).
  if (!v.startsWith("/") || v.includes(" ") || v.includes("\n")) {
    closeSlashPopup();
    return;
  }
  const query = v.slice(1).toLowerCase();
  const matches = SLASH_COMMANDS.filter((c) => c.name.startsWith(query));
  if (matches.length === 0) {
    closeSlashPopup();
    return;
  }
  slashPopupItems = matches;
  slashPopupActive = 0;
  renderSlashPopup();
  slashPopup.classList.remove("hidden");
  inputEl.setAttribute("aria-expanded", "true");
}

function renderSlashPopup(): void {
  slashPopup.innerHTML = "";
  slashPopupItems.forEach((cmd, i) => {
    const row = document.createElement("div");
    row.className = "slash-popup-item" + (i === slashPopupActive ? " active" : "");
    row.id = slashRowId(i);
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(i === slashPopupActive));
    row.dataset.index = String(i);

    const nameEl = document.createElement("span");
    nameEl.className = "slash-popup-name";
    nameEl.textContent = `/${cmd.name}`;
    row.appendChild(nameEl);

    if (cmd.usage && cmd.usage !== `/${cmd.name}`) {
      const usageEl = document.createElement("span");
      usageEl.className = "slash-popup-usage";
      usageEl.textContent = cmd.usage.slice(`/${cmd.name}`.length).trim();
      row.appendChild(usageEl);
    }

    const descEl = document.createElement("span");
    descEl.className = "slash-popup-desc";
    descEl.textContent = cmd.description;
    row.appendChild(descEl);

    row.addEventListener("mousedown", (ev) => {
      // mousedown (not click) so the textarea doesn't lose focus first.
      ev.preventDefault();
      acceptSlashPopup(i);
    });
    slashPopup.appendChild(row);
  });

  // ARIA wiring: the listbox owns the items, but focus stays on the
  // textarea — aria-activedescendant points screen readers at the
  // currently-highlighted row so they announce it on ↑/↓.
  if (slashPopupActive >= 0 && slashPopupItems[slashPopupActive]) {
    inputEl.setAttribute("aria-activedescendant", slashRowId(slashPopupActive));
  } else {
    inputEl.removeAttribute("aria-activedescendant");
  }
}

function moveSlashPopup(direction: "up" | "down"): void {
  if (slashPopupItems.length === 0) return;
  if (direction === "up") {
    slashPopupActive = (slashPopupActive - 1 + slashPopupItems.length) % slashPopupItems.length;
  } else {
    slashPopupActive = (slashPopupActive + 1) % slashPopupItems.length;
  }
  renderSlashPopup();
  const activeRow = slashPopup.querySelector(".slash-popup-item.active") as HTMLElement | null;
  activeRow?.scrollIntoView({ block: "nearest" });
}

function acceptSlashPopup(index: number): void {
  const cmd = slashPopupItems[index];
  if (!cmd) return;
  // Drop user back at the cursor position right after the command name. If
  // there's a usage hint with args, leave a trailing space; otherwise the
  // bare command (Enter submits it).
  const needsArg = cmd.usage && cmd.usage.length > `/${cmd.name}`.length;
  inputEl.value = `/${cmd.name}${needsArg ? " " : ""}`;
  closeSlashPopup();
  inputEl.dispatchEvent(new Event("input"));
  inputEl.focus();
  const end = inputEl.value.length;
  inputEl.setSelectionRange(end, end);
}

inputEl.addEventListener("keydown", (e) => {
  // Slash popup is a hint, not a modal: Tab completes, ↑/↓ navigate
  // within it, Esc dismisses. Enter still submits whatever the user
  // typed — the popup auto-closes as a side effect of submit.
  if (isSlashPopupOpen()) {
    if (e.key === "ArrowUp")    { e.preventDefault(); moveSlashPopup("up"); return; }
    if (e.key === "ArrowDown")  { e.preventDefault(); moveSlashPopup("down"); return; }
    if (e.key === "Tab")        { e.preventDefault(); acceptSlashPopup(slashPopupActive); return; }
    if (e.key === "Escape")     { e.preventDefault(); closeSlashPopup(); return; }
    // Enter falls through to the regular submit path below.
  }

  if (e.key === "ArrowUp" && shouldRecallOnArrow("up")) {
    if (promptHistory.length === 0) return;
    e.preventDefault();
    recallHistory("up");
    return;
  }
  if (e.key === "ArrowDown" && shouldRecallOnArrow("down") && historyCursor < promptHistory.length) {
    e.preventDefault();
    recallHistory("down");
    return;
  }

  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    closeSlashPopup();
    submit();
  }
});

inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + "px";
  maybeOpenSlashPopup();
});

inputEl.addEventListener("blur", () => {
  // Defer so a click inside the popup can still fire.
  setTimeout(() => closeSlashPopup(), 100);
});

sendBtn.addEventListener("click", submit);

abortBtn.addEventListener("click", () => {
  window.orbit.abort();
  clearPendingMessage();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && streaming) {
    window.orbit.abort();
    clearPendingMessage();
  }
});

// ── Agent Events ──────────────────────────────────────────────────────────────

window.orbit.onAgentEvent((event) => {
  const type = event.type as string;
  console.log("[orbit] event:", type, JSON.stringify(event).slice(0, 150));

  // Capture usage from any event that carries a message with usage
  if (type === "message_start" || type === "message_update" || type === "message_end" || type === "turn_end") {
    captureUsage(event as Record<string, unknown>);
  }

  // Feed the agent shell with interesting events
  feedShell(event);

  switch (type) {
    case "agent_start":
      streaming = true;
      sendBtn.classList.add("hidden");
      abortBtn.classList.remove("hidden");
      // Don't hide thinking yet — wait for actual text content
      break;

    case "message_update": {
      // Pi.dev wraps events in assistantMessageEvent
      const ame = (event as { assistantMessageEvent?: Record<string, unknown> }).assistantMessageEvent;
      if (!ame) break;

      const ameType = ame.type as string;

      if (ameType === "text_start") {
        chat.hideThinking();
        setStatusBadge("running", "responding...");
        if (!streaming) {
          streaming = true;
          sendBtn.classList.add("hidden");
          abortBtn.classList.remove("hidden");
        }
        // Only start a new message if there isn't one active
        if (!chat.hasActiveMessage()) {
          chat.startAssistantMessage();
        }
      } else if (ameType === "text_delta") {
        chat.hideThinking();
        if (!streaming) {
          streaming = true;
          sendBtn.classList.add("hidden");
          abortBtn.classList.remove("hidden");
        }
        if (!chat.hasActiveMessage()) {
          chat.startAssistantMessage();
        }
        const delta = ame.delta as string;
        if (delta) chat.appendDelta(delta);
      } else if (ameType === "text_end") {
        // text block finished, but agent turn might continue
      }
      break;
    }

    case "message_end": {
      // Commit per-assistant-message usage to the session total
      // Each assistant message = one LLM call billed separately
      const msg = (event as { message?: { role?: string; stopReason?: string; errorMessage?: string } }).message;
      if (msg?.role === "assistant") {
        commitTurnUsage();
        // Surface assistant-side errors (e.g. 401 invalid API key) so the user
        // isn't staring at a silent UI after a failed call.
        if (msg.stopReason === "error" && msg.errorMessage) {
          chat.hideThinking();
          chat.addErrorMessage(msg.errorMessage);
          setStatusBadge("error");
        }
      }
      break;
    }

    case "turn_end":
      // Turn might not be fully done until agent_end
      break;

    case "tool_execution_start": {
      chat.hideThinking();
      const name = (event as { toolName?: string }).toolName || "tool";
      const id = (event as { toolCallId?: string }).toolCallId || name;
      // Per-tool chat cards are noisy and duplicate what the Activity tab
      // shows (shell stream + activity.jsonl). Only team_dispatch keeps a
      // chat card because its collapsible per-turn body is genuinely useful.
      if (name === "team_dispatch") {
        chat.addToolCard(id, name);
      }
      setStatusBadge("running", `running: ${name}`);
      break;
    }

    case "tool_execution_update": {
      const id = (event as { toolCallId?: string }).toolCallId || "";
      const partial = (event as { partialResult?: { details?: unknown } }).partialResult;
      const details = (partial as { details?: { kind?: string } } | undefined)?.details;
      const args = (event as { args?: Record<string, unknown> }).args;
      const preview = formatArgsPreview(args);
      // updateToolCard no-ops for tools that never got a card (everything
      // except team_dispatch).
      chat.updateToolCard(id, "running", preview, details);
      break;
    }

    case "tool_execution_end": {
      const id = (event as { toolCallId?: string }).toolCallId || "";
      const isError = Boolean((event as { isError?: boolean }).isError);
      const result = (event as { result?: { content?: Array<{ text?: string }>; details?: unknown } }).result;
      const text = result?.content?.[0]?.text;
      const details = (result as { details?: { kind?: string } } | undefined)?.details;
      chat.updateToolCard(id, isError ? "error" : "done", text, details);
      break;
    }

    case "agent_end":
      chat.hideThinking();
      streaming = false;
      setStatusBadge("");
      sendBtn.classList.remove("hidden");
      abortBtn.classList.add("hidden");
      chat.finishAssistantMessage();
      // Safety: clear any stuck button busy states if the turn ends without the
      // expected completion event arriving
      flushPendingMessage();
      hasRevealedActivityThisTurn = false;
      break;

    case "error": {
      const msg = (event as { message?: string }).message || "Unknown error";
      chat.hideThinking();
      chat.addErrorMessage(msg);
      streaming = false;
      setStatusBadge("error");
      sendBtn.classList.remove("hidden");
      abortBtn.classList.add("hidden");
      // Clear any queued message on error so the indicator doesn't get stuck
      clearPendingMessage();
      break;
    }
  }
});

// ── UI Requests (from extension via Pi.dev) ──────────────────────────────────

// Extension-request modal (input / select / confirm). One at a time —
// showExtModal() serializes via pending promise so overlapping requests queue.
const extOverlay = document.getElementById("ext-overlay")!;
const extTitleEl = document.getElementById("ext-title")!;
const extMessageEl = document.getElementById("ext-message")!;
const extInputEl = document.getElementById("ext-input") as HTMLInputElement;
const extOptionsEl = document.getElementById("ext-options")!;
const extCancelBtn = document.getElementById("ext-cancel") as HTMLButtonElement;
const extConfirmBtn = document.getElementById("ext-confirm") as HTMLButtonElement;
const extAcceptBtn = document.getElementById("ext-accept") as HTMLButtonElement;
const extDenyBtn = document.getElementById("ext-deny") as HTMLButtonElement;

function hideExtModal(): void {
  extOverlay.classList.add("hidden");
  extMessageEl.classList.add("hidden");
  extInputEl.classList.add("hidden");
  extOptionsEl.classList.add("hidden");
  extConfirmBtn.classList.add("hidden");
  extAcceptBtn.classList.add("hidden");
  extDenyBtn.classList.add("hidden");
  extOptionsEl.innerHTML = "";
  extInputEl.value = "";
}

function openExtInput(id: string, title: string, placeholder?: string): void {
  extTitleEl.textContent = title;
  extInputEl.classList.remove("hidden");
  extInputEl.placeholder = placeholder || "";
  extConfirmBtn.classList.remove("hidden");
  extConfirmBtn.textContent = "OK";
  extOverlay.classList.remove("hidden");
  setTimeout(() => extInputEl.focus(), 0);

  const respond = (value: string | undefined) => {
    window.orbit.respondToUiRequest(id, value === undefined ? { cancelled: true } : { value });
    hideExtModal();
    cleanup();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); respond(extInputEl.value); }
    if (e.key === "Escape") { e.preventDefault(); respond(undefined); }
  };
  const onOk = () => respond(extInputEl.value);
  const onCancel = () => respond(undefined);
  const cleanup = () => {
    extInputEl.removeEventListener("keydown", onKey);
    extConfirmBtn.removeEventListener("click", onOk);
    extCancelBtn.removeEventListener("click", onCancel);
  };
  extInputEl.addEventListener("keydown", onKey);
  extConfirmBtn.addEventListener("click", onOk);
  extCancelBtn.addEventListener("click", onCancel);
}

function openExtSelect(id: string, title: string, options: string[]): void {
  extTitleEl.textContent = title;
  extOptionsEl.classList.remove("hidden");
  extOverlay.classList.remove("hidden");

  const respond = (value: string | undefined) => {
    window.orbit.respondToUiRequest(id, value === undefined ? { cancelled: true } : { value });
    hideExtModal();
    cleanup();
  };

  options.forEach((opt) => {
    const el = document.createElement("div");
    el.className = "ext-option";
    el.textContent = opt;
    el.addEventListener("click", () => respond(opt));
    extOptionsEl.appendChild(el);
  });

  const onCancel = () => respond(undefined);
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); respond(undefined); } };
  const cleanup = () => {
    extCancelBtn.removeEventListener("click", onCancel);
    document.removeEventListener("keydown", onKey);
  };
  extCancelBtn.addEventListener("click", onCancel);
  document.addEventListener("keydown", onKey);
}

function openExtConfirm(id: string, title: string, message: string): void {
  extTitleEl.textContent = title;
  extMessageEl.textContent = message;
  extMessageEl.classList.remove("hidden");
  extAcceptBtn.classList.remove("hidden");
  extDenyBtn.classList.remove("hidden");
  extOverlay.classList.remove("hidden");

  const respond = (confirmed: boolean | undefined) => {
    window.orbit.respondToUiRequest(id, confirmed === undefined ? { cancelled: true } : { confirmed });
    hideExtModal();
    cleanup();
  };
  const onYes = () => respond(true);
  const onNo = () => respond(false);
  const onCancel = () => respond(undefined);
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); respond(undefined); } };
  const cleanup = () => {
    extAcceptBtn.removeEventListener("click", onYes);
    extDenyBtn.removeEventListener("click", onNo);
    extCancelBtn.removeEventListener("click", onCancel);
    document.removeEventListener("keydown", onKey);
  };
  extAcceptBtn.addEventListener("click", onYes);
  extDenyBtn.addEventListener("click", onNo);
  extCancelBtn.addEventListener("click", onCancel);
  document.addEventListener("keydown", onKey);
}

window.orbit.onUiRequest((request) => {
  console.log("[orbit] UI request:", request.method, (request as Record<string, unknown>).widgetKey || "");
  const method = request.method;
  const id = (request as Record<string, unknown>).id as string;

  if (method === "input") {
    const title = (request as Record<string, unknown>).title as string;
    const placeholder = (request as Record<string, unknown>).placeholder as string | undefined;
    openExtInput(id, title, placeholder);
    return;
  }

  if (method === "select") {
    const title = (request as Record<string, unknown>).title as string;
    const options = ((request as Record<string, unknown>).options as string[]) || [];
    openExtSelect(id, title, options);
    return;
  }

  if (method === "confirm") {
    const title = (request as Record<string, unknown>).title as string;
    const message = (request as Record<string, unknown>).message as string;
    openExtConfirm(id, title, message);
    return;
  }

  if (method === "notify") {
    const message = (request as Record<string, unknown>).message as string | undefined;
    const notifyType = (request as Record<string, unknown>).notifyType as string | undefined;
    if (message) {
      const escaped = message.replace(/</g, "&lt;");
      // Preserve newlines + indentation for multi-line status/profile dumps.
      const body = escaped.includes("\n")
        ? `<div class="notify-preformatted">${escaped}</div>`
        : escaped;
      // Type marker: emoji for the bulk of users (Mac, Windows) plus an
      // inline SVG for Linux/older platforms where the emoji glyph
      // renders as a tofu box. CSS \`.notify-marker\` hides the emoji
      // when the SVG is rendering and vice-versa via a fonts-loaded
      // detector — see notify-marker rules in styles.css.
      let marker = "";
      if (notifyType === "warning") {
        marker =
          `<span class="notify-marker notify-marker-warning" aria-hidden="true">` +
          `<span class="notify-marker-emoji">⚠️</span>` +
          `<svg class="notify-marker-svg" viewBox="0 0 16 16" width="14" height="14">` +
          `<path d="M8 1.5 L15 14.5 H1 Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>` +
          `<path d="M8 6.5 V10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>` +
          `<circle cx="8" cy="12" r="0.8" fill="currentColor"/>` +
          `</svg></span> `;
      } else if (notifyType === "error") {
        marker =
          `<span class="notify-marker notify-marker-error" aria-hidden="true">` +
          `<span class="notify-marker-emoji">❌</span>` +
          `<svg class="notify-marker-svg" viewBox="0 0 16 16" width="14" height="14">` +
          `<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/>` +
          `<path d="M5 5 L11 11 M11 5 L5 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>` +
          `</svg></span> `;
      }
      chat.addInfoMessage(marker + body);
    }
    return;
  }

  if (method === "setWidget") {
    const key = request.widgetKey as string;
    const lines = request.widgetLines as string[] | undefined;

    // Notebook is the only widget the right pane consumes. The Activity
    // tab now mirrors the live shell + proc-monitor streams (see below);
    // the brain-side activity.jsonl is still written for debug but no
    // longer pushed as a widget.
    if (key === LoomWidgetKey.Notebook && lines) {
      artifacts.setNotebookMarkdown(decodeMarkdownWidget(lines));
      setArtifactCollapsed(false);
    }
  }
});

// ── Agent Status ──────────────────────────────────────────────────────────────

let hasShownStartupWelcome = false;
// When the badge is in a stuck state (error or persistent connecting…)
// make it clickable: open Preferences so the user can fix credentials /
// model / etc. without leaving Orbit.
const STUCK_STATUS = new Set(["error", "connecting"]);
let statusBadgeIsStuck = false;
statusBadge.style.cursor = "default";
statusBadge.title = "";
statusBadge.addEventListener("click", () => {
  if (statusBadgeIsStuck) void openPreferences();
});

/**
 * Single source of truth for status-badge updates. Sets className,
 * textContent, and the stuck-click affordance (cursor + title) in one
 * place. The 9+ in-stream sites that previously did
 * `statusBadge.className = "..."` directly skipped the stuck-click
 * sync — after a stream-driven error the badge looked red but click
 * didn't open Preferences.
 *
 * `status` is the bare status word ("running", "thinking", "error",
 * "connecting", or "" for the default ready state). `msg` overrides
 * the badge label when present; otherwise the status word is shown.
 */
function setStatusBadge(status: string, msg?: string): void {
  statusBadge.textContent = msg || status || "Ready";
  statusBadge.className = ("footer-control status-badge " + (status || "")).trim();
  statusBadgeIsStuck = STUCK_STATUS.has(status);
  statusBadge.style.cursor = statusBadgeIsStuck ? "pointer" : "default";
  statusBadge.title = statusBadgeIsStuck ? "Click to open Preferences" : "";
}

window.orbit.onAgentStatus((status, msg) => {
  setStatusBadge(status, msg);

  // Brain transitioned to stopped/error: clear the "we're streaming" UI
  // so the user has a clean Send button + no stuck "thinking…" card.
  // Without this, /resume / agent:restart / a brain crash leaves the
  // renderer believing a turn is still mid-flight (#63).
  if (status === "stopped" || status === "error") {
    streaming = false;
    sendBtn.classList.remove("hidden");
    abortBtn.classList.add("hidden");
    chat.hideThinking();
  }

  // Show cwd welcome once, after the first successful agent start.
  if (status === "running" && !hasShownStartupWelcome) {
    hasShownStartupWelcome = true;
    setArtifactCollapsed(false);
    void showCwdWelcome();
  }
});

// Race fix: did-finish-load → main spawns brain → agent:status fires before
// this module's listener is attached, so the badge stays stuck on its initial
// "connecting..." HTML. Pull the current snapshot now to catch up.
void window.orbit.getAgentStatus().then(({ status, message }) => {
  if (status === "stopped") return;
  setStatusBadge(status, message);
  if (status === "running" && !hasShownStartupWelcome) {
    hasShownStartupWelcome = true;
    setArtifactCollapsed(false);
    void showCwdWelcome();
  }
});

// ── Draggable Divider ─────────────────────────────────────────────────────────

const divider = document.getElementById("divider")!;
const chatPane = document.getElementById("chat-pane")!;

let dragging = false;

divider.addEventListener("mousedown", (e) => {
  e.preventDefault();
  dragging = true;
  divider.classList.add("dragging");
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
});

document.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const appWidth = document.getElementById("app")!.clientWidth;
  const pct = (e.clientX / appWidth) * 100;
  const clamped = Math.max(25, Math.min(75, pct));
  chatPane.style.flex = `0 0 ${clamped}%`;
});

document.addEventListener("mouseup", () => {
  if (!dragging) return;
  dragging = false;
  divider.classList.remove("dragging");
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
});

// ── Preferences ──────────────────────────────────────────────────────────────

const prefsOverlay = document.getElementById("prefs-overlay")!;
const prefsClose = document.getElementById("prefs-close")!;
const prefsCancel = document.getElementById("prefs-cancel")!;
const prefsSave = document.getElementById("prefs-save")!;
const prefsBrowseCwd = document.getElementById("prefs-browse-cwd")!;

const prefsProvider = document.getElementById("prefs-provider") as HTMLSelectElement;
const prefsModel = document.getElementById("prefs-model") as HTMLSelectElement;
const prefsApiKey = document.getElementById("prefs-api-key") as HTMLInputElement;
const prefsApiKeyStatus = document.getElementById("prefs-api-key-status")!;

// Model catalog by provider — labels include cost guidance
// (in/out price per 1M tokens). Fallback only — populateDynamicModelData()
// at startup overwrites this from pi-ai's bundled registry via main IPC,
// so new models don't require hand-edits here.
interface ModelChoice { id: string; label: string; }
let MODELS_BY_PROVIDER: Record<string, ModelChoice[]> = {
  anthropic: [
    { id: "claude-opus-4-7",   label: "Opus 4.7 — $15/$75 (most capable)" },
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6 — $3/$15 (recommended)" },
    { id: "claude-haiku-4-5",  label: "Haiku 4.5 — $1/$5 (cheapest)" },
    { id: "claude-opus-4-6",   label: "Opus 4.6 — $15/$75" },
    { id: "claude-sonnet-4-5", label: "Sonnet 4.5 — $3/$15" },
    { id: "claude-opus-4-5",   label: "Opus 4.5 — $15/$75" },
  ],
  openai: [
    { id: "gpt-4o-mini", label: "GPT-4o mini — $0.15/$0.60 (cheapest)" },
    { id: "gpt-4o",      label: "GPT-4o — $2.50/$10" },
    { id: "gpt-4-turbo", label: "GPT-4 Turbo — $10/$30" },
    { id: "o1-mini",     label: "o1-mini — $3/$12" },
    { id: "o1",          label: "o1 — $15/$60" },
  ],
  google: [
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash — $0.15/$0.60 (cheapest)" },
    { id: "gemini-2.5-pro",   label: "Gemini 2.5 Pro — $1.25/$10" },
  ],
  mistral: [
    { id: "mistral-large-latest", label: "Mistral Large" },
    { id: "mistral-medium-latest", label: "Mistral Medium" },
    { id: "mistral-small-latest", label: "Mistral Small" },
  ],
  groq: [
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
    { id: "llama-3.1-8b-instant",    label: "Llama 3.1 8B (fast)" },
  ],
  xai: [
    { id: "grok-2-latest", label: "Grok 2" },
  ],
  ollama: [
    { id: "qwen3-coder:30b", label: "Qwen3-Coder 30B (local, A5000) — free" },
    { id: "qwen3:8b",        label: "Qwen3 8B (local, fast) — free" },
  ],
};

function populateModels(provider: string, selected?: string): void {
  prefsModel.innerHTML = "";
  const models = MODELS_BY_PROVIDER[provider] || [];
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    if (selected && m.id === selected) opt.selected = true;
    prefsModel.appendChild(opt);
  }
  // If saved model isn't in the catalog (custom or older), add it as a free-form entry
  if (selected && !models.find(m => m.id === selected)) {
    const opt = document.createElement("option");
    opt.value = selected;
    opt.textContent = `${selected} (custom)`;
    opt.selected = true;
    prefsModel.appendChild(opt);
  }
}

// Repopulate model dropdown when provider changes
prefsProvider.addEventListener("change", () => {
  populateModels(prefsProvider.value);
});
wireApiKeyValidation(prefsProvider, prefsApiKey, prefsApiKeyStatus);
const prefsGalaxyUrl = document.getElementById("prefs-galaxy-url") as HTMLInputElement;
const prefsGalaxyKey = document.getElementById("prefs-galaxy-key") as HTMLInputElement;
const prefsGalaxyError = document.getElementById("prefs-galaxy-error")!;
const prefsGalaxyActionsRow = document.getElementById("prefs-galaxy-actions-row")!;
const prefsGalaxyDisconnect = document.getElementById("prefs-galaxy-disconnect") as HTMLButtonElement;
const prefsDefaultCwd = document.getElementById("prefs-default-cwd") as HTMLInputElement;
const prefsCondaBin = document.getElementById("prefs-conda-bin") as HTMLSelectElement;
const prefsSkillsRows = document.getElementById("prefs-skills-rows")!;
const prefsSkillsAddBtn = document.getElementById("prefs-skills-add")!;

interface PrefsSkillRepo {
  name: string;
  url: string;
  branch: string;
  enabled: boolean;
}

let prefsSkillsState: PrefsSkillRepo[] = [];

function renderSkillsRows(): void {
  prefsSkillsRows.innerHTML = "";
  if (prefsSkillsState.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.className = "prefs-skills-empty";
    td.textContent = "No skill repos. Removing all entries re-seeds galaxy-skills on save.";
    tr.appendChild(td);
    prefsSkillsRows.appendChild(tr);
    return;
  }
  prefsSkillsState.forEach((repo, idx) => {
    const tr = document.createElement("tr");
    tr.appendChild(makeSkillCell(repo, idx, "name", "text"));
    tr.appendChild(makeSkillCell(repo, idx, "url", "text"));
    tr.appendChild(makeSkillCell(repo, idx, "branch", "text"));

    const enabledTd = document.createElement("td");
    enabledTd.className = "prefs-skills-enabled";
    const enabledBox = document.createElement("input");
    enabledBox.type = "checkbox";
    enabledBox.checked = repo.enabled;
    enabledBox.addEventListener("change", () => {
      prefsSkillsState[idx].enabled = enabledBox.checked;
    });
    enabledTd.appendChild(enabledBox);
    tr.appendChild(enabledTd);

    const actionsTd = document.createElement("td");
    actionsTd.className = "prefs-skills-actions";
    const removeBtn = document.createElement("button");
    removeBtn.className = "plan-btn";
    removeBtn.textContent = "Remove";
    removeBtn.title = "Remove this skill repo";
    removeBtn.addEventListener("click", () => {
      const label = prefsSkillsState[idx]?.name || prefsSkillsState[idx]?.url || "this skill repo";
      if (!confirm(`Remove ${label}?`)) return;
      prefsSkillsState.splice(idx, 1);
      renderSkillsRows();
    });
    actionsTd.appendChild(removeBtn);
    tr.appendChild(actionsTd);

    prefsSkillsRows.appendChild(tr);
  });
}

function makeSkillCell(
  repo: PrefsSkillRepo,
  idx: number,
  field: "name" | "url" | "branch",
  inputType: "text",
): HTMLTableCellElement {
  const td = document.createElement("td");
  td.className = `prefs-skills-${field}`;
  const input = document.createElement("input");
  input.type = inputType;
  input.value = repo[field];
  if (field === "url") input.placeholder = `${ALLOWED_SKILLS_PREFIX}<repo>`;
  if (field === "branch") input.placeholder = "main";
  input.addEventListener("input", () => {
    prefsSkillsState[idx][field] = input.value.trim();
  });
  td.appendChild(input);
  return td;
}

prefsSkillsAddBtn.addEventListener("click", () => {
  prefsSkillsState.push({ name: "", url: "", branch: "main", enabled: true });
  renderSkillsRows();
});

/** Sentinel mirrors UNCHANGED_SECRET in main/ipc-handlers.ts. */
const UNCHANGED_SECRET = "__loom_unchanged_secret__";
/** Tracks whether a key is already on disk so blank-input = unchanged, not clear. */
let prefsLlmHadKey = false;
let prefsGalaxyHadKey = false;

// Both-or-neither: a half-filled Galaxy profile gets rejected by the brain
// silently, so disable Save and surface why inline rather than letting the
// user click and discover via an alert.
function updatePrefsGalaxyValidity(): void {
  const hasUrl = Boolean(prefsGalaxyUrl.value.trim());
  const hasKey = Boolean(prefsGalaxyKey.value.trim() || prefsGalaxyHadKey);
  const halfFilled = hasUrl !== hasKey;
  prefsGalaxyError.textContent = halfFilled
    ? "Provide both URL and API key, or leave both blank."
    : "";
  (prefsSave as HTMLButtonElement).disabled = halfFilled;
}
prefsGalaxyUrl.addEventListener("input", updatePrefsGalaxyValidity);
prefsGalaxyKey.addEventListener("input", updatePrefsGalaxyValidity);

async function openPreferences(): Promise<void> {
  const config = await window.orbit.getConfig() as {
    llm?: { provider?: string; model?: string; hasApiKey?: boolean };
    galaxy?: { active: string | null; profiles: Record<string, { url: string; hasApiKey?: boolean }> };
    defaultCwd?: string;
    condaBin?: string;
    skills?: { repos?: Array<{ name?: string; url?: string; branch?: string; enabled?: boolean }> };
  };

  prefsProvider.value = config.llm?.provider || "anthropic";
  populateModels(prefsProvider.value, config.llm?.model);
  prefsLlmHadKey = Boolean(config.llm?.hasApiKey);
  prefsApiKey.value = "";
  prefsApiKey.placeholder = prefsLlmHadKey ? "•••••••• (unchanged)" : "";
  prefsApiKeyStatus.className = "api-key-status";
  prefsApiKeyStatus.textContent = "";

  // Galaxy: use active profile
  const activeProfile = config.galaxy?.active
    ? config.galaxy.profiles?.[config.galaxy.active]
    : null;
  prefsGalaxyUrl.value = activeProfile?.url || "";
  prefsGalaxyHadKey = Boolean(activeProfile?.hasApiKey);
  prefsGalaxyKey.value = "";
  prefsGalaxyKey.placeholder = prefsGalaxyHadKey ? "•••••••• (unchanged)" : "";
  // Disconnect button only makes sense when a profile is currently
  // configured. Hide entirely when nothing's stored.
  prefsGalaxyActionsRow.classList.toggle("hidden", !(activeProfile?.url || prefsGalaxyHadKey));
  updatePrefsGalaxyValidity();

  prefsDefaultCwd.value = config.defaultCwd || "";
  prefsCondaBin.value = config.condaBin || "auto";

  // Skills: hydrate the editable table from config. The brain seeds
  // galaxy-skills if absent, but we hydrate from whatever's in config so
  // an admin who explicitly removed it doesn't see it re-appear here
  // until they hit Save (which triggers re-seed if the list ends up empty).
  prefsSkillsState = (config.skills?.repos ?? []).map((r) => ({
    name: typeof r?.name === "string" ? r.name : "",
    url: typeof r?.url === "string" ? r.url : "",
    branch: typeof r?.branch === "string" && r.branch ? r.branch : "main",
    enabled: r?.enabled !== false,
  }));
  renderSkillsRows();

  prefsOverlay.classList.remove("hidden");
}

function closePreferences(): void {
  prefsOverlay.classList.add("hidden");
}

async function savePreferences(): Promise<void> {
  // Saving config restarts the brain (so MCP env / model changes take
  // effect). If a prompt is currently in flight, the restart silently
  // drops it — the user's message is lost without warning (#62). Make
  // them confirm explicitly.
  if (streaming) {
    const ok = confirm(
      "The agent is still working on your previous prompt. " +
      "Saving Preferences will restart it and your in-flight prompt will be lost.\n\n" +
      "Continue?"
    );
    if (!ok) return;
  }

  // Build a delta — only fields the user can edit. Main reconciles secrets
  // against what's on disk; the sentinel preserves a stored key when the
  // user left the input blank.
  const typedApiKey = prefsApiKey.value.trim();
  const llmApiKey = typedApiKey
    ? typedApiKey
    : prefsLlmHadKey
    ? UNCHANGED_SECRET
    : "";

  const typedGalaxyKey = prefsGalaxyKey.value.trim();
  const galaxyUrl = prefsGalaxyUrl.value.trim();
  const galaxyApiKey = typedGalaxyKey
    ? typedGalaxyKey
    : prefsGalaxyHadKey
    ? UNCHANGED_SECRET
    : "";

  const hasGalaxyUrl = Boolean(galaxyUrl);
  const hasGalaxyKey = Boolean(typedGalaxyKey || prefsGalaxyHadKey);
  if (hasGalaxyUrl !== hasGalaxyKey) {
    // Save button should already be disabled by updatePrefsGalaxyValidity.
    // Belt-and-suspenders: bail silently if it somehow fires anyway.
    return;
  }

  const selectedModel = prefsModel.value || undefined;
  const config: Record<string, unknown> = {
    llm: {
      provider: prefsProvider.value,
      model: selectedModel,
      apiKey: llmApiKey,
    },
  };

  if (galaxyUrl || prefsGalaxyHadKey || typedGalaxyKey) {
    config.galaxy = {
      active: "default",
      profiles: {
        default: {
          url: galaxyUrl,
          apiKey: galaxyApiKey,
        },
      },
    };
  }

  config.defaultCwd = prefsDefaultCwd.value.trim() || undefined;
  config.condaBin = (prefsCondaBin.value as "auto" | "mamba" | "conda") || undefined;

  // Skills: persist whatever's in the table, dropping incomplete rows. If the
  // user emptied the list entirely, the brain's loadConfig will lazy-seed
  // galaxy-skills on next read — we don't re-seed here so a deliberate
  // "none" state survives at least until next session start.
  const cleaned = prefsSkillsState
    .filter((r) => r.name.trim() && r.url.trim())
    .map((r) => ({
      name: r.name.trim(),
      url: r.url.trim(),
      branch: r.branch.trim() || "main",
      enabled: r.enabled,
    }));

  // Allowlist: alpha release accepts only github.com/galaxyproject/* repos.
  // The brain enforces the same predicate as defense-in-depth, but we block
  // at save time so the user sees the reason instead of a silent drop.
  const disallowed = cleaned.filter((r) => !isAllowedSkillUrl(r.url));
  if (disallowed.length > 0) {
    const list = disallowed.map((r) => `  • ${r.name}: ${r.url}`).join("\n");
    alert(
      `Skills repos must live under ${ALLOWED_SKILLS_PREFIX}* (alpha ` +
      `restriction). Disallowed entries:\n\n${list}\n\n` +
      `Fix or remove them before saving.`,
    );
    return;
  }

  config.skills = { repos: cleaned };

  const result = await window.orbit.saveConfig(config as Record<string, unknown>);
  if (result.success) {
    closePreferences();
    if (selectedModel) {
      currentModel = selectedModel;
      renderModelIndicator();
    }
    // Info card, not a fake user prompt — was getting numbered as a real
    // user submission and inflating the prompt counter.
    chat.addInfoMessage("<i>Preferences saved. Agent restarted.</i>");
  } else {
    alert(`Failed to save preferences: ${result.error}`);
  }
}

prefsClose.addEventListener("click", closePreferences);
prefsCancel.addEventListener("click", closePreferences);
prefsSave.addEventListener("click", savePreferences);
prefsOverlay.addEventListener("click", (e) => {
  if (e.target === prefsOverlay) closePreferences();
});

prefsBrowseCwd.addEventListener("click", async () => {
  const dir = await window.orbit.browseDirectory();
  if (dir) prefsDefaultCwd.value = dir;
});

// Disconnect Galaxy: send an explicit clear delta. Main's reconciler
// already treats apiKey: "" as "drop the stored field" (#49). We send
// galaxy with no profiles so main writes back active: null + empty
// profiles map, which the brain reads on next start as "Galaxy not
// configured" — re-registers MCP only when a key reappears.
prefsGalaxyDisconnect.addEventListener("click", async () => {
  if (streaming) {
    const ok = confirm(
      "The agent is still working. Disconnecting Galaxy will restart it " +
      "and your in-flight prompt will be lost.\n\nContinue?"
    );
    if (!ok) return;
  } else {
    if (!confirm("Disconnect Galaxy and clear stored credentials? Other Preferences are saved as well.")) return;
  }
  prefsGalaxyDisconnect.disabled = true;
  try {
    const current = (await window.orbit.getConfig()) as Record<string, unknown>;
    current.galaxy = { active: null, profiles: {} };
    const result = await window.orbit.saveConfig(current);
    if (!result.success) {
      alert(`Failed to disconnect: ${result.error}`);
      return;
    }
    closePreferences();
    chat.addInfoMessage("<i>Disconnected from Galaxy. Agent restarted.</i>");
    void refreshGalaxyStatus();
  } finally {
    prefsGalaxyDisconnect.disabled = false;
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !prefsOverlay.classList.contains("hidden")) {
    closePreferences();
  }
});

window.orbit.onOpenPreferences(() => {
  openPreferences();
});

window.orbit.onShowSlashCommands(() => {
  chat.addInfoMessage(slashCommandsHtml());
});

// ── Report-issue modal ───────────────────────────────────────────────────────
//
// One-click affordance for alpha testers: pre-fills a GitHub "new issue" URL
// with the user's title/description plus opt-in sysinfo + log tails, then
// opens the user's browser. The renderer never gets a generic openExternal —
// the URL is constructed in main against a hard-coded repo (#33 option A).

const reportBtn = document.getElementById("report-issue-btn")!;
const reportOverlay = document.getElementById("report-overlay")!;
const reportClose = document.getElementById("report-close")!;
const reportCancel = document.getElementById("report-cancel")!;
const reportSubmit = document.getElementById("report-submit") as HTMLButtonElement;
const reportTitle = document.getElementById("report-title") as HTMLInputElement;
const reportBody = document.getElementById("report-body") as HTMLTextAreaElement;
const reportIncludeSysinfo = document.getElementById("report-include-sysinfo") as HTMLInputElement;
const reportIncludeLogs = document.getElementById("report-include-logs") as HTMLInputElement;

// Budget for the *encoded* body in the GitHub URL. The whole URL
// (~"https://github.com/galaxyproject/loom/issues/new?title=…&body=…")
// has to fit within ~8KB or the OS/browser refuses to open it. Most
// punctuation triples in length once URL-encoded (a newline becomes
// "%0A"), so the raw body has to be capped well below 8000 chars.
const REPORT_URL_BUDGET = 7000;

function openReportModal(): void {
  reportTitle.value = "";
  reportBody.value = "";
  // Default to no auto-collected data. The destination is a public GitHub
  // issue, so opt-in beats opt-out -- forces the user to read the
  // disclosure before sharing logs or sysinfo.
  reportIncludeSysinfo.checked = false;
  reportIncludeLogs.checked = false;
  reportOverlay.classList.remove("hidden");
  reportTitle.focus();
}
function closeReportModal(): void {
  reportOverlay.classList.add("hidden");
}

async function buildReportBody(userText: string): Promise<string> {
  const sections: string[] = [userText.trim() || "(no description provided)"];

  if (reportIncludeSysinfo.checked) {
    try {
      const info = await window.orbit.getReportSysinfo();
      const cfg = (await window.orbit.getConfig()) as {
        llm?: { provider?: string; model?: string };
        galaxy?: { active: string | null };
      };
      // Deliberately not including cwd -- a path like /home/<user>/<project>
      // leaks both username and project name to a public issue, and isn't
      // useful for debugging.
      sections.push(
        `## System info\n` +
        `- Orbit: ${info.appVersion}\n` +
        `- Platform: ${info.platform} ${info.arch}\n` +
        `- Electron: ${info.electronVersion}, Chrome: ${info.chromeVersion}, Node: ${info.nodeVersion}\n` +
        `- LLM: ${cfg.llm?.provider ?? "(none)"} / ${cfg.llm?.model ?? "(none)"}\n` +
        `- Galaxy: ${cfg.galaxy?.active ? "configured" : "not configured"}`
      );
    } catch (err) {
      sections.push(`## System info\n(failed to collect: ${err instanceof Error ? err.message : String(err)})`);
    }
  }

  if (reportIncludeLogs.checked) {
    // Activity tail — last 15 events, summarized to {timestamp} {kind}.
    // The full payload column has stuffed-JSON tool results that explode
    // 3–5× under URL-encoding and quickly blow GitHub's URL budget.
    try {
      const res = await window.orbit.readFile("activity.jsonl");
      if (res.ok) {
        const text = new TextDecoder("utf-8").decode(res.bytes);
        const lines = text.split("\n").filter(Boolean).slice(-15);
        const summarized = lines.map((line) => {
          try {
            const e = JSON.parse(line) as { timestamp?: string; kind?: string; source?: string };
            return `${e.timestamp ?? "?"} ${e.kind ?? "?"}${e.source ? " (" + e.source + ")" : ""}`;
          } catch {
            return line.slice(0, 80);
          }
        });
        sections.push("## activity.jsonl (last 15 events, summarized)\n```\n" + summarized.join("\n") + "\n```");
      }
    } catch { /* file missing or unreadable — skip */ }

    // Shell tail (last ~80 lines of in-memory ShellPanel)
    const shellTail = shell.tail(80);
    if (shellTail.trim()) {
      sections.push("## Shell stream (last ~80 lines)\n```\n" + shellTail + "\n```");
    }
  }

  let body = sections.join("\n\n");
  // Cap on the URL-encoded length, not the raw length — a body full of
  // backslash-quoted JSON expands ~3× under encodeURIComponent. Trim
  // raw chars until the encoded form fits the budget.
  if (encodeURIComponent(body).length > REPORT_URL_BUDGET) {
    const marker = "\n\n…(truncated)";
    const markerCost = encodeURIComponent(marker).length;
    while (encodeURIComponent(body).length + markerCost > REPORT_URL_BUDGET) {
      body = body.slice(0, Math.floor(body.length * 0.9));
    }
    body = body + marker;
  }
  return body;
}

reportBtn.addEventListener("click", openReportModal);
reportClose.addEventListener("click", closeReportModal);
reportCancel.addEventListener("click", closeReportModal);
reportOverlay.addEventListener("click", (e) => {
  if (e.target === reportOverlay) closeReportModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !reportOverlay.classList.contains("hidden")) {
    closeReportModal();
  }
});

reportSubmit.addEventListener("click", async () => {
  const title = reportTitle.value.trim();
  if (!title) {
    // Native validity tooltip is consistent with how form validation works
    // elsewhere in the app and avoids silent failure when the button click
    // doesn't appear to do anything.
    reportTitle.reportValidity();
    return;
  }
  reportSubmit.disabled = true;
  try {
    const body = await buildReportBody(reportBody.value);
    await window.orbit.openIssueReport({ title, body });
    closeReportModal();
  } finally {
    reportSubmit.disabled = false;
  }
});

// ── Agent shell event feed ────────────────────────────────────────────────────

/** Extract a short, useful summary from an agent event and append to the shell. */
function feedShell(event: Record<string, unknown>): void {
  const type = event.type as string;

  switch (type) {
    case "agent_start": {
      shell.append("─── agent turn start ───", "info");
      revealActivityForTurn();
      break;
    }
    case "turn_start": {
      // Some models do multiple "turns" per agent run (thinking, then tools, then text)
      // Skip these to reduce noise; we already have agent_start
      break;
    }
    case "message_start": {
      const msg = event.message as { role?: string; model?: string } | undefined;
      if (msg?.role === "assistant" && msg.model) {
        shell.append(`  thinking… (${msg.model})`, "info");
      }
      break;
    }
    case "message_update": {
      // Show when the agent starts producing visible text / a tool call
      const ame = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      if (!ame) break;
      if (ame.type === "text_start") {
        shell.append("  ▸ writing response…", "info");
      } else if (ame.type === "toolcall_start") {
        shell.append("  ▸ preparing tool call…", "info");
      }
      break;
    }
    case "tool_execution_start": {
      const name = (event.toolName as string) || "tool";
      const args = event.args as Record<string, unknown> | undefined;
      shell.append(`▸ ${name}(${summarizeArgs(args)})`, "tool-start");
      break;
    }
    case "tool_execution_end": {
      const name = (event.toolName as string) || "tool";
      const result = event.result as { content?: { type: string; text: string }[] } | undefined;
      const text = result?.content?.[0]?.text;
      if (!text) {
        shell.append(`  ✓ ${name} done`, "tool-end");
        break;
      }
      try {
        const parsed = JSON.parse(text);
        if (parsed.success === false || parsed.exitCode > 0) {
          const msg = parsed.error || parsed.stderr || parsed.message || "failed";
          shell.append(`  ✗ ${name}: ${truncate(msg, 200)}`, "tool-error");
          // Show a few lines of stderr if present
          if (parsed.stderr && typeof parsed.stderr === "string") {
            for (const line of parsed.stderr.split("\n").slice(-5)) {
              if (line.trim()) shell.append(line, "stdout");
            }
          }
        } else {
          const msg = parsed.message || `exit ${parsed.exitCode ?? 0}`;
          shell.append(`  ✓ ${name}: ${truncate(msg, 200)}`, "tool-end");
          // For run_command, show last few stdout lines
          if (parsed.stdout && typeof parsed.stdout === "string") {
            const lines = parsed.stdout.trim().split("\n").slice(-3);
            for (const line of lines) {
              if (line.trim()) shell.append(line, "stdout");
            }
          }
        }
      } catch {
        // Not JSON — show first 200 chars
        shell.append(`  ✓ ${name}: ${truncate(text, 200)}`, "tool-end");
      }
      break;
    }
    case "extension_ui_request": {
      const method = event.method as string;
      if (method === "setStatus") {
        const key = event.statusKey as string;
        const text = event.statusText as string;
        // Strip ANSI color codes
        const clean = text?.replace(/\x1b\[[0-9;]*m/g, "");
        if (key && key !== "ready" && clean) {
          shell.append(`[${key}] ${clean}`, "status");
        }
      }
      break;
    }
    case "error": {
      const msg = (event.message as string) || "Unknown error";
      shell.append(`✗ ${msg}`, "tool-error");
      break;
    }
  }
}

function summarizeArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  // Format args as compact "key=value" pairs, truncating long strings
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    let s: string;
    if (Array.isArray(v)) {
      s = v.length <= 3 ? `[${v.join(", ")}]` : `[${v.length} items]`;
    } else if (typeof v === "string") {
      s = `"${truncate(v, 60)}"`;
    } else if (v === null || v === undefined) {
      s = String(v);
    } else if (typeof v === "object") {
      s = "{...}";
    } else {
      s = String(v);
    }
    parts.push(`${k}=${s}`);
  }
  return truncate(parts.join(", "), 160);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

// ── Agent shell ──────────────────────────────────────────────────────────────

const shellClearBtn = document.getElementById("agent-shell-clear")!;
shellClearBtn.addEventListener("click", () => shell.clear());

let hasRevealedActivityThisTurn = false;
/**
 * Once per turn, surface the agent shell so the user can watch.
 * If the artifact pane is **collapsed**, expand it AND switch to
 * Activity. If it's already **expanded** with a non-default tab
 * active (Notebook / File), don't yank the user away — they're
 * reading something and the live shell would clobber that. The
 * agent_start case where this matters most is mid-read on the
 * Notebook tab.
 */
function revealActivityForTurn(): void {
  if (hasRevealedActivityThisTurn) return;
  hasRevealedActivityThisTurn = true;
  const wasCollapsed = document.body.classList.contains("artifact-collapsed");
  setArtifactCollapsed(false);
  if (wasCollapsed) {
    artifacts.selectTab("activity");
  }
}

// ── Process monitor ──────────────────────────────────────────────────────────

interface ProcInfo {
  pid: number;
  ppid: number;
  pcpu: number;
  pmem: number;
  rss: number;
  etime: string;
  command: string;
}

const procMonitorCountEl = document.getElementById("proc-monitor-count")!;
const procMonitorRowsEl = document.getElementById("proc-monitor-rows")!;

function formatRss(kb: number): string {
  if (kb < 1024) return `${kb}K`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(0)}M`;
  return `${(kb / (1024 * 1024)).toFixed(1)}G`;
}

function renderProcs(procs: ProcInfo[]): void {
  procMonitorCountEl.textContent = String(procs.length);
  procMonitorCountEl.classList.toggle("zero", procs.length === 0);

  if (procs.length === 0) {
    procMonitorRowsEl.innerHTML = '<tr><td colspan="6" class="empty-procs">No subprocesses running</td></tr>';
    return;
  }

  const sorted = [...procs].sort((a, b) => b.pcpu - a.pcpu);
  procMonitorRowsEl.innerHTML = sorted.map((p) => `
    <tr>
      <td class="col-num">${p.pid}</td>
      <td class="col-num">${p.pcpu.toFixed(1)}</td>
      <td class="col-num">${p.pmem.toFixed(1)}</td>
      <td class="col-num">${formatRss(p.rss)}</td>
      <td class="col-num">${p.etime}</td>
      <td class="col-cmd" title="${escapeAttr(p.command)}">${escapeHtml(p.command)}</td>
    </tr>
  `).join("");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
window.orbit.onProcUpdate((procs) => {
  renderProcs(procs as ProcInfo[]);
});

// ── Focus input on load ───────────────────────────────────────────────────────
inputEl.focus();
