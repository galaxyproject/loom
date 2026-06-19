# Loom evals

Scenario-driven integration tests for Loom. Spawns `loom --mode json`
non-interactively against a fixture cwd, parses the JSON event stream,
asserts on tool calls / chat text / final notebook state.

```bash
npm run evals                          # all scenarios x all available models
npm run evals -- <scenario>            # filter to one scenario directory
npm run evals -- --model <id>          # filter to one model id (or comma list)
npm run evals -- <scenario> --model <id>
```

Scenarios live under `evals/scenarios/<name>/`. The model matrix lives in
`evals/models.json`. `evals/findings.md` records what the suite has
turned up so far -- both Loom-side bugs the matrix surfaced and
per-model behavioral observations.

## Models

Tier 2 scenarios (those with `requiresModel: true`) run against every model
in `evals/models.json` whose required env vars are set; the rest are skipped
with a warning. Missing env vars don't fail the run -- they just shrink the
matrix. Tier 1 scenarios that exercise synchronous Loom paths (slash-command
preflight, etc.) run once with no model.

Drop credentials in `evals/.env` (gitignored). Example contents:

```
PROXY_URL=https://ai.tejas.tacc.utexas.edu/v1
PROXY_API_KEY=<your-key>
```

(Variable names match `~/work/tacc-inference/.env` so symlinking that file
straight in works: `ln -s ~/work/tacc-inference/.env evals/.env`.)

## Dimensions and the leaderboard

Tier 2 scenarios are graded on up to four decision-correctness dimensions.
Every assertion failure carries a `dimension`, and the runner aggregates a
per-model leaderboard from them:

- **validity** -- a well-formed `## Plan X: <title> [routing]` block with
  enough described steps. The gate: a model that can't emit a parseable plan
  fails everything downstream.
- **routing** -- did the plan pick the correct routing tag? Scenarios set
  `plan.routingIn` to the _correct_ answer(s) (e.g. metagenomics -> `[galaxy,
hybrid]`, consumer pharmacogenomics -> `[local, hybrid]`), so an incorrect
  route is graded as wrong rather than waved through.
- **tools** -- did the plan name a sane analysis tool? `plan.mentionsOneOf`
  is a curated, generous allow-set per assay (a coarse heuristic, not an
  oracle; nuance is left to a future judge layer).
- **behavior** -- Loom-contract checks that need no Galaxy. Today:
  `behavior.asksClarifyingQuestion` -- an underspecified prompt should make
  the agent ask, not fabricate a plan.

Plans are read from wherever they land (`plan.source` defaults to `"any"` =
notebook if it has a plan, else chat), because the matrix models don't
reliably follow Loom's draft-in-chat-then-write gate.

Each (scenario, model) cell runs **n=3** times by default (`scenario.runs`
overrides; Tier 1 runs once). A dimension's cell verdict is a majority of the
runs (`pass >= ceil(total/2)`), so a flaky model shows as a pass-rate rather
than a coin-flip. The runner prints a `model x dimension` leaderboard grid
and writes one JSON line per run to `evals/results/<date>-<sha>.jsonl`
(gitignored) for diffing models over time and across Loom prompt changes.

## Model matrix

`evals/models.json` is the 7-model TACC matrix (all on the one SambaNova
proxy): MiniMax-M2.7, gpt-oss-120b, Qwen3-32B, Llama-3.3-70B,
Llama-4-Maverick, Llama-3.1-8B, gemma-4-31B. gpt-oss-120b is flagged
`reasoningModel` (its chain-of-thought lands in `reasoning_content`; see the
findings log for the live caveat). To add a paid reference baseline
(Anthropic/OpenAI/Google), append an entry with that provider and the right
`envRequires` -- the matrix design makes it a one-line config change.

## Out of scope (for now)

LLM-judge plan-_quality_ scoring (the same scenarios with a rubric pass),
end-to-end execution against a recorded/live Galaxy MCP, and notebook
discipline / session-lifecycle scenarios. The assertion library leaves seams
for each. See the plan for sequencing.

## Known issue

Loom does not exit cleanly under `--mode json` after a single slash-command
invocation -- the Galaxy poller's `setInterval` keeps the event loop alive
even when print mode finishes. The runner SIGTERMs each scenario at its
`timeoutMs`, so this doesn't break evals, but it bloats wall-clock and is
worth fixing Loom-side (either `unref()` the poller's timer or wire
`stopGalaxyPoller` into print-mode dispose). Scenarios with no Galaxy
configured (smoke-echo, plan-creation) exit cleanly in ~2s, so this only
bites Galaxy-connected scenarios.

## Known issue

Loom does not exit cleanly under `--mode json` after a single slash-command
invocation -- the Galaxy poller's `setInterval` keeps the event loop alive
even when print mode finishes. The runner SIGTERMs each scenario at its
`timeoutMs`, so this doesn't break evals, but it bloats wall-clock and is
worth fixing Loom-side (either `unref()` the poller's timer or wire
`stopGalaxyPoller` into print-mode dispose).
