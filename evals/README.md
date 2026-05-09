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
`evals/models.json`. See the `loom-evals` plan in your brain vault for the
full design.

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

## Tier today

Phase 2: matrix runner + TACC-only Tier 2 (Llama-3.3-70B, Llama-4-Maverick,
Qwen3-32B). One smoke-test scenario verifies the matrix wiring end-to-end.

Phase 3+ fills out the scenario set (init-gate variants, plan navigation,
notebook discipline, confusables hint, session lifecycle), with Tier 2
scenarios automatically running across the matrix. See the plan for the
full sequencing.

## Known issue

Loom does not exit cleanly under `--mode json` after a single slash-command
invocation -- the Galaxy poller's `setInterval` keeps the event loop alive
even when print mode finishes. The runner SIGTERMs each scenario at its
`timeoutMs`, so this doesn't break evals, but it bloats wall-clock and is
worth fixing Loom-side (either `unref()` the poller's timer or wire
`stopGalaxyPoller` into print-mode dispose).
