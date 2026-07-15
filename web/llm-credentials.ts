import { PROVIDER_KEY_VARS } from "../shared/brain-env.js";
import { ACTIVE_LLM_API_KEY_ENV } from "../shared/custom-provider.js";

/** The env-var name a built-in provider's API key lives in, or null if unknown. */
export function providerKeyVar(provider: string): string | null {
  return PROVIDER_KEY_VARS[provider.toLowerCase()] ?? null;
}

export interface ProviderShape {
  /**
   * The provider is an OpenAI-compatible custom endpoint -- i.e. the container's
   * config.json gives it a baseUrl. That, not the provider's name, is the
   * discriminator everywhere (isCustomProvider in shared/custom-provider.js).
   */
  isCustom?: boolean;
}

/**
 * The env var to hand this provider's key to the brain under, or null when we
 * can't route it anywhere the brain will read.
 *
 * Mirrors how Orbit desktop picks the target var (app/src/main/agent.ts): custom
 * endpoints authenticate from LOOM_ACTIVE_LLM_API_KEY, built-in providers from
 * their own var. Null is a real answer callers must handle -- injecting a key
 * under a name nothing reads spawns an unauthenticated brain that dies at its
 * first request, which is worse than refusing the key up front.
 */
export function llmKeyEnvVar(provider: string, { isCustom }: ProviderShape = {}): string | null {
  if (isCustom) return ACTIVE_LLM_API_KEY_ENV;
  return providerKeyVar(provider);
}

export interface KeyPresenceInput extends ProviderShape {
  env: NodeJS.ProcessEnv;
  provider: string;
  providedKey?: string | null;
}

function nonEmpty(v: string | undefined): boolean {
  return typeof v === "string" && v.length > 0;
}

/** Is a usable provider key available -- either supplied at runtime or in env? */
export function hasProviderKey({
  env,
  provider,
  providedKey,
  isCustom,
}: KeyPresenceInput): boolean {
  if (nonEmpty(providedKey ?? undefined)) return true;
  // Only a custom provider reads LOOM_ACTIVE_LLM_API_KEY. Counting it for a
  // built-in provider would suppress the BYO prompt on the strength of a key the
  // brain never looks at -- a stale one left in the job env, say -- and strand the
  // user in front of an agent that can't authenticate.
  const v = llmKeyEnvVar(provider, { isCustom });
  return v != null && nonEmpty(env[v]);
}
