/**
 * Secret redaction for tool OUTPUT (#183).
 *
 * The exec-guard decides whether a path may be read; this is the data-shaped
 * companion that ensures a known secret VALUE never rides a tool result back
 * into the model's context (and from there into the provider's request logs).
 * It is value-based by design: we redact the concrete keys Loom holds -- the
 * provider/Galaxy API keys in ~/.loom/config.json and the secret-valued env
 * vars the agent process carries -- so there are no false positives on ordinary
 * output. It is a defense-in-depth backstop for the guard, and it also catches
 * vectors the guard can't (an `env` dump, a key pasted into some other file).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../shared/loom-config.js";
import type { LoomConfig } from "../../shared/loom-config.js";

export const REDACTED = "[redacted]";

// Below this length a "secret" is too short to redact safely -- scrubbing a
// 3-char value would mangle ordinary output. Real API keys are far longer.
const MIN_SECRET_LEN = 8;

// Env vars whose VALUE is a live secret. The agent process carries these at
// runtime (the CLI exports the active provider's key from config; Orbit injects
// the decrypted key when it spawns the brain), so an `env`/`printenv` dump would
// otherwise leak them even when the config file itself is locked down. Only
// secret-VALUED vars belong here -- not names like AWS_PROFILE.
const SECRET_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "CEREBRAS_API_KEY",
  "AI_GATEWAY_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "HF_TOKEN",
  "GALAXY_API_KEY",
  // Custom OpenAI-compatible endpoints carry their key here (pi --api-key). With
  // the dev/CI env fallback this can be the only place the key lives, so its
  // value would otherwise dodge redaction.
  "LOOM_ACTIVE_LLM_API_KEY",
];

/** Minimal structural shape for a pi tool-result content item. */
interface ContentItem {
  type: string;
  text?: string;
}

/**
 * Gather the concrete secret strings to scrub: every API key in the config
 * (plaintext apiKey AND the apiKeyEncrypted blob, for LLM providers and Galaxy
 * profiles) plus the known secret-valued env vars. Pure -- env is passed in so
 * it's testable. `testerId` is deliberately not a secret, so it survives (the
 * #189 path can read it without leaking keys).
 */
export function collectSecretValues(
  config: LoomConfig,
  env: Record<string, string | undefined>,
): string[] {
  const out = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v === "string" && v.length >= MIN_SECRET_LEN) out.add(v);
  };
  for (const p of Object.values(config.llm?.providers ?? {})) {
    add(p?.apiKey);
    add(p?.apiKeyEncrypted);
  }
  for (const p of Object.values(config.galaxy?.profiles ?? {})) {
    add(p?.apiKey);
    add(p?.apiKeyEncrypted);
  }
  for (const name of SECRET_ENV_VARS) add(env[name]);
  return [...out];
}

/**
 * Replace every occurrence of each known secret with the placeholder. Literal
 * (no regex, so key characters can't be misread as patterns); longest-first so a
 * key that contains a shorter one is scrubbed whole. Short/empty values ignored.
 */
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  let out = text;
  const sorted = [...secrets]
    .filter((s) => s.length >= MIN_SECRET_LEN)
    .sort((a, b) => b.length - a.length);
  for (const s of sorted) {
    if (out.includes(s)) out = out.split(s).join(REDACTED);
  }
  return out;
}

/**
 * Redact text items of a tool-result content array. Returns a changed copy, or
 * `null` if nothing matched (so the caller can no-op). Non-text items (images)
 * pass through untouched; the original array is never mutated.
 */
export function redactContent<T extends ContentItem>(content: T[], secrets: string[]): T[] | null {
  if (secrets.length === 0) return null;
  let changed = false;
  const next = content.map((c) => {
    if (c && c.type === "text" && typeof c.text === "string") {
      const red = redactSecrets(c.text, secrets);
      if (red !== c.text) {
        changed = true;
        return { ...c, text: red };
      }
    }
    return c;
  });
  return changed ? next : null;
}

/**
 * Register the output-redaction hook. Runs after every tool and rewrites the
 * result content the model receives, so a leaked key never reaches the provider.
 * Reloads config each time so a key added mid-session is covered immediately;
 * a clean result returns nothing (pi keeps the original).
 */
export function registerSecretRedaction(pi: ExtensionAPI): void {
  pi.on("tool_result", async (event) => {
    const secrets = collectSecretValues(loadConfig(), process.env);
    const content = redactContent(event.content, secrets);
    if (content) return { content };
  });
}
