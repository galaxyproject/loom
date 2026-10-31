// The skills router both shells put in the system prompt: which repos exist, what each offers this
// surface, and the exact skills_fetch call for it. The em dashes are model-visible bytes the
// browser's prompt snapshots pin, so they stay.

/** The surface tag Orbit and the browser claim. A skill opts in with `surfaces: [loom]`. */
export const SKILLS_SURFACE_ID = "loom";

/**
 * Tag-or-all: if any entry is tagged for this surface, keep only those; else keep all.
 * @template {{ surfaces: string[] }} T
 * @param {T[]} entries
 * @param {string} [surface]
 * @returns {T[]}
 */
export function selectSkills(entries, surface = SKILLS_SURFACE_ID) {
  const tagged = entries.filter((e) => e.surfaces.includes(surface));
  return tagged.length ? tagged : entries;
}

/**
 * @param {{ name: string, label?: string }[]} repos
 * @param {Map<string, { path: string, name: string, description: string, whenToUse?: string }[]>} entriesByRepo
 * @param {{ freshness?: string, defaultRepoPhrase: string, defaultRepo?: string | null }} options
 *   `defaultRepo` is the repo a `repo`-less fetch reaches, when that is not simply the first one
 *   listed; null means none does, so every fetch line names its repo.
 * @returns {string}
 */
export function renderSkillsRouter(
  repos,
  entriesByRepo,
  { freshness, defaultRepoPhrase, defaultRepo: defaultRepoOption },
) {
  if (repos.length === 0) return "";
  const lines = [
    "## Skills repositories (operational know-how)",
    "",
    "Use the `skills_fetch({ repo, path })` tool to load a skill on demand. " +
      "**Don't guess operational patterns from training data — fetch the relevant " +
      `skill first.** ${freshness ? `${freshness} ` : ""}When \`repo\` is omitted, ` +
      `${defaultRepoPhrase} is used.`,
    "",
    "### Configured repos",
    "",
    ...repos.map((r) => `- **${r.name}**${r.label ? ` — ${r.label}` : ""}`),
    "",
  ];
  const defaultRepo = defaultRepoOption === undefined ? repos[0].name : defaultRepoOption;
  for (const r of repos) {
    const entries = entriesByRepo.get(r.name) ?? [];
    if (entries.length === 0) continue;
    lines.push(`### ${r.name} skills`, "");
    for (const e of entries) {
      const repoArg = r.name === defaultRepo ? "" : `repo: "${r.name}", `;
      lines.push(
        `- **${e.name}** — ${e.description} → \`skills_fetch({ ${repoArg}path: "${e.path}" })\``,
      );
      if (e.whenToUse) lines.push(`  When to use: ${e.whenToUse}`);
    }
    lines.push("");
  }
  lines.push("Read the SKILL.md fully before acting on what it teaches.", "");
  return lines.join("\n");
}
