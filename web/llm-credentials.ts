import { PROVIDER_API_KEY_NAMES } from "../shared/brain-env.js";
import { ACTIVE_LLM_API_KEY_ENV } from "../shared/custom-provider.js";

/** The env-var name a provider's API key lives in, or null if unknown. */
export function providerKeyVar(provider: string): string | null {
  const v = `${provider.toUpperCase()}_API_KEY`;
  return (PROVIDER_API_KEY_NAMES as Set<string>).has(v) ? v : null;
}

/**
 * The env var to hand a key to the brain under. Built-in providers use their own
 * ${PROVIDER}_API_KEY; anything else is an OpenAI-compatible custom endpoint,
 * which the brain authenticates from LOOM_ACTIVE_LLM_API_KEY (see
 * resolveActiveLlmApiKey in shared/custom-provider.js). Mirrors how Orbit
 * desktop picks the target var in app/src/main/agent.ts.
 *
 * Unlike providerKeyVar this never returns null: a key with nowhere to go meant
 * the server silently spawned an unauthenticated brain.
 */
export function llmKeyEnvVar(provider: string): string {
  return providerKeyVar(provider) ?? ACTIVE_LLM_API_KEY_ENV;
}

export interface KeyPresenceInput {
  env: NodeJS.ProcessEnv;
  provider: string;
  providedKey?: string | null;
}

function nonEmpty(v: string | undefined): boolean {
  return typeof v === "string" && v.length > 0;
}

/** Is a usable provider key available -- either supplied at runtime or in env? */
export function hasProviderKey({ env, provider, providedKey }: KeyPresenceInput): boolean {
  if (nonEmpty(providedKey ?? undefined)) return true;
  const v = providerKeyVar(provider);
  if (v != null && nonEmpty(env[v])) return true;
  // A custom endpoint's key. Checked regardless of the provider label: the
  // server defaults activeProvider() to "anthropic" when LOOM_LLM_PROVIDER is
  // unset, while the custom provider is named only in the container's
  // config.json -- which the server never reads in remote mode. Gating this on
  // the label would put a correctly-configured GxIT back behind the BYO overlay.
  return nonEmpty(env[ACTIVE_LLM_API_KEY_ENV]);
}
