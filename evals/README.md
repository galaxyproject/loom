# Loom evals

Scenario-driven integration tests for Loom. Spawns `loom --mode json`
non-interactively against a fixture cwd, parses the JSON event stream,
asserts on tool calls / chat text / final notebook state.

```bash
npm run evals             # run all scenarios
npm run evals -- <name>   # run a single scenario by directory name
```

Scenarios live under `evals/scenarios/<name>/`. See `loom-evals` plan in
`~/work/brain/plans/` for the full design.

## Tier today

Phase 1 (this PR): runner plumbing + one Tier 1 scenario that exercises a
slash-command path which doesn't require an LLM call.

Phase 2 will add an LLM stub (subprocess Anthropic-API-compatible server)
and an MCP stub, unlocking deterministic scenarios that exercise the
agent loop.

## Known issue

Loom currently does not exit cleanly under `--mode json` after a single
slash-command invocation. The Galaxy poller's `setInterval` keeps the
event loop alive even when print mode finishes, so the runner has to
SIGTERM each scenario at its `timeoutMs`. Hard-fail scenarios (this
phase) emit all their events synchronously, so the runner-driven kill
doesn't lose data -- the assertions are evaluated against everything
that came out of the JSON stream before the timeout. Worth filing as a
Loom-side fix in print mode (galaxy poller should `unref()` its interval
or print mode should call `stopGalaxyPoller` on dispose).
