import { safeStorage } from "electron";
import type { LoomConfig } from "../../../shared/loom-config.js";
import { loadConfig, saveConfig } from "../../../shared/loom-config.js";

function log(...args: unknown[]): void {
  console.log("[secure-config]", ...args);
}

export function isAvailable(): boolean {
  // Test/automation escape: macOS Keychain pops a "keychain cannot be found"
  // dialog when probed under a redirected HOME, which blocks headless e2e
  // runs indefinitely. Setting LOOM_DISABLE_SAFE_STORAGE=1 in the launched
  // env makes us skip the probe entirely; encrypted secrets just stay
  // unread for the duration of the test.
  if (process.env.LOOM_DISABLE_SAFE_STORAGE === "1") return false;
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function encryptSecret(plaintext: string): string {
  return safeStorage.encryptString(plaintext).toString("base64");
}

export function decryptSecret(b64: string): string {
  return safeStorage.decryptString(Buffer.from(b64, "base64"));
}

function tryDecrypt(b64: string | undefined): string | null {
  if (!b64) return null;
  try {
    return decryptSecret(b64);
  } catch (err) {
    log("decrypt failed:", err);
    return null;
  }
}

/**
 * Resolve the LLM API key for the brain. Returns the plaintext value if it can
 * be obtained, preferring the encrypted field. `null` means no key is
 * available via config (env vars may still supply one).
 */
export function resolveLlmApiKey(config: LoomConfig): string | null {
  const llm = config.llm;
  if (!llm) return null;
  if (llm.apiKey) return llm.apiKey;
  if (llm.apiKeyEncrypted && isAvailable()) {
    return tryDecrypt(llm.apiKeyEncrypted);
  }
  return null;
}

/**
 * Resolve the active Galaxy profile's API key. Returns `null` if no active
 * profile, no key, or decryption unavailable.
 */
export function resolveGalaxyApiKey(config: LoomConfig): string | null {
  const active = config.galaxy?.active;
  if (!active) return null;
  const profile = config.galaxy?.profiles?.[active];
  if (!profile) return null;
  if (profile.apiKey) return profile.apiKey;
  if (profile.apiKeyEncrypted && isAvailable()) {
    return tryDecrypt(profile.apiKeyEncrypted);
  }
  return null;
}

/**
 * One-shot migration. If any plaintext apiKey field exists and safeStorage is
 * available, encrypt it into apiKeyEncrypted and drop the plaintext. Writes
 * the config back only if changes were made.
 */
export function migratePlaintextSecrets(): { migrated: boolean; skipped: string | null } {
  if (!isAvailable()) {
    return { migrated: false, skipped: "safeStorage unavailable" };
  }
  const config = loadConfig();
  let changed = false;

  if (config.llm?.apiKey) {
    const enc = encryptSecret(config.llm.apiKey);
    config.llm = { ...config.llm, apiKeyEncrypted: enc };
    delete config.llm.apiKey;
    changed = true;
    log("migrated llm.apiKey → apiKeyEncrypted");
  }

  const profiles = config.galaxy?.profiles;
  if (profiles) {
    for (const name of Object.keys(profiles)) {
      const p = profiles[name];
      if (p.apiKey) {
        const enc = encryptSecret(p.apiKey);
        profiles[name] = { ...p, apiKeyEncrypted: enc };
        delete profiles[name].apiKey;
        changed = true;
        log(`migrated galaxy.profiles.${name}.apiKey → apiKeyEncrypted`);
      }
    }
  }

  if (changed) {
    saveConfig(config);
  }
  return { migrated: changed, skipped: null };
}
