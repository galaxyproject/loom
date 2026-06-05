import fs from "node:fs";
import path from "node:path";

/**
 * A provider entry is "custom" (an OpenAI-compatible endpoint) when it carries
 * a non-empty baseUrl. That single field is the discriminator everywhere.
 */
export function isCustomProvider(entry) {
  return Boolean(entry && entry.baseUrl);
}

/**
 * Build a permissive openai-completions model def from just a model id. Cost is
 * zeroed (custom endpoints are typically free/self-hosted) and the context
 * window mirrors the defaults used for the existing local litellm setup. The
 * model is registered for selection; the key is supplied separately at runtime.
 */
export function synthesizeModelDef(entry) {
  if (!entry.model) {
    throw new Error("custom provider entry requires a model id to synthesize a model def");
  }
  return {
    id: entry.model,
    name: entry.model,
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

/**
 * Name of the env var Orbit injects with the decrypted active-LLM key. We write
 * this *name* (not the secret) into the synthesized models.json apiKey field.
 */
export const ACTIVE_LLM_API_KEY_ENV = "LOOM_ACTIVE_LLM_API_KEY";

/**
 * Return a NEW models.json config with the custom provider upserted. Other
 * providers are preserved untouched.
 *
 * The apiKey field is set to the *name* of the env var Orbit injects, never the
 * secret itself. pi's ModelRegistry rejects any custom (non-built-in) provider
 * that defines models without an apiKey and drops the whole provider, so
 * omitting it makes `--provider/--model` fail to resolve and the brain won't
 * launch. pi resolves a bare apiKey string as an env-var lookup at request
 * time, so the real key is read from LOOM_ACTIVE_LLM_API_KEY in memory and
 * still never lands on disk. (The runtime --api-key flag, when passed, takes
 * precedence over this.)
 */
export function mergeCustomProviderIntoModelsConfig(modelsConfig, providerName, entry) {
  const providers = { ...((modelsConfig && modelsConfig.providers) || {}) };
  providers[providerName] = {
    name: providerName,
    baseUrl: entry.baseUrl,
    api: "openai-completions",
    apiKey: ACTIVE_LLM_API_KEY_ENV,
    models: [synthesizeModelDef(entry)],
  };
  return { ...modelsConfig, providers };
}

/**
 * Read models.json (if present), upsert the custom provider, write it back with
 * mode 0600. Best-effort: a malformed existing file is treated as empty rather
 * than throwing, matching how bin/loom.js already tolerates models.json.
 */
export function syncCustomProviderModelsFile(modelsJsonPath, providerName, entry) {
  let current = {};
  try {
    if (fs.existsSync(modelsJsonPath)) {
      current = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8")) || {};
    }
  } catch {
    current = {};
  }
  const merged = mergeCustomProviderIntoModelsConfig(current, providerName, entry);
  fs.mkdirSync(path.dirname(modelsJsonPath), { recursive: true });
  // Plain write + chmod (not tmp+rename) mirrors how bin/loom.js writes
  // mcp.json: this file is regenerated on every launch, so a torn write is
  // self-healing. chmod runs after the write because writeFileSync's mode
  // option only applies when the file is first created.
  fs.writeFileSync(modelsJsonPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(modelsJsonPath, 0o600);
  } catch {
    /* best-effort */
  }
  return merged;
}

/**
 * Resolve the API key for a custom provider at runtime. Orbit injects the
 * decrypted key via LOOM_ACTIVE_LLM_API_KEY; the standalone CLI uses the
 * plaintext apiKey on the entry. Returns undefined when neither is present.
 */
export function resolveActiveLlmApiKey(entry, env) {
  return (env && env[ACTIVE_LLM_API_KEY_ENV]) || (entry && entry.apiKey);
}
