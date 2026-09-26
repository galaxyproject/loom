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
# Clean tree. A pre-release smoke/package run can leave stray artifacts that
# trip this (e.g. app/test-results/, app/out/) -- remove them, don't commit them.
test -z "$(git status --porcelain)"
gh auth status                             # gh must be authenticated
# Canonical remote = whichever remote pushes to galaxyproject/loom (works from a
# fork-origin checkout or a galaxyproject-origin clone -- don't assume "upstream").
# grep, not awk: BSD/macOS awk chokes on the /[:/]/ char class, and the line ends
# in " (push)" so a trailing-$ anchor never matches anyway.
CANON=$(git remote -v | grep '(push)' | grep 'galaxyproject/loom' | head -1 | cut -f1)
test -n "$CANON"                           # abort if no canonical remote found
git fetch "$CANON" --tags
git merge-base --is-ancestor "$CANON/main" HEAD && git merge-base --is-ancestor HEAD "$CANON/main"  # local main == canonical main
LAST_TAG=$(git describe --tags --match 'v*' --abbrev=0)
LAST_DATE=$(git log -1 --format=%cs "$LAST_TAG")
CUR=$(node -p "require('./package.json').version")
```

## Phase 1 -- Generate highlights (the nice things)

Gather the merged PRs since the last tag. The **commit range is the source of truth**
for *which* PRs shipped -- the date search alone is wrong whenever two tags share a day
(it pulls in same-day PRs that were already in the earlier tag), and `gh pr list`
silently truncates at 30 without `--limit`:

```bash
# Authoritative PR set: merge commits since the last tag.
# Strip the "#" before sorting: BSD/macOS `sort -n` reads "#464" as 0, so every
# entry compares equal and `-u` collapses the whole list to one PR. That fails
# silently and looks like a quiet release -- v0.7.0 reported 1 PR against 107
# commits. Anchoring on "Merge pull request #" also drops the "Merge branch ..."
# commits, which carry no PR number.
git log "$LAST_TAG"..HEAD --merges --oneline \
  | grep -oE 'Merge pull request #[0-9]+' | grep -oE '[0-9]+' | sort -un
# Titles/authors/labels for those PRs (--limit: default is 30, which silently drops PRs):
gh pr list --repo galaxyproject/loom --state merged --base main --limit 200 \
  --search "merged:>=$LAST_DATE" --json number,title,author,labels,mergedAt
```

Cross-check the two: distill only PRs that appear in the commit range, using the gh
output for titles. Distill them into a `### Highlights` list per the **Editorial rules**
below -- this is judgment, you do it, not a regex. Then determine the target version: from the
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
(today = `date +%F`). If an `## [Unreleased]` block is there, turn it into this block and keep
its bullets alongside the approved ones -- the what's-new parser ignores `Unreleased`, so leaving
it in place silently drops those bullets from the release:

```markdown
## [0.4.0] - 2026-06-06

### Highlights

- <approved bullet>
- <approved bullet>
```

Then commit (do NOT tag yet):

`npm version` rewrites the version field in **both** `package.json` and
`package-lock.json`, so all four manifests go in the commit. Leaving the
lockfiles out tags a dirty tree whose published lockfile still claims the old
version:

```bash
git add package.json package-lock.json app/package.json app/package-lock.json CHANGELOG.md
git commit -m "release: v$NEW"
git --no-pager show --stat HEAD             # show what was committed
git status --porcelain                      # must be empty -- nothing left behind
```

Reversible: `git reset --hard HEAD~1` undoes everything so far.

## Phase 2.5 -- Pre-tag validation (catch the publish-npm landmine)

The `publish-npm` job installs **root deps only** (`npm ci`, no `app/` install), then
runs the `prepublishOnly` gate (`typecheck && test && smoke:pack`). If any **root**
test transitively imports an **app-only** module -- anything that pulls `electron` via
`app/src/main/...`, or app-only deps -- vite can't even resolve the bare specifier at
transform time and the whole suite fails to load. A normal local `npm test` does NOT
catch this, because you usually have `app/node_modules` installed too; that false
confidence has now sunk three releases (0.4.0 dompurify/marked, 0.5.0 electron).

So reproduce publish-npm faithfully before tagging -- root deps only, no app install:

```bash
# from a throwaway clone/checkout at the release commit (so app/node_modules is absent):
npm ci
npm run typecheck && npm test && npm run smoke:pack
```

Check `app/node_modules` is genuinely gone first. A worktree under
`.worktrees/` usually has it as a symlink into the root checkout, which makes
this test silently pass for the wrong reason -- the thing it exists to catch is
exactly "app deps present when publish-npm won't have them":

```bash
test -e app/node_modules && echo "NOT a faithful test -- remove the symlink first"
```

If it fails, the tag push will fail the same way and **nothing will publish** -- fix on
main and re-run. To also validate the Orbit build matrix (and any **brand-new installer
platform leg** -- whose `make` may never have actually run, since PR checks only do
typecheck/test), dry-run the installers with no publish and no tag:

```bash
gh workflow run release.yml --ref <branch>   # builds all legs; publish/publish-npm are tag-gated, so they're skipped
```

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

