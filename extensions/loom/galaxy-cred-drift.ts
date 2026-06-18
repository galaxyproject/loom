/**
 * Galaxy credential-drift reconnect.
 *
 * The galaxy MCP connection is established by the model *choosing* to call
 * `galaxy_connect()`, and the only thing that prompts it is the startup
 * greeting -- which is suppressed on a `--continue` resume (see
 * session-lifecycle.ts). So when the user rotates their Galaxy API key (or
 * switches server/account) in Orbit's Preferences, the brain restarts with the
 * new credentials in its env, but the resumed model still believes it's
 * connected as the *old* account from the replayed transcript and never
 * rebinds. The result: galaxy tools keep acting as the previous key's user.
 *
 * This module closes that gap. On session_start we fingerprint the active
 * credentials and compare against a per-cwd baseline -- the creds the model
 * last *confirmed* a connection with. On a resume where the fingerprint
 * changed, we nudge the model to call `galaxy_connect()` so it rebinds. The
 * baseline only advances on a confirmed connect (recordGalaxyConnected), so an
 * ignored nudge or a crash before the reconnect lands can't mask the drift.
 *
 * The fingerprint is a one-way hash of url+key, so the raw key never lands on
 * disk -- only an opaque digest used for equality checks.
 */

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activeGalaxyStatus } from "./profiles.js";
import { piAgentDir } from "./agent-dir.js";

export const GALAXY_RECONNECT_NUDGE =
  "Your Galaxy credentials changed since this session was last active -- a different " +
  "server or account is now configured, so the previous connection is no longer valid. " +
  "Call galaxy_connect() to rebind, then confirm in one short sentence which Galaxy " +
  "account is now active. Do NOT use other Galaxy tools until reconnected.";

/**
 * Opaque, stable fingerprint of a (url, key) pair. SHA-256 so the raw key is
 * never recoverable from the stored value. url and key are fed as separate
 * hash updates split by a newline, which neither a URL nor an API key can
 * contain -- so ("ab","c") can't collide with ("a","bc").
 */
export function galaxyCredFingerprint(url: string, apiKey: string): string {
  return createHash("sha256").update(url).update("\n").update(apiKey).digest("hex");
}

export interface CredDriftInput {
  /** Fingerprint persisted by a prior session in this cwd (null = first run). */
  stored: string | null;
  /** Fingerprint of the credentials active now (null = galaxy not usable). */
  current: string | null;
  /** True on a `--continue` resume, where the startup greeting is suppressed. */
  isResume: boolean;
}

/**
 * Decide whether to nudge a reconnect. Pure.
 *
 * Only fires on a resume (fresh starts get the greeting, which already prompts
 * galaxy_connect), only when there are usable creds to reconnect *to*, and only
 * when a baseline exists to prove the creds actually changed.
 */
export function shouldNudgeReconnect({ stored, current, isResume }: CredDriftInput): boolean {
  if (!isResume) return false;
  if (!current) return false;
  if (!stored) return false;
  return stored !== current;
}

/** Encode a cwd into a single filesystem-safe path segment. */
function encodeCwd(cwd: string): string {
  // A readable slug prefix for debuggability, plus a hash of the *full* cwd for
  // uniqueness -- the slug substitution alone collides (e.g. `/a-b/c` and
  // `/a/b-c` both slug to `a-b-c`), so the hash is what keeps distinct cwds in
  // distinct files. The slug is also capped so the filename can't overrun the
  // OS limit.
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  const slug =
    cwd
      .replace(/^[/\\]/, "")
      .replace(/[/\\:]/g, "-")
      .slice(0, 64) || "root";
  return `${slug}-${hash}`;
}

/**
 * Per-cwd path where this cwd's credential fingerprint is persisted. Keyed by
 * cwd (not session id) because credentials are global and the question is "did
 * this project's creds change since it last connected." Caveat: two windows on
 * the *same* cwd share one baseline, so the first to restart after a change can
 * satisfy the second's check -- acceptable since one-window-per-project is the
 * norm.
 */
export function fingerprintPath(cwd: string, agentDir: string = piAgentDir()): string {
  return path.join(agentDir, "galaxy-cred-fp", `${encodeCwd(cwd)}.txt`);
}

export function readStoredFingerprint(filePath: string): string | null {
  try {
    const v = fs.readFileSync(filePath, "utf-8").trim();
    return v || null;
  } catch {
    return null;
  }
}

export function writeStoredFingerprint(filePath: string, fingerprint: string): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // 0600: a credential digest is low-risk but there's no reason to let other
    // users on a shared machine read it.
    fs.writeFileSync(filePath, fingerprint, { mode: 0o600 });
  } catch (err) {
    console.error("galaxy cred fingerprint write failed:", err);
  }
}

export interface ReconnectOptions {
  isResume: boolean;
  cwd?: string;
}

/** Fingerprint of the credentials active in this process's env, or null when
 *  Galaxy isn't usable. */
function currentGalaxyFingerprint(): string | null {
  const url = process.env.GALAXY_URL;
  const key = process.env.GALAXY_API_KEY;
  // The `url && key` guard narrows both to string for the fingerprint call.
  return activeGalaxyStatus() === "usable" && url && key ? galaxyCredFingerprint(url, key) : null;
}

/**
 * Session_start hook: on a resume where the Galaxy account/server changed since
 * the last *confirmed* connect, nudge the model to reconnect.
 */
export function maybeNudgeGalaxyReconnect(pi: ExtensionAPI, opts: ReconnectOptions): void {
  const cwd = opts.cwd ?? process.cwd();
  const current = currentGalaxyFingerprint();
  const fpPath = fingerprintPath(cwd);
  const stored = readStoredFingerprint(fpPath);

  if (shouldNudgeReconnect({ stored, current, isResume: opts.isResume })) {
    pi.sendUserMessage(GALAXY_RECONNECT_NUDGE);
  }

  // Seed an initial baseline the first time usable creds appear, but NEVER
  // overwrite an existing one here. The baseline only advances on a confirmed
  // galaxy_connect (recordGalaxyConnected), so an ignored nudge or a crash
  // before the reconnect lands can't mask the drift -- the next resume
  // re-nudges until the model actually reconnects.
  if (current && stored === null) writeStoredFingerprint(fpPath, current);
}

/**
 * Record that the model successfully (re)connected to Galaxy with the current
 * credentials. This advances the drift baseline so a later key/server change
 * registers as drift on the next resume. Call from the galaxy_connect success
 * hook -- advancing only on confirmed connect is what keeps an unacted nudge
 * from permanently suppressing future ones.
 */
export function recordGalaxyConnected(cwd: string = process.cwd()): void {
  const current = currentGalaxyFingerprint();
  if (current) writeStoredFingerprint(fingerprintPath(cwd), current);
}
