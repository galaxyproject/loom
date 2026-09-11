# evidence-gate-in-progress-contradiction

Tier 1. The fixture notebook is the shape the evidence gate exists for: plan
step 1 is marked `- [x]` while the `loom-invocation` block bound to its anchor
still reads `status: in_progress`. That status is written by the poller from
Galaxy job state, so a completion sitting on top of it is a verified result
claimed for a run Galaxy says has not finished.

The scenario drives `/override plan-a-step-1 <reason>`, which resolves that
binding out of the notebook and records an `evidence.override` row carrying the
step key, the checkbox state it found, the invocation id and status at the time,
the gate's mode, and the reason. Asserting on that row pins the gate's anchor
binding, its contradiction predicate, and `warn` as the shipped default, with no
model in the loop. Step 2 has no bound invocation and must come out of the run
untouched -- the gate has no opinion about a step it is not holding, and neither
does the override.

## Why it goes through `/override` and not through a notebook write

The gate itself hangs off the `tool_call` hook, so the write path needs the
agent to call `edit`/`write` -- which needs a model. This harness's Tier 1 lane
is model-free by construction, and there is no way to script a bare tool call
into `loom --mode json`; the only synchronous surfaces are slash commands. So
the write-hook half of the gate (flip detection, pre-image reading, deny/warn
modes, the override being spent) is covered by unit tests in
`tests/evidence-gate.test.ts` and `tests/evidence-gate-override.test.ts`, which
drive the real hook end to end against a temp notebook. What this scenario adds
on top is that the same predicate works in a real `loom` process against a real
notebook on disk, with the real config and mode resolution, and that the audit
row actually lands in `activity.jsonl` where the warn-mode audit will read it.

Promoting this to a genuine write-hook scenario needs either a model in the loop
(Tier 2) or a harness affordance for injecting a tool call, neither of which is
in scope here.

## Notes

- Asserted through `assertions.activity`, added to the eval lib alongside this
  scenario. In `--mode json` there is no UI, so `ctx.ui.notify` is a no-op and a
  synchronous command that records a decision has no other observable surface.
- The run exits on its own in under two seconds; the `--mode json` exit hang
  noted in `evals/README.md` does not bite here, so `timeoutMs` is a ceiling
  rather than the expected path.
