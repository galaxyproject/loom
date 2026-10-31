/**
 * Orbit's vendored skills tree for the worker: the catalog and manifest inline, the bodies as
 * files beside the bundle, fetched when skills_fetch reads one. Inlining the bodies would put
 * 2.3 MB of text in the worker bundle that most sessions never read.
 *
 * A flavor's own skills (Olit's visualization skill) join the shipped galaxy-skills repo as extra
 * targets: a repo Orbit doesn't ship is fetched from GitHub, and there's no repo to fetch these
 * from. The core's own notebook skill isn't carried: it teaches the browser brain's record tools.
 */
import catalog from "../../../../../extensions/orbit/vendor/skills/_catalog.json";
import manifest from "../../../../../extensions/orbit/vendor/skills/_manifest.json";
import type { SkillEntry } from "../../../../../extensions/orbit/skills-discovery";
import type { VendorSkillsSource } from "../../../../../extensions/orbit/vendor-skills";
import { SKILLS_SURFACE_ID } from "../../../../../shared/skills-router.js";
import { parseFrontmatter } from "../skills";

const ROOT = "../../../../../extensions/orbit/vendor/skills/";

const BODIES = import.meta.glob("../../../../../extensions/orbit/vendor/skills/**/*", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

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

/** A source that answers only manifest targets, as the file tree under Node does. */
export function vendorSkills(own: readonly OwnSkillFile[] = []): VendorSkillsSource {
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
      const url = BODIES[`${ROOT}${target}`];
      if (!url) return null;
      const response = await fetch(url);
      // A failed fetch is a failure, not a file the tree doesn't have.
      if (!response.ok) throw new Error(`${target} could not be loaded (HTTP ${response.status})`);
      return response.text();
    },
  };
}
