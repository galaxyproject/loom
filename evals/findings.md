# Loom evals -- harness findings log

What we learned by iterating on the eval suite against the TACC SambaNova
matrix (Llama-3.3-70B, Llama-4-Maverick, Qwen3-32B). Useful both as a
record of why the suite is shaped the way it is, and as a starter list
for future runs.

## Loom-side bugs surfaced by the matrix

These are real product bugs the eval suite caught. Each shipped to the
branch as its own atomic commit.

### Routing-tag enum was missing `[galaxy]`

`extensions/loom/context.ts` -- the worked example showed
`## Plan A: <Title> [local|hybrid|remote]` and the conventions list said
"Routing tag: `[local]`, `[hybrid]`, or `[remote]`." But every other
piece of Loom (init-gate parser, AGENTS.md hard constraints, the
routing dispatch in execution-commands.ts) treats `galaxy` as a
first-class routing tag _and_ the primary execution path. Models trying
to follow the literal template had no syntactically valid way to say
`[galaxy]`. Visible symptom: every model in the matrix picked `[local]`
on every plan-creation scenario, regardless of how Galaxy-flavored the
request was.

Fix: list `[galaxy]` first in the example heading, expand the
conventions paragraph to spell out when each tag applies (galaxy as
default for matchable workflows, hybrid for mixed, local for ad-hoc).

### Abstract `<Title>` placeholders weren't grounding template-following

The plan-section template used `## Plan A: <Title> [<routing>]` with
each angle-bracket as a substitution placeholder, plus step lines like
`- [ ] 1. **<Step name>** -- <one-line purpose>`. Llama-3.3-70B in
particular kept dropping the letter and the routing tag and emitting
`## Plan: <title>` instead -- the abstract syntax wasn't strong enough
signal.

Fix: replace abstract placeholders with a concrete worked example
(`## Plan A: chrM Variant Calling [galaxy]` with three real steps and a
populated parameter table), and add an explicit positive/negative-example
list of what the heading line must look like.

Result: every Llama-3.3 notebook after the change uses
`## Plan A: <title> [<routing>]` correctly. Plan-creation pass rate
moved from 1/15 to 4/15 on this single change.

### `{#anchor}` syntax collided with litellm's Llama-4 tool-call detector

The plan-section template told the model to write step anchors like
`{#plan-a-step-1}`. Litellm's Llama-4 adapter on the SambaNova-on-TACC
proxy mistakes any `{...}` pattern in the model's chat output for a
tool-call boundary and tries to JSON-parse the contents. `{#plan-a-step-1}`
isn't valid JSON, so the proxy rejects the whole response with
"Invalid function calling output."

