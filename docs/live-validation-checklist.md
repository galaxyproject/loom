# Live Validation Checklist

This checklist matches the notebook-only Loom runtime: `notebook.md` is the durable project record, Galaxy invocations are tracked with `loom-invocation` fenced blocks, and the old `analysis_*`, `data_*`, `research_*`, `publication_*`, and `workflow_*` plan-state tools are not present.

## Preconditions

- Node.js and npm available
- `uv` or `uvx` available for `galaxy-mcp`
- A working `pi` CLI installed
- Galaxy API key ready for the target server if testing Galaxy

## 1. Verify repo checks

From the repo root:

```bash
npm install
npm run typecheck
npm test
pi --version
```

Expected:

- `tsc --noEmit` passes
- Vitest passes
- `pi --version` reports the runtime being used for the live check

## 2. Load the extension in a clean Pi runtime

```bash
mkdir -p /tmp/loom-validation
cd /tmp/loom-validation
pi --no-extensions -e /Users/dannon/work/loom/extensions/loom
```

Check:

- startup completes without extension load errors
- `notebook.md` exists in the working directory
- `/status` shows Galaxy connection state and the notebook path
- `/notebook` opens the current notebook content
- `/connect` and `/profiles` are available

If the runtime exposes a tool listing, the Loom-owned tool surface should be small: GTN fetch/search, skills fetch, Galaxy invocation record/check tools, and any explicitly enabled experimental tools such as `team_dispatch` or session-index recall.

## 3. Validate notebook-first plan drafting

Prompt:

```text
Draft a plan for a small RNA-seq quality-control analysis in Galaxy.
```

Expected:

- the first plan appears in chat as a markdown draft, not immediately in `notebook.md`
- approving the draft asks for a parameter table before writing the notebook
- after parameter approval, the agent edits `notebook.md` directly with the approved plan section
- the notebook section uses checklist steps, routing tags, and stable anchors such as `{#plan-a-step-1}`

This approval flow is prompt-level discipline, not a runtime lock. If the agent writes too early, record it as a behavioral bug.

## 4. Validate Galaxy connection and invocation tracking

Inside the same session:

1. Run `/connect` or configure Galaxy credentials in Orbit Preferences.
2. Ask the agent to create or select a small test Galaxy history.
3. Ask it to run the smallest practical Galaxy action.
4. After the invocation returns, confirm the agent calls `galaxy_invocation_record`.
5. Poll with `galaxy_invocation_check_one` or `galaxy_invocation_check_all`.
6. Ask it to add a file that lives at a public URL (for example a small
   reference FASTA) to that history.

Expected:

- `notebook.md` contains a fenced `loom-invocation` block with `invocation_id`, `galaxy_server_url`, `notebook_anchor`, `label`, `submitted_at`, `status`, and `summary`
- polling transitions the block from `in_progress` to `completed` or `failed`
- the related markdown checklist item is updated after the status transition
- the URL-backed file is fetched server-side (via `galaxy_upload_file_from_url`, or a bioblend `put_url` call), not downloaded locally and re-uploaded

## 5. Validate restart and sidecars

Exit and restart in the same directory:

```bash
cd /tmp/loom-validation
pi --no-extensions -e /Users/dannon/work/loom/extensions/loom
```

Expected:

- the agent reads the existing `notebook.md`
- `/notebook` shows the prior content
- recent activity is available from `activity.jsonl`
- `session.jsonl` is a symlink only when Loom can create it without replacing a user-owned file

## 6. Inspect the analysis directory

Check:

- `notebook.md` is readable markdown
- `activity.jsonl` and `session.jsonl` are not committed by Loom-generated `.gitignore`
- in a directory where Loom initialized git, notebook edits are committed
- in an existing user repo, Loom does not auto-commit `notebook.md` onto the current branch

## 7. Record the validation result

Capture:

- Pi CLI version
- Galaxy server used
- whether notebook drafting and approval behaved correctly
- whether Galaxy credentials connected successfully
- whether invocation blocks were recorded and polled correctly
- whether restart resumed from the notebook and session sidecars safely
