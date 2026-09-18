---
name: discover-shed-tool
description: "Search the Tool Shed for an existing wrapper, drill from hit to a pinnable changeset, classify candidates, and recommend or fall through."
---

# discover-shed-tool

Follow the procedure below and use the artifact/reference sections as the runtime contract.

## When To Use

- Search the Tool Shed for an existing wrapper, drill from hit to a pinnable changeset, classify candidates, and recommend or fall through.

## Inputs

- No upstream artifact inputs declared. See the procedure for user-supplied runtime inputs.

## Outputs

- Write artifact `galaxy-tool-pin` as `galaxy-tool-pin.json`. Format: `json`. Schema: galaxy-tool-discovery. (owner, repo, tool_id, version, changeset_revision) pin for a Tool Shed wrapper plus discovery classification.

## Required Tools

- **`gxwf`** (gxwf). `npm install -g '@galaxy-tool-util/cli@^1.8.1'`.
  Ephemeral run: `npx --yes --package @galaxy-tool-util/cli@1.8.1 gxwf`.
  Check: `gxwf --help | grep -q draft-validate`.
  Docs: https://github.com/jmchilton/galaxy-tool-util-ts/tree/main/packages/cli

## Load Upfront

- `references/schemas/galaxy-tool-discovery.schema.json`: Schema file copied verbatim into the bundle. Validate the hit, weak, or miss recommendation emitted by Tool Shed discovery.

## Load On Demand

- `references/cli/tool-revisions.json`: CLI command reference packaged as a sidecar. Resolve a Tool Shed tool version to an installable changeset revision. Use when: after selecting a candidate version that needs a reproducible changeset pin.
- `references/cli/tool-search.json`: CLI command reference packaged as a sidecar. Search the Tool Shed for candidate wrappers matching a step's tool need. Use when: resolving a workflow step to an installable Galaxy tool wrapper.
- `references/cli/tool-versions.json`: CLI command reference packaged as a sidecar. List available Tool Shed versions for a selected candidate. Use when: after a Tool Shed search candidate is selected and before pinning a version.
- `references/notes/component-tool-shed-search.md`: Research note copied verbatim into the bundle. Explain Tool Shed search/indexing limitations that affect hit scoring and fallthrough decisions. Use when: results are missing, weak, duplicated across owners, stale, or ambiguous.

## Validation

- Validate `galaxy-tool-pin.json` before returning it: run `foundry validate-galaxy-tool-discovery galaxy-tool-pin.json` from `@galaxy-foundry/gxwf-foundry`. If the command is not on PATH, run `npx --package @galaxy-foundry/gxwf-foundry foundry validate-galaxy-tool-discovery galaxy-tool-pin.json`. This checks artifact `galaxy-tool-pin` against the galaxy-tool-discovery schema.

## Procedure

Discover whether the Galaxy Tool Shed already publishes a wrapper for the tool a workflow step needs, and resolve the discovery to a `(owner, repo, tool_id, version, changeset_revision)` quintuple that downstream steps can pin and cache.

This skill is the **Tool Shed leg** of the `discover-or-author` branch in Galaxy-targeting per-step pipelines. On a hit, the skill recommends a pin and exits successfully. On a miss (or a low-quality hit), it falls through to author-galaxy-tool-wrapper. The branch itself is harness logic; this skill owns only the discovery half.

### Inputs

The skill expects, per step:

- A free-text **need** describing what the step should do (typically a one-line description of the tool, plus any constraints — file format in/out, container language, license preferences).
- Optional **owner hint** (e.g. `devteam`, `iuc`) when the caller has a strong prior.
- Optional **exact-name hint** when the caller knows the canonical XML id.

### Outputs

A structured recommendation object, JSON-shaped:

```json
{
  "status": "hit",
  "candidate": {
    "tool_shed_url": "https://toolshed.g2.bx.psu.edu",
    "owner": "devteam",
    "repo": "fastqc",
    "tool_id": "fastqc",
    "trs_tool_id": "devteam~fastqc~fastqc",
    "version": "0.74+galaxy0",
    "changeset_revision": "5ec9f6bceaee",
    "score": 12.3,
    "matched_terms": ["fastqc"],
    "match_fields": ["name", "description"],
    "rationale": "single dominant hit on tool name"
  },
  "alternates": [],
  "rationale": "single dominant hit on tool name; latest version pinned to newest changeset",
  "warnings": []
}
```

`status` semantics:
- `hit` — recommend pinning. Caller should cache and proceed.
- `weak` — candidate exists but the skill is not confident (e.g. only help-text matched, multiple owners with similar tools, deprecated repo, stale-index suspicion). Caller should confirm or fall through.
- `miss` — no usable hit. Caller falls through to author-galaxy-tool-wrapper.

### Procedure

The skill follows the gxwf-shaped discover-and-pin chain. **It does not call the Tool Shed HTTP API directly** — the TS CLI wraps the call sequence and gotchas covered in component-tool-shed-search.

#### 1. Search

Issue tool-search with the need's keywords. Start narrow:

```
gxwf tool-search "<keywords>" --json --max-results 10
```

If an owner hint is present, add `--owner <owner>`. If an exact-name hint is present, add `--match-name`. Lowercase the query (the tool index does not lowercase, see component-tool-shed-search §6).

