# Lesson log

OKF keeps a `log.md` beside the content as the corpus's audit trail. One entry
per change to what the corpus _says_, newest last. A reformat, a script change
or a snapshot rebuild is not an entry; a lesson added, retired, re-scoped or
re-verified is.

## 2026-09-30 -- schema v1, thirteen seed lessons

By: human:loom-maintainers

Opened the corpus with the thirteen seed lessons written on 2026-09-17, ported
from the draft v0 schema to v1. The port renamed `editorial` to `status`, moved
`evidence.provenance` into OKF `sources`, split the single v0 `cues` list into a
prose `cues` string plus the machine-matchable `trigger` sub-fields
(`mcp_tools`, `hosts`, `extensions`, `step_keywords`), dropped the `schema`, `id`
and `revision` fields (the path is the id), and added `description`, `kind`,
`generated` and `stale_after`. All thirteen carry `stale_after: 2027-03-31`.

Added, `status: draft`:

- `stats/na-coerced-to-zero-in-filters`
- `stats/de-contrast-direction-and-sample-labels`
- `reproduction/input-population-mismatch`
- `reproduction/methods-text-vs-executed-parameters`
- `data/downloaded-file-is-not-what-its-extension-says`
- `galaxy-tools/reference-index-not-on-server`

Added, `status: stable` with `graduated_to` filled, so they are kept for the
record and never surfaced:

- `galaxy-api/403-history-is-a-hard-stop`
- `galaxy-api/collection-into-single-dataset-input`
- `galaxy-api/connectedvalue-in-command-line`
- `galaxy-api/hid-is-not-an-id`
- `galaxy-api/invoke-workflow-inputs-not-params`
- `galaxy-api/repeat-param-pipe-keys`
- `galaxy-api/run-tool-returns-on-submit`

Two further seeds were written in September and are deliberately not here: both
describe a case nobody has a real instance of yet, and a lesson without an
observed instance is a guess.
