# Terminal Validation

Runbook for validating Loom's CLI/runtime path without launching the Orbit shell.

The current product model: `notebook.md` in the working directory is the durable project record. Plans, decisions, and results live there as markdown sections. Galaxy invocations are tracked with `loom-invocation` fenced YAML blocks the agent rewrites in place. There are no typed plan / step / decision tools to validate; the validation is "the markdown round-trips and the agent can read its own work back".

## 1. Local checks

From the repo root:

```bash
npm install
npm run typecheck
npm test
cd app && npx tsc --noEmit
```

Expected:

- root typecheck passes
- vitest passes (full suite)
- Orbit typecheck passes too -- Orbit's main process uses several brain-side modules and breaks if their types drift

## 2. Extension-only runtime check

Load the Loom extension into a clean Pi process with no other extensions:

```bash
mkdir -p /tmp/loom-validation
cd /tmp/loom-validation
pi --no-extensions -e /path/to/loom/extensions/loom
```

Check:

- startup completes without extension load errors
- `notebook.md` is created in cwd if absent
- the slash commands respond:
  - `/status` -- Galaxy connection + notebook path
  - `/notebook` -- prints the notebook content
  - `/profiles` -- lists saved Galaxy profiles
  - `/connect` -- profile picker / new-server prompt
  - `/execute`, `/run` -- "no pending step" message when the notebook is empty

This isolates extension behavior from the `loom` CLI wrapper.

## 3. CLI wrapper check

Use a clean working directory:

```bash
mkdir -p /tmp/loom-cli-validation
cd /tmp/loom-cli-validation
node /path/to/loom/bin/loom.js --provider anthropic --model claude-sonnet-4-6
```

Notes:

- `loom` writes Galaxy MCP configuration into `~/.pi/agent/mcp.json` during startup. With no Galaxy credentials available, it strips the `galaxy` server entry instead of writing a placeholder key.
- Informational wrapper commands are side-effect free: `loom --help`, `loom --version`, `loom --list-models` should not rewrite MCP config.

Check:

- startup completes
- if Galaxy credentials are present, `/status` reports the active profile and URL
- if no credentials, `/status` says "Galaxy: not connected" and `/connect` walks through profile setup

## 4. Notebook round-trip

In the same working directory:

1. Ask the agent for a small analysis plan.
2. Approve it. Confirm the plan section appears in `notebook.md` as `## Plan A: …`.
3. Exit the session.
4. Restart `loom` (or `pi --no-extensions -e …`) in the same directory.

Expected:

- session resumes with the existing notebook attached
- `/notebook` prints the same content
- `git log` (in the cwd) shows commits for the notebook initialization and any plan additions, **iff** the repo was created by Loom or has `git config loom.managed true`. Otherwise the notebook still updates but auto-commit stays off.

## 5. Minimal Galaxy flow

If a Galaxy server with credentials is available, run an end-to-end Galaxy step:

1. `/connect` and pick a profile (or add a new server).
2. Ask the agent to draft a one-step plan that uses a Galaxy tool you trust (FastQC on a small dataset is the usual smoke test).
3. Approve the plan and the parameter table.
4. Let the agent invoke the tool.

Expected in the notebook after invocation:

- a plan section with the routing tag (`[hybrid]` or `[remote]`)
- a `loom-invocation` fenced block referencing the step anchor
- after the agent calls `galaxy_invocation_check_all` (or `/run`), the YAML status updates from `in_progress` to `completed` (or `failed`) and the matching checkbox flips

That round-trip is the strongest signal that the notebook-as-state model is intact: the agent reads its own previous work, polls Galaxy, and rewrites the durable record without any external state store.
