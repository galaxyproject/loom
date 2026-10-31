# Orbit evals

Scenario-driven integration tests for Orbit. Spawns `orbit --mode json`
non-interactively against a fixture cwd, parses the JSON event stream,
asserts on tool calls / chat text / final notebook state.

```bash
npm run evals                          # all scenarios x all available models
npm run evals -- <scenario>            # filter to one scenario directory
npm run evals -- --model <id>          # filter to one model id (or comma list)
npm run evals -- <scenario> --model <id>
npm run evals -- galaxy-tools,execution-after  # comma list of names or prefixes
npm run evals -- --runs 1 --tag minimax  # override n; tag the results file
```

Run one process per model with distinct `--tag`s to sweep the matrix in
parallel: each model has its own TACC rate limit, and untagged runs on the
same commit write the same results file.

Scenarios live under `evals/scenarios/<name>/`. The model matrix lives in
`evals/models.json`. `evals/findings.md` records what the suite has
turned up so far -- both Orbit-side bugs the matrix surfaced and
per-model behavioral observations.

## Models

Tier 2 scenarios (those with `requiresModel: true`) run against every model
in `evals/models.json` whose required env vars are set; the rest are skipped
with a warning. Missing env vars don't fail the run -- they just shrink the
matrix. Tier 1 scenarios that exercise synchronous Orbit paths (slash-command
preflight, etc.) run once with no model.

Drop credentials in `evals/.env` (gitignored). Example contents:

```
PROXY_URL=https://ai.tejas.tacc.utexas.edu/v1
PROXY_API_KEY=<your-key>
```

(Variable names match `~/work/tacc-inference/.env` so symlinking that file
straight in works: `ln -s ~/work/tacc-inference/.env evals/.env`.)

Scenarios marked `requiresGalaxy: true` call the Galaxy tools and need a real
server. Add `GALAXY_URL` and `GALAXY_API_KEY` (a test.galaxyproject.org account
is the safe choice) to `evals/.env` to run them; without both, the runner skips
them with a warning rather than grading a Galaxy that was never configured.

## Live Galaxy tool mechanics (`galaxy-tools-*`)

The `galaxy-tools-*` scenarios drive a real model against a real Galaxy
(test.galaxyproject.org is the intended target) to check the in-process tool
plumbing rather than model judgment: that galaxy-ops' operations resolve under
their bare names, that `upload_file` stays hidden in favor of Orbit's
uploader, that an oversized result is saved and readable with
`galaxy_read_output`, that the destructive-delete and SRA fan-out gates fire on
the bare calls, and that a real tool run lands as a `orbit-job` block the
poller follows to completion. They are slow (minutes per run), depend on a
shared public server and its queue, and need both model and Galaxy
credentials -- run them by hand when touching the Galaxy tool layer, not as a
per-commit gate:

```bash
npm run evals -- galaxy-tools --model tacc:minimax-m2.7 --galaxy-cleanup
```

A scenario filter that isn't an exact directory name matches as a prefix,
which is what selects the whole family.

These scenarios create histories. Each one names them
`orbit-eval-<scenario>-{{RUN_ID}}`; the runner replaces `{{RUN_ID}}` in a
scenario's inputs with a fresh per-run token. `--galaxy-cleanup` (opt-in)
purges, after the run, every history whose name starts with `orbit-eval-` (or
`loom-eval-`, what runs from before the rename used) AND contains one of the
run ids this invocation handed out -- so it never touches a history without
the prefix, nor one from a concurrent eval run on the same account. A run
killed before it finishes skips cleanup; look for leftover `orbit-eval-*` and
`loom-eval-*` histories by hand.

`toolResults` assertions look at what a tool _returned_ (`tool_execution_end`)
rather than what was called: `mustSucceed` (optionally matching
`details`/text), `mustNotSucceed`, and `echoedInChat`, which pulls a value out
of a result with a regex and requires the chat to repeat it -- grading an
answer against the live server without committing an account-specific value.
Set `ORBIT_EVAL_DUMP_DIR` to keep each run's raw event stream, stderr,
notebook and activity log for diagnosis (they include tool results verbatim,
so point it outside the repo), and `ORBIT_EVALS_VERBOSE` to print each failing
run's notebook and the tail of its output. The older `LOOM_` spellings of both
still work.

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
- **behavior** -- Orbit-contract checks that need no Galaxy. Today:
  `behavior.asksClarifyingQuestion` -- an underspecified prompt should make
  the agent ask, not fabricate a plan.

Plans are read from wherever they land (`plan.source` defaults to `"any"` =
notebook if it has a plan, else chat), because the matrix models don't
reliably follow Orbit's draft-in-chat-then-write gate.

## Asserting on the activity log

