/**
 * Skills-repo accessors. Single site that turns the persisted config
 * into the list the agent actually sees — applies the alpha-time
 * github.com/galaxyproject/* allowlist as a defense-in-depth filter
 * (the renderer already blocks at save time, but a hand-edited
 * `~/.loom/config.json` shouldn't be able to bypass).
 *
 * Both the `skills_fetch` tool registration (`tools.ts`) and the
 * system-prompt builder (`context.ts`) import from here so the
 * filter is applied uniformly.
 */

import { loadConfig } from "./config";
import { isAllowedSkillUrl } from "../../shared/loom-config.js";

export interface ConfiguredSkillRepo {
  name: string;
  url: string;
  branch: string;
}

/**
 * Conservative slug pattern. The name is later joined into a filesystem path
 * (`~/.loom/cache/skills/<name>/...`); slashes, `..`, and other path-active
 * characters would let a hand-edited config write outside the cache dir.
 * Keep to ASCII letters, digits, dot, dash, underscore.
 */
const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/;

export function isSafeSkillName(name: string): boolean {
  if (typeof name !== "string" || name.length === 0 || name.length > 64) return false;
  if (name === "." || name === "..") return false;
  return SAFE_NAME_RE.test(name);
}

export function listEnabledSkillRepos(): ConfiguredSkillRepo[] {
  const cfg = loadConfig();
  const repos = (cfg.skills?.repos ?? []) as Array<{
    name?: string;
    url?: string;
    branch?: string;
    enabled?: boolean;
  }>;
  const enabled: ConfiguredSkillRepo[] = [];
  for (const r of repos) {
    if (r?.enabled === false) continue;
    if (typeof r?.name !== "string" || typeof r?.url !== "string") continue;
    if (!isSafeSkillName(r.name)) {
      console.warn(
        `[skills] Dropping repo with unsafe name "${r.name}" — ` +
          `must match /^[A-Za-z0-9._-]+$/ (used as filesystem path)`,
      );
      continue;
    }
    if (!isAllowedSkillUrl(r.url)) {
      console.warn(
        `[skills] Dropping disallowed repo "${r.name}" (${r.url}) — ` +
          `not under github.com/galaxyproject/*`,
      );
      continue;
    }
    enabled.push({
      name: r.name,
      url: r.url,
      branch: typeof r.branch === "string" && r.branch ? r.branch : "main",
    });
  }
  return enabled;
}

export function findSkillRepo(name: string | undefined): ConfiguredSkillRepo | null {
  const enabled = listEnabledSkillRepos();
  if (enabled.length === 0) return null;
  if (!name) return enabled[0];
  return enabled.find((r) => r.name === name) ?? null;
}
