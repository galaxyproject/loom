# Staging skills

**These are temporary.** Each skill here is one Orbit needed before it had a proper home, so it
lives here while it is tried with Orbit's users and then moves out. Everything else Orbit's model
can fetch is vendored from [galaxyproject/agentic-plugins](https://github.com/galaxyproject/agentic-plugins)
at a pinned commit; that, or another shared repo, is where these belong. If you maintain one of
those homes and a skill below fits it, take it -- that is the point.

The model reaches them as `skills_fetch({ repo: "orbit", path: "skills/<name>/SKILL.md" })`, and
the system-prompt router lists them under an `orbit` section labelled as staging.

## Currently staged

| Skill                                                     | Proposed home | Why it is here first                                                                                                                                                                                                                                    |
| --------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`galaxy-data-libraries`](galaxy-data-libraries/SKILL.md) | galaxy-skills | Browsing a data library and running tools on its datasets in place. Nothing upstream covered data libraries when users needed it. It also specifies three library operations galaxy-ops does not have yet, after which most of its REST section can go. |

Keep this table current: add a row with each new skill, and delete the row when the skill moves.

## Writing one

- One directory per skill, named for its frontmatter `name`, with a `SKILL.md` and any reference
  files beside it. Text only; no symlinks.
- Frontmatter needs `name` and `description`, and `when_to_use` if the description alone doesn't
  say when to reach for it.
- `metadata.proposed_home` names where the skill should end up (usually `galaxy-skills`). The sync
  refuses a skill without one: a skill with no destination is one nobody will ever move. Follow the galaxy-skills house style so the move upstream is a copy.
- `metadata.surfaces: [loom]` puts the skill in the router (one line in every system prompt).
  Leave it off for a skill that only a hint should point at; it stays fetchable by path. At least
  one skill here has to be tagged -- the router is tag-or-all.
- No paths into anybody's home directory; the sync refuses them.

## Shipping it

Files here are copied into `extensions/orbit/vendor/skills/` by the same sync as the agentic-plugins
content, so after any edit:

```bash
npm run sync:skills    # re-vendor and re-hash
npm run check:skills   # what CI runs; fails if this directory and the vendored copy disagree
```

`sync:skills` also fetches the agentic-plugins pin. To stay offline, point
`LOOM_AGENTIC_PLUGINS_DIR` at a checkout of agentic-plugins at the pinned commit.

A new or changed description changes the system prompt, so update the goldens too:
`npx vitest run -u tests/system-prompt-surface.test.ts`, and read the diff.

## Moving one upstream

Copy the directory into its proposed home (for galaxy-skills, `plugins/galaxy-skills/skills/` in
agentic-plugins), drop `proposed_home` from its frontmatter, land it, bump the pin in
`scripts/skills.manifest.json`, delete it here, and re-sync. The path stays the same, so the only
thing that changes for the model is `repo: "orbit"` becoming the default repo. Forgetting the delete
fails the sync: two plugins would vendor the same file.

If it was the last skill here, also remove the `orbit-skills` entry from
`scripts/skills.manifest.json` before re-syncing. The sync refuses an entry whose files match
nothing, so an empty `skills/` with the entry still in place fails both `sync:skills` and
`check:skills`.
