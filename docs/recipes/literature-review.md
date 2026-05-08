# Recipe: Literature Review

A prompt scaffold for the main agent to produce a durable, citeable literature review and persist the approved references in `notebook.md`.

This recipe is **single-agent** on purpose. `team_dispatch` roles do not yet have tool access (see `docs/superpowers/specs/2026-04-17-multi-agent-dispatch-design.md`), so a Finder role cannot actually search -- it collapses into a second validator. Until roles gain tools, the main agent runs this loop itself.

The target quality bar is `alphagenome-malaria-loci/notes/literature-review.md` in the brain vault: a novelty table, grouped citations with 1-2 sentence relevance notes, and an "implications" section that names where each reference goes.

## Preconditions

- The notebook has a clear research question or plan section (hypothesis at minimum, PICO preferred).
- The main agent has web search available. A PubMed / EuropePMC MCP is optional; see "When to reach for an MCP" at the bottom.
- You have a rough sense of the domain -- enough to judge whether a title is primary research, review, commentary, or off-topic.

## Phase 1 -- Broad search

Build queries from the research question, not from the hypothesis string verbatim. PICO terms expand naturally:

- Population terms -- disease, tissue, organism, cohort descriptors
- Intervention terms -- model/tool/method name, assay, variant class
- Outcome terms -- measurement, endpoint, mechanism
- Plus one "landscape" query -- "<disease> GWAS functional follow-up", "<method> benchmark", "<locus> review"

Run 3-5 queries, broad-then-narrow. Capture the raw hit list -- title, first author, year, venue, and PMID/DOI if visible -- before filtering. Do **not** prune on the first pass; relevance judgment comes later with the full set visible.

Flag **gaps**. If a query returns zero meaningful hits ("no genomic foundation model applied to this disease"), that gap is itself a finding worth recording in the novelty section.

## Phase 2 -- Extract candidates

For each hit that survives a title-and-abstract skim, capture:

| Field               | Required     | Notes                                                                                       |
| ------------------- | ------------ | ------------------------------------------------------------------------------------------- |
| title               | yes          | Full title, not abbreviated                                                                 |
| first author + year | yes          | e.g., "Zhou et al. 2018"                                                                    |
| venue               | yes          | Journal or preprint server                                                                  |
| PMID                | if available | Required for PubMed-indexed work                                                            |
| DOI                 | if available | Preferred for preprints and non-PubMed venues                                               |
| role                | yes          | One of: precedent, comparator, limitation, replication, novel-connection                    |
| relevance           | yes          | 1-2 sentences, concrete. Not "is related to X" -- say what it supports, refutes, or caveats |

Fifteen to twenty-five candidates is a healthy pre-validation pool for a single research question. Fewer suggests the search was too narrow; many more suggests queries were too generic.

## Phase 3 -- Validate

Before persisting, run each candidate through this pass:

1. **Does it actually answer something?** If the relevance note is "related to X," either rewrite it concretely or drop the paper.
2. **Primary vs review.** Both are fine, but label the role. A review cited as if it were primary evidence is a real error.
3. **Recency vs canonical.** Keep old papers only when they are conceptual ancestors or landmark comparators. If a 2018 paper has been superseded by a 2024 one doing the same thing better, cite the 2024.
4. **Venue sanity.** Preprints are fine for recent work; flag them as preprints in the relevance note. Predatory venues go in the trash.
5. **Duplicate IDs.** Two hits with the same PMID or DOI collapse to one.
6. **Novelty-table check.** For the core loci / targets / methods in the research question, does existing literature already answer our question? If yes, the hypothesis needs sharpening before we keep writing the review.

A candidate that fails any of 1-4 either gets rewritten or dropped. Do not persist weak entries -- the notebook's literature section is the durable record, not a scratchpad.

## Phase 4 -- Persist

For each validated reference, edit `notebook.md` under a `## Literature` section using this shape:

```markdown
- **<First author> et al. <year>. <Title>. <Journal>.**
  - Role: precedent | comparator | limitation | replication | novel-connection
  - Relevance: <the 1-2 sentence note from Phase 2, not a generic description>
  - IDs: PMID <pmid if available>; DOI <doi if available>
```

Persist in the order they should appear in the manuscript, grouped by role -- precedents first, then comparators, then limitations, then section-specific entries. The notebook preserves insertion order.

After persisting, produce a short summary in chat: count by role, gaps found, and any "sleeper hits" (unexpected connections worth flagging to the researcher).

## When to reach for an MCP

Stay on generic web search unless you hit a concrete pain:

- **Citation export getting sloppy** (inconsistent author formatting, missing PMIDs on indexed papers) -- a PubMed MCP gives you structured metadata in one call.
- **MeSH-filtered queries** -- "immunology AND not review AND humans, 2020-2026" is awkward in web search, clean in EuropePMC.
- **Reproducible query audit** -- if the query itself needs to be part of the notebook record, the MCP's exact query string is a better artifact than a web-search URL.

Until one of those bites, the MCP is a build-and-maintain cost that duplicates what search already does.

## When not to use this recipe

- **The researcher has a curated list already.** Skip to Phase 4 and persist.
- **Single paper drop-in.** Edit the `## Literature` section directly; a full review scaffold is overkill.
- **Team dispatch becomes viable.** Once `team_dispatch` roles can call tools, revisit -- parallel Finder agents querying PubMed / bioRxiv / EuropePMC independently may earn the orchestration overhead.
