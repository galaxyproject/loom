import fs from "node:fs";
import path from "node:path";
import { readEnv } from "./orbit-env.js";

/**
 * A provider entry is "custom" (a user-supplied endpoint) when it carries a
 * non-empty baseUrl. That single field is the discriminator everywhere.
 */
export function isCustomProvider(entry) {
  return Boolean(entry && entry.baseUrl);
}

/**
 * Wire formats a custom endpoint can speak. Both are pi APIs that need nothing
 * beyond a base URL and an API key, which is the whole contract a custom
 * provider entry can express -- pi knows others (bedrock, vertex, azure) but
 * those need credentials and deployment identifiers this shape has nowhere to
 * put, so offering them would promise something that cannot work.
 *
 * The two disagree about what a base URL includes, because their SDKs do:
 * the OpenAI client appends `/chat/completions` to whatever it is given, so the
 * version segment belongs in the URL (`https://host/v1`), while the Anthropic
 * client appends `/v1/messages`, so it must not (`https://host`). Getting this
 * backwards is a 404 against a URL that looks right.
 */
export const ENDPOINT_APIS = ["openai-completions", "anthropic-messages"];

/** What an entry with no explicit `api` means -- the only shape Loom used to speak. */
export const DEFAULT_ENDPOINT_API = "openai-completions";

/**
 * Resolve an entry's wire format, rejecting anything we can't actually drive.
 *
 * Throwing beats defaulting here. pi's ModelRegistry drops a provider whose
 * `api` names no registered handler, so a typo would surface as
 * "--provider/--model failed to resolve" with nothing pointing at the cause;
 * and silently falling back to openai-completions would send OpenAI JSON at an
 * Anthropic endpoint, which fails later and less legibly than failing here.
 */
export function normalizeEndpointApi(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_ENDPOINT_API;
  const api = String(value).trim().toLowerCase();
  if (!ENDPOINT_APIS.includes(api)) {
    throw new Error(
      `unsupported endpoint api "${value}" -- expected one of: ${ENDPOINT_APIS.join(", ")}`,
    );
  }
  return api;
}

/**
 * Build a permissive model def from just a model id. Cost is zeroed (custom
 * endpoints are typically free, self-hosted, or billed somewhere Loom cannot
 * see) and the model is registered for selection; the key is supplied
 * separately at runtime.
 *
 * The context window is a guess either way -- the endpoint is not asked and
 * generally will not say. 128K mirrors the defaults used for the existing local
 * litellm setup; an Anthropic-shaped endpoint gets 200K because every Claude
 * model in service carries at least that, and under-declaring makes pi compact
 * a conversation that had room left. Both clear the 50K picker floor and the
 * 16K assertion floor, so neither hides the model (#418) or trips the
 * "window too small" message (#419).
 */
export function synthesizeModelDef(entry) {
  if (!entry.model) {
    throw new Error("custom provider entry requires a model id to synthesize a model def");
  }
  const api = normalizeEndpointApi(entry.api);
  return {
    id: entry.model,
    name: entry.model,
    reasoning: false,
    input: ["text"],
    contextWindow: api === "anthropic-messages" ? 200000 : 128000,
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
    api: normalizeEndpointApi(entry.api),
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
 * decrypted key via LOOM_ACTIVE_LLM_API_KEY (or ORBIT_ACTIVE_LLM_API_KEY); the standalone CLI uses the
 * plaintext apiKey on the entry. Returns undefined when neither is present.
 */
export function resolveActiveLlmApiKey(entry, env) {
  return (env && readEnv("ACTIVE_LLM_API_KEY", env)) || (entry && entry.apiKey);
}