Visible symptom: Maverick failed every plan-creation eval with a
confused error wrapping its chat text. Took two false-trail
investigations (a SambaNova API replay-arguments bug surfaced via
litellm's source on GitHub; a Pi serialization patch that turned out
not to apply) before capturing the full Pi event stream surfaced the
real error message:

    JSONDecodeError: Expecting property name enclosed in double quotes
    when trying to decode function call string: {#plan-a-step-1}

First fix was a blunt drop: remove anchor guidance from the prompt
entirely. That worked for Maverick but cost Opus/Sonnet some
step-reference precision they'd been using fine. So the actual fix is
conditional: `setupContextInjection` reads `ctx.model` at session start
and passes `omitAnchors: true` to `buildPlanConventionBlock` only when
the model id matches `/llama-?4|maverick|scout/i`. Anthropic, OpenAI,
Google, Llama-3 et al. keep full anchor guidance; only the Llama-4
deployments that trip the proxy bug get the workaround. Init-gate
parser accepts anchors when present regardless of which prompt path
ran, so the suppression is fail-soft. Verified on the matrix: zero
"Invalid function calling" errors, 40+ `{#plan-...}` anchor
occurrences in Llama-3.3 + Qwen3 output, pass rate stable.

## Eval-side iterations

### Stripping `--no-skills --no-context-files` was the wrong default

Initial scenarios had `loomArgs: ["--tools", "read,write,edit",
"--no-skills", "--no-context-files"]` in the name of "isolating the
variable being tested." The flags were stripping Pi's AGENTS.md / skills
discovery, but Loom's hard-constraint guidance is injected via a
`before_agent_start` extension hook (`extensions/loom/context.ts`) --
not through Pi's discovery -- so most of the Loom system prompt was
always in play regardless. Even so, the framing was wrong: the eval
suite exists to measure how the harness _as it ships_ behaves on each
model and to iterate on Loom's prompts/skills based on what we learn.
Stripping context defeats that.

Fix: drop the strip flags and trim prompts to a naturalistic ask
("I have RNA-seq FASTQ files, help me draft a plan") instead of
hand-spelling the notebook conventions inside each prompt.

### chatPlan vs notebook.plan: protocol gate is too strict for the matrix

Loom's plan-convention block documents a four-stage approval gate
(chat draft -> approve -> param table -> approve -> notebook write).
Adding `chatPlan` (looking for the formal `## Plan A:` block in chat
text) plus `notebook.plan.exists: false` to enforce "no notebook write
before approval" produced 0/15 on the matrix, because no model in the
TACC matrix actually follows the documented gate. Qwen3 collapses to
two stages (clarify, then write), Llama-3.3 to one stage (write
immediately on turn 1). Forcing the eval to enforce a protocol the
matrix won't follow is a stuck-loop.

Fix: relax to "by end of run, a structurally valid plan exists in the
notebook (the durable record)." This is what end-user UX actually
wants. The `chatPlan` primitive stays in the assertion library for
future scenarios that explicitly want to test the gate (e.g. a "model
paused for approval before writing" check).

### Sub-bullet descriptions need to count

`eachStepHasDescription` originally only counted text on the step's
main line after stripping number/title/anchor. Some models put
descriptive content (`Routing: <x>`, `Tool: <y>`) in indented
sub-bullets and leave the main line as just `**Title**`. Parser saw
descriptionLength=0 and failed the heuristic.

Fix: fold immediate sub-bullet text into the description measurement.

## Per-model behavioral observations

(From the latest matrix run, with caveats: single runs are noisy, and
Maverick especially shows nondeterminism on tool-call format.)

|                  | Plan-creation pass | Notable behavior                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Qwen3-32B        | 4-5 / 5            | Most consistent. Rich plans with parameter tables. Honors Galaxy routing more than the Llamas. Sometimes paraphrases instead of formal-block on turn 1, then writes properly on turn 2. Occasional hallucinated Galaxy toolshed URLs (caught in galaxy harness with LLMJudge, not by us).                                                                                                     |
| Llama-3.3-70B    | 2 / 5              | Writes to notebook on turn 1 (skips chat-draft stage). Defaults to `[local]` routing despite Galaxy-first guidance in the prompt. Heading format now correct after the worked-example fix.                                                                                                                                                                                                    |
| Llama-4-Maverick | 3 / 5              | Highest variance run-to-run. Mostly correct format when it does write; failures are nondeterministic "drafted in chat, never invoked write tool" -- not a fundamental limit. A direct re-run of one of the eval-runner failures (pharmacogenomics) produced a perfect 5-step plan. n=3 median scoring (Phase 6) will smooth this out; today's single-run snapshot under-represents the model. |

## What the eval is good at, and what it isn't

**Good at:**

- Catching Loom-side prompt regressions (any of the three above bugs would have shown up immediately).
- Per-model leaderboard for _shell contract compliance_ -- "did the agent honor our notebook conventions when asked for a plan."
- Spotting upstream proxy/model issues (the litellm Llama-4 adapter bug surfaced cleanly).

**Not good at, by design:**

- Content quality scoring. No LLMJudge. The galaxy harness handles that
  (`/Users/dannon/work/galaxy__worktrees/agent-evals-harness/`); duplicating
  it here would mean re-implementing pydantic-evals in TypeScript.
- Catching subtle regressions in Loom's _non-prompt_ code paths (init-gate,
  notebook-writer, session-lifecycle). Those need their own scenarios that
  exercise the slash commands and the lifecycle hooks directly.
- Single-run reliability. Real comparison needs n>=3 runs per (scenario,
  model) tuple with median scoring. Phase 6 in the plan covers this.

## Suggested next iterations

1. **n=3 median runs (Phase 6 of the plan).** TACC is free; we just need a
   `--repeat N` flag in the runner that aggregates results per
   (scenario, model) tuple. Maverick's run-to-run variance is the strongest
   single argument for this -- single-run scoring under-represents it
   meaningfully.
2. **Shell-contract scenarios that don't ride the matrix.** Init-gate
   variants (no plan, weak step), confusables hint (#102), notebook
   discipline (does the agent flip `- [ ]` to `- [x]` after completion).
   These exercise Loom-the-shell rather than model behavior, complement
   the model leaderboard.
3. **Markdown report with per-(scenario, model) detail.** Today's stdout
   tells you pass/fail counts but burying the comparative content in
   `LOOM_EVALS_VERBOSE` is fragile. A report file written under
   `evals/results/` (gitignored, with a committed `baseline.md`) gives a
   real artifact to diff between runs.
4. **Once init-gate.ts (#104) is on main, replace the stub
   evals/lib/notebook-parser.ts with a direct import.** Less duplication.
5. **Llama-3.3 protocol-following.** It writes to notebook on turn 1
   (skipping chat-draft) and picks `[local]` routing despite the
   Galaxy-first prompt. Worth a focused prompt-tightening cycle if we
   want it to score above 2/5.
