# udt-authoring-threads

A Tier-2 scenario that checks whether Loom's skills router actually steers the
agent to the `udt-authoring` skill before it hand-writes a User-Defined Tool,
and whether the resulting tool respects Galaxy's core allocation.

## What it tests

Two things, in order:

1. **Progressive disclosure** -- did the agent fetch `udt-authoring` at all?
   The prompt asks for a `samtools sort` UDT, which is squarely the kind of
   glue-tool the skill exists to teach. If the router does its job the agent
   calls `skills_fetch({ path: "udt-authoring/SKILL.md" })` instead of drafting
   the YAML from training priors. Asserted via the `skills_fetch` tool call.

2. **The outcome** -- does the drafted UDT wire `$GALAXY_SLOTS` into the thread
   flag? The prompt deliberately asks for two things at once: multithreaded
   sorting _and_ logging the core count "for debugging." That is the exact shape
   that tempts a model to `echo $GALAXY_SLOTS` to the log while still passing a
   hardcoded number to `--threads` / `-@` -- it looks core-aware while ignoring
   the allocation. We assert the YAML actually contains `$GALAXY_SLOTS` (and is a
   `class: GalaxyUserTool` definition).

`--tools skills_fetch` restricts the tool surface so the agent can't create the
tool on the server or write it to a file -- it has to draft the full definition
in chat, where the `chatText` assertions can see it.

## Why there's no `mustNotInclude` for hardcoded thread counts

The tempting negative assertion would be "the YAML must not contain `-@ 8` or
`--threads 4`." We don't do that on purpose: the specific hardcoded value varies
across models (`4`, `8`, `$(nproc)`, whatever), so an absence check is brittle
and prone to false greens/reds. The positive `$GALAXY_SLOTS` check is the robust
proxy -- if the thread flag is fed by `$GALAXY_SLOTS`, it isn't hardcoded.

## Prerequisites to run green

- A Tier-2 model with credentials in `evals/.env` (this scenario sets
  `requiresModel: true`, so it runs across every model in `evals/models.json`
  whose env vars are present).
- Network access for `skills_fetch` to reach the galaxy-skills repo.
- The `$GALAXY_SLOTS` chatText assertion needs `udt-authoring` to be fetchable on
  the seeded galaxy-skills branch, since the skill content is what teaches the
  `$GALAXY_SLOTS` pattern. As of this scenario, `udt-authoring` is merged to
  galaxy-skills `main` (PR #30) with `metadata.surfaces: [loom]`, so this
  prerequisite is satisfied on the default branch.

The `skills_fetch`-call assertion (progressive disclosure) is meaningful even
without the skill content: `tool_execution_start` fires whether the fetch returns
200 or 404, so this scenario can catch a router regression -- the agent forgetting
to consult the skill at all -- independently of whether the skill is fetchable.

## A note on the tool surface

`--tools skills_fetch` is intended to (a) keep the skills router in the system
prompt -- the router is gated on the enabled skill repos, not on the tool
surface, so it stays -- (b) expose `skills_fetch` so the fetch can happen, and
(c) force chat-drafted output by withholding the create/write tools. If a future
harness change means the router or `skills_fetch` needs to be requested
differently, adjust `loomArgs` accordingly.
