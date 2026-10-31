/**
 * Orbit's vendored skills tree: the catalog and manifest inline, the bodies read by the host's own
 * reader when skills_fetch asks for one.
 *
 * A flavor's own skills (Olit's visualization skill) join the shipped galaxy-skills repo as extra
 * targets: a repo Orbit doesn't ship is fetched from GitHub, and there's no repo to fetch these
 * from.
 */
import catalog from "../../../../../extensions/orbit/vendor/skills/_catalog.json";
import manifest from "../../../../../extensions/orbit/vendor/skills/_manifest.json";
import type { SkillEntry } from "../../../../../extensions/orbit/skills-discovery";
import type { VendorSkillsSource } from "../../../../../extensions/orbit/vendor-skills";
import { SKILLS_SURFACE_ID } from "../../../../../shared/skills-router.js";
import { parseFrontmatter } from "../../../../../extensions/orbit/skills-discovery";

/** The repo flavor skills are offered under: the one Orbit ships and reads from the package. */
const HOST_REPO = "galaxy-skills";

/** One of a flavor's own skill files, as the shipped tree would hold it. */
export interface OwnSkillFile {
  target: string;
  text: string;
}

/**
 * A flavor's own skills (files keyed "./skills/own/<skill>/<path>", as AgentFlavor.skills is) as
 * shipped targets under galaxy-skills, named after the brand so they can't meet a real skill.
 */
export function ownSkillFiles(files: Record<string, string>, brandId: string): OwnSkillFile[] {
  return Object.entries(files).flatMap(([key, text]) => {
    const own = key.match(/^\.\/skills\/own\/(.+)$/)?.[1];
    return own ? [{ target: `skills/${brandId}-${own}`, text }] : [];
  });
}

/** A shipped skill file's text by its manifest target, or null when there's none. */
export type SkillReader = (target: string) => Promise<string | null>;

/** No shipped bodies: a host that serves them passes its own reader. */
const noBodies: SkillReader = async () => null;

/**
 * A source that answers only manifest targets, as the file tree under Node does. `readBody` reads
 * a shipped body the way the host can: fetched beside the worker bundle (browser-env.ts), or
 * through the bundler under Node (skills-node.ts).
 */
export function vendorSkills(
  own: readonly OwnSkillFile[] = [],
  readBody: SkillReader = noBodies,
): VendorSkillsSource {
  const shipped = manifest as { files: Array<{ target: string; plugin: string }> };
  const ownText = new Map(own.map((f) => [f.target, f.text]));
  const entries: SkillEntry[] = own.flatMap((file) => {
    if (!file.target.endsWith("/SKILL.md")) return [];
    const fm = parseFrontmatter(file.text);
    if (!fm.name || !fm.description) return [];
    return [
      {
        path: file.target,
        name: fm.name,
        description: fm.description,
        ...(fm.when_to_use ? { when_to_use: fm.when_to_use } : {}),
        surfaces: fm.surfaces?.length ? fm.surfaces : [SKILLS_SURFACE_ID],
      },
    ];
  });
  const shippedCatalog = catalog as Record<string, unknown>;
  const targets = new Set([...shipped.files.map((f) => f.target), ...ownText.keys()]);
  return {
    catalog: {
      ...shippedCatalog,
      [HOST_REPO]: [...((shippedCatalog[HOST_REPO] as SkillEntry[]) ?? []), ...entries],
    },
    manifest: {
      ...shipped,
      files: [...shipped.files, ...own.map((f) => ({ target: f.target, plugin: HOST_REPO }))],
    },
    async read(target) {
      if (!targets.has(target)) return null;
      const ownBody = ownText.get(target);
      if (ownBody !== undefined) return ownBody;
      return readBody(target);
    },
  };
}
