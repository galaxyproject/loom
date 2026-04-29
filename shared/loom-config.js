import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const DEFAULT_SKILLS = [
  {
    name: "galaxy-skills",
    url: "https://github.com/galaxyproject/galaxy-skills",
    branch: "main",
    enabled: true,
  },
];

/**
 * Allowlist for skill-repo URLs. The agent treats fetched SKILL.md
 * content as authoritative instructions, so an arbitrary third-party
 * repo is a prompt-injection vector. For the alpha release we limit
 * skill repos to github.com/galaxyproject/* — Galaxy-controlled,
 * auditable. To relax, edit this constant or replace
 * isAllowedSkillUrl() with a more permissive predicate.
 */
export const ALLOWED_SKILLS_PREFIX = "https://github.com/galaxyproject/";

export function isAllowedSkillUrl(url) {
  if (typeof url !== "string") return false;
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.hostname.toLowerCase() !== "github.com") return false;
  const cleaned = parsed.pathname
    .toLowerCase()
    .replace(/\.git\/*$/, "")
    .replace(/\/+$/, "");
  if (!cleaned.startsWith("/galaxyproject/")) return false;
  // Require at least owner + repo segments (no /galaxyproject alone).
  return cleaned.split("/").filter(Boolean).length >= 2;
}

export function getConfigDir() {
  return path.join(os.homedir(), ".loom");
}

export function getConfigPath() {
  return path.join(getConfigDir(), "config.json");
}

export function loadConfig() {
  const p = getConfigPath();
  let raw = {};
  if (fs.existsSync(p)) {
    try {
      raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      raw = {};
    }
  }
  // Lazy-seed default skills repo if the user hasn't configured any. This
  // also re-seeds galaxy-skills if every repo was removed manually — feels
  // less surprising than silently leaving it absent.
  if (!raw.skills || !Array.isArray(raw.skills.repos) || raw.skills.repos.length === 0) {
    raw.skills = { repos: [...DEFAULT_SKILLS] };
  }
  // Default execution mode: cloud (agent decides per-plan). Local sandboxes
  // the project to local-only execution regardless of Galaxy credentials.
  if (raw.executionMode !== "local" && raw.executionMode !== "cloud") {
    raw.executionMode = "cloud";
  }
  return raw;
}

export function saveConfig(config) {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = getConfigPath();
  // Atomic write: never leave a half-written ~/.loom/config.json behind.
  // A power-loss / process-kill mid-write would otherwise truncate the
  // config and lose the user's API keys + skills + profiles. The .tmp
  // file lives next to the dest so the rename is on the same filesystem.
  const tmp = `${dest}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(config, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, dest);
  // fs.openSync mode applies to the tmp file. Tighten the final path too,
  // including the case where an existing file had looser permissions.
  try {
    fs.chmodSync(dest, 0o600);
  } catch {}
}
