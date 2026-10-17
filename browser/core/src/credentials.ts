/** Provider/model/key selection, held on the client and never sent to Galaxy. */

import { DEFAULT_BRAND, type Brand } from "./agent/brand";
import { needsKey, PROVIDERS, providerById, takesModel, type Provider } from "./agent/providers";

export interface Credentials {
  provider: string;
  model?: string;
  apiKey?: string;
  /** Overrides the provider's own endpoint; the only way to reach a self-hosted server. */
  baseUrl?: string;
}

// sessionStorage, so the key survives a reload but dies with the tab. It is
// never written to the plugin specs, which Galaxy persists server-side.
const storeKey = (brand: Brand) => `${brand.id}.credentials`;

export function loadCredentials(brand: Brand = DEFAULT_BRAND): Credentials | null {
  try {
    const raw = sessionStorage.getItem(storeKey(brand));
    return raw ? (JSON.parse(raw) as Credentials) : null;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: Credentials, brand: Brand = DEFAULT_BRAND): void {
  try {
    sessionStorage.setItem(storeKey(brand), JSON.stringify(creds));
  } catch {
    // A blocked store is not fatal: the key still works for this page.
  }
}

export function clearCredentials(brand: Brand = DEFAULT_BRAND): void {
  try {
    sessionStorage.removeItem(storeKey(brand));
  } catch {
    /* nothing to clear */
  }
}

/**
 * Is this selection usable? A provider whose endpoint takes no user key (the
 * Galaxy proxy, a local server) is usable without one; every other provider
 * needs a non-empty key. Returning a reason rather than a bool lets the caller
 * keep the overlay up and say what is missing, instead of starting an agent that
 * fails on its first request.
 */
export function credentialProblem(
  creds: Credentials | null,
  offered: readonly Provider[] = PROVIDERS,
): string | null {
  if (!creds) return "Choose a provider to continue.";
  const p = providerById(creds.provider);
  if (!p) return `Unknown provider "${creds.provider}".`;
  // A selection stored under a page that offered the Galaxy proxy is no use on one without it.
  if (!offered.includes(p)) return `${p.name} is not available on this page.`;
  if (needsKey(p) && !creds.apiKey?.trim()) return `${p.name} requires an API key.`;
  // A server that takes no key ignores the model name too, so only hosted providers need one.
  if (takesModel(p) && needsKey(p) && !creds.model?.trim()) {
    return `Name a model for ${p.name}.`;
  }
  if (creds.baseUrl?.trim() && !/^https?:\/\//i.test(creds.baseUrl.trim())) {
    return "The endpoint must start with http:// or https://.";
  }
  return null;
}