**Normalize a tool-id-shaped need before searching.** A caller (e.g. a template `_plan_context` that guessed a candidate) may hand this skill an XML-id token rather than a human name — `iuc/integron_finder`, `integron_finder`. The lexical index does **not** reliably match the underscored token: `tool-search integron_finder` returns no hits while `integron finder` and `integron` both score. So derive query variants instead of feeding the token verbatim: strip any `owner/` prefix, split on `_` / `-` into space-separated words, and also try the bare significant word. A `miss` is only honest after the name variants have been tried — a no-hit on the raw underscored token alone is a search artifact, not evidence the tool is absent.

#### 2. Triage hits

For each hit, score on:
- **Name match.** Exact match on `toolId` or `name` is a strong signal; help-only matches are weak.
- **Owner reputation.** `iuc` and `devteam` repos are typically maintained; an unfamiliar owner with a single-tool repo is a weaker prior. (No machine-readable approval flag exists — the Tool Shed's `approved` field is dead code.)
- **Recency.** Recent `last_updated` strengthens a hit; very old wrappers can still be valid but warrant the `weak` classification.
- **Duplicates across repos.** Two owners can publish wrappers with the same XML id. Either pick the maintained one or downgrade to `weak` and surface the choice.

Drop hits from deprecated repos when detectable. Note: deprecated repos can still appear in shed search results until the next index rebuild — see component-tool-shed-search §6.

#### 3. Resolve to a pinnable version

For the top candidate, list versions:

```
gxwf tool-versions <trsToolId> --json
```

Pick the newest installable version unless the need specifies otherwise (rare: a workflow may pin to a specific historical version for reproducibility). Be aware that **TRS dedupes by version string** — multiple changesets may publish the same version, and only one is visible at this layer.

#### 4. Resolve to a changeset

Drill from `(trsToolId, version)` to a concrete changeset:

```
gxwf tool-revisions <trsToolId> --tool-version <v> --latest --json
```

Prefer `--latest` so the newest changeset publishing that version wins (tool versions are not monotonic; two changesets can legally publish the same version with different content). The output's `changesetRevision` is what lands in the workflow's `tool_shed_repository.changeset_revision` for reproducible reinstall.

#### 5. Classify and emit

Combine the scored hit and the resolved pin into the recommendation object above:
- One dominant hit + clean version+changeset resolution → `hit`.
- Multiple plausible hits, ambiguous owner, deprecated suspicion, or only-help-text match → `weak` with the leading candidate plus alternates.
- No usable hit → `miss`.

Validate the recommendation with `validate-galaxy-tool-discovery` before returning it. Do not rely on prose-only shape checks; downstream phases branch on this contract.

### Caveats baked into the procedure

The procedure assumes — and the skill must surface in its rationale when relevant — the following Tool Shed realities (full detail in component-tool-shed-search §6):

- **Indexes are stale by design.** A freshly published tool may not appear; a deprecated tool may still appear. Treat absence as soft evidence, not proof.
- **Wildcard `*term*` wrapping** disables stemming; spelling matters. Try alternate phrasings before declaring `miss`. In particular an underscored or owner-prefixed **tool-id token** (`integron_finder`, `iuc/integron_finder`) can score zero where the **human name** (`integron finder`) hits — never declare `miss` on a single id-token query (see §1 normalization).
- **No EDAM in shed search** — semantic queries that work in Galaxy's installed-toolbox search will not work here. Stick to lexical name/keyword queries.
- **Same XML id across repos.** Hits collapse only on `(repoName, owner)`; expect duplicates that need triage.
- **Repo-level discovery is a different surface.** For "find me the *package* that contains a tool about X" with server-side `owner:` / `category:` keywords, `gxwf repo-search` is the right command — out of scope for this skill but a known sibling.

### Non-goals

- **Authoring.** This skill never produces a tool wrapper. On `miss`, the harness's `discover-or-author` branch fall-through invokes author-galaxy-tool-wrapper.
- **Caching.** This skill emits a pin recommendation. The caller (or the next phase) runs `galaxy-tool-cache add toolshed.g2.bx.psu.edu/repos/<owner>/<repo>/<tool_id> --tool-version <v>` to populate the cache.
- **Galaxy-instance discovery.** Hitting a running Galaxy server's installed-tool index (EDAM-aware, panel-aware) is a different mechanism — the future `discover-tool-via-galaxy-api` skill. The contrast is sketched in component-tool-shed-search §4.
- **Test-data resolution.** Out of scope; handled by the `test-data-resolution` branch elsewhere in the pipeline.

## Feedback Mode

- Feedback mode is off unless the caller explicitly enables `--feedback` or supplies a feedback-ledger path.
- When enabled, read `_feedback.md` before doing the work and use its registered `foundry-feedback.ledger.yml` protocol.
- Preserve harness-owned run and phase state. Append only concrete observations about a canonical Foundry source asset or a related project that this run showed to be at fault; do not put ordinary workflow requirements in this ledger.
- Before reporting completion, make one explicit pass over the work you just did. Do not ask yourself whether anything was unclear — recall what happened: where you guessed at something the instructions should have settled, needed information this bundle does not carry, hit an instruction that contradicted another or contradicted the artifacts in front of you, used a packaged reference that did not cover your case, or did something the procedure never describes.
- Append an entry for each such event that clears the protocol's bar. If none do, append nothing and report `no feedback` explicitly. Silence and a clean pass are not the same thing, and nothing downstream can tell them apart unless you say which one it was.
- Pass the same ledger path to any subagent used for this work, and merge updates serially so one writer cannot overwrite another.

## Runtime Notes

- Do not read Foundry source files at runtime; use only files packaged in this skill bundle and user-supplied artifacts.
- Preserve declared artifact filenames unless the user or harness supplies explicit paths.
- Carry unresolved assumptions into the output artifact instead of silently inventing missing source evidence.
