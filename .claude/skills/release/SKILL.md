---
name: release
description: Use when cutting a release of galaxyproject/loom -- tagging a new version that publishes the @galaxyproject/loom npm package and builds the Orbit desktop installers. Triggers include "cut a release", "ship 0.x", "release loom", or /release.
---

# Release (Loom / Orbit)

## Overview

Cut a Loom/Orbit release end to end. Two actions are irreversible and outward-facing:
the **tag push** (fires `release.yml` -> npm publish + installer build) and the **draft
promotion** (makes the GitHub release public). **STOP for explicit human confirmation
before each.** Everything before the tag push is local and reversible.

Why use this over running commands by hand: it generates *good* release notes -- curated
highlights, not a raw commit dump or GitHub's auto PR-title list -- and it gates the two
publish steps so nothing ships on autopilot.

**Violating the letter of the two gates is violating the spirit.** Do not collapse the
flow into one script. Stop, show, and wait for a human "go" before each publish boundary.

## Modes

- `/release` -- full guided run (all phases).
- `/release preview` -- Phase 0-1 only: gather PRs, draft highlights, propose the version, then STOP. Writes nothing, pushes nothing.
- `/release <version>` -- pin the version (e.g. `0.4.0`, `0.4.0-beta.1`) instead of being asked for a bump.

## Phase 0 -- Preconditions

Abort cleanly (change nothing) on any failure, with a specific message.

```bash
git rev-parse --abbrev-ref HEAD            # must be: main
test -z "$(git status --porcelain)"        # working tree must be clean
gh auth status                             # gh must be authenticated
# Canonical remote = whichever remote pushes to galaxyproject/loom (works from a
# fork-origin checkout or a galaxyproject-origin clone -- don't assume "upstream"):
CANON=$(git remote -v | awk '$3=="(push)" && $2 ~ /[:/]galaxyproject\/loom(\.git)?$/ {print $1; exit}')
test -n "$CANON"                           # abort if no canonical remote found
git fetch "$CANON" --tags
git merge-base --is-ancestor "$CANON/main" HEAD && git merge-base --is-ancestor HEAD "$CANON/main"  # local main == canonical main
LAST_TAG=$(git describe --tags --match 'v*' --abbrev=0)
LAST_DATE=$(git log -1 --format=%cs "$LAST_TAG")
CUR=$(node -p "require('./package.json').version")
```

## Phase 1 -- Generate highlights (the nice things)

Gather the merged PRs since the last tag:

```bash
gh pr list --repo galaxyproject/loom --state merged --base main \
  --search "merged:>=$LAST_DATE" --json number,title,author,labels,mergedAt
```

Distill them into a `### Highlights` list per the **Editorial rules** below -- this is
judgment, you do it, not a regex. Then determine the target version: from the
`/release <version>` arg, or ask for a bump (patch / minor / major + optional prerelease
channel alpha/beta/rc) and compute it from `$CUR`.

**Present the proposed version + the highlights block for the human to edit and approve.**
Nothing is written yet. `/release preview` ends here.

## Phase 2 -- Safe local prep (auto, after approval)

```bash
NEW=0.4.0   # the approved version
npm version "$NEW" --no-git-tag-version
npm version "$NEW" --no-git-tag-version --prefix app
node scripts/check-version-lockstep.mjs     # abort if mismatch
```

Prepend a new block to `CHANGELOG.md`, immediately above the most recent `## [` entry
(today = `date +%F`):

```markdown
## [0.4.0] - 2026-06-06

### Highlights

- <approved bullet>
- <approved bullet>
```

Then commit (do NOT tag yet):

```bash
git add package.json app/package.json CHANGELOG.md
git commit -m "release: v$NEW"
git --no-pager show --stat HEAD             # show what was committed
```

Reversible: `git reset --hard HEAD~1` undoes everything so far.

## Phase 3 -- GATE 1: tag push  (STOP)

⛔ **Hard stop.** State plainly: pushing will run `release.yml`, which **publishes
`@galaxyproject/loom@$NEW` to npm** (cannot be un-published) and builds the installers.
Wait for an explicit "go".

On go:

```bash
git push "$CANON" main
git tag "v$NEW"
git push "$CANON" "v$NEW"                    # this fires release.yml
```

Watch the run; STOP and report if it fails (do not proceed to promotion):

```bash
RUN=$(gh run list --repo galaxyproject/loom --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch --repo galaxyproject/loom "$RUN"
```

## Phase 4 -- Curated release body

The workflow makes a **draft** release with auto-generated "What's Changed". Replace its
body with the curated highlights ABOVE the auto notes (same highlights from Phase 1):

```bash
AUTO=$(gh release view "v$NEW" --repo galaxyproject/loom --json body -q .body)
gh release edit "v$NEW" --repo galaxyproject/loom \
  --notes "$(printf '## Highlights\n\n%s\n\n---\n\n%s' "$HIGHLIGHTS" "$AUTO")"
```

## Phase 5 -- GATE 2: promote draft  (STOP)

⛔ **Hard stop.** Only after CI is green. Tell the human to eyeball the draft + the
attached installers in the GitHub UI first. Wait for an explicit "go".

On go:

```bash
gh release edit "v$NEW" --repo galaxyproject/loom --draft=false
gh release view "v$NEW" --repo galaxyproject/loom --json url -q .url   # report the published URL
```

npm publish already happened in `release.yml` on the tag push -- the skill does not run
`npm publish` itself.

## Editorial rules for highlights

The core value -- match the voice of the existing `CHANGELOG.md` entries.

- **2-4 bullets.** User-facing benefit framing, present tense, concrete, no marketing. Group related PRs into one bullet.
- **Keep:** new features, new commands, user-visible fixes, new model/provider support, safety/security changes users care about, notable performance wins.
- **Drop:** CI/release-plumbing PRs, the `cut`/`bump X.Y.Z` PRs, dependency bumps (unless user-visible, e.g. "Opus 4.8 available"), pure internal refactors, docs-only and test-only PRs.
- **Voice:** casual, direct; plain hyphens, never a Unicode em-dash (restructure instead); name user-facing things (`/compact`, `loom update`), not PR numbers.
- **Always a draft:** highlights are public copy -- ALWAYS show them for human edit/approval before committing or publishing. Never publish generated copy unreviewed.

## Red flags -- STOP

- About to run the tag push or `--draft=false` without an explicit human "go" this turn -> STOP, show, wait.
- About to push to the fork (`origin` = your fork) instead of `$CANON` -> wrong remote.
- About to ship the auto-generated PR-title list as the release body -> that's the noise this skill replaces; curate first.
- Skipped `check-version-lockstep.mjs`, or bumped only one `package.json` -> CI will fail; fix before tagging.
- CI failed but proceeding to promote -> never promote a failed build.

## Common mistakes

| Mistake | Fix |
|---|---|
| Push tag to the fork | Push to `$CANON` (detected as the galaxyproject/loom remote) |
| Versions out of lockstep | Bump both via `npm version ... --prefix app`; run the lockstep check |
| Raw commit list as notes | Distill per the editorial rules; curate the release body too |
| Promote before CI is green | Watch the run; only `--draft=false` after green + eyeball |
| Re-cut after a bad publish | npm can't un-publish -- bump to a new version; never reuse a tag |
