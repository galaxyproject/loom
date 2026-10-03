# Lesson schema v1

The file format. `validate.mjs` is the authoritative version of all of this:
where this document and that script disagree, the script wins and this document
is wrong. Run `npm run check:lessons`.

One markdown file per lesson at `lessons/<namespace>/<slug>.md`. The id is the
path minus `.md`, e.g. `stats/na-coerced-to-zero-in-filters`. The slug is
lowercase words joined by hyphens, at most 80 characters.

The format is Google Cloud's Open Knowledge Format: a directory of markdown with
YAML frontmatter, distributed as a git repository. OKF fields come first; Loom's
extension fields come after.

## Frontmatter

```yaml
type: Lesson # OKF required
title: string # <= 120 chars; the situation, not the fix
description: string # <= 200 chars, one line
tags: [string] # free; stage and formats are mirrored here by the build
status: draft | stable | deprecated # OKF
generated: { by: string, at: string } # e.g. "agent:loom/0.6.0" or "human:loom-maintainers"
verified: [{ by: string, at: string }] # optional; by = "human:<pseudonym>", never a contributor id
stale_after: string # ISO date; required
sources: [{ id: string, resource?: string, title?: string }] # provenance; required when derived from GTN/forum

kind: pitfall | expectation | choice | source-quirk | reproduction
stage:
  [
    data-acquisition | metadata-reconciliation | tool-parameterization | job-execution | result-interpretation,
  ]
trigger:
  signatures: [string] # literal, normalized, each <= 200
  tools: [string] # Galaxy tool ids or families
  mcp_tools: [string] # galaxy_* names
  formats: [string] # datatypes / extensions
  hosts: [string] # hostnames seen in URLs/commands, e.g. "ncbi.nlm.nih.gov"
  extensions: [string] # file extensions seen in args, e.g. ".gtf"
  step_keywords: [string] # lowercase words matched against plan-step text
cues: string # human-readable description of when this applies (not matched)
applies_to: { versions: string, tested: string }
evidence:
  symptom: verified | reported
  cause: verified | hypothesized | unknown
  outcome: validated | unvalidated
  method: string
graduated_to: [string] # free text or links; non-empty => not surfaced by the matcher
upstream: [string]
supersedes: [string] # lesson ids
```

## Body

Exactly these `##` sections, in this order. `Cause` is optional; the rest are
required.

`Symptom`, `Cause`, `Check first`, `Intervention`, `Validate`,
`Does NOT apply when`.

Each section is at most 600 characters and must not be empty. Nothing before
the first heading. No fenced code blocks anywhere on a line, and no indented
code blocks, at any depth (a short inline backtick span is fine). No URLs of
any scheme, protocol-relative, scheme-less or `www.`, anywhere in the body. No
heading other than those six, whether `#`-style at any indent or a setext
underline, and no horizontal rules. The whole file is at most 16384 bytes.

The body and every frontmatter string are also run through `marked`'s GFM lexer,
so "is this a link" is answered the way a renderer answers it rather than by a
line regex. Refused at any depth (inside blockquotes, list items and tables
too): links of every kind (inline, reference, autolinks), link reference
definitions, images, HTML, backslash escapes and character references
(`&#64;`, `&#x40;`, `&amp;`). A code span may show a placeholder such as
`<collection id>`, but not a tag with attributes, a closing tag, a link, a nested
code span hiding either, or an element like `<script>` or `<iframe>` that is
live even bare. The placeholders `normalizeSignature` writes (`<path>`, `<id>`,
`<url>`, `<n>`, `<email>`) are text anywhere. A string longer than the file cap
is refused unchecked.

## What the validator adds on top of the field list

The contract names the fields; these are the rules the validator applies to
them, and they are part of the schema.

- **Unknown keys are rejected**, at the top level and inside `generated`,
  `verified[]`, `sources[]`, `trigger`, `applies_to` and `evidence`. Every
  required key must be present; `verified` is the only optional one.
- **Printable ASCII only, in the whole file and in every parsed value.** A
  Unicode em-dash, a smart quote or a non-breaking space is an error, reported
  by codepoint. Write `--`. Parsed values are checked too, so a YAML escape like
  `"\u202e"` cannot carry a control character past the file check.
- **Plain YAML only.** No comments (they ship in the raw file and would
  otherwise go unchecked), no anchors or aliases, no explicit tags.
