/**
 * /tester-id -- the get-or-set counterpart to buildTesterIdBlock (#189/#191).
 *
 * With no argument it prints the current tester ID; with an argument it sets it.
 *
 * Beta onboarding asks testers to put a `testerId` in ~/.loom/config.json. That
 * file is a credential store, so the agent's edit/write to it is floored by the
 * exec-guard -- a hard deny on low-capability models and an unreachable
 * read-then-edit on every tier once #194 landed (issue #222). This gives the
 * user a deterministic, model-independent path that sets ONLY the testerId key.
 *
 * It deliberately reads/echoes ONLY the testerId field (a non-secret tester code
 * like "orbit-007", which already passes #194 redaction), never any other config
 * value, so it cannot become a way to surface the API keys that #183/#194 lock
 * down.
 */

import fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getConfigPath, loadConfig, saveConfig } from "./config.js";

// Tester codes are opaque, non-secret strings (e.g. "orbit-007"). Constrain the
// shape so neither a fat-fingered user nor a pasted blob can smuggle a newline,
// JSON, or a giant value into the key: first char alphanumeric, then a few safe
// separators, capped length.
const TESTER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type ValidateResult = { ok: true; id: string } | { ok: false; error: string };

export function validateTesterId(raw: string): ValidateResult {
  const id = (raw ?? "").trim();
  if (!id) {
    return { ok: false, error: "Usage: /tester-id <id>  (e.g. /tester-id orbit-007)" };
  }
  if (!TESTER_ID_RE.test(id)) {
    return {
      ok: false,
      error:
        "Tester ID must be 1-64 characters: letters, digits, and . _ - only, " +
        "starting with a letter or digit (e.g. orbit-007).",
    };
  }
  return { ok: true, id };
}

/**
 * The currently-effective tester ID and where it came from. Mirrors
 * buildTesterIdBlock's precedence (config wins over the env override). Reads
 * ONLY testerId -- never another config field.
 */
export function getCurrentTesterId(): { id: string; source: "config" | "env" } | null {
  const fromConfig = loadConfig().testerId;
  if (fromConfig) return { id: fromConfig, source: "config" };
  const fromEnv = process.env.LOOM_TESTER_ID;
  if (fromEnv) return { id: fromEnv, source: "env" };
  return null;
}

/**
 * Set ONLY the testerId key. Loads the full config so existing fields (API keys
 * included) ride straight back to disk unchanged, mutates the single key, and
 * persists via the shared atomic writer. No other field is read out, returned,
 * or echoed.
 *
 * Fails closed: loadConfig() silently returns {} when an existing config can't
 * be read or parsed, so writing that back would wipe the user's stored API
 * keys. We refuse rather than clobber -- a genuinely absent file is still fine
 * to create. A save failure is rewrapped in a fixed message so the raw error
 * (whatever it carries) can never be surfaced through this command.
 */
export function setTesterId(id: string): void {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    try {
      JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch (err) {
      throw new Error(
        "~/.loom/config.json couldn't be read, so it wasn't changed -- fix or remove the file and try again.",
        { cause: err },
      );
    }
  }
  const cfg = loadConfig();
  cfg.testerId = id;
  try {
    saveConfig(cfg);
  } catch (err) {
    throw new Error(
      "Couldn't write ~/.loom/config.json -- check file permissions and free space, then try again.",
      { cause: err },
    );
  }
}

export function registerTesterIdCommand(pi: ExtensionAPI): void {
  pi.registerCommand("tester-id", {
    description:
      "Show or set your Orbit beta tester ID (writes only testerId to ~/.loom/config.json).",
    handler: async (args: string | undefined, ctx: ExtensionContext) => {
      const raw = (args ?? "").trim();

      if (!raw) {
        const current = getCurrentTesterId();
        if (!current) {
          ctx.ui.notify(
            "No tester ID set. Set one with /tester-id <id>  (e.g. /tester-id orbit-007).",
            "info",
          );
          return;
        }
        const suffix = current.source === "env" ? " (from LOOM_TESTER_ID)" : "";
        ctx.ui.notify(`Tester ID: ${current.id}${suffix}`, "info");
        return;
      }

      const result = validateTesterId(raw);
      if (!result.ok) {
        ctx.ui.notify(result.error, "error");
        return;
      }
      try {
        setTesterId(result.id);
      } catch (err) {
        // setTesterId only throws messages it authored -- never a raw error
        // that could carry config contents -- so showing it is safe.
        ctx.ui.notify(err instanceof Error ? err.message : "Failed to save tester ID.", "error");
        return;
      }
      ctx.ui.notify(`Tester ID set to ${result.id}.`, "info");
    },
  });
}
