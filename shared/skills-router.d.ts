export const SKILLS_SURFACE_ID: "loom";
export function selectSkills<T extends { surfaces: string[] }>(entries: T[], surface?: string): T[];
export interface SkillsRouterRepo {
  name: string;
  label?: string;
}
export interface SkillsRouterEntry {
  path: string;
  name: string;
  description: string;
  whenToUse?: string;
}
export function renderSkillsRouter(
  repos: readonly SkillsRouterRepo[],
  entriesByRepo: ReadonlyMap<string, readonly SkillsRouterEntry[]>,
  options: { freshness?: string; defaultRepoPhrase: string; defaultRepo?: string | null },
): string;
