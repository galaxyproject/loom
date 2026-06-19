import { PROVIDER_API_KEY_NAMES } from "../shared/brain-env.js";

/** The env-var name a provider's API key lives in, or null if unknown. */
export function providerKeyVar(provider: string): string | null {
  const v = `${provider.toUpperCase()}_API_KEY`;
  return (PROVIDER_API_KEY_NAMES as Set<string>).has(v) ? v : null;
}

export interface KeyPresenceInput {
  env: NodeJS.ProcessEnv;
  provider: string;
  providedKey?: string | null;
}

/** Is a usable provider key available -- either supplied at runtime or in env? */
export function hasProviderKey({ env, provider, providedKey }: KeyPresenceInput): boolean {
  if (typeof providedKey === "string" && providedKey.length > 0) return true;
  const v = providerKeyVar(provider);
  return v != null && typeof env[v] === "string" && (env[v] as string).length > 0;
}
