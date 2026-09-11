/**
 * Bundled Foundry reference material.
 *
 * Files under `vendor/skills/` are vendored at a pinned Foundry ref by
 * `scripts/sync-foundry-skills.mjs` and ship inside the package -- both the npm
 * CLI (`files: ["extensions/", ...]`) and the Orbit installers (forge's
 * `LOOM_BUNDLE_FILES` includes `extensions`) pick them up with no packaging
 * change. That is deliberate: the guidance has to be available offline, at a
 * version we reviewed, with no runtime dependency on GitHub.
 *
 * This is a read-only source for `skills_fetch`, not a configured skills repo.
 * It never appears in the system-prompt skills router -- nothing here is
 * ambient guidance the model needs to know exists up front. Hints point at it
 * at the moment it becomes relevant (see `invocation-failure-hint.ts`).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Reserved repo name for `skills_fetch({ repo: "foundry" })`. */
export const VENDOR_REPO_NAME = "foundry";

export interface VendorManifestEntry {
  target: string;
  source: string;
  bytes: number;
  sha256: string;
  why: string;
}

export interface VendorManifest {
  repo: string;
  ref: string;
  refDate?: string;
  files: VendorManifestEntry[];
}

/** Absolute path to the vendored skills directory (sibling of this module). */
export function vendorSkillsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "vendor", "skills");
}

/**
 * Resolve a vendored file path to an absolute path inside the vendor dir, or
 * null if it escapes. The vendor set is flat, but a caller-supplied path still
 * gets the same containment check the GitHub path takes -- `..`, absolute
 * paths, and backslash separators are all rejected rather than normalized.
 */
export function resolveVendorPath(rawPath: string): string | null {
  const clean = rawPath.replace(/^\/+/, "").replace(/\\/g, "/");
  if (!clean || clean.includes("..")) return null;
  const dir = vendorSkillsDir();
  const abs = path.resolve(dir, clean);
  // path.resolve collapses traversal; confirm the result is still contained.
  // The trailing separator stops `/vendor/skillsX` from passing as `/vendor/skills`.
  if (abs !== dir && !abs.startsWith(dir + path.sep)) return null;
  return abs;
}

export function readVendorManifest(): VendorManifest | null {
  try {
    const raw = fs.readFileSync(path.join(vendorSkillsDir(), "_manifest.json"), "utf-8");
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.files)) return null;
    return data as VendorManifest;
  } catch {
    return null;
  }
}

export type VendorReadResult =
  | { ok: true; text: string }
  | { ok: false; error: string; available: string[] };

/** Read one vendored file. Never touches the network. */
export function readVendoredSkill(rawPath: string): VendorReadResult {
  const available = (readVendorManifest()?.files ?? [])
    .map((f) => f.target)
    .filter((t) => t !== "_manifest.json");
  const abs = resolveVendorPath(rawPath);
  if (!abs) return { ok: false, error: `Invalid vendored skill path "${rawPath}"`, available };
  try {
    return { ok: true, text: fs.readFileSync(abs, "utf-8") };
  } catch {
    return { ok: false, error: `No vendored file "${rawPath}"`, available };
  }
}
