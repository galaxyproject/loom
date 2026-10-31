/**
 * Orbit's shipped skill bodies for a host with no server beside it (Node: Headless, the session
 * bundle): read through the bundler, so a bundled session carries them. Only Node's entry imports
 * this; the worker fetches them beside its bundle instead (skills.ts).
 */
import type { SkillReader } from "./skills";

const ROOT = "../../../../../extensions/orbit/vendor/skills/";

const BODIES = import.meta.glob("../../../../../extensions/orbit/vendor/skills/**/*", {
  query: "?raw",
  import: "default",
}) as Record<string, () => Promise<string>>;

export const readShippedSkill: SkillReader = async (target) => {
  const load = BODIES[`${ROOT}${target}`];
  return load ? load() : null;
};
