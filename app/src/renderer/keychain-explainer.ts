/**
 * localStorage flag marking that the macOS Keychain explainer has been shown
 * once on this install. Renderer-local; survives launches.
 */
export const KEYCHAIN_EXPLAINER_SHOWN_KEY = "orbit.keychainExplainerShown";

type SecretBearingConfig = {
  llm?: { providers?: Record<string, { apiKey?: unknown }> };
  galaxy?: { profiles?: Record<string, { apiKey?: unknown }> };
};

/**
 * True when the outgoing config payload carries at least one freshly typed
 * secret -- i.e. a real string that is neither empty nor the unchanged-secret
 * sentinel. OAuth providers omit apiKey entirely, so they never count.
 */
export function payloadHasNewSecret(
  config: SecretBearingConfig,
  unchangedSentinel: string,
): boolean {
  const isReal = (k: unknown): k is string =>
    typeof k === "string" && k.length > 0 && k !== unchangedSentinel;
  for (const p of Object.values(config.llm?.providers ?? {})) {
    if (isReal(p?.apiKey)) return true;
  }
  for (const p of Object.values(config.galaxy?.profiles ?? {})) {
    if (isReal(p?.apiKey)) return true;
  }
  return false;
}

export interface KeychainExplainerGate {
  platform: string;
  encryptionAvailable: boolean;
  alreadyShown: boolean;
  hasNewSecret: boolean;
}

/**
 * Sole authority for whether to show the pre-prompt explainer. macOS only pops
 * the Keychain dialog when safeStorage actually encrypts, and only the first
 * time, so we gate on darwin + availability + a new secret + not-shown-before.
 */
export function shouldShowKeychainExplainer(g: KeychainExplainerGate): boolean {
  return g.platform === "darwin" && g.encryptionAvailable && !g.alreadyShown && g.hasNewSecret;
}
