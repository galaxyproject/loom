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

import * as fs from "fs";
import * as path from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../shared/loom-config.js";
import type { LoomConfig } from "../../shared/loom-config.js";
import { installedConfigSource } from "../../shared/config-source.js";
import { piAgentDir } from "./agent-dir";
import { galaxyCredentials } from "./galaxy-api";

export const REDACTED = "[redacted]";

// Below this length a "secret" is too short to redact safely -- scrubbing a
// 3-char value would mangle ordinary output. Real API keys are far longer.
const MIN_SECRET_LEN = 8;

// Env vars whose VALUE is a live secret. The agent process carries these at
// runtime (the CLI exports the active provider's key from config; Orbit injects
// the decrypted key when it spawns the brain), so an `env`/`printenv` dump would
// otherwise leak them even when the config file itself is locked down. Only
// secret-VALUED vars belong here -- not names like AWS_PROFILE. Every LOOM_ name
// is paired with its ORBIT_ twin (tests/orbit-env-security.test.ts enforces it):
// either spelling can carry the value, and brain-env forwards both prefixes.
export const SECRET_ENV_VARS = [
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
  "ORBIT_ACTIVE_LLM_API_KEY",
  // Shell-side secrets that still ride into the brain through the LOOM_/ORBIT_
  // prefix forwarding, so an `env` dump would otherwise show them.
  "LOOM_WEB_TOKEN",
  "ORBIT_WEB_TOKEN",
  "LOOM_FEEDBACK_KEY",
  "ORBIT_FEEDBACK_KEY",
];

// Keys in a stored pi credential that are metadata rather than secret. Every
// other long-enough string in the entry gets collected, deliberately: pi-ai's
// OAuthCredentials carries an open index signature (`[key: string]: unknown`),
// so a provider can add a token-shaped field whenever it likes. The two failure
// modes are not symmetric -- missing a field leaks a live token, over-matching
// costs a `[redacted]` where an account id used to print -- so this errs toward
// collecting.
const AUTH_METADATA_KEYS = new Set(["type", "expires"]);

/**
 * Read pi's credential store (~/.pi/agent/auth.json, or wherever
 * PI_CODING_AGENT_DIR points). Best-effort: absent, unreadable, or mid-write
 * under pi's lock all yield null and simply contribute no secrets, exactly as
 * an unconfigured provider does. Never throws -- a redaction pass that failed
 * closed would drop every tool result.
 */
export function loadPiAuth(agentDir: string = piAgentDir()): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"));
  } catch {
    return null;
  }
}

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
 * #189 path can read it without leaking keys). `extra` is for values a caller
 * already holds that live in none of those places.
 */
export function collectSecretValues(
  config: LoomConfig,
  env: Record<string, string | undefined>,
  auth: unknown = null,
  extra: readonly unknown[] = [],
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
  // pi's auth.json: the one credential class Loom cannot encrypt at rest, so
  // value-redaction is the only backstop its tokens get.
  for (const cred of Object.values((auth ?? {}) as Record<string, unknown>)) {
    if (!cred || typeof cred !== "object") continue;
    for (const [key, value] of Object.entries(cred as Record<string, unknown>)) {
      if (AUTH_METADATA_KEYS.has(key)) continue;
      if (typeof value === "string") add(value);
      // An api-key credential nests provider-scoped config under `env`
      // (Cloudflare account/gateway ids and the like), which can itself be secret.
      else if (value && typeof value === "object")
        for (const nested of Object.values(value as Record<string, unknown>)) add(nested);
    }
  }
  for (const v of extra) add(v);
  return [...out];
}

/**
 * Everything the redactor scrubs right now: the config's keys, the secret env
 * vars, pi's auth.json where pi runs natively, the Galaxy key the transport
 * holds, and whatever the shell's config source lists. `auth: false` leaves
 * auth.json out: only the tool_result redactor has ever read it, and the
 * activity log and lesson text keep the set they had.
 */
export function currentSecretValues({ auth = true }: { auth?: boolean } = {}): string[] {
  const source = installedConfigSource();
  // A shell that hands over the config hands over its secrets too; auth.json is pi's own store.
  const piAuth = auth && !source ? loadPiAuth() : null;
  return collectSecretValues(loadConfig(), process.env, piAuth, [
    galaxyCredentials().apiKey,
    ...(source?.secrets?.() ?? []),
  ]);
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
    const secrets = currentSecretValues();
    const content = redactContent(event.content, secrets);
    if (content) return { content };
  });
}
