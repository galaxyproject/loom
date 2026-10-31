# CLAUDE.md

Repo-local orientation for Claude Code and similar agents.

## Read first

1. [`AGENTS.md`](AGENTS.md) and [`docs/agent/`](docs/agent/)
   Primary repo behavior and domain guidance. `AGENTS.md` is the slim router (hard constraints + pointers); topic docs under `docs/agent/` cover role, notebook schema, Galaxy routing, commands, and gotchas. This is the main instruction source for how to operate in this codebase.

2. [`docs/architecture.md`](docs/architecture.md)
   Canonical architecture reference for the Orbit core, its shells, shared contracts, session lifecycle, and future shell direction.

3. [`README.md`](README.md)
   Product/runtime overview, install/usage notes, and current-state summary.

## What this file is for

This file is intentionally thin. It should only capture repo-local developer guidance that is useful while editing code.

## Development commands

```bash
# Install dependencies (root + Orbit)
npm install
cd app && npm install

# Run tests
npm test
npx vitest run path/to/test

# Type checks
npm run typecheck
cd app && npx tsc --noEmit

# Start Orbit
cd app && npm start
```

## Repo-local conventions

- Keep the Orbit core shell-neutral. Desktop/web-specific behavior belongs in shells, not in `extensions/orbit/`.
- Shared cross-boundary contracts belong in `shared/`, not in duplicated ad hoc payload logic.
- Galaxy is the primary execution path. Local mode is an exception path, not the main runtime model.
- Startup/shutdown/restore behavior belongs in `extensions/orbit/session-lifecycle.ts`.
- `/execute` and `/run` are brain-owned command semantics in `extensions/orbit/execution-commands.ts`.
- The desktop app should stay a shell, not a second brain.
- One brain, many shells applies to the browser shell (`browser/`) too, and that is where it is
  most at risk right now. `browser/core/src/agent/` is the browser's own agent on pi-durable, with
  its own prompt, tools and guards: an interim copy of the brain that Orbit's brain is replacing.
  Once the worker boots Orbit's brain, the duplicated brain modules there are deleted; the worker,
  `pi-host.ts`, storage and the other shell support stay. Fix bugs there when you have to, but
  put new brain behavior (prompt text, guards, Galaxy tool handling, notebook and record semantics)
  in `extensions/orbit/` and `shared/`. If the browser needs something Orbit lacks, add it to Orbit
  and let the browser pick it up; browser-only behavior goes on top of Orbit's, not in place of it.
- A shell says what it can do through the capability profile (`shared/capability-profile.js`),
  and swaps storage or tools through the brain's seams (`galaxy-tool-source.ts`,
  `record-store-seam.ts`, `provenance-fs.ts`), not by forking brain code. `pi-host.orbit.test.ts`
  boots `extensions/orbit` on the browser's host under Node and pins, in `pi-host.orbit.golden.json`,
  the Node reaches it observes and the import edges it scans for; a brain change that adds one of
  those shows up there.
- `extensions/orbit/vendor/` is generated from `galaxyproject/agentic-plugins` at the commit pinned
  in `scripts/skills.manifest.json`. Change the manifest and run `npm run sync:skills`; never
  hand-edit the vendored files. `npm run check:skills` is the CI drift gate. The browser shell
  copies its galaxy-skills corpus from the same tree (`browser/core/scripts/install_skills.js`), so
  a manifest bump moves both shells; rebuild the browser and commit its `core/skills.lock.json`.
  Orbit's system-prompt goldens carry the skills catalog too, so a bump that changes a description
  also needs `npx vitest run -u tests/system-prompt-surface.test.ts`.
- Staging skills -- ones Orbit needs before they have a permanent home upstream -- live in `skills/`
  (the `orbit` repo to `skills_fetch`). Each names its destination in `metadata.proposed_home`. They are
  vendored into the same tree by the same sync -- edit them there, never in `vendor/`, then re-sync.
  `skills/README.md` has the authoring rules and how a skill moves upstream. The browser shell does
  not pick them up yet.

## Validation bias

- Prefer validating root tests plus app typecheck after architectural changes.
- When changing shell contracts or startup/session behavior, verify both the extension side and the Orbit side.
- Renderer, status-surface, or shell-event changes need an actual look, not just green tests. `docs/browser-validation.md` covers driving the web shell (same renderer, scriptable) with `agent-browser` -- including how to force a failure path and how to point it at a real model.