`assertions.activity` matches rows of the `activity.jsonl` the run wrote
beside its notebook -- `{ kind, source?, payloadContains? }` per entry,
plus `mustNotIncludeKinds` and `ordered` (`{ before, after }`: no row matching
`after` may come before the first row matching `before`). This is the surface for anything the harness
decides rather than the model: gate adjudications, overrides, poller
transitions. It matters most in Tier 1, where there is no model, no
assistant text, and no tool call to look at: `--mode json` attaches no
UI, so `ctx.ui.notify` is a no-op and a synchronous command that records
a decision leaves no other trace.

Each (scenario, model) cell runs **n=3** times by default (`scenario.runs`
overrides; Tier 1 runs once). A dimension's cell verdict is a majority of the
runs (`pass >= ceil(total/2)`), so a flaky model shows as a pass-rate rather
than a coin-flip. The runner prints a `model x dimension` leaderboard grid
and writes one JSON line per run to `evals/results/<date>-<sha>.jsonl`
(gitignored) for diffing models over time and across Orbit prompt changes.

Each run's `usage` is summed over every model call it made (pi emits one
`turn_end` per call, with the usage on `turn_end.message.usage`): `calls`,
`errors` (calls that ended in an error or abort, such as a provider 429),
`input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, and `cost`. The
report prints it under each run and as a per-model token table, so a prompt or
tool change can be judged on cost as well as pass rate. `input` is pi's
uncached input, so prompt size shows up across `input`, `cacheRead`, and
`cacheWrite` together. Cost uses pi's per-model prices, which are 0 for the
TACC matrix, so only the token counts mean anything there.

## Model matrix

`evals/models.json` is the 5-model TACC matrix (all on the one SambaNova
proxy): MiniMax-M2.7, DeepSeek-V3.2, Qwen3-235B-A22B, gpt-oss-120b,
gemma-4-31B. Mistral-Large-3 is left out because the proxy rejects its tool
calls. Llama-4-Maverick and Llama-3.3-70B were dropped after the 2026-10-17
local sweep: Maverick's tool calls come back as raw `<|python_start|>` text the
proxy never parses, and Llama-3.3 can't finish a multi-turn approval flow; Qwen3-32B's 32K window overflows on Orbit's prompt. No entry sets `reasoningModel`, so
every run records `reasoning: false`; gpt-oss-120b used to carry the flag (its
chain-of-thought lands in `reasoning_content`; see the findings log). To add a
paid reference baseline
(Anthropic/OpenAI/Google), append an entry with that provider and the right
`envRequires` -- the matrix design makes it a one-line config change.

## Replaying submissions (Tier 1, no model)

The submission-capture hook fires on `tool_execution_end`, which needs a real
tool call, which needs a model turn -- and the Tier 1 scenarios are
deliberately model-free. `ORBIT_SUBMISSION_REPLAY` bridges that: it names a
JSONL file, relative to the scenario's cwd, whose lines are recorded Galaxy
tool results, and each is fed through the same dispatch path a live submission
takes. One line per submission:

```json
{
  "tool": "run_tool",
  "args": { "tool_id": "fastp" },
  "stepAnchor": "plan-a-step-1",
  "result": { "content": [{ "type": "text", "text": "<the GalaxyResult envelope as JSON>" }] }
}
```

The fixtures under `scenarios/submission-capture-*/cwd/submissions.jsonl` are
the `GalaxyResult` envelope shapes galaxy-mcp 1.9.0 returned, read out of its
source; galaxy-ops answers with the same envelope. `result` is a pi tool
result, so the envelope sits in a text content block. A `tool` the shell no
longer offers is logged as `submission.unparsed`, not recorded.

The seam is off unless the variable is set, the file must resolve inside the
session directory, and every replay writes a `submission.replay` activity row
first -- a notebook produced this way carries provenance claiming
`submitted_by: harness`, and that row is what keeps it distinguishable from one
produced by real submissions.

## Replaying tool results into the lesson matcher (Tier 1, no model)

`ORBIT_LESSON_REPLAY` is the same seam for the lesson hint, which fires on
`tool_result` and so has the same model-turn problem. It reads the same JSONL
format, resolves inside the session directory the same way, writes a
`lesson.replay` activity row before anything else, and prints the hint each
replayed result would have carried to stderr.

The scenario also has to plant the lesson it expects to fire, and the runner
points `HOME` at a temp dir fixtures cannot reach, so `ORBIT_LESSONS_DIR`
replaces the user-local lessons directory with one inside the scenario's `cwd/`.
Lessons read from it are validated and wrapped exactly like `~/.orbit/lessons`.

## A scripted model (Tier 1, no real model)

The replay seams hand one hook a recorded result. Some things can only be
seen with a model in the loop -- the evidence gate judges a model's edit to
the notebook, and the deny that counts is the one pi's own `tool_call` path
honours, after every other handler and the exec-guard have had their say.
`ORBIT_MODEL_SCRIPT` puts pi's faux provider in for the model and tells it
exactly what to say. It names a JSONL file, one model turn per line, in the
order the model would make them:

```json
{"tool": "galaxy_invocation_check_all", "input": {}, "text": "Checking the run first."}
{"tool": "edit", "input": {"path": "notebook.md", "edits": [{"oldText": "- [ ] 1.", "newText": "- [x] 1."}]}}
{"text": "Step 1 is verified."}
```

A tool line ends its turn with `toolUse`, so pi runs the call and asks for the
next line; a text line ends the prompt. A script that runs out answers every
later turn with nothing, which ends the prompt cleanly. Lines that aren't a
turn are skipped and counted. The scenario's `inputs` need a plain prompt (not
only slash commands) for a turn to happen at all.

Same rules as the replay seams: off unless the variable is set, the file must
resolve inside the session directory, and a `model.script` activity row
(`file`, `entries`, `skipped`, and `rejected` if the file was refused) is
written before the first turn. The file is read once per process, at the
first session start, through one descriptor on a regular file (a symlink
swapped in after the check, or a named pipe, is refused), so nothing the
session does -- including `/new` or a resume -- can add lines to it. And when
the variable is set the scripted model stays selected: it is selected even if
the file was refused, selected again if anything picks another model
(`model.script.reselected`), and any request that still reaches a real
provider is aborted and logged (`model.script.blocked`). `team_dispatch`,
which calls a model directly, refuses to run.

Nothing in the script is trusted: it is the model. Combine it with
`ORBIT_SUBMISSION_REPLAY` and `ORBIT_GALAXY_FIXTURE` to give the scripted model a
recorded run to verify; the `gate-scripted-*` scenarios do that to produce the
`evidence.decision` rows `docs/evidence-gate-audit.md` adjudicates.

## Out of scope (for now)

LLM-judge plan-_quality_ scoring (the same scenarios with a rubric pass),
full analyses executed end to end against a live Galaxy (the `galaxy-tools-*`
scenarios cover the tool mechanics, not analysis outcomes), and notebook
discipline / session-lifecycle scenarios. The assertion library leaves seams
for each. See the plan for sequencing.

## Poller exit (fixed)

`--mode json` runs used to sit until the runner's `timeoutMs` SIGTERM: the
Galaxy poller's `setInterval` keeps the event loop alive, and print mode has
nothing else holding it. `session_shutdown` clears the timer, so this only
bit runs where shutdown didn't get there first -- but the timer is now
`unref()`ed as well, which takes the poller out of the exit path entirely.
Interactive and Orbit sessions are held open by stdin, so nothing changes for
them.

The flip side is that a run can quit before the poller's next 15 s tick, so a
job that finished just after the model's last reply never logs its
`poll.transition`. A scenario that asserts on one sets
`ORBIT_EVAL_POLLER_DRAIN_MS` (galaxy-tools-job-capture uses 120000): on a `quit`
shutdown the session then keeps ticking, with auto-resume off, until nothing is
in flight or the bound passes. Unset, and on reload or a new session, nothing
waits.

## Seeded proposal ids

Proposal ids are random, and a scenario's inputs are fixed before the run
starts, so `/approve <id>` can't name one. `ORBIT_EVAL_PROPOSAL_IDS` (comma
separated, each a valid `prop-xxxxxx`) makes `loom_propose` mint those ids in
order before falling back to random ones, and each seeded mint logs a
`proposal.id_seeded` row so a seeded run is always identifiable. The
`execution-after-approval-tools` scenario asserts only that `run_tool` is
called. Two twins seed `prop-eva001` and check the approval itself:
`execution-after-slash-approve-tools` types `/approve prop-eva001 --yes`
(json mode has no dialog, hence `--yes`), and
`execution-after-chat-approve-tools` approves in plain chat with
`ORBIT_EVAL_CHAT_APPROVAL=1`, so that approval stands in for `--yes` where json
mode has no dialog (outside an eval it never does). Each asserts the
`proposal.approved` row with its own `confirmed_by` (`"--yes"` for the slash
twin, `"chat"` for the chat one). Both use
`activity.ordered` to fail a run whose `run_tool` call (its `tool.start` row)
came before the `proposal.approved` row, since approval does not yet block
submission.

## Asserting the target history

A run can pass every other check while its job lands in the wrong history:
a model that trips the cross-history guard can satisfy it by moving the job
to wherever its inputs live, and a live run once passed the slash twin with
its job in "Orbit demo" rather than the `hist1` its prompt named. History ids
differ per server, so a scenario can't pin one. `toolCalls.inHistory` names
the history instead:

```json
"toolCalls": { "inHistory": [{ "name": "run_tool", "history": "hist1" }] }
```

At run start, before spawning anything, the runner looks each named history
up on `GALAXY_URL` with `GALAXY_API_KEY`, and every call to `name` must then
carry that id in its `history_id` (`arg` names a different argument). A name
that matches no live history, or more than one, fails the run without
spawning it, as does a failed lookup, and the failure says why. With no call
at all the check passes; `mustInclude` is what requires one. The execution
scenarios and `execution-unprompted-run-needs-proposal` use it, so the account
they run on needs exactly one history named `hist1` with a dataset in it.
