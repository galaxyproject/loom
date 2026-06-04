import { parse as parseYaml } from "yaml";

/** The product-surface id Loom claims. A skill opts in with `surfaces: [loom]`. */
export const SURFACE_ID = "loom";

/** Catalog freshness window. SKILL.md frontmatter + the tree listing use this; deep refs stay 24h. */
export const CATALOG_TTL_MS = 60 * 60 * 1000;

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  when_to_use?: string;
  surfaces?: string[];
}

export interface SkillEntry {
  path: string;
  name: string;
  description: string;
  when_to_use?: string;
  surfaces: string[];
}

function toSurfaces(v: unknown): string[] {
  if (typeof v === "string") return [v.trim()].filter(Boolean);
  if (Array.isArray(v)) {
    return v
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

export function parseFrontmatter(text: string): SkillFrontmatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  let data: unknown;
  try {
    data = parseYaml(m[1]);
  } catch {
    return {};
  }
  if (!data || typeof data !== "object") return {};
  const o = data as Record<string, unknown>;
  const fm: SkillFrontmatter = {};
  if (typeof o.name === "string") fm.name = o.name;
  if (typeof o.description === "string") fm.description = o.description;
  if (typeof o.when_to_use === "string") fm.when_to_use = o.when_to_use.trim();
  fm.surfaces = toSurfaces(o.surfaces);
  return fm;
}

/** Tag-or-all: if any entry is tagged for this surface, keep only those; else keep all. */
export function selectSkills(entries: SkillEntry[], surface: string = SURFACE_ID): SkillEntry[] {
  const tagged = entries.filter((e) => e.surfaces.includes(surface));
  return tagged.length ? tagged : entries;
}