- **Nothing identifying, anywhere.** No absolute or home-directory paths,
  Windows or UNC paths, hex ids of 16 or more characters, uuids, IPv4 or IPv6
  addresses (the `::` forms too), email addresses, hostnames on network
  top-level domains, or credential-shaped strings (provider API keys, AWS key
  ids, GitHub and Slack tokens, private key headers, JWTs) in the body, in any
  frontmatter value or on any raw frontmatter line. `trigger.hosts` is the one
  field that holds a hostname, and it must be a public one (no `.internal`,
  `.local`, `.lan`, `.corp` and the like). No URL in the body or in a
  frontmatter field: nothing with `://`, no `www.`, no known scheme such as
  `mailto:`, `tel:` or `data:` followed by anything, and no other `word:`
  followed by a host or an address. A plain `word:word` (`batch:condition`,
  `list:paired`) is prose. Paths include `$HOME/...`, `%USERPROFILE%\...` and
  drive-less backslash paths. An IPv4 address starting with `0.` is not
  refused, so a four-part tool version like `0.7.17.4` is not either; one
  starting with any other number is.
- **Links** go only in `graduated_to`, `upstream` and `sources[].resource`, and
  each must be a canonical `https` URL to one of the hosts in `LINK_HOSTS` at the
  top of `validate.mjs`: no port, credentials, query, fragment, percent-escape
  or `..`; a path of letters, digits and `._~/+-` only; and the path still gets
  the identifying-data checks, hostnames and URLs included (so no commit SHAs,
  uuids, home paths or a second host in the path). Those fields may hold free text
  instead, like `galaxy-mcp#55`. To link somewhere new, add the host to
  `LINK_HOSTS` in the same pull request and say why.
- **These are shape checks, not meaning checks.** A private hostname written as
  prose, a person's name, a copied data value or an instruction aimed at the
  model ("ignore prior instructions and...") all pass. They need the
  contributor's own judgement and a reviewer's.
- **Dates** are `YYYY-MM-DD` strings that are also real calendar dates.
- **`generated.by`** matches `agent:<something>` or `human:<something>`;
  **`verified[].by`** must be `human:<pseudonym>`. It is the one identity field
  in the schema, and the shared tier uses maintainer pseudonyms rather than
  contributor ids.
- **Signatures must be specific.** At least 8 characters, and never the
  normalizer's `unknown` fallback, which would match every empty error.
- **Signatures must already be normalized.** The validator runs the same
  normalization the matcher will run over a tool result and rejects any
  signature it would change, naming the normalized form to store instead. A
  signature stored raw can never match anything. Normalization takes the first
  line, collapses whitespace, then replaces URLs with `<url>`, emails with
  `<email>`, paths with two or more separators with `<path>`, runs of 16+ hex
  characters with `<id>` and integers of 5+ digits with `<n>`, in that order,
  and truncates to 200.
- **At least one trigger list must be non-empty.** A lesson nothing can match is
  documentation, and documentation belongs in the GTN.
- **Per-entry shapes.** `mcp_tools` are `galaxy_*`; `hosts` are bare hostnames
  with no scheme and no path; `extensions` start with a dot; `step_keywords` are
  lowercase; `formats` are lowercase; `supersedes` entries are namespaced lesson
  ids. Lists cap at 20 entries.
- **Caps.** title 120, description 200, each tag 40, cues 300, each signature
  200, each tool id 200, each MCP tool name 80, each format 40, each host 100,
  each extension 20, each step keyword 40, each `applies_to` field 200,
  `evidence.method` 300, each source id 100, each free-text list entry 200, each
  body section 600.
- **A `galaxy-api` lesson must have a non-empty `graduated_to`.** That namespace
  exists for lessons whose durable fix lives elsewhere, and `graduated_to` is
  what keeps them unsurfaced.
- **Directory shape.** A namespace directory holds `.md` lesson files only, one
  level deep. Top-level files (this one, README, LICENSE, log, the scripts) are
  not lessons and are not validated.

## The snapshot

`npm run build:lessons` writes `lessons/snapshot.json`:

```ts
interface LessonSnapshot {
  schema: 1;
  built_at: string; // ISO
  source: { repo: "galaxyproject/loom"; commit: string };
  licence: "CC-BY-4.0";
  lessons: Lesson[];
}
interface Lesson {
  id: string; // "stats/na-coerced-to-zero-in-filters"
  // every frontmatter field above, same names, same shapes
  sections: {
    symptom: string;
    cause?: string;
    check_first: string;
    intervention: string;
    validate: string;
    not_when: string;
  };
}
```

A lesson is left out when `status` is `deprecated` or when `stale_after` has
passed as of the snapshot's own `built_at`. `tags` in the snapshot is the
authored tags plus the lesson's `stage` values and `trigger.formats`, deduped.

Published file:
`https://raw.githubusercontent.com/galaxyproject/loom/main/lessons/snapshot.json`.
A lesson's canonical page:
`https://github.com/galaxyproject/loom/blob/main/lessons/<id>.md`.
