# CLAUDE.md

Repo-local orientation for Claude Code and similar agents.

## Read first

1. [`AGENTS.md`](AGENTS.md) and [`docs/agent/`](docs/agent/)
   Primary repo behavior and domain guidance. `AGENTS.md` is the slim router (hard constraints + pointers); topic docs under `docs/agent/` cover role, notebook schema, Galaxy routing, commands, and gotchas. This is the main instruction source for how to operate in this codebase.

2. [`docs/architecture.md`](docs/architecture.md)
   Canonical architecture reference for Loom, Orbit, shared contracts, session lifecycle, and future shell direction.

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

- Keep the Loom brain shell-neutral. Orbit/web-specific behavior belongs in shells, not in `extensions/loom/`.
- Shared cross-boundary contracts belong in `shared/`, not in duplicated ad hoc payload logic.
- Galaxy is the primary execution path. Local mode is an exception path, not the main runtime model.
- Startup/restore behavior belongs in `extensions/loom/session-bootstrap.ts`.
- `/review`, `/test`, `/execute`, and `/run` are brain-owned command semantics in `extensions/loom/execution-commands.ts`.
- Orbit should stay a shell, not a second brain.

## Validation bias

- Prefer validating root tests plus app typecheck after architectural changes.
- When changing shell contracts or startup/session behavior, verify both the extension side and the Orbit side.