### If the run fails

First check whether `publish-npm` succeeded -- that determines recovery:

```bash
npm view @galaxyproject/loom@$NEW version 2>/dev/null   # empty/404 = NOT published
```

- **A build leg failed on flaky infra** (e.g. macOS `hdiutil detach -- No such file or
  directory` during DMG, a runner timeout) -- don't re-cut. Re-run just the failed jobs;
  this re-runs the failed leg and the `publish` job it gated, and leaves a succeeded
  `publish-npm` alone (so npm isn't republished):
  ```bash
  gh run rerun --failed "$RUN"
  ```
- **It failed before npm published** (prepublishOnly failed, or a build leg died before
  the `publish`/`publish-npm` jobs) and `npm view` shows nothing -- the version is clean
  to **reuse**: fix on main, then delete and re-cut the tag:
  ```bash
  git tag -d "v$NEW"; git push "$CANON" --delete "v$NEW"
  git tag "v$NEW"; git push "$CANON" "v$NEW"     # fires release.yml again
  ```
  Re-run Phase 2.5 on the new HEAD first. **Only if npm actually published** must you
  bump to a new version instead -- npm can't un-publish a version.

## Phase 4 -- Curated release body

The `publish` job makes a **draft** release with auto-generated "What's Changed". (If a
build leg failed, `publish` is skipped and there's no draft yet -- fix per Phase 3's
rerun guidance first.) Replace its body with the curated highlights ABOVE the auto notes
(same highlights from Phase 1). Build the body in a file and use `--notes-file` --
robust for large bodies where inline `--notes` with `printf` gets fragile:

```bash
gh release view "v$NEW" --repo galaxyproject/loom --json body -q .body > /tmp/auto.md
{ printf '## Highlights\n\n%s\n\n---\n\n' "$HIGHLIGHTS"; cat /tmp/auto.md; } > /tmp/body.md
gh release edit "v$NEW" --repo galaxyproject/loom --notes-file /tmp/body.md
```

If anything user-facing shifted late (e.g. an installer dropped to a portable `.zip`),
add a one-line note under the highlights so the download page sets the right expectation.

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

- **2-5 bullets, scaled to the release.** A patch release is 2-3; a big multi-feature release can run 5-6. User-facing benefit framing, present tense, concrete, no marketing. Group related PRs into one bullet.
- **Keep:** new features, new commands, user-visible fixes, new model/provider support, safety/security changes users care about, notable performance wins.
- **Drop:** CI/release-plumbing PRs, the `cut`/`bump X.Y.Z` PRs, dependency bumps (unless user-visible, e.g. "Opus 4.8 available"), pure internal refactors, docs-only and test-only PRs.
- **Voice:** casual, direct; plain hyphens, never a Unicode em-dash (restructure instead); name user-facing things (`/compact`, `loom update`), not PR numbers.
- **Always a draft:** highlights are public copy -- ALWAYS show them for human edit/approval before committing or publishing. Never publish generated copy unreviewed.

## Red flags -- STOP

- About to run the tag push or `--draft=false` without an explicit human "go" this turn -> STOP, show, wait.
- About to push to the fork (`origin` = your fork) instead of `$CANON` -> wrong remote.
- About to ship the auto-generated PR-title list as the release body -> that's the noise this skill replaces; curate first.
- Skipped `check-version-lockstep.mjs`, or bumped only one `package.json` -> CI will fail; fix before tagging.
- About to tag without the Phase 2.5 root-only dry-run -> the publish-npm gate can fail on a root test that imports app-only code, and a local `npm test` won't have caught it.
- CI failed but proceeding to promote -> never promote a failed build.
- Phase 1 reported a suspiciously small PR set (one or two PRs against a big commit range) -> the `sort -un` trap above; re-check before writing highlights from it.
- `git status` not empty after the release commit -> the lockfiles were left out; amend before tagging.
- Re-tagging after a *flaky* leg instead of `gh run rerun --failed` -> wasteful, and risks republish errors if npm already succeeded on the first attempt.

## Common mistakes

| Mistake | Fix |
|---|---|
| Push tag to the fork | Push to `$CANON` (detected as the galaxyproject/loom remote) |
| Versions out of lockstep | Bump both via `npm version ... --prefix app`; run the lockstep check |
| Raw commit list as notes | Distill per the editorial rules; curate the release body too |
| Promote before CI is green | Watch the run; only `--draft=false` after green + eyeball |
| Trusting a local `npm test` for publish-npm | It runs root-only; do the Phase 2.5 root-only dry-run -- a root test importing app/electron code passes locally but breaks publish-npm |
| `gh pr list` silently drops PRs | Pass `--limit 200`; use the commit range (`$LAST_TAG..HEAD --merges`) as the PR-set source of truth |
| Re-cutting after a flaky leg | `gh run rerun --failed "$RUN"` re-runs only the failed leg + `publish`; don't re-tag |
| Re-cut after a failed release | Reuse the tag (delete + re-push) **only if `npm view` shows the version never published**; if it did publish, bump -- npm can't un-publish |
