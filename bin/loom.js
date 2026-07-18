#!/usr/bin/env node

import { main } from "@earendil-works/pi-coding-agent";
import { resolve, dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { homedir } from "os";
import {
  loadConfig as loadLoomConfig,
  saveConfig as saveLoomConfig,
} from "../shared/loom-config.js";
import { spawn } from "child_process";
import { getLoomVersion, detectInstall } from "./update-check.js";
import { isUvxAvailable, uvxMissingNotice } from "./uvx-check.js";
import { resolveHideThinking, isInteractiveTerminal } from "./thinking-pref.js";
import { pickChannel } from "../shared/version-compare.js";
import {
  isCustomProvider,
  syncCustomProviderModelsFile,
  resolveActiveLlmApiKey,
} from "../shared/custom-provider.js";
import { GALAXY_MCP_SPEC } from "../shared/galaxy-mcp-spec.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Loom is a standalone product — suppress Pi's branding and update checks.
// quietStartup hides the keybinding banner + resource listing on launch.
process.env.PI_SKIP_VERSION_CHECK = "1";

// Resolve extension paths relative to this script
const extensionPath = resolve(__dirname, "../extensions/loom");
// CLI-shell hand-off glue (the /orbit command). Kept out of the loom brain so
// the brain stays shell-neutral; the command no-ops when embedded in Orbit.
const orbitHandoffPath = resolve(__dirname, "../extensions/orbit-handoff");
const cliUpdatePath = resolve(__dirname, "../extensions/cli-update");
const whatsNewPath = resolve(__dirname, "../extensions/whats-new");
const updateCheckScript = resolve(__dirname, "update-check.js");

// pi-mcp-adapter is what teaches Pi how to use MCP servers from mcp.json
// pi-web-access provides web_search, fetch_content, and code_search tools
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const mcpAdapterPath = dirname(require.resolve("pi-mcp-adapter/index.ts"));
const webAccessPath = dirname(require.resolve("pi-web-access/index.ts"));
const piEntryPointPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piPackageDir = dirname(dirname(piEntryPointPath));
const piArgsModulePath = join(piPackageDir, "dist/cli/args.js");
const piListModelsModulePath = join(piPackageDir, "dist/cli/list-models.js");
const piConfigModulePath = join(piPackageDir, "dist/config.js");
const piAuthStorageModulePath = join(piPackageDir, "dist/core/auth-storage.js");
const piModelRegistryModulePath = join(piPackageDir, "dist/core/model-registry.js");
const userArgs = process.argv.slice(2);

// Local-execution safety flags. Translate to env so the exec-guard (brain side)
// reads them; strip so they aren't forwarded to pi as unknown flags.
if (userArgs.includes("--dangerously-bypass-permissions")) {
  process.env.LOOM_DANGEROUSLY_BYPASS_PERMISSIONS = "1";
}
if (userArgs.includes("--safe")) {
  process.env.LOOM_SAFE = "1";
}
// Opt-in bash sandbox: run allowed bash inside an OS sandbox (the gate still gates).
if (userArgs.includes("--sandbox")) {
  process.env.LOOM_SANDBOX = "1";
}
// A bare interactive CLI always has a local execution surface, so the exec-guard
// (brain side) must stay on regardless of any ambient LOOM_LOCAL_EXEC in the
// launching env. The web/desktop shells run the brain with --mode rpc and set
// LOOM_LOCAL_EXEC authoritatively themselves (off for the no-exec web container,
// on for desktop), so only pin it here for the non-rpc CLI path.
const isRpcMode = userArgs.includes("--mode") && userArgs[userArgs.indexOf("--mode") + 1] === "rpc";
if (!isRpcMode) {
  process.env.LOOM_LOCAL_EXEC = "on";
}
if (userArgs.includes("--no-update-check")) {
  process.env.LOOM_NO_UPDATE_CHECK = "1";
}
for (let i = userArgs.length - 1; i >= 0; i--) {
  if (
    userArgs[i] === "--dangerously-bypass-permissions" ||
    userArgs[i] === "--safe" ||
    userArgs[i] === "--sandbox" ||
    userArgs[i] === "--no-update-check"
  ) {
    userArgs.splice(i, 1);
  }
}

function hasArg(flag) {
  return userArgs.includes(flag) || userArgs.some((arg) => arg.startsWith(`${flag}=`));
}

const isInformationalCommand = ["--help", "-h", "--version", "--list-models"].some(hasArg);

// Config opt-out feeds the same single signal the extension + refresh read.
try {
  if (loadLoomConfig().updateCheck === false) process.env.LOOM_NO_UPDATE_CHECK = "1";
} catch {}

if (
  !isInformationalCommand &&
  process.env.LOOM_DANGEROUSLY_BYPASS_PERMISSIONS === "1" &&
  process.env.LOOM_SAFE !== "1"
) {
  console.error(
    "\n  \x1b[1;31m⚠  PERMISSIONS BYPASSED\x1b[0m -- Loom will run any command without asking.\n",
  );
}

function getListModelsSearchPattern() {
  const index = userArgs.findIndex((arg) => arg === "--list-models");
  if (index === -1) return undefined;
  const candidate = userArgs[index + 1];
  if (!candidate || candidate.startsWith("-") || candidate.startsWith("@")) {
    return undefined;
  }
  return candidate;
}

async function handleInformationalCommand() {
  if (hasArg("--help") || hasArg("-h")) {
    const { printHelp } = await import(pathToFileURL(piArgsModulePath).href);
    printHelp();
    return true;
  }

  if (hasArg("--version")) {
    const { VERSION } = await import(pathToFileURL(piConfigModulePath).href);
    console.log(`loom ${getLoomVersion()} (pi-coding-agent ${VERSION})`);
    return true;
  }

  if (hasArg("--list-models")) {
    const { listModels } = await import(pathToFileURL(piListModelsModulePath).href);
    const { getModelsPath } = await import(pathToFileURL(piConfigModulePath).href);
    const { AuthStorage } = await import(pathToFileURL(piAuthStorageModulePath).href);
    const { ModelRegistry } = await import(pathToFileURL(piModelRegistryModulePath).href);
    const authStorage = AuthStorage.inMemory();
    const modelRegistry = new ModelRegistry(authStorage, getModelsPath());
    await listModels(modelRegistry, getListModelsSearchPattern());
    return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loom brain-level config (~/.loom/config.json)
//
// Shared by every consumer (loom CLI, Orbit, future shells). The CLI only
// reads/writes it; it doesn't own the schema. Shell-specific state lives in
// each shell's own dir.
// ─────────────────────────────────────────────────────────────────────────────

const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

// ─────────────────────────────────────────────────────────────────────────────
// Apply consolidated config
// ─────────────────────────────────────────────────────────────────────────────

const loomConfig = loadLoomConfig();

// Provider name → env var mapping
const PROVIDER_ENV_MAP = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  xai: "XAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

// Providers that authenticate via OAuth (~/.pi/agent/auth.json) instead of env vars.
const OAUTH_PROVIDERS = new Set(["openai-codex"]);

function readAuthJson() {
  const authPath = join(agentDir, "auth.json");
  if (!existsSync(authPath)) return {};
  try {
    return JSON.parse(readFileSync(authPath, "utf-8")) || {};
  } catch {
    return {};
  }
}

// Can this CLI actually authenticate the given provider? OAuth providers need a
// credential in auth.json; everyone else needs a plaintext config key or the
// provider's env var (encrypted config keys aren't decryptable outside Orbit).
function activeProviderUsable(provider, entry, auth) {
  if (OAUTH_PROVIDERS.has(provider)) return Boolean(auth[provider]);
  // Custom OpenAI-compatible providers resolve their key from the injected
  // env var (Orbit) or a plaintext config key (CLI) -- same logic as
  // checkLLMProvider. Without this, a keyless-on-disk custom provider looks
  // unusable and the reconciler could silently switch llm.active away from it.
  if (isCustomProvider(entry)) return Boolean(resolveActiveLlmApiKey(entry, process.env));
  if (entry?.apiKey) return true;
  const envVar = PROVIDER_ENV_MAP[provider];
  return Boolean(envVar && process.env[envVar]);
}

// Pi's `/login` writes credentials to auth.json but never touches Loom's
// llm.active, so signing into a new provider mid-session has no effect on the
// next launch. Bridge that gap: if the configured active provider has no
// credential this CLI can use, but the user has signed into an OAuth provider,
// switch llm.active to it and persist so the choice sticks.
function reconcileActiveProviderWithAuth() {
  const llm = loomConfig.llm;
  if (!llm?.active) return;
  const auth = readAuthJson();
  if (activeProviderUsable(llm.active, llm.providers?.[llm.active], auth)) return;
  const candidate = [...OAUTH_PROVIDERS].find((p) => auth[p]);
  if (!candidate || candidate === llm.active) return;
  const from = llm.active;
  llm.active = candidate;
  llm.providers = llm.providers || {};
  if (!llm.providers[candidate]) llm.providers[candidate] = {};
  try {
    saveLoomConfig(loomConfig);
    console.error(
      `loom: active provider "${from}" has no usable credential here; switched to "${candidate}" (signed in via ~/.pi/agent/auth.json).`,
    );
  } catch {}
}
reconcileActiveProviderWithAuth();

// apiKeyEncrypted isn't readable here -- no Electron safeStorage in the
// brain process. Orbit decrypts and passes via env when it spawns us;
// standalone CLI usage only works with plaintext keys. OAuth providers
// skip env injection entirely: a stale apiKey on the entry shouldn't leak
// under a misrouted env variable when the brain will authenticate via
// ~/.pi/agent/auth.json anyway.
const activeLlmProvider = loomConfig.llm?.active;
const activeLlmConfig = activeLlmProvider ? loomConfig.llm?.providers?.[activeLlmProvider] : null;
if (
  activeLlmConfig?.apiKey &&
  !OAUTH_PROVIDERS.has(activeLlmProvider) &&
  !isCustomProvider(activeLlmConfig)
) {
  const envVar = PROVIDER_ENV_MAP[activeLlmProvider] || "AI_GATEWAY_API_KEY";
  if (!process.env[envVar]) {
    process.env[envVar] = activeLlmConfig.apiKey;
  }
}

// Custom OpenAI-compatible provider: register it in ~/.pi/agent/models.json so
// pi can resolve --provider/--model. The key is NOT written here; it's supplied
// at runtime via --api-key below.
if (!isInformationalCommand && activeLlmProvider && isCustomProvider(activeLlmConfig)) {
  try {
    syncCustomProviderModelsFile(join(agentDir, "models.json"), activeLlmProvider, activeLlmConfig);
  } catch (err) {
    console.error(`loom: failed to sync custom provider into models.json: ${err}`);
  }
}

// Prefer auth.json (OAuth) over a stray provider env key. When the active
// provider authenticates via OAuth and is signed in, scrub the conflicting
// *_API_KEY from the env so Pi uses the OAuth token -- otherwise a leftover
// (possibly dummy) key like OPENAI_API_KEY shadows it and routes the request
// to the keyed provider with the wrong credential. Mirrors the Galaxy-cred
// scrubbing below.
const OAUTH_CONFLICT_ENV = {
  "openai-codex": ["OPENAI_API_KEY"],
};
if (activeLlmProvider && OAUTH_PROVIDERS.has(activeLlmProvider)) {
  const auth = readAuthJson();
  if (auth[activeLlmProvider]) {
    for (const v of OAUTH_CONFLICT_ENV[activeLlmProvider] || []) {
      if (process.env[v]) delete process.env[v];
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Galaxy credential + MCP registration
//
// Credentials come from ~/.loom/config.json (written by /connect) or env
// vars (CI/testing). Galaxy MCP registers whenever credentials are present;
// the agent decides per-plan whether to use Galaxy. The `executionMode`
// field affects prompt guidance, not MCP registration.
// ─────────────────────────────────────────────────────────────────────────────

let galaxyUrl = null;
let galaxyApiKey = null;

if (loomConfig.galaxy?.active && loomConfig.galaxy.profiles) {
  const active = loomConfig.galaxy.profiles[loomConfig.galaxy.active];
  if (active) {
    galaxyUrl = active.url;
    galaxyApiKey = active.apiKey;
  }
}
if (!galaxyUrl) galaxyUrl = process.env.GALAXY_URL || null;
if (!galaxyApiKey) galaxyApiKey = process.env.GALAXY_API_KEY || null;

// Publish to env so the extension can read them. If credentials are absent,
// scrub stale env so the extension doesn't see ghosts from a prior session.
if (galaxyUrl && galaxyApiKey) {
  process.env.GALAXY_URL = galaxyUrl;
  process.env.GALAXY_API_KEY = galaxyApiKey;
} else {
  delete process.env.GALAXY_URL;
  delete process.env.GALAXY_API_KEY;
}

const mcpConfigPath = join(agentDir, "mcp.json");

let mcpConfig = {};
if (!isInformationalCommand) {
  if (existsSync(mcpConfigPath)) {
    mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
  }

  mcpConfig.mcpServers = mcpConfig.mcpServers || {};

  const hasGalaxyCredentials = galaxyUrl && galaxyApiKey;

  if (hasGalaxyCredentials) {
    mcpConfig.mcpServers.galaxy = {
      command: "uvx",
      args: [GALAXY_MCP_SPEC],
      directTools: true,
      // Local-path upload over MCP times out on large files (-32001); the
      // loom-native galaxy_upload_local_file tool handles those instead. URL
      // upload (upload_file_from_url) and the rest stay exposed.
      excludeTools: ["upload_file"],
      env: {
        GALAXY_URL: galaxyUrl,
        GALAXY_API_KEY: galaxyApiKey,
      },
    };
  } else {
    // No credentials: tear down Galaxy MCP if present from a previous session.
    delete mcpConfig.mcpServers.galaxy;
  }

  // BRC Analytics is a public, anonymous HTTP MCP -- no creds required, so we
  // register it unconditionally. It exposes BRC genome/assembly/lineage
  // lookups that the agent can call alongside Galaxy MCP.
  mcpConfig.mcpServers["brc-analytics"] = {
    url: "https://dev.brc-analytics.org/api/v1/mcp/",
    directTools: true,
  };

  mkdirSync(dirname(mcpConfigPath), { recursive: true });
  // mcp.json carries Galaxy credentials in its env block — keep file mode
  // 0600 so other users on a shared machine can't read the API key. The
  // mode option on writeFileSync sets perms only when the file is *created*;
  // a follow-up chmod ensures we tighten existing files too.
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
  try {
    chmodSync(mcpConfigPath, 0o600);
  } catch {
    /* best-effort */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// pi-web-access default: skip the curator browser popup.
//
// pi-web-access ships with the brain and exposes a web_search tool. Its
// default workflow ("summary-review") opens a curator window in the system
// browser on every search so the user can prune results before the LLM sees
// them. In Orbit the chat is the UI, so popping a separate browser tab on
// every search is jarring -- and on a fresh install with no Exa/Gemini key,
// the search still routes through Exa MCP (https://mcp.exa.ai/mcp, no auth)
// so the popup is the only thing standing between the user and a working
// zero-config web search. Default workflow:"none" returns raw results inline
// for the LLM to summarize. Users who want the curator back can flip it on
// with `/curator on` or by setting "workflow":"summary-review" in this file.
// ─────────────────────────────────────────────────────────────────────────────

const webSearchConfigPath = join(homedir(), ".pi", "web-search.json");

if (!isInformationalCommand) {
  let webSearchConfig = {};
  let parseOk = true;
  if (existsSync(webSearchConfigPath)) {
    try {
      webSearchConfig = JSON.parse(readFileSync(webSearchConfigPath, "utf-8"));
    } catch {
      // Don't clobber a file we can't parse -- pi-web-access surfaces a
      // more useful error on its own when it tries to load this.
      parseOk = false;
    }
  }
  if (parseOk && webSearchConfig.workflow === undefined) {
    webSearchConfig.workflow = "none";
    mkdirSync(dirname(webSearchConfigPath), { recursive: true });
    writeFileSync(webSearchConfigPath, JSON.stringify(webSearchConfig, null, 2));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-flight: ensure at least one LLM provider is configured
// ─────────────────────────────────────────────────────────────────────────────

function checkLLMProvider() {
  const skipFlags = ["--version", "--help", "-h", "--api-key", "--list-models"];
  if (userArgs.some((a) => skipFlags.some((f) => a.startsWith(f)))) return;
  if (hasArg("--provider")) return;

  // OAuth providers authenticate via ~/.pi/agent/auth.json, not config keys.
  // Short-circuit on a present credential for the active provider; stale
  // plaintext / encrypted fields on the entry are ignored entirely so they
  // can't mask a missing OAuth login or falsely trigger the encrypted-key
  // exit below.
  if (activeLlmProvider && OAUTH_PROVIDERS.has(activeLlmProvider)) {
    const authPath = join(agentDir, "auth.json");
    if (existsSync(authPath)) {
      try {
        const auth = JSON.parse(readFileSync(authPath, "utf-8"));
        if (auth && auth[activeLlmProvider]) return;
      } catch {}
    }
    console.error(`loom: provider "${activeLlmProvider}" requires an OAuth sign-in.
Launch via Orbit (\`cd app && npm start\`) and sign in from Preferences,
or unset the active provider in ~/.loom/config.json.
`);
    process.exit(1);
  }

  // Custom OpenAI-compatible provider: usable when a key is resolvable from the
  // injected env var (Orbit) or a plaintext config key (standalone CLI).
  if (isCustomProvider(activeLlmConfig) && resolveActiveLlmApiKey(activeLlmConfig, process.env)) {
    return;
  }

  // Consolidated config has an API key (non-OAuth providers only)
  if (activeLlmConfig?.apiKey) return;

  const providerEnvVars = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
    "MISTRAL_API_KEY",
    "XAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENROUTER_API_KEY",
    "CEREBRAS_API_KEY",
    "AI_GATEWAY_API_KEY",
    "HF_TOKEN",
    "AWS_PROFILE",
    "AWS_ACCESS_KEY_ID",
    "GOOGLE_CLOUD_PROJECT",
    "AZURE_OPENAI_API_KEY",
    "COPILOT_GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ];
  if (providerEnvVars.some((v) => process.env[v])) return;

  // Config has an encrypted key but this CLI can't decrypt it — Electron's
  // safeStorage lives in the Orbit main process. Point the user at the two
  // working paths instead of falling through to the generic error.
  if (activeLlmConfig?.apiKeyEncrypted) {
    const envVar = PROVIDER_ENV_MAP[activeLlmProvider] || "AI_GATEWAY_API_KEY";
    console.error(`loom: your ~/.loom/config.json has an encrypted API key
(apiKeyEncrypted) for provider "${activeLlmProvider}", but the standalone
CLI cannot decrypt it -- that only works inside Orbit.

Do one of the following:

  * Launch via Orbit (\`cd app && npm start\`), which decrypts and injects
    ${envVar} into the brain.

  * Export the key for this shell:
      export ${envVar}=...
`);
    process.exit(1);
  }

  const authPath = join(agentDir, "auth.json");
  if (existsSync(authPath)) {
    try {
      const auth = JSON.parse(readFileSync(authPath, "utf-8"));
      if (Object.keys(auth).length > 0) return;
    } catch {}
  }

  const modelsPath = join(agentDir, "models.json");
  if (existsSync(modelsPath)) {
    try {
      const models = JSON.parse(readFileSync(modelsPath, "utf-8"));
      const providers = models.providers || {};
      if (Object.values(providers).some((p) => p.apiKey)) return;
    } catch {}
  }

  console.error(`loom requires an LLM provider to function.

Set up one of the following:

  1. Config file (recommended):
     Create ~/.loom/config.json:
     {
       "llm": {
         "active": "anthropic",
         "providers": {
           "anthropic": { "apiKey": "sk-ant-..." }
         }
       }
     }

  2. Environment variable:
     export ANTHROPIC_API_KEY=sk-ant-...
     export OPENAI_API_KEY=sk-...

  3. Custom provider (~/.pi/agent/models.json):
     For local/self-hosted models via litellm, ollama, etc.
     See: https://github.com/galaxyproject/loom#local-llms

  4. OAuth login:
     Run with --provider anthropic (or openai, google, etc.)
     and follow the login prompts.
`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Inject --provider / --model from consolidated config or legacy models.json
// ─────────────────────────────────────────────────────────────────────────────

const providerArgs = [];
if (!hasArg("--provider")) {
  // Prefer consolidated config (multi-provider shape)
  if (activeLlmProvider) {
    providerArgs.push("--provider", activeLlmProvider);
    if (
      activeLlmConfig?.model &&
      !userArgs.includes("--model") &&
      !userArgs.some((a) => a.startsWith("--model="))
    ) {
      providerArgs.push("--model", activeLlmConfig.model);
    }
    // Custom endpoints have no built-in key resolution; hand pi the key at
    // runtime so it stays in memory (setRuntimeApiKey) rather than on disk.
    if (isCustomProvider(activeLlmConfig) && !hasArg("--api-key")) {
      const key = resolveActiveLlmApiKey(activeLlmConfig, process.env);
      if (key) providerArgs.push("--api-key", key);
    }
  } else {
    // Fall back to legacy models.json
    const modelsPath = join(agentDir, "models.json");
    if (existsSync(modelsPath)) {
      try {
        const models = JSON.parse(readFileSync(modelsPath, "utf-8"));
        const providers = models.providers || {};
        const [providerName, providerConfig] = Object.entries(providers)[0] || [];
        if (providerName && providerConfig?.models?.length) {
          providerArgs.push("--provider", providerName);
          if (!userArgs.includes("--model") && !userArgs.some((a) => a.startsWith("--model="))) {
            providerArgs.push("--model", providerConfig.models[0].id);
          }
        }
      } catch {}
    }
  }
}

// Build args: inject extensions, pass through everything else
const args = [
  "-e",
  mcpAdapterPath,
  "-e",
  webAccessPath,
  "-e",
  extensionPath,
  "-e",
  orbitHandoffPath,
  "-e",
  cliUpdatePath,
  "-e",
  whatsNewPath,
  ...providerArgs,
  ...userArgs,
];
if (await handleInformationalCommand()) {
  process.exit(0);
}

if (userArgs[0] === "update") {
  if (process.env.LOOM_SHELL_KIND === "orbit") {
    console.error("Orbit manages its own updates -- update from the Orbit app, not the CLI.");
    process.exit(0);
  }
  const channel = pickChannel(getLoomVersion());
  const { kind, cmd } = detectInstall(channel);
  if (!cmd) {
    console.error(
      `Loom looks like a source checkout, not an npm install -- can't self-update.\n` +
        `To upgrade an installed copy: npm install -g @galaxyproject/loom@${channel}`,
    );
    process.exit(0);
  }
  console.error(`Updating Loom (${kind}) -- ${cmd}`);
  const [bin, ...rest] = cmd.split(" ");
  const child = spawn(bin, rest, { stdio: "inherit" });
  child.on("error", (err) => {
    console.error(`Failed to run "${cmd}": ${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  checkLLMProvider();

  // Galaxy is configured but the uvx runner that launches galaxy-mcp is missing.
  // Warn (don't block): Loom is still useful without Galaxy, and pi-mcp-adapter
  // would otherwise fail to spawn that server with a buried error. Orbit bundles
  // uv onto PATH before spawn, so this only fires for standalone CLI installs.
  if (galaxyUrl && galaxyApiKey && !isUvxAvailable()) {
    console.error(`\n${uvxMissingNotice()}\n`);
  }

  // Resolve pi-coding-agent's own version by walking up from its entry point to
  // the package root. Used to pin the changelog watermark below.
  function resolvePiVersion() {
    let dir = dirname(piEntryPointPath);
    for (let i = 0; i < 6; i++) {
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
          if (pkg.name === "@earendil-works/pi-coding-agent") return pkg.version;
        } catch {}
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  // Reconcile the Pi settings loom manages. Two concerns share one read/write:
  //  - Startup quiet (banner, resource listing, "What's New" changelog): loom is
  //    the product identity, so users shouldn't see Pi internals unless they
  //    pass --verbose. The changelog is gated on lastChangelogVersion; pinning
  //    it to Pi's current version means getNewEntries() finds nothing newer.
  //  - Thinking visibility (interactive terminal only): Pi streams the model's
  //    reasoning into the TUI, which is noisy, so loom hides it by default.
  //    `hideThinkingBlock` is a persisted global Pi setting that only the
  //    interactive renderer reads, so only reconcile it for an interactive
  //    terminal launch -- never for the non-interactive modes (rpc for Orbit
  //    and the web server, json for evals, headless --print), which would
  //    churn the global file for a setting they never read. Override
  //    persistently with `ui.showThinking: true` in ~/.loom/config.json, or
  //    just toggle it live in-session with Ctrl+T.
  {
    const piSettingsPath = join(agentDir, "settings.json");
    try {
      let piSettings = {};
      if (existsSync(piSettingsPath)) {
        piSettings = JSON.parse(readFileSync(piSettingsPath, "utf-8"));
      }
      let changed = false;

      if (!hasArg("--verbose")) {
        if (!piSettings.quietStartup) {
          piSettings.quietStartup = true;
          changed = true;
        }
        const piVersion = resolvePiVersion();
        if (piVersion && piSettings.lastChangelogVersion !== piVersion) {
          piSettings.lastChangelogVersion = piVersion;
          changed = true;
        }
      }

      if (isInteractiveTerminal(userArgs)) {
        const hideThinking = resolveHideThinking({
          configShowThinking: loomConfig.ui?.showThinking,
        });
        if (piSettings.hideThinkingBlock !== hideThinking) {
          piSettings.hideThinkingBlock = hideThinking;
          changed = true;
        }
      }

      if (changed) {
        mkdirSync(dirname(piSettingsPath), { recursive: true });
        writeFileSync(piSettingsPath, JSON.stringify(piSettings, null, 2));
      }
    } catch {}
  }

  // Refresh the update-check cache in a fully detached child so the network call
  // never delays startup, holds the TUI, or is killed mid-write. The notice the
  // user sees this run comes from the cache; this updates it for next run.
  if (process.env.LOOM_SHELL_KIND !== "orbit" && process.env.LOOM_NO_UPDATE_CHECK !== "1") {
    try {
      const refresh = spawn(process.execPath, [updateCheckScript, "--refresh"], {
        detached: true,
        stdio: "ignore",
      });
      refresh.unref();
    } catch {}
  }

  main(args);
}
