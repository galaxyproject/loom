#!/usr/bin/env node

import { main } from "@mariozechner/pi-coding-agent";
import { resolve, dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { homedir } from "os";
import { loadConfig as loadLoomConfig } from "../shared/loom-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Loom is a standalone product — suppress Pi's branding and update checks.
// quietStartup hides the keybinding banner + resource listing on launch.
process.env.PI_SKIP_VERSION_CHECK = "1";

// Resolve extension paths relative to this script
const extensionPath = resolve(__dirname, "../extensions/loom");

// pi-mcp-adapter is what teaches Pi how to use MCP servers from mcp.json
// pi-web-access provides web_search, fetch_content, and code_search tools
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const mcpAdapterPath = dirname(require.resolve("pi-mcp-adapter/index.ts"));
const webAccessPath = dirname(require.resolve("pi-web-access/index.ts"));
const piEntryPointPath = fileURLToPath(import.meta.resolve("@mariozechner/pi-coding-agent"));
const piPackageDir = dirname(dirname(piEntryPointPath));
const piArgsModulePath = join(piPackageDir, "dist/cli/args.js");
const piListModelsModulePath = join(piPackageDir, "dist/cli/list-models.js");
const piConfigModulePath = join(piPackageDir, "dist/config.js");
const piAuthStorageModulePath = join(piPackageDir, "dist/core/auth-storage.js");
const piModelRegistryModulePath = join(piPackageDir, "dist/core/model-registry.js");
const userArgs = process.argv.slice(2);

function hasArg(flag) {
  return userArgs.includes(flag) || userArgs.some((arg) => arg.startsWith(`${flag}=`));
}

const isInformationalCommand = ["--help", "-h", "--version", "--list-models"].some(hasArg);

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
    console.log(VERSION);
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
};

// LLM config: set env var if not already present
if (loomConfig.llm?.apiKey) {
  const provider = loomConfig.llm.provider || "anthropic";
  const envVar = PROVIDER_ENV_MAP[provider] || "AI_GATEWAY_API_KEY";
  if (!process.env[envVar]) {
    process.env[envVar] = loomConfig.llm.apiKey;
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
      args: ["galaxy-mcp>=1.4.0"],
      directTools: true,
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
// Pre-flight: ensure at least one LLM provider is configured
// ─────────────────────────────────────────────────────────────────────────────

function checkLLMProvider() {
  const skipFlags = ["--version", "--help", "-h", "--api-key", "--list-models"];
  if (userArgs.some((a) => skipFlags.some((f) => a.startsWith(f)))) return;
  if (hasArg("--provider")) return;

  // Consolidated config has an API key
  if (loomConfig.llm?.apiKey) return;

  const providerEnvVars = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
    "MISTRAL_API_KEY",
    "XAI_API_KEY",
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
  if (loomConfig.llm?.apiKeyEncrypted) {
    console.error(`loom: your ~/.loom/config.json has an encrypted API key
(apiKeyEncrypted), but the standalone CLI cannot decrypt it — that only
works inside Orbit.

Do one of the following:

  • Launch via Orbit (\`cd app && npm start\`), which decrypts and injects
    ANTHROPIC_API_KEY (or the provider-specific variable) into the brain.

  • Export the key for this shell:
      export ANTHROPIC_API_KEY=sk-ant-...
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
         "provider": "anthropic",
         "apiKey": "sk-ant-..."
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
  // Prefer consolidated config
  if (loomConfig.llm?.provider) {
    providerArgs.push("--provider", loomConfig.llm.provider);
    if (
      loomConfig.llm.model &&
      !userArgs.includes("--model") &&
      !userArgs.some((a) => a.startsWith("--model="))
    ) {
      providerArgs.push("--model", loomConfig.llm.model);
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
  ...providerArgs,
  ...userArgs,
];

if (await handleInformationalCommand()) {
  process.exit(0);
}

checkLLMProvider();

// Suppress Pi's keybinding banner and resource listing. Loom is the product
// identity -- users shouldn't see Pi internals unless they pass --verbose.
if (!hasArg("--verbose")) {
  const piSettingsPath = join(agentDir, "settings.json");
  try {
    let piSettings = {};
    if (existsSync(piSettingsPath)) {
      piSettings = JSON.parse(readFileSync(piSettingsPath, "utf-8"));
    }
    if (!piSettings.quietStartup) {
      piSettings.quietStartup = true;
      mkdirSync(dirname(piSettingsPath), { recursive: true });
      writeFileSync(piSettingsPath, JSON.stringify(piSettings, null, 2));
    }
  } catch {}
}

main(args);
